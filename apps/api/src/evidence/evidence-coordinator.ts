import type { Logger } from "pino";
import type { EvidenceCollectionTarget, EvidenceRepository } from "./evidence-repository";

export interface EvidenceCollector {
  collect(target: EvidenceCollectionTarget): Promise<boolean>;
}

export interface EvidenceCycleRunner {
  runCycle(): Promise<void>;
}

export class EvidenceCoordinator implements EvidenceCycleRunner {
  public constructor(
    private readonly repository: EvidenceRepository,
    private readonly service: EvidenceCollector,
    private readonly logger: Logger,
    private readonly staleAfterMs: number
  ) {}

  public async runCycle(): Promise<void> {
    const target =
      (await this.repository.claimNextDetected()) ??
      (await this.repository.findInterruptedCollection(new Date(Date.now() - this.staleAfterMs)));
    if (target === null) {
      return;
    }
    try {
      const completed = await this.service.collect(target);
      if (!completed) {
        this.logger.warn(
          { incidentId: target.incidentId, projectId: target.projectId },
          "Evidence collection lost its incident state guard"
        );
      }
    } catch (error) {
      this.logger.error(
        {
          incidentId: target.incidentId,
          projectId: target.projectId,
          errorName: error instanceof Error ? error.name : "UnknownError"
        },
        "Evidence collection cycle failed"
      );
    }
  }
}
