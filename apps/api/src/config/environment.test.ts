import { describe, expect, it } from "vitest";
import { EnvironmentValidationError, loadEnvironment } from "./environment";

const validEnvironment = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://selfheal:test@localhost:5432/selfheal_test",
  JWT_SECRET: "test-secret-with-at-least-32-characters"
};

describe("environment validation", () => {
  it("applies the approved MVP defaults", () => {
    const config = loadEnvironment(validEnvironment);

    expect(config.jwt.ttlHours).toBe(8);
    expect(config.evidence).toEqual({ maxBytes: 262_144, maxLines: 500, retentionDays: 30 });
    expect(config.monitoring).toEqual({
      healthCheckTimeoutMs: 2_000,
      intervalMs: 10_000,
      pollIntervalMs: 1_000,
      incidentFailureThreshold: 3,
      dockerInspectionTimeoutMs: 2_000,
      candidateStartupTimeoutMs: 60_000
    });
    expect(config.verification.productionDatabaseAllowed).toBe(false);
  });

  it("fails clearly when required values are missing", () => {
    expect(() => loadEnvironment({ NODE_ENV: "test" })).toThrow(EnvironmentValidationError);

    try {
      loadEnvironment({ NODE_ENV: "test" });
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentValidationError);
      expect((error as EnvironmentValidationError).issues).toEqual(
        expect.arrayContaining([
          expect.stringContaining("DATABASE_URL"),
          expect.stringContaining("JWT_SECRET")
        ])
      );
    }
  });

  it("rejects short JWT secrets and non-PostgreSQL database URLs", () => {
    expect(() =>
      loadEnvironment({ DATABASE_URL: "sqlite:dev.db", JWT_SECRET: "short" })
    ).toThrow(/DATABASE_URL must be a PostgreSQL connection URL/);
  });

  it("accepts explicit configurable limits", () => {
    const config = loadEnvironment({
      ...validEnvironment,
      EVIDENCE_MAX_BYTES: "1024",
      EVIDENCE_MAX_LINES: "25",
      EVIDENCE_RETENTION_DAYS: "7",
      MONITORING_INTERVAL_MS: "15000"
    });

    expect(config.evidence).toEqual({ maxBytes: 1_024, maxLines: 25, retentionDays: 7 });
    expect(config.monitoring.intervalMs).toBe(15_000);
  });

  it.each([
    ["HEALTH_CHECK_TIMEOUT_MS", "99"],
    ["MONITORING_INTERVAL_MS", "999"],
    ["MONITOR_POLL_INTERVAL_MS", "60001"],
    ["INCIDENT_FAILURE_THRESHOLD", "21"],
    ["DOCKER_INSPECTION_TIMEOUT_MS", "30001"]
  ])("rejects unsafe monitoring bound %s=%s", (name, value) => {
    expect(() => loadEnvironment({ ...validEnvironment, [name]: value })).toThrow(
      EnvironmentValidationError
    );
  });

  it.each([
    ["EVIDENCE_MAX_BYTES", "262145"],
    ["EVIDENCE_MAX_LINES", "501"],
    ["EVIDENCE_RETENTION_DAYS", "366"]
  ])("rejects unsafe evidence bound %s=%s", (name, value) => {
    expect(() => loadEnvironment({ ...validEnvironment, [name]: value })).toThrow(
      EnvironmentValidationError
    );
  });

  it.each(["ftp://localhost:3000", "http://user:secret@localhost:3000", "http://localhost:3000/app"])(
    "rejects invalid frontend origin %s",
    (frontendOrigin) => {
      expect(() => loadEnvironment({ ...validEnvironment, FRONTEND_ORIGIN: frontendOrigin })).toThrow(
        /FRONTEND_ORIGIN must be an HTTP\(S\) origin/
      );
    }
  );
});
