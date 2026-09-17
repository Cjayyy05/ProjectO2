import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Canonical } from "./canonical-hash";

describe("canonical plan hashing", () => {
  it("sorts object keys recursively while preserving array order", () => {
    expect(canonicalJson({ z: 1, nested: { b: 2, a: 1 }, actions: ["first", "second"] }))
      .toBe('{"actions":["first","second"],"nested":{"a":1,"b":2},"z":1}');
  });

  it("is deterministic across insertion order and changes with actionable content", () => {
    expect(sha256Canonical({ deploymentId: "one", action: { type: "RESTART_CONTAINER" } }))
      .toBe(sha256Canonical({ action: { type: "RESTART_CONTAINER" }, deploymentId: "one" }));
    expect(sha256Canonical({ deploymentId: "one" }))
      .not.toBe(sha256Canonical({ deploymentId: "two" }));
  });

  it("uses locale-independent ordinal key ordering", () => {
    expect(canonicalJson({ "ä": 3, z: 2, A: 1 })).toBe('{"A":1,"z":2,"ä":3}');
  });

  it("rejects non-JSON numeric values", () => {
    expect(() => canonicalJson({ confidence: Number.NaN })).toThrow();
  });
});
