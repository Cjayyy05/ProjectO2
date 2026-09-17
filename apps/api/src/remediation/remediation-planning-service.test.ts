import { describe, expect, it } from "vitest";
import type { RemediationPlanningRepository } from "./remediation-planning-repository";
import {
  RemediationPlanningService,
  type RemediationPlanningBuilder
} from "./remediation-planning-service";
import type { RemediationPlanningCandidate, RemediationPlanningDecision } from "./remediation-types";

describe("RemediationPlanningService", () => {
  it("persists the deterministic builder decision without exposing execution capabilities", async () => {
    const candidate: RemediationPlanningCandidate = {
      incidentId: "incident",
      incidentVersion: 1,
      projectId: "project",
      ownerId: "owner",
      diagnosisId: "diagnosis",
      diagnosisResult: {},
      affectedDeployment: null,
      projectExpectedPort: null,
      projectDeployments: []
    };
    const decision = {
      kind: "NOT_ACTIONABLE",
      code: "NO_REMEDIATION_SUGGESTED"
    } as const satisfies RemediationPlanningDecision;
    let persisted: RemediationPlanningDecision | undefined;
    const repository: RemediationPlanningRepository = {
      findNextCandidate: async () => candidate,
      persistDecision: async (_candidate, value) => { persisted = value; return true; }
    };
    const builder: RemediationPlanningBuilder = { build: () => decision };

    await new RemediationPlanningService(repository, builder).runCycle();

    expect(persisted).toEqual(decision);
  });

  it("does nothing when there is no eligible FIX_PROPOSED Incident", async () => {
    let built = false;
    const repository: RemediationPlanningRepository = {
      findNextCandidate: async () => null,
      persistDecision: async () => false
    };
    const builder: RemediationPlanningBuilder = {
      build: () => { built = true; throw new Error("not expected"); }
    };

    await new RemediationPlanningService(repository, builder).runCycle();

    expect(built).toBe(false);
  });
});
