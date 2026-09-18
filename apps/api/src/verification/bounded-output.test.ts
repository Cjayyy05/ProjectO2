import { describe, expect, it } from "vitest";
import { BoundedVerificationOutput } from "./bounded-output";

describe("BoundedVerificationOutput", () => {
  it("redacts secrets before retaining output and enforces an exact UTF-8 byte bound", () => {
    const output = new BoundedVerificationOutput(64);
    output.append("PASSWORD=never-persist-this\n");
    output.append("😀".repeat(100));

    expect(output.value()).not.toContain("never-persist-this");
    expect(output.value()).toContain("[REDACTED]");
    expect(Buffer.byteLength(output.value(), "utf8")).toBeLessThanOrEqual(64);
    expect(output.value()).not.toContain("�");
  });
});
