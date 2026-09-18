import type { PreparedVerificationWorkspace } from "../verification/verification-workspace";
import type { BoundedVerificationOutput } from "../verification/bounded-output";
import type { TrustedVerificationTest } from "../verification/verification-types";

export interface VerificationSandboxSpec {
  readonly runId: string;
  readonly imageTag: string;
  readonly containerName: string;
  readonly networkName: string;
  readonly workspace: PreparedVerificationWorkspace;
  readonly containerPort: number;
  readonly buildTimeoutMs: number;
  readonly output: BoundedVerificationOutput;
}

export interface VerificationSandboxHandle {
  readonly runId: string;
  readonly imageTag: string;
  readonly containerName: string;
  readonly networkName: string;
  readonly containerId: string;
  readonly containerPort: number;
}

export interface VerificationCommandResult {
  readonly exitCode: number;
}

export interface VerificationSandbox {
  cleanupOrphans(): Promise<void>;
  buildAndStart(spec: VerificationSandboxSpec): Promise<VerificationSandboxHandle>;
  waitForStartup(handle: VerificationSandboxHandle, timeoutMs: number): Promise<void>;
  checkHealth(
    handle: VerificationSandboxHandle,
    path: string,
    timeoutMs: number
  ): Promise<boolean>;
  runTrustedTest(
    handle: VerificationSandboxHandle,
    test: TrustedVerificationTest,
    output: BoundedVerificationOutput
  ): Promise<VerificationCommandResult>;
  collectLogs(
    handle: VerificationSandboxHandle,
    output: BoundedVerificationOutput
  ): Promise<void>;
  cleanup(resources: Partial<VerificationSandboxHandle> & {
    readonly runId: string;
    readonly imageTag: string;
    readonly containerName: string;
    readonly networkName: string;
  }): Promise<void>;
}
