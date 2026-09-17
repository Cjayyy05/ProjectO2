import { describe, expect, it } from "vitest";
import { collectBoundedLogChunks, createEvidenceDraft } from "./bounded-evidence";
import { EvidenceSanitizer } from "./evidence-sanitizer";

const sanitizer = new EvidenceSanitizer();

describe("bounded evidence", () => {
  it("preserves chronological ordering", async () => {
    const result = await collectBoundedLogChunks(
      chunks("first\n", "second\n", "third"),
      { maxBytes: 1_024, maxLines: 500 },
      sanitizer
    );

    expect(result.content).toBe("first\nsecond\nthird");
    expect(result.truncated).toBe(false);
  });

  it("limits persisted logs to 500 lines and records truncation", async () => {
    const input = Array.from({ length: 501 }, (_value, index) => `line-${index + 1}`).join("\n");
    const result = await collectBoundedLogChunks(
      chunks(input),
      { maxBytes: 256 * 1_024, maxLines: 500 },
      sanitizer
    );

    expect(result.lineCount).toBe(500);
    expect(result.content).toContain("line-1");
    expect(result.content).not.toContain("line-501");
    expect(result.truncated).toBe(true);
  });

  it("does not mark exactly 500 newline-terminated lines as truncated", async () => {
    const input = `${Array.from({ length: 500 }, (_value, index) => `line-${index + 1}`).join("\n")}\n`;
    const result = await collectBoundedLogChunks(
      chunks(input),
      { maxBytes: 256 * 1_024, maxLines: 500 },
      sanitizer
    );

    expect(result.lineCount).toBe(500);
    expect(result.content.endsWith("line-500")).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it("limits logs to 256 KB", async () => {
    const result = await collectBoundedLogChunks(
      chunks("x".repeat(300 * 1_024)),
      { maxBytes: 256 * 1_024, maxLines: 500 },
      sanitizer
    );

    expect(result.byteCount).toBe(256 * 1_024);
    expect(result.truncated).toBe(true);
  });

  it("does not let one very large line bypass the byte limit", async () => {
    const result = await collectBoundedLogChunks(
      chunks("PASSWORD=" + "secret-value".repeat(50_000)),
      { maxBytes: 4_096, maxLines: 500 },
      sanitizer
    );

    expect(result.byteCount).toBeLessThanOrEqual(4_096);
    expect(result.lineCount).toBe(1);
    expect(result.content).not.toContain("secret-value");
    expect(result.truncated).toBe(true);
  });

  it("handles invalid UTF-8 without throwing", async () => {
    const result = await collectBoundedLogChunks(
      byteChunks(Buffer.from([0xff, 0xfe, 0x0a])),
      { maxBytes: 1_024, maxLines: 500 },
      sanitizer
    );

    expect(result.content).toContain("�");
  });

  it("records the configured evidence expiry", () => {
    const collectedAt = new Date("2026-09-17T00:00:00.000Z");
    const draft = createEvidenceDraft(
      "DEPLOYMENT",
      "deployment:example",
      "{}",
      {},
      { maxBytes: 256 * 1_024, maxLines: 500, retentionDays: 30 },
      sanitizer,
      collectedAt
    );

    expect(draft.collectedAt).toEqual(collectedAt);
    expect(draft.expiresAt).toEqual(new Date("2026-10-17T00:00:00.000Z"));
  });
});

async function* chunks(...values: string[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield Buffer.from(value);
}

async function* byteChunks(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* values;
}
