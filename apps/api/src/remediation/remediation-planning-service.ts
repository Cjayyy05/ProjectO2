import type { RemediationPlanningRepository } from "./remediation-planning-repository";
import type {
  RemediationPlanningCandidate,
  RemediationPlanningDecision
} from "./remediation-types";

export interface RemediationPlanningCycleRunner {
  runCycle(): Promise<void>;
}

export interface RemediationPlanningBuilder {
  build(candidate: RemediationPlanningCandidate): RemediationPlanningDecision;
}

export class RemediationPlanningService implements RemediationPlanningCycleRunner {
  public constructor(
    private readonly repository: RemediationPlanningRepository,
    private readonly builder: RemediationPlanningBuilder
  ) {}

  public async runCycle(): Promise<void> {
    const candidate = await this.repository.findNextCandidate();
    if (candidate === null) return;
    const decision = this.builder.build(candidate);
    await this.repository.persistDecision(candidate, decision);
  }
}
