export const EVIDENCE_KINDS = [
  "CONTAINER_RUNTIME",
  "HEALTH_CHECK",
  "DEPLOYMENT",
  "ENVIRONMENT",
  "DOCKER_LOG",
  "COLLECTION_ERROR",
  "COLLECTION_SUMMARY"
] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface EvidenceLimits {
  readonly maxBytes: number;
  readonly maxLines: number;
  readonly retentionDays: number;
}

export interface EvidenceDraft {
  readonly kind: EvidenceKind;
  readonly source: string;
  readonly content: string;
  readonly byteCount: number;
  readonly lineCount: number;
  readonly truncated: boolean;
  readonly contentHash: string;
  readonly metadata: Readonly<Record<string, string | number | boolean | readonly string[] | null>>;
  readonly collectedAt: Date;
  readonly expiresAt: Date;
}

export interface BoundedEvidenceText {
  readonly content: string;
  readonly byteCount: number;
  readonly lineCount: number;
  readonly truncated: boolean;
}
