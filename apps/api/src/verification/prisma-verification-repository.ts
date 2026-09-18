import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { validateRemediationPlanIntegrity } from "../remediation/remediation-validation";
import type { PlanningDeployment } from "../remediation/remediation-types";
import type { VerificationRepository } from "./verification-repository";
import type {
  ClaimedVerificationCandidate,
  VerificationExecutionResult
} from "./verification-types";

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

const remediationPlanSelection = {
  id: true,
  schemaVersion: true,
  version: true,
  incidentId: true,
  diagnosisId: true,
  projectId: true,
  deploymentId: true,
  actionTypes: true,
  actions: true,
  baseline: true,
  summary: true,
  rollbackSupported: true,
  rollbackDescription: true,
  planHash: true,
  targetSnapshotHash: true
} satisfies Prisma.RemediationPlanSelect;

const candidateSelection = {
  id: true,
  claimToken: true,
  incident: {
    select: {
      id: true,
      version: true,
      projectId: true,
      deployment: { select: deploymentSelection },
      project: {
        select: {
          userId: true,
          healthCheckPath: true,
          expectedPort: true,
          deployments: { take: 50, orderBy: { createdAt: "desc" as const }, select: deploymentSelection }
        }
      }
    }
  },
  remediationPlan: {
    select: remediationPlanSelection
  }
} satisfies Prisma.VerificationRunSelect;

class StaleVerificationWorkError extends Error {}

export class PrismaVerificationRepository implements VerificationRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async claimNext(leaseMs: number): Promise<ClaimedVerificationCandidate | null> {
    const reclaimed = await this.reclaimInterrupted(leaseMs);
    if (reclaimed !== null) return reclaimed;

