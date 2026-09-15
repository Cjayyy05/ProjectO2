import type { PrismaClient } from "@prisma/client";
import type {
  IncidentTransitionRecord,
  IncidentTransitionRepository,
  PersistIncidentTransitionInput
} from "./incident-transition-repository";

export class PrismaIncidentTransitionRepository implements IncidentTransitionRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async transition(
    input: PersistIncidentTransitionInput
  ): Promise<IncidentTransitionRecord | null> {
    return this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.incident.updateMany({
        where: {
          id: input.incidentId,
          state: input.expectedState,
          version: input.expectedVersion,
          project: { userId: input.ownerId }
        },
        data: {
          state: input.targetState,
          version: { increment: 1 },
          ...(input.targetState === "RESOLVED" ? { resolvedAt: new Date() } : {})
        }
      });

      if (updated.count !== 1) {
        return null;
      }

      const incident = await transaction.incident.findUniqueOrThrow({
        where: { id: input.incidentId },
        select: { id: true, projectId: true, state: true, version: true, updatedAt: true }
      });

      await transaction.auditEvent.create({
        data: {
          userId: input.ownerId,
          projectId: incident.projectId,
          incidentId: incident.id,
          action: "INCIDENT_STATE_TRANSITIONED",
          resourceType: "Incident",
          resourceId: incident.id,
          outcome: "SUCCESS",
          ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
          details: {
            from: input.expectedState,
            to: input.targetState,
            reason: input.reason,
            version: incident.version
          }
        }
      });

      return incident;
    });
  }
}
