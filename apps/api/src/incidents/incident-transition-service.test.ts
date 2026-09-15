import type { IncidentState } from "@selfheal/shared";
import { InvalidIncidentTransitionError } from "@selfheal/shared";
import { describe, expect, it } from "vitest";
import type {
  IncidentTransitionRecord,
  IncidentTransitionRepository,
  PersistIncidentTransitionInput
} from "./incident-transition-repository";
import { IncidentTransitionService } from "./incident-transition-service";

class RecordingIncidentRepository implements IncidentTransitionRepository {
  public calls: PersistIncidentTransitionInput[] = [];
  public result: IncidentTransitionRecord | null = {
    id: "incident-1",
    projectId: "project-1",
    state: "COLLECTING_EVIDENCE",
    version: 2,
    updatedAt: new Date()
  };

  public async transition(input: PersistIncidentTransitionInput): Promise<IncidentTransitionRecord | null> {
    this.calls.push(input);
    return this.result;
  }
}

function transitionInput(from: IncidentState, to: IncidentState) {
  return {
    incidentId: "incident-1",
    ownerId: "user-1",
    currentState: from,
    expectedVersion: 1,
    targetState: to,
    reason: "test transition"
  };
}

describe("IncidentTransitionService", () => {
  it("validates before asking persistence to mutate state", async () => {
    const repository = new RecordingIncidentRepository();
    const service = new IncidentTransitionService(repository);

    await expect(
      service.transition(transitionInput("DETECTED", "COLLECTING_EVIDENCE"))
    ).resolves.toMatchObject({ state: "COLLECTING_EVIDENCE", version: 2 });
    expect(repository.calls).toHaveLength(1);
  });

  it("rejects an invalid transition without invoking persistence", async () => {
    const repository = new RecordingIncidentRepository();
    const service = new IncidentTransitionService(repository);

    await expect(service.transition(transitionInput("DETECTED", "RECOVERING"))).rejects.toBeInstanceOf(
      InvalidIncidentTransitionError
    );
    expect(repository.calls).toHaveLength(0);
  });

  it("reports an optimistic concurrency conflict", async () => {
    const repository = new RecordingIncidentRepository();
    repository.result = null;
    const service = new IncidentTransitionService(repository);

    await expect(
      service.transition(transitionInput("DETECTED", "COLLECTING_EVIDENCE"))
    ).rejects.toMatchObject({ code: "INCIDENT_TRANSITION_CONFLICT", statusCode: 409 });
  });
});

