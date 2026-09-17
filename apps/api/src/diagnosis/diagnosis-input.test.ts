import { describe, expect, it } from "vitest";
import { buildDiagnosisInput, type PersistedDiagnosisEvidence } from "./diagnosis-input";

describe("buildDiagnosisInput", () => {
  it("uses only bounded re-sanitized persisted evidence", () => {
    const items = Array.from({ length: 33 }, (_value, index): PersistedDiagnosisEvidence => ({
      id: uuid(index + 1),
      kind: index === 0 ? "COLLECTION_SUMMARY" : "DOCKER_LOG",
      source: `source-${index}`,
      content: index === 0
        ? '{"complete":false,"password":"database-secret"}'
        : `${"x".repeat(20_000)} PASSWORD=log-secret-${index}`,
      truncated: false,
      collectedAt: new Date(`2026-09-18T00:00:${index.toString().padStart(2, "0")}.000Z`)
    }));

    const input = buildDiagnosisInput(
      "00000000-0000-4000-8000-999999999999",
      "HEALTH_CHECK_FAILURE",
      items
    );
    const serialized = JSON.stringify(input);

    expect(input.evidence.length).toBeLessThanOrEqual(32);
    expect(input.evidenceIncomplete).toBe(true);
    expect(input.inputTruncated).toBe(true);
    expect(input.evidence.reduce(
      (total, item) => total + Buffer.byteLength(item.content, "utf8"),
      0
    )).toBeLessThanOrEqual(384 * 1_024);
    expect(serialized).not.toContain("database-secret");
    expect(serialized).not.toContain("log-secret-");
    expect(serialized).toContain("REDACTED");
  });

  it("marks persisted truncation as incomplete diagnosis evidence", () => {
    const input = buildDiagnosisInput(
      "00000000-0000-4000-8000-999999999999",
      "CONTAINER_CRASH",
      [{
        id: uuid(1),
        kind: "DOCKER_LOG",
        source: "DOCKER_LOGS",
        content: "bounded log",
        truncated: true,
        collectedAt: new Date("2026-09-18T00:00:00.000Z")
      }]
    );

    expect(input.evidenceIncomplete).toBe(true);
  });
});

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}
