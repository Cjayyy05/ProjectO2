import { describe, expect, it } from "vitest";
import {
  MOCK_DIAGNOSIS_RULE_PRECEDENCE,
  MockDiagnosisProvider
} from "./mock-diagnosis-provider";
import type { DiagnosisEvidenceInput, DiagnosisInput } from "./diagnosis-types";

const provider = new MockDiagnosisProvider();

describe("MockDiagnosisProvider", () => {
  it("documents deterministic rule precedence", () => {
    expect(MOCK_DIAGNOSIS_RULE_PRECEDENCE).toEqual([
      "MISSING_OR_INVALID_ENV",
      "PORT_CONFIGURATION_FAILURE",
      "DATABASE_CONNECTION_FAILURE",
      "CONTAINER_CRASH",
      "HEALTH_CHECK_FAILURE",
      "INSUFFICIENT_EVIDENCE"
    ]);
  });

  it("diagnoses a database connection refusal", async () => {
    const log = evidence(1, "DOCKER_LOG", "connect ECONNREFUSED 127.0.0.1:5432");
    const result = await provider.analyzeIncident(input("HEALTH_CHECK_FAILURE", [log]));

    expect(result).toMatchObject({
      rootCauseCode: "DATABASE_CONNECTION_FAILURE",
      supportingEvidenceReferences: [log.id],
      proposedRemediation: { type: "UPDATE_ALLOWED_ENV", variableNames: [] }
    });
  });

  it("diagnoses a named missing environment variable without inventing its value", async () => {
    const log = evidence(1, "DOCKER_LOG", "Missing required environment variable: DATABASE_URL");
    const result = await provider.analyzeIncident(input("HEALTH_CHECK_FAILURE", [log]));

    expect(result).toMatchObject({
      rootCauseCode: "MISSING_OR_INVALID_ENV",
      proposedRemediation: {
        type: "UPDATE_ALLOWED_ENV",
        variableNames: ["DATABASE_URL"]
      }
    });
    expect(JSON.stringify(result)).not.toContain("postgresql://");
  });

  it("diagnoses an expected/published port mismatch", async () => {
    const deployment = evidence(1, "DEPLOYMENT", JSON.stringify({ expectedPort: 8080 }));
    const runtime = evidence(2, "CONTAINER_RUNTIME", JSON.stringify({
      state: "RUNNING",
      publishedHostPorts: [3000]
    }));
    const result = await provider.analyzeIncident(input("HEALTH_CHECK_FAILURE", [deployment, runtime]));

    expect(result).toMatchObject({
      rootCauseCode: "PORT_CONFIGURATION_FAILURE",
      supportingEvidenceReferences: [deployment.id, runtime.id],
      proposedRemediation: { type: "PATCH_APPLICATION_FILE" }
    });
  });

  it("diagnoses a non-zero container exit", async () => {
    const runtime = evidence(1, "CONTAINER_RUNTIME", JSON.stringify({ state: "STOPPED", exitCode: 137 }));
    const result = await provider.analyzeIncident(input("CONTAINER_CRASH", [runtime]));

    expect(result).toMatchObject({
      rootCauseCode: "CONTAINER_CRASH",
      proposedRemediation: { type: "RESTART_CONTAINER" }
    });
  });

  it("falls back to a generic repeated health failure", async () => {
    const health = evidence(1, "HEALTH_CHECK", JSON.stringify({
      healthState: "UNHEALTHY",
      consecutiveFailures: 3,
      httpStatus: 503
    }));
    const result = await provider.analyzeIncident(input("HEALTH_CHECK_FAILURE", [health]));

    expect(result).toMatchObject({
      rootCauseCode: "HEALTH_CHECK_FAILURE",
      supportingEvidenceReferences: [health.id]
    });
  });

  it("prefers concrete database evidence over a generic health failure", async () => {
    const health = evidence(1, "HEALTH_CHECK", JSON.stringify({ healthState: "UNHEALTHY" }));
    const log = evidence(2, "DOCKER_LOG", "database connection failed: ECONNREFUSED localhost:5432");
    const result = await provider.analyzeIncident(input("HEALTH_CHECK_FAILURE", [health, log]));

    expect(result.rootCauseCode).toBe("DATABASE_CONNECTION_FAILURE");
  });

  it("returns insufficient evidence for an unsupported signal and reduces confidence when incomplete", async () => {
    const complete = await provider.analyzeIncident(inputWithUnknownType(false));
    const incomplete = await provider.analyzeIncident(inputWithUnknownType(true));

    expect(complete).toMatchObject({
      rootCauseCode: "INSUFFICIENT_EVIDENCE",
      confidence: 0.2,
      proposedRemediation: null,
      manualInvestigationRecommended: true
    });
    expect(incomplete.confidence).toBe(0.1);
  });

  it("reduces known-rule confidence and recommends investigation for incomplete evidence", async () => {
    const health = evidence(1, "HEALTH_CHECK", JSON.stringify({ healthState: "UNHEALTHY" }));
    const complete = await provider.analyzeIncident(input("HEALTH_CHECK_FAILURE", [health]));
    const incomplete = await provider.analyzeIncident(input("HEALTH_CHECK_FAILURE", [health], true));

    expect(incomplete.confidence).toBeLessThan(complete.confidence);
    expect(incomplete.manualInvestigationRecommended).toBe(true);
  });
});

function input(
  incidentType: DiagnosisInput["incidentType"],
  items: readonly DiagnosisEvidenceInput[],
  evidenceIncomplete = false
): DiagnosisInput {
  return {
    incidentId: uuid(99),
    incidentType,
    evidence: items,
    evidenceIncomplete,
    inputTruncated: false
  };
}

function inputWithUnknownType(evidenceIncomplete: boolean): DiagnosisInput {
  return {
    incidentId: uuid(99),
    incidentType: "HEALTH_CHECK_FAILURE",
    evidence: [evidence(1, "DEPLOYMENT", "registered deployment")],
    evidenceIncomplete,
    inputTruncated: false
  };
}

function evidence(index: number, kind: string, content: string): DiagnosisEvidenceInput {
  return {
    id: uuid(index),
    kind,
    source: `source-${index}`,
    content,
    persistedTruncated: false,
    inputTruncated: false,
    collectedAt: "2026-09-18T00:00:00.000Z"
  };
}

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}
