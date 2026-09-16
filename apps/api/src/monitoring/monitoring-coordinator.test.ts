import { describe, expect, it } from "vitest";
import { createLogger } from "../logging/logger";
import { MonitoringCoordinator } from "./monitoring-coordinator";
import type { MonitoringRepository, MonitoringTarget } from "./monitoring-repository";

const target = (id: string): MonitoringTarget => ({
  projectId: `project-${id}`,
  ownerId: `owner-${id}`,
  deploymentId: `deployment-${id}`,
  containerName: `container-${id}`,
  healthCheckPath: "/health",
  expectedPort: 8080,
  monitoringIntervalMs: 10_000,
  healthCheckTimeoutMs: 2_000,
  incidentFailureThreshold: 3
});

describe("MonitoringCoordinator", () => {
  it("isolates one deployment failure and continues checking other deployments", async () => {
    const checked: string[] = [];
    const repository: MonitoringRepository = {
      claimDueTargets: async () => [target("broken"), target("healthy")],
      recordObservation: async () => {
        throw new Error("not used");
      },
      recordMonitoringError: async () => {
        throw new Error("not used");
      }
    };
    const monitor = {
      async check(item: MonitoringTarget) {
        checked.push(item.deploymentId);
        if (item.deploymentId === "deployment-broken") {
          throw new Error("database unavailable for this target");
        }
      }
    };
    const coordinator = new MonitoringCoordinator(
      repository,
      monitor,
      createLogger("test")
    );

    await expect(coordinator.runCycle()).resolves.toBeUndefined();
    expect(checked).toEqual(["deployment-broken", "deployment-healthy"]);
  });
});
