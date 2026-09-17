import { assertIncidentTransition } from "@selfheal/shared";
import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  EvidenceCollectionTarget,
  EvidenceCompletion,
  EvidenceRepository
} from "./evidence-repository";

const targetSelection = {
  id: true,
  type: true,
  version: true,
  projectId: true,
  project: { select: { userId: true, expectedPort: true } },
  deployment: {
    select: {
      id: true,
      isCurrent: true,
      name: true,
      containerName: true,
      imageReference: true,
      lastContainerState: true,
      lastHealthState: true,
      lastHttpStatus: true,
      consecutiveFailures: true,
      lastCheckErrorCode: true,
      lastCheckedAt: true,
      createdAt: true
    }
  }
} satisfies Prisma.IncidentSelect;

export class PrismaEvidenceRepository implements EvidenceRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async findInterruptedCollection(before: Date): Promise<EvidenceCollectionTarget | null> {
    return this.prisma.$transaction(async (transaction) => {
      const resumable = await transaction.incident.findFirst({
        where: {
          state: "COLLECTING_EVIDENCE",
          deploymentId: { not: null },
          updatedAt: { lt: before }
        },
        orderBy: { updatedAt: "asc" },
        select: targetSelection
      });
      if (resumable === null || resumable.deployment === null) {
        return null;
      }

      const reclaimed = await transaction.incident.updateMany({
        where: {
          id: resumable.id,
          state: "COLLECTING_EVIDENCE",
          version: resumable.version,
          updatedAt: { lt: before }
        },
        data: { version: { increment: 1 } }
      });
      if (reclaimed.count !== 1) {
        return null;
      }

      const claimedVersion = resumable.version + 1;
      await transaction.auditEvent.create({
        data: {
          userId: resumable.project.userId,
          projectId: resumable.projectId,
          incidentId: resumable.id,
          action: "EVIDENCE_COLLECTION_RECLAIMED",
          resourceType: "Incident",
          resourceId: resumable.id,
          outcome: "SUCCESS",
          details: {
            reason: "Stale evidence collection lease reclaimed",
            version: claimedVersion
          }
        }
      });
      return mapTarget({ ...resumable, version: claimedVersion });
    });
  }

  public async complete(
    target: EvidenceCollectionTarget,
    completion: EvidenceCompletion
  ): Promise<boolean> {
    assertIncidentTransition("COLLECTING_EVIDENCE", "DIAGNOSING");
    return this.prisma.$transaction(async (transaction) => {
      const current = await transaction.incident.findFirst({
        where: {
          id: target.incidentId,
          projectId: target.projectId,
          deploymentId: target.deployment.id,
          state: "COLLECTING_EVIDENCE",
          version: target.incidentVersion,
          project: { userId: target.ownerId }
        },
        select: { id: true }
      });
      if (current === null) {
        return false;
      }

      const transitioned = await transaction.incident.updateMany({
        where: {
          id: target.incidentId,
          projectId: target.projectId,
          deploymentId: target.deployment.id,
          state: "COLLECTING_EVIDENCE",
          version: target.incidentVersion,
          project: { userId: target.ownerId }
        },
        data: { state: "DIAGNOSING", version: { increment: 1 } }
      });
      if (transitioned.count !== 1) {
        return false;
      }

      await transaction.incidentEvidence.createMany({
        data: completion.items.map((item) => ({
          incidentId: target.incidentId,
          kind: item.kind,
          source: item.source,
          content: item.content,
          metadata: item.metadata as Prisma.InputJsonValue,
          byteCount: item.byteCount,
          lineCount: item.lineCount,
          truncated: item.truncated,
          contentHash: item.contentHash,
          collectedAt: item.collectedAt,
          expiresAt: item.expiresAt
        }))
      });

      await transaction.auditEvent.createMany({
        data: [
          {
            userId: target.ownerId,
            projectId: target.projectId,
            incidentId: target.incidentId,
            action: "EVIDENCE_COLLECTION_COMPLETED",
            resourceType: "Incident",
            resourceId: target.incidentId,
            outcome: "SUCCESS",
            details: {
              itemCount: completion.items.length,
              incomplete: completion.incomplete,
              failedSources: completion.failedSources
            }
          },
          {
            userId: target.ownerId,
            projectId: target.projectId,
            incidentId: target.incidentId,
            action: "INCIDENT_STATE_TRANSITIONED",
            resourceType: "Incident",
            resourceId: target.incidentId,
            outcome: "SUCCESS",
            details: {
              from: "COLLECTING_EVIDENCE",
              to: "DIAGNOSING",
              reason: "Bounded evidence collection completed",
              version: target.incidentVersion + 1
            }
          }
        ]
      });
      return true;
    });
  }

  public async claimNextDetected(): Promise<EvidenceCollectionTarget | null> {
    assertIncidentTransition("DETECTED", "COLLECTING_EVIDENCE");
    return this.prisma.$transaction(async (transaction) => {
      const incident = await transaction.incident.findFirst({
        where: { state: "DETECTED", deploymentId: { not: null } },
        orderBy: { createdAt: "asc" },
        select: targetSelection
      });
      if (incident === null || incident.deployment === null) {
        return null;
      }
      const transitioned = await transaction.incident.updateMany({
        where: { id: incident.id, state: "DETECTED", version: incident.version },
        data: { state: "COLLECTING_EVIDENCE", version: { increment: 1 } }
      });
      if (transitioned.count !== 1) {
        return null;
      }
      const claimedVersion = incident.version + 1;
      await transaction.auditEvent.create({
        data: {
          userId: incident.project.userId,
          projectId: incident.projectId,
          incidentId: incident.id,
          action: "INCIDENT_STATE_TRANSITIONED",
          resourceType: "Incident",
          resourceId: incident.id,
          outcome: "SUCCESS",
          details: {
            from: "DETECTED",
            to: "COLLECTING_EVIDENCE",
            reason: "Evidence collection claimed incident",
            version: claimedVersion
          }
        }
      });
      return mapTarget({ ...incident, version: claimedVersion });
    });
  }
}

function mapTarget(record: Prisma.IncidentGetPayload<{ select: typeof targetSelection }>): EvidenceCollectionTarget {
  if (record.deployment === null) {
    throw new Error("Evidence collection requires an incident-linked deployment");
  }
  return {
    incidentId: record.id,
    incidentType: record.type,
    incidentVersion: record.version,
    projectId: record.projectId,
    ownerId: record.project.userId,
    deployment: record.deployment,
    expectedPort: record.project.expectedPort
  };
}
