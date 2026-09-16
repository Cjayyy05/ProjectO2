import { Prisma, type IncidentType, type PrismaClient } from "@prisma/client";
import type { ContainerRuntimeState } from "../docker/docker-service";
import type {
  MonitoringDefaults,
  MonitoringObservation,
  MonitoringRecordResult,
  MonitoringRepository,
  MonitoringTarget
} from "./monitoring-repository";

const MAX_TRANSACTION_ATTEMPTS = 3;

export class PrismaMonitoringRepository implements MonitoringRepository {
  public constructor(
    private readonly prisma: PrismaClient,
    private readonly defaults: MonitoringDefaults
  ) {}

  public async claimDueTargets(now: Date): Promise<readonly MonitoringTarget[]> {
    const projects = await this.prisma.project.findMany({
      where: {
        monitoringEnabled: true,
        healthCheckPath: { not: null },
        expectedPort: { not: null },
        OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: now } }]
      },
      select: {
        id: true,
        userId: true,
        healthCheckPath: true,
        expectedPort: true,
        monitoringIntervalMs: true,
        healthCheckTimeoutMs: true,
        incidentFailureThreshold: true,
        deployments: {
          where: { isCurrent: true },
          select: { id: true, containerName: true }
        }
      }
    });
    const targets: MonitoringTarget[] = [];

    for (const project of projects) {
      const intervalMs = project.monitoringIntervalMs ?? this.defaults.intervalMs;
      const claimed = await this.prisma.project.updateMany({
        where: {
          id: project.id,
          monitoringEnabled: true,
          OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: now } }]
        },
        data: { nextCheckAt: new Date(now.getTime() + intervalMs) }
      });
      if (claimed.count !== 1 || project.healthCheckPath === null || project.expectedPort === null) {
        continue;
      }

      for (const deployment of project.deployments) {
        targets.push({
          projectId: project.id,
          ownerId: project.userId,
          deploymentId: deployment.id,
          containerName: deployment.containerName,
          healthCheckPath: project.healthCheckPath,
          expectedPort: project.expectedPort,
          monitoringIntervalMs: intervalMs,
          healthCheckTimeoutMs:
            project.healthCheckTimeoutMs ?? this.defaults.healthCheckTimeoutMs,
          incidentFailureThreshold:
            project.incidentFailureThreshold ?? this.defaults.incidentFailureThreshold
        });
      }
    }

    return targets;
  }

  public async recordObservation(
    target: MonitoringTarget,
    observation: MonitoringObservation
  ): Promise<MonitoringRecordResult> {
    return this.withRetry(() =>
      this.prisma.$transaction((transaction) =>
        recordObservationTransaction(transaction, target, observation)
      )
    );
  }

  public async recordMonitoringError(
    target: MonitoringTarget,
    errorCode: string,
    observedAt: Date,
    containerState?: ContainerRuntimeState
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.deployment.updateMany({
        where: {
          id: target.deploymentId,
          projectId: target.projectId,
          isCurrent: true,
          project: { userId: target.ownerId, monitoringEnabled: true }
        },
        data: {
          lastContainerState: containerState ?? "UNKNOWN",
          lastHealthState: "UNKNOWN",
          lastHttpStatus: null,
          lastCheckErrorCode: errorCode,
          lastCheckedAt: observedAt
        }
      });
      if (updated.count !== 1) {
        return;
      }
      await transaction.project.updateMany({
        where: { id: target.projectId, monitoringEnabled: true },
        data: { lastCheckedAt: observedAt }
      });
    });
  }

  private async withRetry<T>(operation: () => Promise<T>, attempt = 1): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (attempt < MAX_TRANSACTION_ATTEMPTS && isRetryableConflict(error)) {
        return this.withRetry(operation, attempt + 1);
      }
      throw error;
    }
  }
}

