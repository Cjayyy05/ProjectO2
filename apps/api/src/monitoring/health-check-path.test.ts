import { describe, expect, it } from "vitest";
import { healthCheckPathSchema } from "./health-check-path";

describe("health-check path validation", () => {
  it.each(["/", "/health", "/api/health", "/ready-v1"])("accepts path %s", (path) => {
    expect(healthCheckPathSchema.parse(path)).toBe(path);
  });

  it.each([
    "health",
    "https://attacker.example/health",
    "//attacker.example/health",
    "/health?verbose=true",
    "/health#details",
    "\\\\attacker.example\\health",
    "/../health",
    "/api//health",
    "/health%2Fadmin"
  ])("rejects unsafe path %s", (path) => {
    expect(() => healthCheckPathSchema.parse(path)).toThrow();
  });
});
