import type { Logger } from "pino";
import type { MonitoringRepository } from "./monitoring-repository";
import type { TargetMonitor } from "./monitoring-service";

export interface MonitoringCycleRunner {
  runCycle(): Promise<void>;
}

export class MonitoringCoordinator implements MonitoringCycleRunner {
  public constructor(
    private readonly repository: MonitoringRepository,
    private readonly monitor: TargetMonitor,
    private readonly logger: Logger
  ) {}

  public async runCycle(): Promise<void> {
    const targets = await this.repository.claimDueTargets(new Date());
    const results = await Promise.allSettled(targets.map((target) => this.monitor.check(target)));

    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        return;
      }
      const target = targets[index];
      this.logger.error(
        {
          projectId: target?.projectId,
          deploymentId: target?.deploymentId,
          errorName: result.reason instanceof Error ? result.reason.name : "UnknownError"
        },
        "Deployment monitoring failed"
      );
    });
  }
}
