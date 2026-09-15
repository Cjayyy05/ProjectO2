export const MVP_DEFAULTS = Object.freeze({
  evidenceMaxBytes: 256 * 1024,
  evidenceMaxLines: 500,
  evidenceRetentionDays: 30,
  healthCheckTimeoutMs: 2_000,
  monitoringIntervalMs: 10_000,
  incidentFailureThreshold: 3,
  candidateStartupTimeoutMs: 60_000,
  jwtTtlHours: 8,
  verification: Object.freeze({
    productionDatabaseAllowed: false,
    requiresDisposableOrIsolatedDatabase: true,
    receivesOnlyNecessarySecrets: true
  })
});

