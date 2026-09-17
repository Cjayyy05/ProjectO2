import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../logging/logger";
import { DiagnosisCoordinator } from "./diagnosis-coordinator";
import type { DiagnosisRepository, DiagnosisWorkItem } from "./diagnosis-repository";

const work = {
  incidentId: "00000000-0000-4000-8000-000000000001",
  incidentVersion: 4,
  projectId: "00000000-0000-4000-8000-000000000002",
  ownerId: "00000000-0000-4000-8000-000000000003",
  claimedAt: new Date(),
  input: {
    incidentId: "00000000-0000-4000-8000-000000000001",
    incidentType: "CONTAINER_CRASH",
    evidence: [],
    evidenceIncomplete: true,
    inputTruncated: false
  }
} satisfies DiagnosisWorkItem;

afterEach(() => vi.useRealTimers());

describe("DiagnosisCoordinator", () => {
  it("isolates one Incident failure", async () => {
    const repository = repositoryReturning(work);
    const coordinator = new DiagnosisCoordinator(
      repository,
      { process: async () => { throw new Error("temporary failure"); } },
      createLogger("test"),
      30_000
    );

    await expect(coordinator.runCycle()).resolves.toBeUndefined();
  });

  it("uses the configured stale cutoff for interrupted diagnosis", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T00:01:00.000Z"));
    let cutoff: Date | undefined;
    let processed = false;
    const repository: DiagnosisRepository = {
      claimNext: async () => null,
      reclaimInterrupted: async (before) => {
        cutoff = before;
        return work;
      },
      complete: async () => false,
      fail: async () => false
    };
    const coordinator = new DiagnosisCoordinator(
      repository,
      { process: async () => { processed = true; return true; } },
      createLogger("test"),
      30_000
    );

    await coordinator.runCycle();

    expect(cutoff).toEqual(new Date("2026-09-18T00:00:30.000Z"));
    expect(processed).toBe(true);
  });
});

function repositoryReturning(item: DiagnosisWorkItem): DiagnosisRepository {
  return {
    claimNext: async () => item,
    reclaimInterrupted: async () => null,
    complete: async () => false,
    fail: async () => false
  };
}
