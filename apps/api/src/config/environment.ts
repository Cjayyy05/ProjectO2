import { MVP_DEFAULTS } from "@selfheal/shared";
import { z } from "zod";

const booleanFromString = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const frontendOrigin = z.url().refine((value) => {
  const parsed = new URL(value);
  return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.origin === value;
}, "FRONTEND_ORIGIN must be an HTTP(S) origin without a path, query, or credentials");

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4_000),
  FRONTEND_ORIGIN: frontendOrigin.default("http://localhost:3000"),
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine(
      (value) => value.startsWith("postgresql://") || value.startsWith("postgres://"),
      "DATABASE_URL must be a PostgreSQL connection URL"
    ),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_TTL_HOURS: z.coerce.number().int().min(1).max(24).default(MVP_DEFAULTS.jwtTtlHours),
  AUTH_COOKIE_NAME: z.string().regex(/^[A-Za-z0-9_-]+$/).default("selfheal_token"),
  PASSWORD_HASH_ROUNDS: z.coerce.number().int().min(10).max(14).default(12),
  EVIDENCE_MAX_BYTES: z.coerce.number().int().positive().default(MVP_DEFAULTS.evidenceMaxBytes),
  EVIDENCE_MAX_LINES: z.coerce.number().int().positive().default(MVP_DEFAULTS.evidenceMaxLines),
  EVIDENCE_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .positive()
    .default(MVP_DEFAULTS.evidenceRetentionDays),
  HEALTH_CHECK_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(MVP_DEFAULTS.healthCheckTimeoutMs),
  MONITORING_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(MVP_DEFAULTS.monitoringIntervalMs),
  INCIDENT_FAILURE_THRESHOLD: z.coerce
    .number()
    .int()
    .positive()
    .default(MVP_DEFAULTS.incidentFailureThreshold),
  CANDIDATE_STARTUP_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(MVP_DEFAULTS.candidateStartupTimeoutMs),
  TRUST_PROXY: booleanFromString.default(false)
});

export interface AppConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly port: number;
  readonly frontendOrigin: string;
  readonly databaseUrl: string;
  readonly jwt: {
    readonly secret: string;
    readonly ttlHours: number;
    readonly cookieName: string;
  };
  readonly passwordHashRounds: number;
  readonly evidence: {
    readonly maxBytes: number;
    readonly maxLines: number;
    readonly retentionDays: number;
  };
  readonly monitoring: {
    readonly healthCheckTimeoutMs: number;
    readonly intervalMs: number;
    readonly incidentFailureThreshold: number;
    readonly candidateStartupTimeoutMs: number;
  };
  readonly verification: {
    readonly productionDatabaseAllowed: false;
    readonly requiresDisposableOrIsolatedDatabase: true;
    readonly receivesOnlyNecessarySecrets: true;
  };
  readonly trustProxy: boolean;
}

export class EnvironmentValidationError extends Error {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    super(`Invalid environment configuration:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "EnvironmentValidationError";
    this.issues = issues;
  }
}

export function loadEnvironment(source: NodeJS.ProcessEnv): AppConfig {
  const result = environmentSchema.safeParse(source);

  if (!result.success) {
    throw new EnvironmentValidationError(
      result.error.issues.map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
    );
  }

  const env = result.data;

  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    frontendOrigin: env.FRONTEND_ORIGIN,
    databaseUrl: env.DATABASE_URL,
    jwt: {
      secret: env.JWT_SECRET,
      ttlHours: env.JWT_TTL_HOURS,
      cookieName: env.AUTH_COOKIE_NAME
    },
    passwordHashRounds: env.PASSWORD_HASH_ROUNDS,
    evidence: {
      maxBytes: env.EVIDENCE_MAX_BYTES,
      maxLines: env.EVIDENCE_MAX_LINES,
      retentionDays: env.EVIDENCE_RETENTION_DAYS
    },
    monitoring: {
      healthCheckTimeoutMs: env.HEALTH_CHECK_TIMEOUT_MS,
      intervalMs: env.MONITORING_INTERVAL_MS,
      incidentFailureThreshold: env.INCIDENT_FAILURE_THRESHOLD,
      candidateStartupTimeoutMs: env.CANDIDATE_STARTUP_TIMEOUT_MS
    },
    verification: MVP_DEFAULTS.verification,
    trustProxy: env.TRUST_PROXY
  };
}