    const incident = await this.prisma.incident.findFirst({
      where: {
        state: "FIX_PROPOSED",
        remediationPlans: { some: { verificationRuns: { none: {} } } },
        diagnosis: { is: { remediationPlanningCode: "PLAN_CREATED" } }
      },
      orderBy: { updatedAt: "asc" },
      select: {
        id: true,
        version: true,
        projectId: true,
        project: { select: { userId: true } },
        remediationPlans: {
          where: { verificationRuns: { none: {} } },
          take: 1,
          orderBy: { createdAt: "desc" },
          select: { id: true, planHash: true, targetSnapshotHash: true }
        }
      }
    });
    const plan = incident?.remediationPlans[0];
    if (incident === null || incident === undefined || plan === undefined) return null;
    const claimToken = randomUUID();
    const runId = randomUUID();
    const claimedAt = new Date();
    const won = await this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.incident.updateMany({
        where: {
          id: incident.id,
          version: incident.version,
          state: "FIX_PROPOSED",
          remediationPlans: { some: { id: plan.id, verificationRuns: { none: {} } } }
        },
        data: { state: "VERIFYING", version: { increment: 1 } }
      });
      if (updated.count !== 1) return false;
      await transaction.verificationRun.create({
        data: {
          id: runId,
          incidentId: incident.id,
          remediationPlanId: plan.id,
          state: "PREPARING",
          planHash: plan.planHash,
          targetSnapshotHash: plan.targetSnapshotHash,
          claimToken,
          claimedAt,
          startedAt: claimedAt
        }
      });
      await transaction.auditEvent.create({
        data: {
          userId: incident.project.userId,
          projectId: incident.projectId,
          incidentId: incident.id,
          action: "VERIFICATION_STARTED",
          resourceType: "VerificationRun",
          resourceId: runId,
          outcome: "SUCCESS",
          details: { planId: plan.id, planHash: plan.planHash, incidentVersion: incident.version + 1 }
        }
      });
      return true;
    });
    return won ? this.loadCandidate(runId, claimToken) : null;
  }

  public async markRunning(candidate: ClaimedVerificationCandidate): Promise<boolean> {
    const result = await this.prisma.verificationRun.updateMany({
      where: {
        id: candidate.runId,
        claimToken: candidate.claimToken,
        state: "PREPARING",
        incident: { state: "VERIFYING", version: candidate.incidentVersion },
        remediationPlan: {
          planHash: extractStoredDigest(candidate.planValue, "planHash"),
          targetSnapshotHash: extractStoredDigest(candidate.planValue, "targetSnapshotHash")
        }
      },
      data: { state: "RUNNING", claimedAt: new Date() }
    });
    return result.count === 1;
  }

  public async renewClaim(candidate: ClaimedVerificationCandidate): Promise<boolean> {
    const result = await this.prisma.verificationRun.updateMany({
      where: {
        id: candidate.runId,
        claimToken: candidate.claimToken,
        state: "RUNNING",
        planHash: extractStoredDigest(candidate.planValue, "planHash"),
        targetSnapshotHash: extractStoredDigest(candidate.planValue, "targetSnapshotHash"),
        incident: { state: "VERIFYING", version: candidate.incidentVersion },
        remediationPlan: {
          planHash: extractStoredDigest(candidate.planValue, "planHash"),
          targetSnapshotHash: extractStoredDigest(candidate.planValue, "targetSnapshotHash")
        }
      },
      data: { claimedAt: new Date() }
    });
    return result.count === 1;
  }

  public async complete(
    candidate: ClaimedVerificationCandidate,
    result: VerificationExecutionResult,
    resultTtlMs: number
  ): Promise<boolean> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const currentPlan = await transaction.remediationPlan.findUnique({
          where: { id: candidate.planId },
          select: remediationPlanSelection
        });
        const validatedPlan = currentPlan === null
          ? null
          : validateRemediationPlanIntegrity(toPlanValue(currentPlan));
        if (validatedPlan === null || validatedPlan.planHash !== result.planHash ||
          validatedPlan.targetSnapshotHash !== result.targetSnapshotHash) {
          return false;
        }
        const runUpdated = await transaction.verificationRun.updateMany({
          where: {
            id: candidate.runId,
            claimToken: candidate.claimToken,
            state: "RUNNING",
            planHash: result.planHash,
            targetSnapshotHash: result.targetSnapshotHash,
            incident: { state: "VERIFYING", version: candidate.incidentVersion },
            remediationPlan: {
              planHash: result.planHash,
              targetSnapshotHash: result.targetSnapshotHash
            }
          },
          data: {
            state: result.passed ? "PASSED" : "FAILED",
            failureCode: result.failureCode,
            sandboxIdentifier: result.sandboxIdentifier,
            checkResults: serializeCheckResults(result),
            boundedOutput: result.boundedOutput,
            cleanupSucceeded: result.cleanupSucceeded,
            completedAt: new Date(),
            expiresAt: result.passed ? new Date(Date.now() + resultTtlMs) : null,
            claimToken: null,
            claimedAt: null
          }
        });
        if (runUpdated.count !== 1) return false;
        const incidentUpdated = await transaction.incident.updateMany({
          where: {
            id: candidate.incidentId,
            projectId: candidate.projectId,
            deploymentId: candidate.affectedDeployment.id,
            state: "VERIFYING",
            version: candidate.incidentVersion,
            project: { userId: candidate.ownerId }
          },
          data: {
            state: result.passed ? "AWAITING_APPROVAL" : "VERIFICATION_FAILED",
            version: { increment: 1 }
          }
        });
        if (incidentUpdated.count !== 1) throw new StaleVerificationWorkError();
        await transaction.auditEvent.create({
          data: {
            userId: candidate.ownerId,
            projectId: candidate.projectId,
            incidentId: candidate.incidentId,
            action: result.passed ? "VERIFICATION_PASSED" : "VERIFICATION_FAILED",
            resourceType: "VerificationRun",
            resourceId: candidate.runId,
            outcome: result.passed ? "SUCCESS" : "FAILURE",
            details: {
              planId: candidate.planId,
              planHash: result.planHash,
              targetSnapshotHash: result.targetSnapshotHash,
              failureCode: result.failureCode,
              cleanupSucceeded: result.cleanupSucceeded,
              incidentVersion: candidate.incidentVersion + 1
            }
          }
        });
        return true;
      });
    } catch (error) {
      if (error instanceof StaleVerificationWorkError) return false;
      throw error;
    }
  }

  private async reclaimInterrupted(leaseMs: number): Promise<ClaimedVerificationCandidate | null> {
    const cutoff = new Date(Date.now() - leaseMs);
    const existing = await this.prisma.verificationRun.findFirst({
      where: {
        state: { in: ["PREPARING", "RUNNING"] },
        claimedAt: { lte: cutoff },
        incident: { state: "VERIFYING" }
      },
      orderBy: { claimedAt: "asc" },
      select: { id: true, claimToken: true, incident: { select: { id: true, version: true } } }
    });
    if (existing === null) return null;
    const claimToken = randomUUID();
    const reclaimed = await this.prisma.$transaction(async (transaction) => {
      const incidentUpdated = await transaction.incident.updateMany({
        where: { id: existing.incident.id, state: "VERIFYING", version: existing.incident.version },
        data: { version: { increment: 1 } }
      });
      if (incidentUpdated.count !== 1) return false;
      const runUpdated = await transaction.verificationRun.updateMany({
        where: {
          id: existing.id,
          claimToken: existing.claimToken,
          claimedAt: { lte: cutoff },
          state: { in: ["PREPARING", "RUNNING"] }
        },
        data: { claimToken, claimedAt: new Date(), state: "PREPARING" }
      });
      if (runUpdated.count !== 1) throw new StaleVerificationWorkError();
      return true;
    }).catch((error: unknown) => {
      if (error instanceof StaleVerificationWorkError) return false;
      throw error;
    });
    return reclaimed ? this.loadCandidate(existing.id, claimToken) : null;
  }

  private async loadCandidate(
    runId: string,
    claimToken: string
  ): Promise<ClaimedVerificationCandidate | null> {
    const run = await this.prisma.verificationRun.findFirst({
      where: { id: runId, claimToken, state: "PREPARING" },
      select: candidateSelection
    });
    if (run === null || run.claimToken === null || run.incident.deployment === null) {
      return null;
    }
    const plan = run.remediationPlan;
    return {
      runId: run.id,
      claimToken: run.claimToken,
      incidentId: run.incident.id,
      incidentVersion: run.incident.version,
      ownerId: run.incident.project.userId,
      projectId: run.incident.projectId,
      healthCheckPath: run.incident.project.healthCheckPath,
      expectedPort: run.incident.project.expectedPort,
      planId: plan.id,
      planValue: {
        schemaVersion: plan.schemaVersion,
        version: plan.version,
        incidentId: plan.incidentId,
        diagnosisId: plan.diagnosisId,
        projectId: plan.projectId,
        deploymentId: plan.deploymentId,
        actionTypes: plan.actionTypes,
        actions: plan.actions,
        baseline: plan.baseline,
        summary: plan.summary,
        rollbackSupported: plan.rollbackSupported,
        rollbackDescription: plan.rollbackDescription,
        planHash: plan.planHash,
        targetSnapshotHash: plan.targetSnapshotHash
      },
      affectedDeployment: mapDeployment(run.incident.deployment),
      projectDeployments: run.incident.project.deployments.map(mapDeployment)
    };
  }
}

