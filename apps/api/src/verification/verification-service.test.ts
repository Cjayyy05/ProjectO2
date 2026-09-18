import type { Logger } from "pino";
import { describe, expect, it } from "vitest";
import type {
  VerificationSandbox,
  VerificationSandboxHandle,
  VerificationSandboxSpec
} from "../docker/verification-sandbox";
import { createLogger } from "../logging/logger";
import type { VerificationRepository } from "./verification-repository";
import { VerificationService } from "./verification-service";
import { createVerificationFixture } from "./verification-test-fixtures";
import type {
  ClaimedVerificationCandidate,
  VerificationConfiguration,
  VerificationExecutionResult
} from "./verification-types";
import { VerificationFailure } from "./verification-types";
import type {
  PreparedVerificationWorkspace,
  VerificationWorkspace
} from "./verification-workspace";

const config: VerificationConfiguration = {
  leaseMs: 30_000,
  buildTimeoutMs: 1_000,
  startupTimeoutMs: 5,
  testTimeoutMs: 1_000,
  healthCheckTimeoutMs: 100,
  outputMaxBytes: 4_096,
  resultTtlMs: 60_000
};

describe("VerificationService", () => {
  it("verifies the exact plan, records honest gates, and never exposes a production mutation API", async () => {
    const fixture = createVerificationFixture();
    const repository = new RepositoryStub(fixture.claimed);
    const workspace = new WorkspaceStub();
    const sandbox = new SandboxStub();
    const service = createService(repository, workspace, sandbox);

    await service.runCycle();

    expect(repository.marked).toBe(1);
    expect(repository.completed).toHaveLength(1);
    expect(repository.completed[0]).toMatchObject({
      passed: true,
      failureCode: null,
      planHash: fixture.plan.planHash,
      targetSnapshotHash: fixture.plan.targetSnapshotHash,
      cleanupSucceeded: true,
      checkResults: {
        tests: { status: "NOT_CONFIGURED", code: "TESTS_NOT_CONFIGURED" },
        healthCheck: { status: "PASSED" }
      }
    });
    expect(sandbox.buildSpecs).toHaveLength(1);
    expect(sandbox.cleanupCalls).toHaveLength(1);
    expect(sandbox.orphanCleanupCalls).toBe(1);
    expect(workspace.cleaned).toEqual(["C:/isolated/workspace"]);
    expect(Object.keys(sandbox).join(" ")).not.toMatch(/restartProduction|stopProduction|mount/i);
  });

  it("fails a tampered plan before workspace preparation or Docker access", async () => {
    const fixture = createVerificationFixture();
    const repository = new RepositoryStub({
      ...fixture.claimed,
      planValue: { ...fixture.plan, summary: "Tampered after planning." }
    });
    const workspace = new WorkspaceStub();
    const sandbox = new SandboxStub();

    await createService(repository, workspace, sandbox).runCycle();

    expect(workspace.prepared).toBe(0);
    expect(sandbox.buildSpecs).toHaveLength(0);
    expect(repository.completed[0]).toMatchObject({
      passed: false,
      failureCode: "PLAN_INTEGRITY_MISMATCH",
      checkResults: { planIntegrity: { status: "FAILED" } }
    });
  });

  it("fails a mandatory trusted test and still cleans every temporary resource", async () => {
    const fixture = createVerificationFixture();
    const repository = new RepositoryStub(fixture.claimed);
    const workspace = new WorkspaceStub({ command: ["node", "test.js"], mandatory: true, timeoutMs: 500 });
    const sandbox = new SandboxStub();
    sandbox.testExitCode = 1;

    await createService(repository, workspace, sandbox).runCycle();

    expect(repository.completed[0]).toMatchObject({ passed: false, failureCode: "TEST_FAILED" });
    expect(sandbox.testCommands).toEqual([["node", "test.js"]]);
    expect(sandbox.cleanupCalls).toHaveLength(1);
    expect(workspace.cleaned).toHaveLength(1);
  });

  it("fails a required candidate health check without accepting arbitrary targets", async () => {
    const fixture = createVerificationFixture();
    const repository = new RepositoryStub(fixture.claimed);
    const sandbox = new SandboxStub();
    sandbox.healthResult = false;

    await createService(repository, new WorkspaceStub(), sandbox).runCycle();

    expect(sandbox.healthChecks).toEqual([{ path: "/health", timeoutMs: 100, port: 8080 }]);
    expect(repository.completed[0]).toMatchObject({
      passed: false,
      failureCode: "HEALTH_CHECK_FAILED"
    });
  });

  it("isolates cleanup failure while recording it on an otherwise valid result", async () => {
    const fixture = createVerificationFixture();
    const repository = new RepositoryStub(fixture.claimed);
    const sandbox = new SandboxStub();
    sandbox.cleanupFails = true;

    await createService(repository, new WorkspaceStub(), sandbox).runCycle();

    expect(repository.completed[0]).toMatchObject({ passed: true, cleanupSucceeded: false });
  });

  it("records cleanup failure that occurs during workspace preparation", async () => {
    const fixture = createVerificationFixture();
    const repository = new RepositoryStub(fixture.claimed);
    const workspace = new WorkspaceStub();
    workspace.prepareFailure = new VerificationFailure(
      "UNSAFE_SOURCE",
      "sanitized preparation failure",
      true
    );

    await createService(repository, workspace, new SandboxStub()).runCycle();

    expect(repository.completed[0]).toMatchObject({
      passed: false,
      failureCode: "UNSAFE_SOURCE",
      cleanupSucceeded: false
    });
    expect(repository.completed[0]?.boundedOutput).not.toContain("sanitized preparation failure");
  });

  it.each([
    ["BUILD_FAILED", "build"],
    ["BUILD_TIMEOUT", "build"],
    ["STARTUP_FAILED", "startup"],
    ["STARTUP_TIMEOUT", "startup"]
  ] as const)("records bounded typed %s failures at the correct gate", async (code, gate) => {
    const fixture = createVerificationFixture();
    const repository = new RepositoryStub(fixture.claimed);
    const sandbox = new SandboxStub();
    if (gate === "build") sandbox.buildFailure = new VerificationFailure(code, "raw detail ignored");
    else sandbox.startupFailure = new VerificationFailure(code, "raw detail ignored");

    await createService(repository, new WorkspaceStub(), sandbox).runCycle();

    expect(repository.completed[0]).toMatchObject({
      passed: false,
      failureCode: code,
      checkResults: { [gate]: { status: "FAILED", code } }
    });
    expect(repository.completed[0]?.boundedOutput).not.toContain("raw detail ignored");
  });

  it("does not persist after losing its claim", async () => {
    const fixture = createVerificationFixture();
    const repository = new RepositoryStub(fixture.claimed);
    repository.markResult = false;
    const sandbox = new SandboxStub();

    await createService(repository, new WorkspaceStub(), sandbox).runCycle();

    expect(sandbox.buildSpecs).toHaveLength(0);
    expect(repository.completed).toHaveLength(0);
  });
});

