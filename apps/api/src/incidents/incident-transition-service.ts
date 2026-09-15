import { assertIncidentTransition, type IncidentState } from "@selfheal/shared";
import { ConflictError } from "../errors/app-error";
import type {
  IncidentTransitionRecord,
  IncidentTransitionRepository
} from "./incident-transition-repository";

export interface TransitionIncidentInput {
  readonly incidentId: string;
  readonly ownerId: string;
  readonly currentState: IncidentState;
  readonly expectedVersion: number;
  readonly targetState: IncidentState;
  readonly reason: string;
  readonly requestId?: string;
}

export class IncidentTransitionService {
  public constructor(private readonly incidents: IncidentTransitionRepository) {}

  public async transition(input: TransitionIncidentInput): Promise<IncidentTransitionRecord> {
    assertIncidentTransition(input.currentState, input.targetState);

    const result = await this.incidents.transition({
      incidentId: input.incidentId,
      ownerId: input.ownerId,
      expectedState: input.currentState,
      expectedVersion: input.expectedVersion,
      targetState: input.targetState,
      reason: input.reason,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId })
    });

    if (result === null) {
      throw new ConflictError(
        "INCIDENT_TRANSITION_CONFLICT",
        "Incident state or version changed before this transition could be applied"
      );
    }

    return result;
  }
}
