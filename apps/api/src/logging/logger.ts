import pino, { type Logger } from "pino";

const REDACTED_PATHS = [
  "password",
  "passwordHash",
  "token",
  "jwt",
  "jwtSecret",
  "JWT_SECRET",
  "databaseUrl",
  "DATABASE_URL",
  "body",
  "req.body",
  "request.body",
  "config.databaseUrl",
  "config.jwt.secret",
  "env.DATABASE_URL",
  "env.JWT_SECRET",
  "headers.authorization",
  "headers.cookie",
  "req.headers.authorization",
  "req.headers.cookie",
  "request.headers.authorization",
  "request.headers.cookie"
];

export function createLogger(environment: string): Logger {
  return pino({
    level: environment === "test" ? "silent" : process.env.LOG_LEVEL ?? "info",
    redact: {
      paths: REDACTED_PATHS,
      censor: "[REDACTED]"
    },
    base: {
      service: "selfheal-api",
      environment
    }
  });
}
