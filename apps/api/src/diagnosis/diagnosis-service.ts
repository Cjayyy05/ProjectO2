import { EvidenceSanitizer } from "../evidence/evidence-sanitizer";
import type { DiagnosisProvider } from "./diagnosis-provider";
import type { DiagnosisRepository, DiagnosisWorkItem } from "./diagnosis-repository";
import {
  diagnosisProviderIdentitySchema,
  diagnosisResultSchema,
  sanitizeDiagnosisResult,
  type DiagnosisResult
} from "./diagnosis-types";

export interface DiagnosisProcessor {
  process(work: DiagnosisWorkItem): Promise<boolean>;
}

export class DiagnosisService implements DiagnosisProcessor {
  public constructor(
    private readonly repository: DiagnosisRepository,
    private readonly provider: DiagnosisProvider,
    private readonly sanitizer = new EvidenceSanitizer()
  ) {}

  public async process(work: DiagnosisWorkItem): Promise<boolean> {
    const identity = diagnosisProviderIdentitySchema.safeParse({
      provider: this.provider.provider,
      model: this.provider.model
    });
    if (!identity.success) {
      return this.repository.fail(work, "INVALID_PROVIDER_RESULT");
    }

    let providerOutput: unknown;
    try {
      providerOutput = await this.provider.analyzeIncident(work.input);
    } catch {
      return this.repository.fail(work, "PROVIDER_FAILED");
    }

    const parsed = diagnosisResultSchema.safeParse(providerOutput);
    if (!parsed.success) {
      return this.repository.fail(work, "INVALID_PROVIDER_RESULT");
    }
    const allowedReferences = new Set(work.input.evidence.map((item) => item.id));
    if (parsed.data.supportingEvidenceReferences.some((id) => !allowedReferences.has(id))) {
      return this.repository.fail(work, "INVALID_EVIDENCE_REFERENCE");
    }

    let sanitized: DiagnosisResult;
    try {
      sanitized = sanitizeDiagnosisResult(parsed.data, this.sanitizer);
    } catch {
      return this.repository.fail(work, "INVALID_PROVIDER_RESULT");
    }
    return this.repository.complete(work, identity.data, sanitized);
  }
}
