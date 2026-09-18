import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import type { Logger } from "pino";
import type { VerificationSandbox, VerificationSandboxHandle } from "../docker/verification-sandbox";
import { validateRemediationPlanIntegrity } from "../remediation/remediation-validation";
import { BoundedVerificationOutput } from "./bounded-output";
import { validateVerificationBaseline } from "./verification-baseline";
import type { VerificationRepository } from "./verification-repository";
import {
  VerificationFailure,
  type ClaimedVerificationCandidate,
  type VerificationCandidate,
  type VerificationCheckResults,
  type VerificationConfiguration,
  type VerificationExecutionResult,
  type VerificationFailureCode,
  type VerificationGateResult
} from "./verification-types";
import {
  type PreparedVerificationWorkspace,
  type VerificationWorkspace
} from "./verification-workspace";

const notRun = (code: string, summary: string): VerificationGateResult => ({
  status: "NOT_CONFIGURED",
  code,
  summary
});
const passed = (code: string, summary: string): VerificationGateResult => ({
  status: "PASSED",
  code,
  summary
});
const failed = (code: string, summary: string): VerificationGateResult => ({
  status: "FAILED",
  code,
  summary
});

export interface VerificationCycleRunner {
  runCycle(): Promise<void>;
}

export class VerificationService implements VerificationCycleRunner {
  private startupReconciled = false;

  public constructor(
    private readonly repository: VerificationRepository,
    private readonly workspaceManager: VerificationWorkspace,
    private readonly sandbox: VerificationSandbox,
    private readonly config: VerificationConfiguration,
    private readonly logger: Logger
  ) {}

  public async runCycle(): Promise<void> {
    if (!this.startupReconciled) {
      await this.sandbox.cleanupOrphans();
      await this.workspaceManager.cleanupOrphans();
      this.startupReconciled = true;
    }
    const claimed = await this.repository.claimNext(this.config.leaseMs);
    if (claimed === null) return;
    const marked = await this.repository.markRunning(claimed);
    if (!marked) return;
    let leaseLost = false;
    let renewalInProgress = false;
    const renewalIntervalMs = Math.max(1_000, Math.floor(this.config.leaseMs / 3));
    const leaseTimer = setInterval(() => {
      if (renewalInProgress || leaseLost) return;
      renewalInProgress = true;
      void this.repository.renewClaim(claimed)
        .then((renewed) => { if (!renewed) leaseLost = true; })
        .catch(() => { leaseLost = true; })
        .finally(() => { renewalInProgress = false; });
    }, renewalIntervalMs);
    try {
      const result = await this.verify(claimed);
      if (!leaseLost) await this.repository.complete(claimed, result, this.config.resultTtlMs);
    } finally {
      clearInterval(leaseTimer);
    }
  }

  private async verify(claimed: ClaimedVerificationCandidate): Promise<VerificationExecutionResult> {
    const output = new BoundedVerificationOutput(this.config.outputMaxBytes);
    const resourceId = randomUUID();
    const resources = {
      runId: claimed.runId,
      imageTag: `selfheal-verification:${resourceId}`,
      containerName: `selfheal-verification-${resourceId}`,
      networkName: `selfheal-verification-${resourceId}`
    };
    let workspace: PreparedVerificationWorkspace | null = null;
    let handle: VerificationSandboxHandle | null = null;
    let cleanupSucceeded = true;
    let failureCode: VerificationFailureCode | null = null;
    let planHash = extractDigest(claimed.planValue, "planHash");
    let targetSnapshotHash = extractDigest(claimed.planValue, "targetSnapshotHash");
    let checks = initialChecks();

    try {
      const plan = validateRemediationPlanIntegrity(claimed.planValue);
      if (plan === null) {
        throw new VerificationFailure("PLAN_INTEGRITY_MISMATCH", "Plan integrity validation failed");
      }
      planHash = plan.planHash;
      targetSnapshotHash = plan.targetSnapshotHash;
      const candidate: VerificationCandidate = { ...claimed, plan };
      checks = { ...checks, planIntegrity: passed("PLAN_HASH_VALID", "Exact plan digest is valid.") };

      const verificationTarget = validateVerificationBaseline(candidate);
      checks = { ...checks, baseline: passed("BASELINE_VALID", "Trusted target baseline matches.") };
      workspace = await this.workspaceManager.prepare(candidate);
      checks = { ...checks, application: passed("ACTION_APPLIED", "Exact action was staged in isolation.") };

      handle = await this.sandbox.buildAndStart({
        ...resources,
        workspace,
        containerPort: verificationTarget.expectedPort,
        buildTimeoutMs: this.config.buildTimeoutMs,
        output
      });
      checks = {
        ...checks,
        build: passed("IMAGE_BUILT", "Disposable candidate image built successfully.")
      };

      await this.sandbox.waitForStartup(handle, this.config.startupTimeoutMs);
      checks = { ...checks, startup: passed("CANDIDATE_STARTED", "Candidate remained running.") };

      if (workspace.test === null) {
        checks = { ...checks, tests: notRun("TESTS_NOT_CONFIGURED", "No trusted tests are configured.") };
      } else {
        const testResult = await this.sandbox.runTrustedTest(handle, {
          ...workspace.test,
          timeoutMs: Math.min(workspace.test.timeoutMs, this.config.testTimeoutMs)
        }, output);
        if (testResult.exitCode !== 0) {
          checks = { ...checks, tests: failed("TEST_EXIT_NONZERO", "Configured tests failed.") };
          if (workspace.test.mandatory) {
            throw new VerificationFailure("TEST_FAILED", "Required configured tests failed");
          }
        } else {
          checks = { ...checks, tests: passed("TESTS_PASSED", "Configured tests passed.") };
        }
      }

      const health = await this.waitForHealth(
        handle,
        verificationTarget.healthCheckPath,
        this.config.startupTimeoutMs
      );
      if (!health) throw new VerificationFailure("HEALTH_CHECK_FAILED", "Candidate health check failed");
      checks = { ...checks, healthCheck: passed("HEALTHY", "Candidate health check passed.") };

      await this.sandbox.collectLogs(handle, output);
      checks = { ...checks, candidateLogs: passed("LOGS_BOUNDED", "Bounded candidate logs were captured.") };

      const finalPlan = validateRemediationPlanIntegrity(plan);
      if (finalPlan === null || finalPlan.planHash !== planHash) {
        throw new VerificationFailure("PLAN_INTEGRITY_MISMATCH", "Plan changed during verification");
      }
    } catch (error) {
      const failure = normalizeFailure(error);
      if (failure.cleanupFailed) {
        cleanupSucceeded = false;
        this.logger.warn(
          { runId: claimed.runId, errorName: "VerificationWorkspaceCleanupError" },
          "Verification workspace cleanup failed during preparation"
        );
        output.append("Verification workspace cleanup was incomplete.\n");
      }
      failureCode = failure.code;
      checks = markFailure(checks, failure.code);
      output.append(`Verification failed with ${failure.code}.\n`);
      if (handle !== null) await this.sandbox.collectLogs(handle, output);
    } finally {
      await this.sandbox.cleanup({ ...resources, ...(handle ?? {}) }).catch((error: unknown) => {
        cleanupSucceeded = false;
        this.logger.warn(
          { runId: claimed.runId, errorName: error instanceof Error ? error.name : "UnknownError" },
          "Verification sandbox cleanup failed"
        );
        output.append("Verification sandbox cleanup was incomplete.\n");
      });
      if (workspace !== null) {
        await this.workspaceManager.cleanup(workspace.path).catch((error: unknown) => {
          cleanupSucceeded = false;
          this.logger.warn(
            { runId: claimed.runId, errorName: error instanceof Error ? error.name : "UnknownError" },
            "Verification workspace cleanup failed"
          );
          output.append("Verification workspace cleanup was incomplete.\n");
        });
      }
    }

    return {
      passed: failureCode === null,
      failureCode,
      planHash,
      targetSnapshotHash,
      sandboxIdentifier: resources.containerName,
      checkResults: checks,
      boundedOutput: output.value(),
      cleanupSucceeded
    };
  }

