import type { Logger } from "pino";
import type { EvidenceCycleRunner } from "./evidence-coordinator";

export class EvidenceScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private activeCycle: Promise<void> | undefined;
  private started = false;
  private stopping = false;

  public constructor(
    private readonly runner: EvidenceCycleRunner,
    private readonly pollIntervalMs: number,
    private readonly logger: Logger
  ) {}

  public start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.schedule(0);
  }

  public async stop(): Promise<void> {
    if (!this.started) return;
    this.stopping = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.activeCycle;
    this.started = false;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.activeCycle = this.runOnce();
    }, delayMs);
  }

  private async runOnce(): Promise<void> {
    try {
      await this.runner.runCycle();
    } catch (error) {
      this.logger.error(
        { errorName: error instanceof Error ? error.name : "UnknownError" },
        "Evidence scheduler cycle failed"
      );
    } finally {
      this.activeCycle = undefined;
      if (!this.stopping) this.schedule(this.pollIntervalMs);
    }
  }
}
