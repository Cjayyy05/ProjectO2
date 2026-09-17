import type {
  RemediationPlanningCandidate,
  RemediationPlanningDecision
} from "./remediation-types";

export interface RemediationPlanningRepository {
  findNextCandidate(incidentId?: string): Promise<RemediationPlanningCandidate | null>;
  persistDecision(
    candidate: RemediationPlanningCandidate,
    decision: RemediationPlanningDecision
  ): Promise<boolean>;
}
