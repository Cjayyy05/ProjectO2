import type { IncidentState } from "@selfheal/shared";

export interface IncidentTransitionRecord {
  readonly id: string;
  readonly projectId: string;
  readonly state: IncidentState;
  readonly version: number;
  readonly updatedAt: Date;
}

export interface PersistIncidentTransitionInput {
  readonly incidentId: string;
  readonly ownerId: string;
  readonly expectedState: IncidentState;
  readonly expectedVersion: number;
  readonly targetState: IncidentState;
  readonly reason: string;
  readonly requestId?: string;
}

export interface IncidentTransitionRepository {
  transition(input: PersistIncidentTransitionInput): Promise<IncidentTransitionRecord | null>;
}

