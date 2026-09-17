import { assertIncidentTransition } from "@selfheal/shared";
import { Prisma, type PrismaClient } from "@prisma/client";
import { buildDiagnosisInput } from "./diagnosis-input";
import type {
  DiagnosisFailureCode,
  DiagnosisRepository,
  DiagnosisWorkItem
} from "./diagnosis-repository";
import type { DiagnosisResult } from "./diagnosis-types";

const targetSelection = {
  id: true,
  type: true,
  version: true,
  projectId: true,
  diagnosisClaimedAt: true,
  project: { select: { userId: true } },
  evidence: {
    orderBy: [{ collectedAt: "asc" as const }, { id: "asc" as const }],
    take: 33,
    select: {
      id: true,
      kind: true,
      source: true,
      content: true,
      truncated: true,
      collectedAt: true
    }
  }
} satisfies Prisma.IncidentSelect;

export class PrismaDiagnosisRepository implements DiagnosisRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async claimNext(): Promise<DiagnosisWorkItem | null> {
    return this.prisma.$transaction(async (transaction) => {
      const incident = await transaction.incident.findFirst({
        where: {
          state: "DIAGNOSING",
          diagnosisClaimedAt: null,
          diagnosis: null
        },
        orderBy: { updatedAt: "asc" },
        select: targetSelection
      });
      if (incident === null) return null;

      const claimedAt = new Date();
      const claimed = await transaction.incident.updateMany({
        where: {
          id: incident.id,
          state: "DIAGNOSING",
          version: incident.version,
          diagnosisClaimedAt: null,
          diagnosis: null
        },
        data: { diagnosisClaimedAt: claimedAt, version: { increment: 1 } }
      });
      if (claimed.count !== 1) return null;

      const claimedVersion = incident.version + 1;
      await transaction.auditEvent.create({
        data: claimAudit(incident, claimedVersion, false)
      });
      return mapWork({ ...incident, version: claimedVersion, diagnosisClaimedAt: claimedAt });
    });
  }

  public async reclaimInterrupted(before: Date): Promise<DiagnosisWorkItem | null> {
    return this.prisma.$transaction(async (transaction) => {
      const incident = await transaction.incident.findFirst({
        where: {
          state: "DIAGNOSING",
          diagnosisClaimedAt: { lt: before },
          diagnosis: null
        },
        orderBy: { diagnosisClaimedAt: "asc" },
        select: targetSelection
      });
      if (incident === null || incident.diagnosisClaimedAt === null) return null;

      const claimedAt = new Date();
      const reclaimed = await transaction.incident.updateMany({
        where: {
          id: incident.id,
          state: "DIAGNOSING",
          version: incident.version,
          diagnosisClaimedAt: { lt: before },
          diagnosis: null
        },
        data: { diagnosisClaimedAt: claimedAt, version: { increment: 1 } }
      });
      if (reclaimed.count !== 1) return null;

      const claimedVersion = incident.version + 1;
      await transaction.auditEvent.create({
        data: claimAudit(incident, claimedVersion, true)
      });
      return mapWork({ ...incident, version: claimedVersion, diagnosisClaimedAt: claimedAt });
    });
  }

  public async complete(
    work: DiagnosisWorkItem,
    identity: { readonly provider: string; readonly model: string },
    result: DiagnosisResult
  ): Promise<boolean> {
    const allowedReferences = new Set(work.input.evidence.map((item) => item.id));
    if (result.supportingEvidenceReferences.some((id) => !allowedReferences.has(id))) {
      return this.fail(work, "INVALID_EVIDENCE_REFERENCE");
    }

    assertIncidentTransition("DIAGNOSING", "FIX_PROPOSED");
    return this.prisma.$transaction(async (transaction) => {
      const transitioned = await transaction.incident.updateMany({
        where: workGuard(work),
        data: {
          state: "FIX_PROPOSED",
          version: { increment: 1 },
          diagnosisClaimedAt: null
        }
      });
      if (transitioned.count !== 1) return false;

      const diagnosis = await transaction.diagnosis.create({
        data: {
          incidentId: work.incidentId,
          provider: identity.provider,
          providerVersion: identity.model,
          rootCauseCode: result.rootCauseCode,
          summary: result.summary,
          confidence: result.confidence,
          evidenceReferences: result.supportingEvidenceReferences,
          result: result as Prisma.InputJsonValue
        }
      });
      await transaction.auditEvent.createMany({
        data: [
          {
            userId: work.ownerId,
            projectId: work.projectId,
            incidentId: work.incidentId,
            action: "DIAGNOSIS_COMPLETED",
            resourceType: "Diagnosis",
            resourceId: diagnosis.id,
            outcome: "SUCCESS",
            details: {
              provider: identity.provider,
              model: identity.model,
              rootCauseCode: result.rootCauseCode,
              confidence: result.confidence,
              evidenceReferenceCount: result.supportingEvidenceReferences.length
            }
          },
          {
            userId: work.ownerId,
            projectId: work.projectId,
            incidentId: work.incidentId,
            action: "INCIDENT_STATE_TRANSITIONED",
            resourceType: "Incident",
            resourceId: work.incidentId,
            outcome: "SUCCESS",
            details: {
              from: "DIAGNOSING",
              to: "FIX_PROPOSED",
              reason: "Validated diagnosis persisted",
              version: work.incidentVersion + 1
            }
          }
        ]
      });
      return true;
    });
  }

  public async fail(work: DiagnosisWorkItem, code: DiagnosisFailureCode): Promise<boolean> {
    assertIncidentTransition("DIAGNOSING", "DIAGNOSIS_FAILED");
    return this.prisma.$transaction(async (transaction) => {
      const transitioned = await transaction.incident.updateMany({
        where: workGuard(work),
        data: {
          state: "DIAGNOSIS_FAILED",
          version: { increment: 1 },
          diagnosisClaimedAt: null
        }
      });
      if (transitioned.count !== 1) return false;

      await transaction.auditEvent.createMany({
        data: [
          {
            userId: work.ownerId,
            projectId: work.projectId,
            incidentId: work.incidentId,
            action: "DIAGNOSIS_FAILED",
            resourceType: "Incident",
            resourceId: work.incidentId,
            outcome: "FAILURE",
            details: { code }
          },
          {
            userId: work.ownerId,
            projectId: work.projectId,
            incidentId: work.incidentId,
            action: "INCIDENT_STATE_TRANSITIONED",
            resourceType: "Incident",
            resourceId: work.incidentId,
            outcome: "SUCCESS",
            details: {
              from: "DIAGNOSING",
              to: "DIAGNOSIS_FAILED",
              reason: code,
              version: work.incidentVersion + 1
            }
          }
        ]
      });
      return true;
    });
  }
}

