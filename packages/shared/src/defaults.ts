export const MVP_DEFAULTS = Object.freeze({
  evidenceMaxBytes: 256 * 1024,
  evidenceMaxLines: 500,
  evidenceRetentionDays: 30,
  healthCheckTimeoutMs: 2_000,
  monitoringIntervalMs: 10_000,
  monitorPollIntervalMs: 1_000,
  incidentFailureThreshold: 3,
  dockerInspectionTimeoutMs: 2_000,
  candidateStartupTimeoutMs: 60_000,
  jwtTtlHours: 8,
  verification: Object.freeze({
    productionDatabaseAllowed: false,
    requiresDisposableOrIsolatedDatabase: true,
    receivesOnlyNecessarySecrets: true
  })
});

export const MONITORING_LIMITS = Object.freeze({
  intervalMs: Object.freeze({ min: 1_000, max: 3_600_000 }),
  pollIntervalMs: Object.freeze({ min: 100, max: 60_000 }),
  healthCheckTimeoutMs: Object.freeze({ min: 100, max: 30_000 }),
  incidentFailureThreshold: Object.freeze({ min: 1, max: 20 })
});

export const EVIDENCE_LIMITS = Object.freeze({
  maxBytes: Object.freeze({ min: 1_024, max: MVP_DEFAULTS.evidenceMaxBytes }),
  maxLines: Object.freeze({ min: 1, max: MVP_DEFAULTS.evidenceMaxLines }),
  retentionDays: Object.freeze({ min: 1, max: 365 })
});