  private async waitForHealth(
    handle: VerificationSandboxHandle,
    path: string,
    timeoutMs: number
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    do {
      if (await this.sandbox.checkHealth(handle, path, this.config.healthCheckTimeoutMs)) return true;
      await wait(Math.min(250, Math.max(1, deadline - Date.now())));
    } while (Date.now() < deadline);
    return false;
  }
}

function initialChecks(): VerificationCheckResults {
  return {
    schemaVersion: 1,
    planIntegrity: notRun("NOT_RUN", "Plan integrity was not evaluated."),
    baseline: notRun("NOT_RUN", "Baseline was not evaluated."),
    application: notRun("NOT_RUN", "Action was not staged."),
    build: notRun("NOT_RUN", "Candidate image was not built."),
    startup: notRun("NOT_RUN", "Candidate was not started."),
    tests: notRun("NOT_RUN", "Tests were not evaluated."),
    healthCheck: notRun("NOT_RUN", "Health was not evaluated."),
    candidateLogs: notRun("NOT_COLLECTED", "Candidate logs were not collected.")
  };
}

function markFailure(
  checks: VerificationCheckResults,
  code: VerificationFailureCode
): VerificationCheckResults {
  if (code.startsWith("BUILD")) return { ...checks, build: failed(code, "Candidate build failed.") };
  if (code.startsWith("STARTUP")) {
    return {
      ...checks,
      build: checks.build.status === "NOT_CONFIGURED"
        ? passed("IMAGE_BUILT", "Disposable candidate image built successfully.")
        : checks.build,
      startup: failed(code, "Candidate startup failed.")
    };
  }
  if (code.startsWith("TEST")) return { ...checks, tests: failed(code, "Configured tests failed.") };
  if (code === "HEALTH_CHECK_FAILED") {
    return { ...checks, healthCheck: failed(code, "Candidate health check failed.") };
  }
  if (code === "PLAN_INTEGRITY_MISMATCH") {
    return { ...checks, planIntegrity: failed(code, "Plan integrity validation failed.") };
  }
  if (code.includes("BASELINE") || code === "UNSAFE_DEPENDENCY") {
    return { ...checks, baseline: failed(code, "Trusted target baseline validation failed.") };
  }
  return { ...checks, application: failed(code, "Isolated remediation staging failed.") };
}

function normalizeFailure(error: unknown): VerificationFailure {
  return error instanceof VerificationFailure
    ? error
    : new VerificationFailure("INTERNAL_VERIFICATION_ERROR", "Unexpected verification failure");
}

function extractDigest(value: unknown, field: "planHash" | "targetSnapshotHash"): string {
  if (typeof value === "object" && value !== null && field in value) {
    const digest: unknown = Reflect.get(value, field);
    if (typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest)) return digest;
  }
  return "0".repeat(64);
}
