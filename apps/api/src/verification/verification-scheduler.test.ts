import { createLogger } from "../logging/logger";
import { describe, expect, it, vi } from "vitest";
import { VerificationScheduler } from "./verification-scheduler";

describe("VerificationScheduler", () => {
  it("does not overlap cycles and waits for active work during shutdown", async () => {
    let active = 0;
    let maximumActive = 0;
    let release: (() => void) | undefined;
    const runner = {
      runCycle: vi.fn(async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => { release = resolve; });
        active -= 1;
      })
    };
    const scheduler = new VerificationScheduler(runner, 1, createLogger("test"));
    scheduler.start();
    await vi.waitFor(() => expect(runner.runCycle).toHaveBeenCalledTimes(1));
    const stopping = scheduler.stop();
    expect(active).toBe(1);
    release?.();
    await stopping;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(maximumActive).toBe(1);
    expect(runner.runCycle).toHaveBeenCalledTimes(1);
  });

  it("isolates a failed cycle and schedules the next one", async () => {
    const runner = {
      runCycle: vi.fn()
        .mockRejectedValueOnce(new Error("temporary Docker failure"))
        .mockResolvedValue(undefined)
    };
    const scheduler = new VerificationScheduler(runner, 1, createLogger("test"));
    scheduler.start();
    await vi.waitFor(() => expect(runner.runCycle.mock.calls.length).toBeGreaterThanOrEqual(2));
    await scheduler.stop();
  });
});
