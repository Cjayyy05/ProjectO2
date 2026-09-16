import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { createLogger } from "../logging/logger";
import { PrismaMonitoringRepository } from "../monitoring/prisma-monitoring-repository";
import { MonitoringService } from "../monitoring/monitoring-service";
import { createDockerContainerInspector } from "./dockerode-container-inspector";

const dockerTestsEnabled = process.env.RUN_DOCKER_INTEGRATION_TESTS === "true";
const describeDocker = dockerTestsEnabled ? describe : describe.skip;

describeDocker("Dockerode container inspection integration", () => {
  it("normalizes running, stopped, and missing registered containers", async () => {
    const runningContainer = process.env.TEST_DOCKER_RUNNING_CONTAINER;
    const stoppedContainer = process.env.TEST_DOCKER_STOPPED_CONTAINER;
    const runningPort = Number(process.env.TEST_DOCKER_RUNNING_PORT);
    if (
      runningContainer === undefined ||
      stoppedContainer === undefined ||
      !Number.isInteger(runningPort)
    ) {
      throw new Error("Docker integration container names and running host port are required");
    }
    const inspector = createDockerContainerInspector(2_000);

    await expect(inspector.inspect(runningContainer)).resolves.toMatchObject({
      state: "RUNNING",
      publishedHostPorts: expect.arrayContaining([runningPort])
    });
    await expect(inspector.inspect(stoppedContainer)).resolves.toMatchObject({ state: "STOPPED" });
    await expect(inspector.inspect(`missing-${randomUUID()}`)).resolves.toEqual({
      state: "MISSING",
      publishedHostPorts: []
    });
  });

  it("persists one crash incident for repeated checks of a registered stopped container", async () => {
    if (process.env.RUN_DATABASE_INTEGRATION_TESTS !== "true") {
      throw new Error("Database integration must be enabled for the Docker monitoring vertical slice");
    }
    const stoppedContainer = process.env.TEST_DOCKER_STOPPED_CONTAINER;
    if (stoppedContainer === undefined) {
      throw new Error("Stopped Docker integration container name is required");
    }
    const prisma = new PrismaClient();
    let createdIds: { readonly userId: string; readonly projectId: string } | undefined;
    try {
      const unique = randomUUID();
      const user = await prisma.user.create({
        data: { email: `docker-monitor-${unique}@example.com`, passwordHash: "not-used-by-this-test" }
      });
      const project = await prisma.project.create({
        data: {
          userId: user.id,
          name: "Docker vertical slice",
          monitoringEnabled: true,
          healthCheckPath: "/health",
          expectedPort: 8080
        }
      });
      createdIds = { userId: user.id, projectId: project.id };
      const deployment = await prisma.deployment.create({
        data: {
          projectId: project.id,
          name: "production",
          containerName: stoppedContainer,
          imageReference: "postgres:16-alpine"
        }
      });
      const repository = new PrismaMonitoringRepository(prisma, {
        intervalMs: 10_000,
        healthCheckTimeoutMs: 2_000,
        incidentFailureThreshold: 3
      });
      const service = new MonitoringService(
        repository,
        createDockerContainerInspector(2_000),
        { check: async () => { throw new Error("HTTP check must not run for a stopped container"); } },
        createLogger("test")
      );
      const target = {
        projectId: project.id,
        ownerId: user.id,
        deploymentId: deployment.id,
        containerName: stoppedContainer,
        healthCheckPath: "/health",
        expectedPort: 8080,
        monitoringIntervalMs: 10_000,
        healthCheckTimeoutMs: 2_000,
        incidentFailureThreshold: 3
      };

      await service.check(target);
      await service.check(target);

      await expect(
        prisma.incident.findMany({ where: { projectId: project.id } })
      ).resolves.toEqual([
        expect.objectContaining({
          deploymentId: deployment.id,
          type: "CONTAINER_CRASH",
          state: "DETECTED",
          occurrenceCount: 2
        })
      ]);
    } finally {
      if (createdIds !== undefined) {
        await prisma.auditEvent.deleteMany({ where: { projectId: createdIds.projectId } });
        await prisma.incident.deleteMany({ where: { projectId: createdIds.projectId } });
        await prisma.deployment.deleteMany({ where: { projectId: createdIds.projectId } });
        await prisma.project.delete({ where: { id: createdIds.projectId } });
        await prisma.user.delete({ where: { id: createdIds.userId } });
      }
      await prisma.$disconnect();
    }
  });
});
