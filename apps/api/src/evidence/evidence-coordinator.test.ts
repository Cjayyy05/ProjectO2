import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../logging/logger";
import { EvidenceCoordinator } from "./evidence-coordinator";
import type { EvidenceCollectionTarget, EvidenceRepository } from "./evidence-repository";

const target = {
  incidentId: "incident-1",
  incidentType: "CONTAINER_CRASH",
  incidentVersion: 2,
  projectId: "project-1",
  ownerId: "owner-1",
  deployment: {
    id: "deployment-1",
    isCurrent: true,
    name: "production",
    containerName: "container-1",
    imageReference: "example/app:latest",
    lastContainerState: "STOPPED",
    lastHealthState: "UNHEALTHY",
    lastHttpStatus: null,
    consecutiveFailures: 0,
    lastCheckErrorCode: "CONTAINER_STOPPED",
    lastCheckedAt: new Date(),
    createdAt: new Date()
  },
  expectedPort: 8080
} satisfies EvidenceCollectionTarget;

describe("EvidenceCoordinator", () => {
  afterEach(() => vi.useRealTimers());

  it("isolates collection failure instead of rejecting the scheduler cycle", async () => {
    const repository: EvidenceRepository = {
      claimNextDetected: async () => target,
      findInterruptedCollection: async () => null,
      complete: async () => false
    };
    const coordinator = new EvidenceCoordinator(
      repository,
      { collect: async () => { throw new Error("temporary Docker failure"); } },
      createLogger("test"),
      30_000
    );

    await expect(coordinator.runCycle()).resolves.toBeUndefined();
  });

  it("reconciles collections that have remained interrupted beyond the stale threshold", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-17T00:01:00.000Z"));
    let reconciliationCutoff: Date | undefined;
    let collected = false;
    const repository: EvidenceRepository = {
      claimNextDetected: async () => null,
      findInterruptedCollection: async (before) => {
        reconciliationCutoff = before;
        return target;
      },
      complete: async () => false
    };
    const coordinator = new EvidenceCoordinator(
      repository,
      { collect: async () => { collected = true; return true; } },
      createLogger("test"),
      30_000
    );

    await coordinator.runCycle();

    expect(reconciliationCutoff).toEqual(new Date("2026-09-17T00:00:30.000Z"));
    expect(collected).toBe(true);
  });
});
