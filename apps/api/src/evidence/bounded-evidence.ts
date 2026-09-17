import { createHash } from "node:crypto";
import type { BoundedEvidenceText, EvidenceDraft, EvidenceKind, EvidenceLimits } from "./evidence-types";
import type { EvidenceSanitizer } from "./evidence-sanitizer";

export async function collectBoundedLogChunks(
  chunks: AsyncIterable<Uint8Array>,
  limits: Pick<EvidenceLimits, "maxBytes" | "maxLines">,
  sanitizer: EvidenceSanitizer
): Promise<BoundedEvidenceText> {
  const output = Buffer.alloc(limits.maxBytes);
  let used = 0;
  let completedLines = 0;
  let truncated = false;

  outer: for await (const chunk of chunks) {
    for (const byte of chunk) {
      if (used >= limits.maxBytes || completedLines >= limits.maxLines) {
        truncated = true;
        break outer;
      }
      output[used] = byte;
      used += 1;
      if (byte === 10) {
        completedLines += 1;
      }
    }
  }

  const raw = output.subarray(0, used).toString("utf8");
  const bounded = boundSanitizedText(raw, limits, sanitizer);
  return { ...bounded, truncated: truncated || bounded.truncated };
}

export function boundSanitizedText(
  input: string,
  limits: Pick<EvidenceLimits, "maxBytes" | "maxLines">,
  sanitizer: EvidenceSanitizer
): BoundedEvidenceText {
  const sanitized = sanitizer.sanitizeText(input);
  const lines = sanitized.length === 0 ? [] : sanitized.split(/\r?\n/);
  if (lines.length > 0 && lines.at(-1) === "" && /\r?\n$/.test(sanitized)) {
    lines.pop();
  }
  const lineBounded = lines.slice(0, limits.maxLines).join("\n");
  const lineTruncated = lines.length > limits.maxLines;
  const encoded = Buffer.from(lineBounded, "utf8");
  const byteTruncated = encoded.byteLength > limits.maxBytes;
  const content = byteTruncated
    ? truncateUtf8(encoded, limits.maxBytes)
    : lineBounded;

  return {
    content,
    byteCount: Buffer.byteLength(content, "utf8"),
    lineCount: content.length === 0 ? 0 : content.split("\n").length,
    truncated: lineTruncated || byteTruncated
  };
}

export function createEvidenceDraft(
  kind: EvidenceKind,
  source: string,
  content: string,
  metadata: EvidenceDraft["metadata"],
  limits: EvidenceLimits,
  sanitizer: EvidenceSanitizer,
  collectedAt = new Date()
): EvidenceDraft {
  const bounded = boundSanitizedText(content, limits, sanitizer);
  return {
    kind,
    source,
    ...bounded,
    contentHash: createHash("sha256").update(bounded.content).digest("hex"),
    metadata,
    collectedAt,
    expiresAt: new Date(collectedAt.getTime() + limits.retentionDays * 24 * 60 * 60 * 1_000)
  };
}

export function createLogEvidenceDraft(
  source: string,
  bounded: BoundedEvidenceText,
  metadata: EvidenceDraft["metadata"],
  limits: EvidenceLimits,
  collectedAt = new Date()
): EvidenceDraft {
  return {
    kind: "DOCKER_LOG",
    source,
    ...bounded,
    contentHash: createHash("sha256").update(bounded.content).digest("hex"),
    metadata,
    collectedAt,
    expiresAt: new Date(collectedAt.getTime() + limits.retentionDays * 24 * 60 * 60 * 1_000)
  };
}

function truncateUtf8(input: Buffer, maxBytes: number): string {
  let end = maxBytes;
  while (end > 0 && (input[end]! & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  return input.subarray(0, end).toString("utf8");
}
