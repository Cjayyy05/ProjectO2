import { Prisma, type PrismaClient } from "@prisma/client";
import type { RemediationPlanningRepository } from "./remediation-planning-repository";
import { validateRemediationPlanIntegrity } from "./remediation-validation";
import type {
  PlanningDeployment,
  RemediationPlanDraft,
  RemediationPlanningCandidate,
  RemediationPlanningDecision
} from "./remediation-types";

const deploymentSelection = {
  id: true,
  projectId: true,
  isCurrent: true,
  containerName: true,
  imageReference: true,
  configurationSnapshot: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.DeploymentSelect;

const candidateSelection = {
  id: true,
  version: true,
  projectId: true,
  deploymentId: true,
  project: {
    select: {
      userId: true,
      healthCheckPath: true,
      expectedPort: true,
      deployments: {
        orderBy: { createdAt: "desc" as const },
        take: 50,
        select: deploymentSelection
      }
    }
  },
  deployment: { select: deploymentSelection },
  diagnosis: {
    select: {
      id: true,
      result: true,
      remediationPlanningCompletedAt: true
    }
  }
} satisfies Prisma.IncidentSelect;

class StaleRemediationPlanningWorkError extends Error {}

export class PrismaRemediationPlanningRepository implements RemediationPlanningRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async findNextCandidate(incidentId?: string): Promise<RemediationPlanningCandidate | null> {
    const incident = await this.prisma.incident.findFirst({
      where: {
        ...(incidentId === undefined ? {} : { id: incidentId }),
        state: "FIX_PROPOSED",
        diagnosis: { is: { remediationPlanningCompletedAt: null } },
        remediationPlans: { none: {} }
      },
      orderBy: { updatedAt: "asc" },
      select: candidateSelection
    });
    if (incident === null || incident.diagnosis === null) return null;
    return {
      incidentId: incident.id,
      incidentVersion: incident.version,
      projectId: incident.projectId,
      ownerId: incident.project.userId,
      diagnosisId: incident.diagnosis.id,
      diagnosisResult: incident.diagnosis.result,
      affectedDeployment: incident.deployment === null ? null : mapDeployment(incident.deployment),
      projectHealthCheckPath: incident.project.healthCheckPath,
      projectExpectedPort: incident.project.expectedPort,
      projectDeployments: incident.project.deployments.map(mapDeployment)
    };
  }

  public async persistDecision(
    candidate: RemediationPlanningCandidate,
    decision: RemediationPlanningDecision
  ): Promise<boolean> {
    let validatedPlan: RemediationPlanDraft | null = null;
    if (decision.kind === "PLAN" && (
      decision.plan.incidentId !== candidate.incidentId ||
      decision.plan.diagnosisId !== candidate.diagnosisId ||
      decision.plan.projectId !== candidate.projectId ||
      decision.plan.deploymentId !== candidate.affectedDeployment?.id
    )) {
      return this.persistDecision(candidate, {
        kind: "NOT_ACTIONABLE",
        code: "PLAN_IDENTITY_MISMATCH"
      });
    }
    if (decision.kind === "PLAN") {
      validatedPlan = validateRemediationPlanIntegrity(decision.plan);
      if (validatedPlan === null) {
        return this.persistDecision(candidate, {
          kind: "NOT_ACTIONABLE",
          code: "PLAN_INTEGRITY_MISMATCH"
        });
      }
    }
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const guarded = await transaction.incident.updateMany({
          where: {
            id: candidate.incidentId,
            projectId: candidate.projectId,
            deploymentId: candidate.affectedDeployment?.id ?? null,
            state: "FIX_PROPOSED",
            version: candidate.incidentVersion,
            project: { userId: candidate.ownerId },
            diagnosis: {
              id: candidate.diagnosisId,
              remediationPlanningCompletedAt: null
            },
            remediationPlans: { none: {} }
          },
          data: { version: { increment: 1 } }
        });
        if (guarded.count !== 1) return false;

        const completedAt = new Date();
        const diagnosisUpdated = await transaction.diagnosis.updateMany({
          where: {
            id: candidate.diagnosisId,
            incidentId: candidate.incidentId,
            remediationPlanningCompletedAt: null
          },
          data: {
            remediationPlanningCompletedAt: completedAt,
            remediationPlanningCode: decision.kind === "PLAN" ? "PLAN_CREATED" : decision.code
          }
        });
        if (diagnosisUpdated.count !== 1) throw new StaleRemediationPlanningWorkError();

        if (decision.kind === "NOT_ACTIONABLE") {
          await transaction.auditEvent.create({
            data: {
              userId: candidate.ownerId,
              projectId: candidate.projectId,
              incidentId: candidate.incidentId,
              action: "REMEDIATION_PLAN_NOT_CREATED",
              resourceType: "Diagnosis",
              resourceId: candidate.diagnosisId,
              outcome: "FAILURE",
              details: { code: decision.code, incidentVersion: candidate.incidentVersion + 1 }
            }
          });
          return true;
        }

        const plan = validatedPlan;
        if (plan === null) throw new Error("Validated remediation plan is unavailable");
        const created = await transaction.remediationPlan.create({
          data: {
            projectId: plan.projectId,
            incidentId: plan.incidentId,
            diagnosisId: plan.diagnosisId,
            deploymentId: plan.deploymentId,
            version: plan.version,
            schemaVersion: plan.schemaVersion,
            actionTypes: [...plan.actionTypes],
            actions: plan.actions as unknown as Prisma.InputJsonValue,
            baseline: plan.baseline as Prisma.InputJsonValue,
            summary: plan.summary,
            rollbackSupported: plan.rollbackSupported,
            rollbackDescription: plan.rollbackDescription,
            planHash: plan.planHash,
            targetSnapshotHash: plan.targetSnapshotHash
          }
        });
        await transaction.auditEvent.create({
          data: {
            userId: candidate.ownerId,
            projectId: candidate.projectId,
            incidentId: candidate.incidentId,
            action: "REMEDIATION_PLAN_CREATED",
            resourceType: "RemediationPlan",
            resourceId: created.id,
            outcome: "SUCCESS",
            details: {
              diagnosisId: candidate.diagnosisId,
              deploymentId: plan.deploymentId,
              actionType: plan.actions[0].type,
              planHash: plan.planHash,
              targetSnapshotHash: plan.targetSnapshotHash,
              incidentVersion: candidate.incidentVersion + 1
            }
          }
        });
        return true;
      });
    } catch (error) {
      if (error instanceof StaleRemediationPlanningWorkError) return false;
      throw error;
    }
  }
}

function mapDeployment(deployment: Prisma.DeploymentGetPayload<{
  select: typeof deploymentSelection;
}>): PlanningDeployment {
  return deployment;
}