class RepositoryStub implements VerificationRepository {
  public marked = 0;
  public markResult = true;
  public completed: VerificationExecutionResult[] = [];
  private returned = false;

  public constructor(private readonly candidate: ClaimedVerificationCandidate) {}

  public async claimNext(): Promise<ClaimedVerificationCandidate | null> {
    if (this.returned) return null;
    this.returned = true;
    return this.candidate;
  }

  public async markRunning(): Promise<boolean> {
    this.marked += 1;
    return this.markResult;
  }

  public async renewClaim(): Promise<boolean> {
    return true;
  }

  public async complete(
    _candidate: ClaimedVerificationCandidate,
    result: VerificationExecutionResult
  ): Promise<boolean> {
    this.completed.push(result);
    return true;
  }
}

class WorkspaceStub implements VerificationWorkspace {
  public prepared = 0;
  public cleaned: string[] = [];
  public orphanCleanupCalls = 0;
  public prepareFailure: VerificationFailure | null = null;

  public constructor(private readonly test: PreparedVerificationWorkspace["test"] = null) {}

  public async prepare(): Promise<PreparedVerificationWorkspace> {
    this.prepared += 1;
    if (this.prepareFailure !== null) throw this.prepareFailure;
    return {
      path: "C:/isolated/workspace",
      buildFiles: ["Dockerfile"],
      dockerfilePath: "Dockerfile",
      environment: { PORT: "8080" },
      test: this.test
    };
  }

  public async cleanup(path: string): Promise<void> {
    this.cleaned.push(path);
  }

  public async cleanupOrphans(): Promise<void> {
    this.orphanCleanupCalls += 1;
  }
}

class SandboxStub implements VerificationSandbox {
  public buildSpecs: VerificationSandboxSpec[] = [];
  public cleanupCalls: string[] = [];
  public testCommands: readonly string[][] = [];
  public testExitCode = 0;
  public cleanupFails = false;
  public orphanCleanupCalls = 0;
  public buildFailure: VerificationFailure | null = null;
  public startupFailure: VerificationFailure | null = null;
  public healthResult = true;
  public healthChecks: Array<{ readonly path: string; readonly timeoutMs: number; readonly port: number }> = [];

  public async cleanupOrphans(): Promise<void> {
    this.orphanCleanupCalls += 1;
  }

  public async buildAndStart(spec: VerificationSandboxSpec): Promise<VerificationSandboxHandle> {
    if (this.buildFailure !== null) throw this.buildFailure;
    this.buildSpecs.push(spec);
    return {
      runId: spec.runId,
      imageTag: spec.imageTag,
      containerName: spec.containerName,
      networkName: spec.networkName,
      containerId: "candidate-container",
      containerPort: spec.containerPort
    };
  }

  public async waitForStartup(): Promise<void> {
    if (this.startupFailure !== null) throw this.startupFailure;
  }

  public async checkHealth(
    handle: VerificationSandboxHandle,
    path: string,
    timeoutMs: number
  ): Promise<boolean> {
    this.healthChecks.push({ path, timeoutMs, port: handle.containerPort });
    return this.healthResult;
  }

  public async runTrustedTest(
    _handle: VerificationSandboxHandle,
    test: { readonly command: readonly string[] }
  ): Promise<{ readonly exitCode: number }> {
    this.testCommands = [...this.testCommands, [...test.command]];
    return { exitCode: this.testExitCode };
  }

  public async collectLogs(): Promise<void> {}

  public async cleanup(resources: { readonly runId: string; readonly containerName: string }): Promise<void> {
    this.cleanupCalls.push(resources.containerName);
    if (this.cleanupFails) throw new Error("sanitized test cleanup failure");
  }
}

function createService(
  repository: VerificationRepository,
  workspace: VerificationWorkspace,
  sandbox: VerificationSandbox,
  logger: Logger = createLogger("test")
): VerificationService {
  return new VerificationService(repository, workspace, sandbox, config, logger);
}
