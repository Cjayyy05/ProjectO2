import { describe, expect, it } from "vitest";
import {
  INCIDENT_STATES,
  InvalidIncidentTransitionError,
  assertIncidentTransition,
  canTransitionIncident,
  isTerminalIncidentState
} from "./incident";

describe("incident state transitions", () => {
  it.each([
    ["DETECTED", "COLLECTING_EVIDENCE"],
    ["COLLECTING_EVIDENCE", "DIAGNOSING"],
    ["COLLECTING_EVIDENCE", "DIAGNOSIS_FAILED"],
    ["DIAGNOSING", "FIX_PROPOSED"],
    ["DIAGNOSING", "DIAGNOSIS_FAILED"],
    ["FIX_PROPOSED", "VERIFYING"],
    ["VERIFYING", "AWAITING_APPROVAL"],
    ["VERIFYING", "VERIFICATION_FAILED"],
    ["AWAITING_APPROVAL", "RECOVERING"],
    ["AWAITING_APPROVAL", "FIX_PROPOSED"],
    ["RECOVERING", "RESOLVED"],
    ["RECOVERING", "RECOVERY_FAILED"],
    ["DIAGNOSIS_FAILED", "COLLECTING_EVIDENCE"],
    ["VERIFICATION_FAILED", "FIX_PROPOSED"],
    ["RECOVERY_FAILED", "COLLECTING_EVIDENCE"]
  ] as const)("allows %s -> %s", (from, to) => {
    expect(canTransitionIncident(from, to)).toBe(true);
    expect(() => assertIncidentTransition(from, to)).not.toThrow();
  });

  it.each([
    ["DETECTED", "RESOLVED"],
    ["DIAGNOSING", "RECOVERING"],
    ["AWAITING_APPROVAL", "RESOLVED"],
    ["VERIFICATION_FAILED", "RECOVERING"],
    ["RECOVERY_FAILED", "RESOLVED"]
  ] as const)("rejects %s -> %s", (from, to) => {
    expect(canTransitionIncident(from, to)).toBe(false);
    expect(() => assertIncidentTransition(from, to)).toThrow(InvalidIncidentTransitionError);
  });

  it("treats RESOLVED as terminal", () => {
    expect(isTerminalIncidentState("RESOLVED")).toBe(true);

    for (const state of INCIDENT_STATES) {
      expect(canTransitionIncident("RESOLVED", state)).toBe(false);
    }
  });

  it("does not treat recoverable failure states as terminal", () => {
    expect(isTerminalIncidentState("DIAGNOSIS_FAILED")).toBe(false);
    expect(isTerminalIncidentState("VERIFICATION_FAILED")).toBe(false);
    expect(isTerminalIncidentState("RECOVERY_FAILED")).toBe(false);
  });

  it.each(INCIDENT_STATES)("rejects a self-transition from %s", (state) => {
    expect(canTransitionIncident(state, state)).toBe(false);
  });
});
