import { healthCheckPathSchema } from "./health-check-path";

const MONITORING_TARGET_HOST = "127.0.0.1";

export type HealthCheckErrorCode = "TIMEOUT" | "CONNECTION_REFUSED" | "NETWORK_ERROR";

export interface HealthCheckResult {
  readonly healthy: boolean;
  readonly checkedAt: Date;
  readonly durationMs: number;
  readonly statusCode?: number;
  readonly errorCode?: HealthCheckErrorCode;
}

export interface HealthCheckInput {
  readonly port: number;
  readonly path: string;
  readonly timeoutMs: number;
}

export interface HealthChecker {
  check(input: HealthCheckInput): Promise<HealthCheckResult>;
}

export class HttpHealthChecker implements HealthChecker {
  public constructor(private readonly fetchImplementation: typeof fetch = fetch) {}

  public async check(input: HealthCheckInput): Promise<HealthCheckResult> {
    const path = healthCheckPathSchema.parse(input.path);
    const startedAt = Date.now();
    const checkedAt = new Date();
    const url = `http://${MONITORING_TARGET_HOST}:${input.port}${path}`;

    try {
      const response = await this.fetchImplementation(url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(input.timeoutMs),
        headers: { accept: "*/*", "user-agent": "SelfHeal-Monitor/1.0" }
      });
      await response.body?.cancel();

      return {
        healthy: response.status >= 200 && response.status <= 399,
        checkedAt,
        durationMs: Date.now() - startedAt,
        statusCode: response.status
      };
    } catch (error) {
      return {
        healthy: false,
        checkedAt,
        durationMs: Date.now() - startedAt,
        errorCode: classifyNetworkError(error)
      };
    }
  }
}

function classifyNetworkError(error: unknown): HealthCheckErrorCode {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "TIMEOUT";
  }
  if (hasStringCode(error, "ECONNREFUSED")) {
    return "CONNECTION_REFUSED";
  }
  if (typeof error === "object" && error !== null && "cause" in error) {
    return hasStringCode(error.cause, "ECONNREFUSED") ? "CONNECTION_REFUSED" : "NETWORK_ERROR";
  }
  return "NETWORK_ERROR";
}

function hasStringCode(value: unknown, expected: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    value.code === expected
  );
}
