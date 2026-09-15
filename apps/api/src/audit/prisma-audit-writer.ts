import type { Prisma, PrismaClient } from "@prisma/client";
import type { AuditEventInput, AuditWriter } from "./audit";

export class PrismaAuditWriter implements AuditWriter {
  public constructor(private readonly prisma: PrismaClient) {}

  public async record(event: AuditEventInput): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        action: event.action,
        resourceType: event.resourceType,
        outcome: event.outcome,
        ...(event.userId === undefined ? {} : { userId: event.userId }),
        ...(event.projectId === undefined ? {} : { projectId: event.projectId }),
        ...(event.incidentId === undefined ? {} : { incidentId: event.incidentId }),
        ...(event.resourceId === undefined ? {} : { resourceId: event.resourceId }),
        ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
        ...(event.details === undefined ? {} : { details: event.details as Prisma.InputJsonValue })
      }
    });
  }
}

