import { describe, expect, it } from "vitest";
import { diagnosisResultSchema } from "./diagnosis-types";

const validResult = {
  rootCauseCode: "CONTAINER_CRASH",
  summary: "Container exited.",
  explanation: "Runtime evidence records a non-zero exit.",
  supportingEvidenceReferences: ["00000000-0000-4000-8000-000000000001"],
  confidence: 0.8,
  proposedRemediation: {
    type: "RESTART_CONTAINER",
    reason: "Evaluate a controlled restart."
  },
  manualInvestigationRecommended: false
};

describe("diagnosisResultSchema", () => {
  it.each([-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid confidence %s",
    (confidence) => {
      expect(diagnosisResultSchema.safeParse({ ...validResult, confidence }).success).toBe(false);
    }
  );

  it("rejects an unknown remediation type", () => {
    expect(diagnosisResultSchema.safeParse({
      ...validResult,
      proposedRemediation: { type: "RUN_SHELL", command: "rm -rf /" }
    }).success).toBe(false);
  });

  it("rejects arbitrary command and file-path fields", () => {
    expect(diagnosisResultSchema.safeParse({
      ...validResult,
      proposedRemediation: {
        type: "RESTART_CONTAINER",
        reason: "restart",
        command: "docker restart target"
      }
    }).success).toBe(false);
    expect(diagnosisResultSchema.safeParse({
      ...validResult,
      proposedRemediation: {
        type: "PATCH_APPLICATION_FILE",
        reason: "patch",
        advisoryDescription: "Align the configured port.",
        path: "../../sensitive"
      }
    }).success).toBe(false);
  });

  it("bounds every remediation parameter string", () => {
    expect(diagnosisResultSchema.safeParse({
      ...validResult,
      proposedRemediation: {
        type: "UPDATE_ALLOWED_ENV",
        variableNames: [`A${"B".repeat(128)}`],
        reason: "Review the approved environment configuration."
      }
    }).success).toBe(false);
  });

  it("rejects oversized prose, malformed references, duplicates, and unknown fields", () => {
    expect(diagnosisResultSchema.safeParse({ ...validResult, summary: "x".repeat(301) }).success)
      .toBe(false);
    expect(diagnosisResultSchema.safeParse({
      ...validResult,
      supportingEvidenceReferences: ["not-a-uuid"]
    }).success).toBe(false);
    expect(diagnosisResultSchema.safeParse({
      ...validResult,
      supportingEvidenceReferences: [
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000001"
      ]
    }).success).toBe(false);
    expect(diagnosisResultSchema.safeParse({ ...validResult, unexpected: true }).success).toBe(false);
  });
});
