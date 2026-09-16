import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import type { HealthCheckResult } from "./http-health-checker";
import type { MonitoringTarget } from "./monitoring-repository";
import { PrismaMonitoringRepository } from "./prisma-monitoring-repository";

const databaseTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeDatabase = databaseTestsEnabled ? describe : describe.skip;
const defaults = {
  intervalMs: 10_000,
  healthCheckTimeoutMs: 2_000,
  incidentFailureThreshold: 3
};

describeDatabase("Prisma monitoring integration", () => {
  it("enforces at most one current deployment per project in PostgreSQL", async () => {
    const prisma = new PrismaClient();
    try {
      const target = await createTarget(prisma, 3);

      await expect(
        prisma.deployment.create({
          data: {
            projectId: target.projectId,
            isCurrent: true,
            name: "second-current",
            containerName: `second-current-${randomUUID()}`,
            imageReference: "example/app:conflict"
          }
        })
      ).rejects.toMatchObject({ code: "P2002" });
      await expect(
        prisma.deployment.count({ where: { projectId: target.projectId, isCurrent: true } })
      ).resolves.toBe(1);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("increments failures, resets after success, and creates one threshold incident", async () => {
    const prisma = new PrismaClient();
    try {
      const target = await createTarget(prisma, 3);
      const repository = new PrismaMonitoringRepository(prisma, defaults);

      await expect(recordHealth(repository, target, failedHealth())).resolves.toMatchObject({
        consecutiveFailures: 1,
        incidentCreated: false
      });
      await expect(recordHealth(repository, target, healthyHealth())).resolves.toMatchObject({
        consecutiveFailures: 0,
        incidentCreated: false
      });
      await recordHealth(repository, target, failedHealth());
      await recordHealth(repository, target, failedHealth());
      const threshold = await recordHealth(repository, target, failedHealth());
      const continued = await recordHealth(repository, target, failedHealth());

      expect(threshold).toMatchObject({ consecutiveFailures: 3, incidentCreated: true });
      expect(continued).toMatchObject({ consecutiveFailures: 4, incidentCreated: false });
      expect(continued.incidentId).toBe(threshold.incidentId);
      await expect(
        prisma.incident.findMany({
          where: { projectId: target.projectId, type: "HEALTH_CHECK_FAILURE" }
        })
      ).resolves.toEqual([
        expect.objectContaining({
          id: threshold.incidentId,
          deploymentId: target.deploymentId,
          state: "DETECTED",
          occurrenceCount: 2,
          detectionSource: "MONITORING"
        })
      ]);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("creates exactly one incident for repeated stopped-container checks", async () => {
    const prisma = new PrismaClient();
    try {
      const target = await createTarget(prisma, 3);
      const repository = new PrismaMonitoringRepository(prisma, defaults);

      const first = await repository.recordObservation(target, {
        containerState: "STOPPED",
        observedAt: new Date()
      });
      const second = await repository.recordObservation(target, {
        containerState: "STOPPED",
        observedAt: new Date()
      });

      expect(first.incidentCreated).toBe(true);
      expect(second).toMatchObject({ incidentId: first.incidentId, incidentCreated: false });
      await expect(
        prisma.incident.count({ where: { projectId: target.projectId, type: "CONTAINER_CRASH" } })
      ).resolves.toBe(1);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("does not monitor or write incidents for an inactive historical deployment", async () => {
    const prisma = new PrismaClient();
    try {
      const target = await createTarget(prisma, 1);
      const repository = new PrismaMonitoringRepository(prisma, defaults);
      const historical = await prisma.deployment.create({
        data: {
          projectId: target.projectId,
          isCurrent: false,
          name: "historical",
          containerName: `historical-${randomUUID()}`,
          imageReference: "example/app:previous"
        }
      });
      const historicalTarget = { ...target, deploymentId: historical.id, containerName: historical.containerName };

      await prisma.project.updateMany({
        where: { id: { not: target.projectId }, monitoringEnabled: true },
        data: { nextCheckAt: new Date(Date.now() + 60_000) }
      });

      const claims = await repository.claimDueTargets(new Date());
      const result = await repository.recordObservation(historicalTarget, {
        containerState: "STOPPED",
        observedAt: new Date()
      });

      expect(claims.map((claim) => claim.deploymentId)).toEqual([target.deploymentId]);
      expect(result).toEqual({ consecutiveFailures: 0, incidentCreated: false });
      await expect(
        prisma.incident.count({ where: { deploymentId: historical.id } })
      ).resolves.toBe(0);
      await expect(
        prisma.deployment.findUniqueOrThrow({ where: { id: historical.id } })
      ).resolves.toMatchObject({ lastContainerState: "UNKNOWN", lastCheckedAt: null });
    } finally {
      await prisma.$disconnect();
    }
  });

  it("creates a new incident after the prior fingerprint is resolved without mutating it", async () => {
    const prisma = new PrismaClient();
    try {
      const target = await createTarget(prisma, 1);
      const repository = new PrismaMonitoringRepository(prisma, defaults);
      const first = await recordHealth(repository, target, failedHealth());
      if (first.incidentId === undefined) {
        throw new Error("Expected the first failure to create an incident");
      }
      await prisma.incident.update({
        where: { id: first.incidentId },
        data: { state: "RESOLVED", resolvedAt: new Date() }
      });
      const resolvedBefore = await prisma.incident.findUniqueOrThrow({
        where: { id: first.incidentId }
      });

      const later = await recordHealth(repository, target, failedHealth());

      expect(later).toMatchObject({ incidentCreated: true });
      expect(later.incidentId).not.toBe(first.incidentId);
      await expect(
        prisma.incident.findUniqueOrThrow({ where: { id: first.incidentId } })
      ).resolves.toMatchObject({
        state: "RESOLVED",
        occurrenceCount: resolvedBefore.occurrenceCount,
        lastDetectedAt: resolvedBefore.lastDetectedAt
      });
      await expect(
        prisma.incident.count({
          where: { projectId: target.projectId, type: "HEALTH_CHECK_FAILURE" }
        })
      ).resolves.toBe(2);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("deduplicates concurrent incident creation using the database constraint", async () => {
    const prisma = new PrismaClient();
    try {
      const target = await createTarget(prisma, 1);
      const repository = new PrismaMonitoringRepository(prisma, {
        ...defaults,
        incidentFailureThreshold: 1
      });

      const results = await Promise.all([
        recordHealth(repository, target, failedHealth()),
        recordHealth(repository, target, failedHealth())
      ]);

      expect(results.filter((result) => result.incidentCreated)).toHaveLength(1);
      expect(new Set(results.map((result) => result.incidentId)).size).toBe(1);
      await expect(
        prisma.incident.count({
          where: { projectId: target.projectId, type: "HEALTH_CHECK_FAILURE" }
        })
      ).resolves.toBe(1);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("atomically claims a due project once across overlapping cycle queries", async () => {
    const prisma = new PrismaClient();
    try {
      const target = await createTarget(prisma, 3);
      const repository = new PrismaMonitoringRepository(prisma, defaults);
      await prisma.project.update({
        where: { id: target.projectId },
        data: { nextCheckAt: new Date(0) }
      });
      const now = new Date();
      await prisma.project.updateMany({
        where: { id: { not: target.projectId }, monitoringEnabled: true },
        data: { nextCheckAt: new Date(now.getTime() + 60_000) }
      });

      const claims = await Promise.all([
        repository.claimDueTargets(now),
        repository.claimDueTargets(now)
      ]);

      expect(claims.flat()).toHaveLength(1);
      expect(claims.flat()[0]?.deploymentId).toBe(target.deploymentId);
    } finally {
      await prisma.$disconnect();
    }
  });
});

async function createTarget(prisma: PrismaClient, threshold: number): Promise<MonitoringTarget> {
  const unique = randomUUID();
  const user = await prisma.user.create({
    data: { email: `monitor-${unique}@example.com`, passwordHash: "not-used-by-this-test" }
  });
  const project = await prisma.project.create({
    data: {
      userId: user.id,
      name: `Monitor ${unique}`,
      monitoringEnabled: true,
      healthCheckPath: "/health",
      expectedPort: 8080,
      monitoringIntervalMs: 10_000,
      healthCheckTimeoutMs: 2_000,
      incidentFailureThreshold: threshold,
      nextCheckAt: new Date(0)
    }
  });
  const deployment = await prisma.deployment.create({
    data: {
      projectId: project.id,
      isCurrent: true,
      name: "production",
      containerName: `monitor-${unique}`,
      imageReference: "example/app:latest"
    }
  });
  return {
    projectId: project.id,
    ownerId: user.id,
    deploymentId: deployment.id,
    containerName: deployment.containerName,
    healthCheckPath: "/health",
    expectedPort: 8080,
    monitoringIntervalMs: 10_000,
    healthCheckTimeoutMs: 2_000,
    incidentFailureThreshold: threshold
  };
}

function healthyHealth(): HealthCheckResult {
  return { healthy: true, statusCode: 200, checkedAt: new Date(), durationMs: 1 };
}

function failedHealth(): HealthCheckResult {
  return { healthy: false, errorCode: "CONNECTION_REFUSED", checkedAt: new Date(), durationMs: 1 };
}

function recordHealth(
  repository: PrismaMonitoringRepository,
  target: MonitoringTarget,
  healthCheck: HealthCheckResult
) {
  return repository.recordObservation(target, {
    containerState: "RUNNING",
    healthCheck,
    observedAt: new Date()
  });
}
