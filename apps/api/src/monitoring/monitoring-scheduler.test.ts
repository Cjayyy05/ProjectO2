import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../logging/logger";
import { MonitoringScheduler } from "./monitoring-scheduler";

afterEach(() => {
  vi.useRealTimers();
});

describe("MonitoringScheduler", () => {
  it("does not overlap cycles and stops without leaving a timer", async () => {
    vi.useFakeTimers();
    let cycles = 0;
    let finishCycle: (() => void) | undefined;
    const runner = {
      runCycle: () => {
        cycles += 1;
        return new Promise<void>((resolve) => {
          finishCycle = resolve;
        });
      }
    };
    const scheduler = new MonitoringScheduler(runner, 1_000, createLogger("test"));

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(cycles).toBe(1);

    const stopped = scheduler.stop();
    finishCycle?.();
    await stopped;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(cycles).toBe(1);
  });

  it("continues scheduling after a temporary cycle failure", async () => {
    vi.useFakeTimers();
    let cycles = 0;
    const scheduler = new MonitoringScheduler(
      {
        runCycle: async () => {
          cycles += 1;
          if (cycles === 1) {
            throw new Error("temporary database failure");
          }
        }
      },
      1_000,
      createLogger("test")
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(cycles).toBe(2);
    await scheduler.stop();
  });
});
