import type { Logger } from "pino";
import type { DiagnosisProcessor } from "./diagnosis-service";
import type { DiagnosisRepository } from "./diagnosis-repository";

export interface DiagnosisCycleRunner {
  runCycle(): Promise<void>;
}

export class DiagnosisCoordinator implements DiagnosisCycleRunner {
  public constructor(
    private readonly repository: DiagnosisRepository,
    private readonly processor: DiagnosisProcessor,
    private readonly logger: Logger,
    private readonly staleAfterMs: number
  ) {}

  public async runCycle(): Promise<void> {
    const work =
      (await this.repository.claimNext()) ??
      (await this.repository.reclaimInterrupted(new Date(Date.now() - this.staleAfterMs)));
    if (work === null) return;

    try {
      const completed = await this.processor.process(work);
      if (!completed) {
        this.logger.warn(
          { incidentId: work.incidentId, projectId: work.projectId },
          "Diagnosis processing lost its incident state guard"
        );
      }
    } catch (error) {
      this.logger.error(
        {
          incidentId: work.incidentId,
          projectId: work.projectId,
          errorName: error instanceof Error ? error.name : "UnknownError"
        },
        "Diagnosis processing cycle failed"
      );
    }
  }
}