async function recordObservationTransaction(
  transaction: Prisma.TransactionClient,
  target: MonitoringTarget,
  observation: MonitoringObservation
): Promise<MonitoringRecordResult> {
  const deployment = await transaction.deployment.findFirst({
    where: {
      id: target.deploymentId,
      projectId: target.projectId,
      isCurrent: true,
      project: { userId: target.ownerId, monitoringEnabled: true }
    },
    select: { id: true, consecutiveFailures: true }
  });
  if (deployment === null) {
    return { consecutiveFailures: 0, incidentCreated: false };
  }
  const crash = observation.containerState === "STOPPED" || observation.containerState === "MISSING";
  const containerUnavailable = observation.containerState !== "RUNNING";
  const healthFailed = observation.healthCheck !== undefined && !observation.healthCheck.healthy;
  const consecutiveFailures = containerUnavailable
    ? deployment.consecutiveFailures
    : healthFailed
      ? deployment.consecutiveFailures + 1
      : 0;

  const updated = await transaction.deployment.updateMany({
    where: {
      id: deployment.id,
      projectId: target.projectId,
      isCurrent: true,
      project: { userId: target.ownerId, monitoringEnabled: true }
    },
    data: {
      lastContainerState: observation.containerState,
      lastHealthState: containerUnavailable || healthFailed ? "UNHEALTHY" : "HEALTHY",
      lastHttpStatus: observation.healthCheck?.statusCode ?? null,
      consecutiveFailures,
      lastCheckErrorCode:
        crash
          ? observation.containerState === "MISSING"
            ? "CONTAINER_MISSING"
            : "CONTAINER_STOPPED"
          : observation.healthCheck?.errorCode ?? null,
      lastCheckedAt: observation.observedAt
    }
  });
  if (updated.count !== 1) {
    return { consecutiveFailures: 0, incidentCreated: false };
  }
  await transaction.project.updateMany({
    where: { id: target.projectId, monitoringEnabled: true },
    data: { lastCheckedAt: observation.observedAt }
  });

  if (crash) {
    return detectIncident(
      transaction,
      target,
      "CONTAINER_CRASH",
      `Container ${observation.containerState.toLowerCase()}`,
      observation.observedAt,
      consecutiveFailures
    );
  }
  if (healthFailed && consecutiveFailures >= target.incidentFailureThreshold) {
    return detectIncident(
      transaction,
      target,
      "HEALTH_CHECK_FAILURE",
      monitoringReason(observation),
      observation.observedAt,
      consecutiveFailures
    );
  }
  return { consecutiveFailures, incidentCreated: false };
}

async function detectIncident(
  transaction: Prisma.TransactionClient,
  target: MonitoringTarget,
  type: IncidentType,
  reason: string,
  detectedAt: Date,
  consecutiveFailures: number
): Promise<MonitoringRecordResult> {
  const fingerprint = `${target.deploymentId}:${type}`;
  const existing = await transaction.incident.findFirst({
    where: { projectId: target.projectId, type, fingerprint, state: { not: "RESOLVED" } },
    select: { id: true }
  });
  if (existing !== null) {
    const updated = await transaction.incident.updateMany({
      where: { id: existing.id, state: { not: "RESOLVED" } },
      data: {
        occurrenceCount: { increment: 1 },
        lastDetectedAt: detectedAt,
        detectionReason: reason
      }
    });
    if (updated.count === 1) {
      return { consecutiveFailures, incidentId: existing.id, incidentCreated: false };
    }
  }

  const incident = await transaction.incident.create({
    data: {
      projectId: target.projectId,
      deploymentId: target.deploymentId,
      type,
      fingerprint,
      detectionSource: "MONITORING",
      detectionReason: reason,
      firstDetectedAt: detectedAt,
      lastDetectedAt: detectedAt
    }
  });
  await transaction.auditEvent.create({
    data: {
      userId: target.ownerId,
      projectId: target.projectId,
      incidentId: incident.id,
      action: "INCIDENT_DETECTED",
      resourceType: "Incident",
      resourceId: incident.id,
      outcome: "SUCCESS",
      details: { type, deploymentId: target.deploymentId, source: "MONITORING" }
    }
  });
  return { consecutiveFailures, incidentId: incident.id, incidentCreated: true };
}

function monitoringReason(observation: MonitoringObservation): string {
  if (observation.healthCheck?.statusCode !== undefined) {
    return `Health check returned HTTP ${observation.healthCheck.statusCode}`;
  }
  return `Health check failed: ${observation.healthCheck?.errorCode ?? "NETWORK_ERROR"}`;
}

function isRetryableConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2002" || error.code === "P2034")
  );
}
