import { describe, expect, it } from "vitest";
import type { DiagnosisProvider } from "./diagnosis-provider";
import type {
  DiagnosisFailureCode,
  DiagnosisRepository,
  DiagnosisWorkItem
} from "./diagnosis-repository";
import { DiagnosisService } from "./diagnosis-service";
import type { DiagnosisResult } from "./diagnosis-types";

const evidenceId = "00000000-0000-4000-8000-000000000001";
const work: DiagnosisWorkItem = {
  incidentId: "00000000-0000-4000-8000-000000000099",
  incidentVersion: 4,
  projectId: "00000000-0000-4000-8000-000000000098",
  ownerId: "00000000-0000-4000-8000-000000000097",
  claimedAt: new Date("2026-09-18T00:00:00.000Z"),
  input: {
    incidentId: "00000000-0000-4000-8000-000000000099",
    incidentType: "CONTAINER_CRASH",
    evidence: [{
      id: evidenceId,
      kind: "CONTAINER_RUNTIME",
      source: "DOCKER_INSPECT",
      content: '{"state":"STOPPED","exitCode":1}',
      persistedTruncated: false,
      inputTruncated: false,
      collectedAt: "2026-09-18T00:00:00.000Z"
    }],
    evidenceIncomplete: false,
    inputTruncated: false
  }
};

const validResult: DiagnosisResult = {
  rootCauseCode: "CONTAINER_CRASH",
  summary: "Container exited.",
  explanation: "Runtime evidence records a non-zero exit.",
  supportingEvidenceReferences: [evidenceId],
  confidence: 0.85,
  proposedRemediation: {
    type: "RESTART_CONTAINER",
    reason: "Evaluate a controlled restart."
  },
  manualInvestigationRecommended: false
};

class RecordingRepository implements DiagnosisRepository {
  public failure: DiagnosisFailureCode | undefined;
  public result: DiagnosisResult | undefined;
  public identity: { readonly provider: string; readonly model: string } | undefined;

  public async claimNext(): Promise<DiagnosisWorkItem | null> { return null; }
  public async reclaimInterrupted(): Promise<DiagnosisWorkItem | null> { return null; }
  public async complete(
    _work: DiagnosisWorkItem,
    identity: { readonly provider: string; readonly model: string },
    result: DiagnosisResult
  ): Promise<boolean> {
    this.identity = identity;
    this.result = result;
    return true;
  }
  public async fail(_work: DiagnosisWorkItem, code: DiagnosisFailureCode): Promise<boolean> {
    this.failure = code;
    return true;
  }
}

describe("DiagnosisService", () => {
  it("depends on the provider abstraction and persists sanitized validated output", async () => {
    const repository = new RecordingRepository();
    const provider = staticProvider({
      ...validResult,
      summary: "PASSWORD=provider-secret",
      explanation: "Authorization: Bearer provider-token",
      proposedRemediation: {
        type: "PATCH_APPLICATION_FILE",
        reason: "PASSWORD=nested-provider-secret",
        advisoryDescription: "Authorization: Bearer nested-provider-token"
      }
    });
    const service = new DiagnosisService(repository, provider);

    await expect(service.process(work)).resolves.toBe(true);

    expect(repository.identity).toEqual({ provider: "test", model: "deterministic-test" });
    expect(repository.result?.summary).toContain("REDACTED");
    expect(repository.result?.explanation).toContain("REDACTED");
    expect(JSON.stringify(repository.result)).not.toContain("provider-secret");
    expect(JSON.stringify(repository.result)).not.toContain("provider-token");
    expect(repository.result?.proposedRemediation).toEqual(expect.objectContaining({
      reason: expect.stringContaining("REDACTED"),
      advisoryDescription: expect.stringContaining("REDACTED")
    }));
  });

  it("transitions through the safe failure path when the provider throws", async () => {
    const repository = new RecordingRepository();
    const provider: DiagnosisProvider = {
      provider: "test",
      model: "deterministic-test",
      analyzeIncident: async () => { throw new Error("socket password=secret"); }
    };

    await expect(new DiagnosisService(repository, provider).process(work)).resolves.toBe(true);
    expect(repository.failure).toBe("PROVIDER_FAILED");
  });

  it.each([
    [{ ...validResult, confidence: -1 }, "INVALID_PROVIDER_RESULT"],
    [{ ...validResult, confidence: 2 }, "INVALID_PROVIDER_RESULT"],
    [{
      ...validResult,
      proposedRemediation: { type: "RUN_SHELL", command: "docker restart target" }
    }, "INVALID_PROVIDER_RESULT"],
    [{
      ...validResult,
      supportingEvidenceReferences: ["00000000-0000-4000-8000-000000000002"]
    }, "INVALID_EVIDENCE_REFERENCE"]
  ])("rejects untrusted provider output %#", async (providerResult, expectedFailure) => {
    const repository = new RecordingRepository();

    await expect(
      new DiagnosisService(repository, staticProvider(providerResult)).process(work)
    ).resolves.toBe(true);
    expect(repository.failure).toBe(expectedFailure);
    expect(repository.result).toBeUndefined();
  });
});

function staticProvider(result: unknown): DiagnosisProvider {
  return {
    provider: "test",
    model: "deterministic-test",
    analyzeIncident: async () => result
  };
}