function workGuard(work: DiagnosisWorkItem): Prisma.IncidentWhereInput {
  return {
    id: work.incidentId,
    projectId: work.projectId,
    state: "DIAGNOSING",
    version: work.incidentVersion,
    diagnosisClaimedAt: work.claimedAt,
    diagnosis: null,
    project: { userId: work.ownerId }
  };
}

function mapWork(
  incident: Prisma.IncidentGetPayload<{ select: typeof targetSelection }>
): DiagnosisWorkItem {
  if (incident.diagnosisClaimedAt === null) {
    throw new Error("A diagnosis work item requires a persisted claim timestamp");
  }
  return {
    incidentId: incident.id,
    incidentVersion: incident.version,
    projectId: incident.projectId,
    ownerId: incident.project.userId,
    claimedAt: incident.diagnosisClaimedAt,
    input: buildDiagnosisInput(incident.id, incident.type, incident.evidence)
  };
}

function claimAudit(
  incident: Prisma.IncidentGetPayload<{ select: typeof targetSelection }>,
  version: number,
  reclaimed: boolean
): Prisma.AuditEventCreateManyInput {
  return {
    userId: incident.project.userId,
    projectId: incident.projectId,
    incidentId: incident.id,
    action: reclaimed ? "DIAGNOSIS_RECLAIMED" : "DIAGNOSIS_CLAIMED",
    resourceType: "Incident",
    resourceId: incident.id,
    outcome: "SUCCESS",
    details: { version }
  };
}
