import type { IncidentType } from "@selfheal/shared";
import { EvidenceSanitizer } from "../evidence/evidence-sanitizer";
import type { DiagnosisEvidenceInput, DiagnosisInput } from "./diagnosis-types";

const MAX_INPUT_ITEMS = 32;
const MAX_INPUT_BYTES = 384 * 1_024;
const sanitizer = new EvidenceSanitizer();
const KIND_PRIORITY: Readonly<Record<string, number>> = {
  DEPLOYMENT: 0,
  HEALTH_CHECK: 1,
  CONTAINER_RUNTIME: 2,
  ENVIRONMENT: 3,
  COLLECTION_SUMMARY: 4,
  COLLECTION_ERROR: 5,
  DOCKER_LOG: 6
};

export interface PersistedDiagnosisEvidence {
  readonly id: string;
  readonly kind: string;
  readonly source: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly collectedAt: Date;
}

export function buildDiagnosisInput(
  incidentId: string,
  incidentType: IncidentType,
  persistedEvidence: readonly PersistedDiagnosisEvidence[]
): DiagnosisInput {
  const ordered = [...persistedEvidence]
    .sort((left, right) => {
      const priorityDifference = (KIND_PRIORITY[left.kind] ?? 99) - (KIND_PRIORITY[right.kind] ?? 99);
      if (priorityDifference !== 0) return priorityDifference;
      const timeDifference = left.collectedAt.getTime() - right.collectedAt.getTime();
      return timeDifference !== 0 ? timeDifference : left.id.localeCompare(right.id);
    })
    .slice(0, MAX_INPUT_ITEMS);
  const evidence: DiagnosisEvidenceInput[] = [];
  let remainingBytes = MAX_INPUT_BYTES;
  let inputTruncated = persistedEvidence.length > ordered.length;

  for (const item of ordered) {
    if (remainingBytes === 0) {
      inputTruncated = true;
      break;
    }
    const sanitized = sanitizer.sanitizeText(item.content);
    const bounded = truncateUtf8(sanitized, remainingBytes);
    const itemTruncated = Buffer.byteLength(bounded, "utf8") < Buffer.byteLength(sanitized, "utf8");
    evidence.push({
      id: item.id,
      kind: item.kind,
      source: item.source,
      content: bounded,
      persistedTruncated: item.truncated,
      inputTruncated: itemTruncated,
      collectedAt: item.collectedAt.toISOString()
    });
    remainingBytes -= Buffer.byteLength(bounded, "utf8");
    inputTruncated ||= itemTruncated;
  }

  return {
    incidentId,
    incidentType,
    evidence,
    evidenceIncomplete: evidence.some((item) =>
      item.persistedTruncated || item.inputTruncated ||
      item.kind === "COLLECTION_ERROR" || isIncompleteSummary(item)
    ),
    inputTruncated
  };
}

function isIncompleteSummary(evidence: DiagnosisEvidenceInput): boolean {
  if (evidence.kind !== "COLLECTION_SUMMARY") return false;
  try {
    const value: unknown = JSON.parse(evidence.content);
    return isRecord(value) && value.complete === false;
  } catch {
    return true;
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (encoded[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  return encoded.subarray(0, end).toString("utf8");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
