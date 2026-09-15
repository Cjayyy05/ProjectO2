export const INCIDENT_TYPES = [
  "CONTAINER_CRASH",
  "HEALTH_CHECK_FAILURE",
  "DATABASE_CONNECTION_FAILURE",
  "MISSING_OR_INVALID_ENV",
  "PORT_CONFIGURATION_FAILURE"
] as const;

export type IncidentType = (typeof INCIDENT_TYPES)[number];

export const INCIDENT_STATES = [
  "DETECTED",
  "COLLECTING_EVIDENCE",
  "DIAGNOSING",
  "FIX_PROPOSED",
  "VERIFYING",
  "AWAITING_APPROVAL",
  "RECOVERING",
  "RESOLVED",
  "DIAGNOSIS_FAILED",
  "VERIFICATION_FAILED",
  "RECOVERY_FAILED"
] as const;

export type IncidentState = (typeof INCIDENT_STATES)[number];

export const TERMINAL_INCIDENT_STATES = ["RESOLVED"] as const satisfies readonly IncidentState[];

const ALLOWED_INCIDENT_TRANSITIONS: Readonly<Record<IncidentState, readonly IncidentState[]>> = {
  DETECTED: ["COLLECTING_EVIDENCE"],
  COLLECTING_EVIDENCE: ["DIAGNOSING", "DIAGNOSIS_FAILED"],
  DIAGNOSING: ["FIX_PROPOSED", "DIAGNOSIS_FAILED"],
  FIX_PROPOSED: ["VERIFYING"],
  VERIFYING: ["AWAITING_APPROVAL", "VERIFICATION_FAILED"],
  AWAITING_APPROVAL: ["RECOVERING", "FIX_PROPOSED"],
  RECOVERING: ["RESOLVED", "RECOVERY_FAILED"],
  RESOLVED: [],
  DIAGNOSIS_FAILED: ["COLLECTING_EVIDENCE"],
  VERIFICATION_FAILED: ["FIX_PROPOSED"],
  RECOVERY_FAILED: ["COLLECTING_EVIDENCE"]
};

export class InvalidIncidentTransitionError extends Error {
  public readonly from: IncidentState;
  public readonly to: IncidentState;

  public constructor(from: IncidentState, to: IncidentState) {
    super(`Incident cannot transition from ${from} to ${to}`);
    this.name = "InvalidIncidentTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function canTransitionIncident(from: IncidentState, to: IncidentState): boolean {
  return ALLOWED_INCIDENT_TRANSITIONS[from].includes(to);
}

export function assertIncidentTransition(from: IncidentState, to: IncidentState): void {
  if (!canTransitionIncident(from, to)) {
    throw new InvalidIncidentTransitionError(from, to);
  }
}

export function isTerminalIncidentState(state: IncidentState): boolean {
  return state === "RESOLVED";
}
