import type { RemediationPlanDraft, PlanningDeployment } from "../remediation/remediation-types";

export const VERIFICATION_FAILURE_CODES = [
  "PLAN_INTEGRITY_MISMATCH",
  "BASELINE_INVALID",
  "BASELINE_DRIFT",
  "TRUSTED_SOURCE_UNAVAILABLE",
  "UNSAFE_SOURCE",
  "UNSAFE_DEPENDENCY",
  "PATCH_BASELINE_MISMATCH",
  "PATCH_APPLY_MISMATCH",
  "BUILD_FAILED",
  "BUILD_TIMEOUT",
  "STARTUP_FAILED",
  "STARTUP_TIMEOUT",
  "TEST_FAILED",
  "TEST_TIMEOUT",
  "HEALTH_CHECK_FAILED",
  "DOCKER_UNAVAILABLE",
  "INTERNAL_VERIFICATION_ERROR"
] as const;

export type VerificationFailureCode = typeof VERIFICATION_FAILURE_CODES[number];

export interface TrustedSourceFile {
  readonly relativePath: string;
  readonly content: string;
  readonly contentHash: string;
}

export interface TrustedVerificationTest {
  readonly command: readonly string[];
  readonly mandatory: boolean;
  readonly timeoutMs: number;
}

export interface TrustedVerificationSource {
  readonly files: readonly TrustedSourceFile[];
  readonly dockerfilePath: string;
  readonly safeEnvironment: Readonly<Record<string, string>>;
  readonly test: TrustedVerificationTest | null;
  readonly requiresDatabase: boolean;
}

interface VerificationCandidateBase {
  readonly runId: string;
  readonly claimToken: string;
  readonly incidentId: string;
  readonly incidentVersion: number;
  readonly ownerId: string;
  readonly projectId: string;
  readonly healthCheckPath: string | null;
  readonly expectedPort: number | null;
  readonly planId: string;
  readonly affectedDeployment: PlanningDeployment;
  readonly projectDeployments: readonly PlanningDeployment[];
}

export interface ClaimedVerificationCandidate extends VerificationCandidateBase {
  readonly planValue: unknown;
}

export interface VerificationCandidate extends VerificationCandidateBase {
  readonly plan: RemediationPlanDraft;
}

export type VerificationGateStatus = "PASSED" | "FAILED" | "NOT_CONFIGURED";

export interface VerificationGateResult {
  readonly status: VerificationGateStatus;
  readonly code: string;
  readonly summary: string;
}

export interface VerificationCheckResults {
  readonly schemaVersion: 1;
  readonly planIntegrity: VerificationGateResult;
  readonly baseline: VerificationGateResult;
  readonly application: VerificationGateResult;
  readonly build: VerificationGateResult;
  readonly startup: VerificationGateResult;
  readonly tests: VerificationGateResult;
  readonly healthCheck: VerificationGateResult;
  readonly candidateLogs: VerificationGateResult;
}

export interface VerificationExecutionResult {
  readonly passed: boolean;
  readonly failureCode: VerificationFailureCode | null;
  readonly planHash: string;
  readonly targetSnapshotHash: string;
  readonly sandboxIdentifier: string | null;
  readonly checkResults: VerificationCheckResults;
  readonly boundedOutput: string;
  readonly cleanupSucceeded: boolean;
}

export interface VerificationConfiguration {
  readonly leaseMs: number;
  readonly buildTimeoutMs: number;
  readonly startupTimeoutMs: number;
  readonly testTimeoutMs: number;
  readonly healthCheckTimeoutMs: number;
  readonly outputMaxBytes: number;
  readonly resultTtlMs: number;
}

export class VerificationFailure extends Error {
  public constructor(
    public readonly code: VerificationFailureCode,
    message: string,
    public readonly cleanupFailed = false
  ) {
    super(message);
    this.name = "VerificationFailure";
  }
}
