import { describe, expect, it } from "vitest";
import { DockerInspectionError, type ContainerInspector } from "../docker/docker-service";
import { createLogger } from "../logging/logger";
import type { HealthChecker } from "./http-health-checker";
import type {
  MonitoringObservation,
  MonitoringRecordResult,
  MonitoringRepository,
  MonitoringTarget
} from "./monitoring-repository";
import { MonitoringService } from "./monitoring-service";

const target: MonitoringTarget = {
  projectId: "project-1",
  ownerId: "owner-1",
  deploymentId: "deployment-1",
  containerName: "registered-container",
  healthCheckPath: "/health",
  expectedPort: 8080,
  monitoringIntervalMs: 10_000,
  healthCheckTimeoutMs: 2_000,
  incidentFailureThreshold: 3
};

class RecordingRepository implements MonitoringRepository {
  public readonly observations: MonitoringObservation[] = [];
  public readonly errors: { code: string; containerState: string | undefined }[] = [];
  public result: MonitoringRecordResult = { consecutiveFailures: 0, incidentCreated: false };

  public async claimDueTargets(): Promise<readonly MonitoringTarget[]> {
    return [];
  }

  public async recordObservation(
    _target: MonitoringTarget,
    observation: MonitoringObservation
  ): Promise<MonitoringRecordResult> {
    this.observations.push(observation);
    return this.result;
  }

  public async recordMonitoringError(
    _target: MonitoringTarget,
    errorCode: string,
    _observedAt: Date,
    containerState?: "RUNNING" | "STOPPED" | "MISSING" | "PAUSED" | "RESTARTING"
  ): Promise<void> {
    this.errors.push({ code: errorCode, containerState });
  }
}

describe("MonitoringService", () => {
  it("persists a healthy check for a running container", async () => {
    const repository = new RecordingRepository();
    const healthChecker: HealthChecker = {
      check: async () => ({ healthy: true, statusCode: 200, checkedAt: new Date(), durationMs: 4 })
    };
    const service = new MonitoringService(
      repository,
      inspectorReturning("RUNNING"),
      healthChecker,
      createLogger("test")
    );

    await service.check(target);

    expect(repository.observations).toHaveLength(1);
    expect(repository.observations[0]).toMatchObject({
      containerState: "RUNNING",
      healthCheck: { healthy: true, statusCode: 200 }
    });
  });

  it("records a stopped container without attempting an HTTP check", async () => {
    const repository = new RecordingRepository();
    let healthChecks = 0;
    const healthChecker: HealthChecker = {
      check: async () => {
        healthChecks += 1;
        return { healthy: true, statusCode: 200, checkedAt: new Date(), durationMs: 1 };
      }
    };
    const service = new MonitoringService(
      repository,
      inspectorReturning("STOPPED"),
      healthChecker,
      createLogger("test")
    );

    await service.check(target);

    expect(healthChecks).toBe(0);
    expect(repository.observations[0]).toMatchObject({ containerState: "STOPPED" });
  });

  it("records a bounded Docker error without throwing out of the target check", async () => {
    const repository = new RecordingRepository();
    const containers: ContainerInspector = {
      inspect: async () => {
        throw new DockerInspectionError("DOCKER_TIMEOUT");
      }
    };
    const healthChecker: HealthChecker = {
      check: async () => {
        throw new Error("health checker must not run");
      }
    };
    const service = new MonitoringService(
      repository,
      containers,
      healthChecker,
      createLogger("test")
    );

    await expect(service.check(target)).resolves.toBeUndefined();
    expect(repository.errors).toEqual([{ code: "DOCKER_TIMEOUT", containerState: undefined }]);
  });

  it("does not probe a port that the registered container has not published", async () => {
    const repository = new RecordingRepository();
    let healthChecks = 0;
    const healthChecker: HealthChecker = {
      check: async () => {
        healthChecks += 1;
        throw new Error("health checker must not run");
      }
    };
    const service = new MonitoringService(
      repository,
      inspectorReturning("RUNNING", [9090]),
      healthChecker,
      createLogger("test")
    );

    await service.check(target);

    expect(healthChecks).toBe(0);
    expect(repository.observations).toHaveLength(0);
    expect(repository.errors).toEqual([
      { code: "PORT_NOT_PUBLISHED", containerState: "RUNNING" }
    ]);
  });
});

function inspectorReturning(
  state: "RUNNING" | "STOPPED",
  publishedHostPorts: readonly number[] = [8080]
): ContainerInspector {
  return { inspect: async () => ({ state, publishedHostPorts }) };
}
