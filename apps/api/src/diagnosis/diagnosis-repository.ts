import type { DiagnosisInput, DiagnosisResult } from "./diagnosis-types";

export interface DiagnosisWorkItem {
  readonly incidentId: string;
  readonly incidentVersion: number;
  readonly projectId: string;
  readonly ownerId: string;
  readonly claimedAt: Date;
  readonly input: DiagnosisInput;
}

export type DiagnosisFailureCode =
  | "PROVIDER_FAILED"
  | "INVALID_PROVIDER_RESULT"
  | "INVALID_EVIDENCE_REFERENCE";

export interface DiagnosisRepository {
  claimNext(): Promise<DiagnosisWorkItem | null>;
  reclaimInterrupted(before: Date): Promise<DiagnosisWorkItem | null>;
  complete(
    work: DiagnosisWorkItem,
    identity: { readonly provider: string; readonly model: string },
    result: DiagnosisResult
  ): Promise<boolean>;
  fail(work: DiagnosisWorkItem, code: DiagnosisFailureCode): Promise<boolean>;
}
