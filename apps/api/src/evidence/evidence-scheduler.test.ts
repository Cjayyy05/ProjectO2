import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../logging/logger";
import { EvidenceScheduler } from "./evidence-scheduler";

afterEach(() => vi.useRealTimers());

describe("EvidenceScheduler", () => {
  it("does not overlap collection cycles and cleans up its timer on shutdown", async () => {
    vi.useFakeTimers();
    let cycles = 0;
    let finish: (() => void) | undefined;
    const scheduler = new EvidenceScheduler(
      {
        runCycle: () => {
          cycles += 1;
          return new Promise<void>((resolve) => { finish = resolve; });
        }
      },
      1_000,
      createLogger("test")
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(cycles).toBe(1);

    const stopped = scheduler.stop();
    finish?.();
    await stopped;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(cycles).toBe(1);
  });

  it("continues scheduling after a temporary cycle failure", async () => {
    vi.useFakeTimers();
    let cycles = 0;
    const scheduler = new EvidenceScheduler(
      {
        runCycle: async () => {
          cycles += 1;
          if (cycles === 1) throw new Error("temporary PostgreSQL failure");
        }
      },
      1_000,
      createLogger("test")
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(cycles).toBe(2);

    await scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