function mapDeployment(deployment: Prisma.DeploymentGetPayload<{
  select: typeof deploymentSelection;
}>): PlanningDeployment {
  return deployment;
}

function serializeCheckResults(result: VerificationExecutionResult): Prisma.InputJsonObject {
  const gate = (value: VerificationExecutionResult["checkResults"]["baseline"]): Prisma.InputJsonObject => ({
    status: value.status,
    code: value.code,
    summary: value.summary
  });
  return {
    schemaVersion: result.checkResults.schemaVersion,
    planIntegrity: gate(result.checkResults.planIntegrity),
    baseline: gate(result.checkResults.baseline),
    application: gate(result.checkResults.application),
    build: gate(result.checkResults.build),
    startup: gate(result.checkResults.startup),
    tests: gate(result.checkResults.tests),
    healthCheck: gate(result.checkResults.healthCheck),
    candidateLogs: gate(result.checkResults.candidateLogs)
  };
}

function extractStoredDigest(
  value: unknown,
  field: "planHash" | "targetSnapshotHash"
): string {
  if (typeof value !== "object" || value === null) return "";
  const candidate: unknown = Reflect.get(value, field);
  return typeof candidate === "string" ? candidate : "";
}

function toPlanValue(
  plan: Prisma.RemediationPlanGetPayload<{ select: typeof remediationPlanSelection }>
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: plan.schemaVersion,
    version: plan.version,
    incidentId: plan.incidentId,
    diagnosisId: plan.diagnosisId,
    projectId: plan.projectId,
    deploymentId: plan.deploymentId,
    actionTypes: plan.actionTypes,
    actions: plan.actions,
    baseline: plan.baseline,
    summary: plan.summary,
    rollbackSupported: plan.rollbackSupported,
    rollbackDescription: plan.rollbackDescription,
    planHash: plan.planHash,
    targetSnapshotHash: plan.targetSnapshotHash
  };
}
