import { setTimeout as wait } from "node:timers/promises";
import Docker from "dockerode";
import { healthCheckPathSchema } from "../monitoring/health-check-path";
import type { BoundedVerificationOutput } from "../verification/bounded-output";
import { VerificationFailure } from "../verification/verification-types";
import type {
  VerificationCommandResult,
  VerificationSandbox,
  VerificationSandboxHandle,
  VerificationSandboxSpec
} from "./verification-sandbox";

const LABEL = "selfheal.verification";
const LABEL_VALUE = "managed";
const RUN_LABEL = "selfheal.verification.run";

export class DockerodeVerificationSandbox implements VerificationSandbox {
  public constructor(private readonly docker: Docker) {}

  public async cleanupOrphans(): Promise<void> {
    const failures: string[] = [];
    const filters = { label: [`${LABEL}=${LABEL_VALUE}`] };
    const [containers, networks, images] = await Promise.all([
      this.docker.listContainers({ all: true, filters }),
      this.docker.listNetworks({ filters }),
      this.docker.listImages({ filters })
    ]).catch((error: unknown) => {
      throw normalizeDockerFailure(error, "STARTUP_FAILED");
    });
    for (const container of containers) {
      await this.docker.getContainer(container.Id).remove({ force: true, v: true }).catch(() => {
        failures.push("container");
      });
    }
    for (const network of networks) {
      if (network.Id === undefined) continue;
      await this.docker.getNetwork(network.Id).remove().catch(() => {
        failures.push("network");
      });
    }
    for (const image of images) {
      await this.docker.getImage(image.Id).remove({ force: true }).catch(() => {
        failures.push("image");
      });
    }
    if (failures.length > 0) throw new Error("Verification orphan cleanup was incomplete");
  }

  public async buildAndStart(spec: VerificationSandboxSpec): Promise<VerificationSandboxHandle> {
    await this.build(spec);
    let network: Docker.Network | null = null;
    try {
      network = await this.docker.createNetwork({
        Name: spec.networkName,
        Internal: true,
        CheckDuplicate: true,
        Labels: verificationLabels(spec.runId)
      });
      const container = await this.docker.createContainer(createCandidateContainerOptions(spec));
      await container.start();
      return {
        runId: spec.runId,
        imageTag: spec.imageTag,
        containerName: spec.containerName,
        networkName: spec.networkName,
        containerId: container.id,
        containerPort: spec.containerPort
      };
    } catch (error) {
      await network?.remove().catch(() => undefined);
      throw normalizeDockerFailure(error, "STARTUP_FAILED");
    }
  }

  public async waitForStartup(handle: VerificationSandboxHandle, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const container = this.docker.getContainer(handle.containerId);
    let observedRunning = false;
    while (Date.now() < deadline) {
      const inspected = await container.inspect().catch((error: unknown) => {
        throw normalizeDockerFailure(error, "STARTUP_FAILED");
      });
      if (!inspected.State.Running) {
        throw new VerificationFailure("STARTUP_FAILED", "Candidate exited before verification");
      }
      if (observedRunning) return;
      observedRunning = true;
      await wait(Math.min(500, Math.max(1, deadline - Date.now())));
    }
    throw new VerificationFailure("STARTUP_TIMEOUT", "Candidate startup timed out");
  }

  public async checkHealth(
    handle: VerificationSandboxHandle,
    path: string,
    timeoutMs: number
  ): Promise<boolean> {
    const safePath = healthCheckPathSchema.parse(path);
    const probe = [
      "const port=Number(process.argv[1]);",
      "const path=process.argv[2];",
      "const controller=new AbortController();",
      `const timer=setTimeout(()=>controller.abort(),${timeoutMs});`,
      "fetch(`http://127.0.0.1:${port}${path}`,{redirect:'manual',signal:controller.signal})",
      ".then(async response=>{await response.body?.cancel();clearTimeout(timer);",
      "process.exit(response.status>=200&&response.status<=399?0:1)})",
      ".catch(()=>process.exit(1))"
    ].join("");
    const container = this.docker.getContainer(handle.containerId);
    try {
      const execution = await container.exec({
        Cmd: ["node", "-e", probe, String(handle.containerPort), safePath],
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
        Privileged: false
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs + 250);
      try {
        const stream = await execution.start({ Detach: false, Tty: true, abortSignal: controller.signal });
        for await (const chunk of stream as AsyncIterable<Uint8Array>) {
          void chunk;
          if (controller.signal.aborted) return false;
        }
        const inspected = await execution.inspect();
        return inspected.ExitCode === 0;
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return false;
    }
  }

  public async runTrustedTest(
    handle: VerificationSandboxHandle,
    test: { readonly command: readonly string[]; readonly timeoutMs: number },
    output: BoundedVerificationOutput
  ): Promise<VerificationCommandResult> {
    const container = this.docker.getContainer(handle.containerId);
    const execution = await container.exec({
      Cmd: [...test.command],
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Privileged: false
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), test.timeoutMs);
    try {
      const stream = await execution.start({ Detach: false, Tty: true, abortSignal: controller.signal });
      await consumeStream(stream, output, controller.signal);
      const inspected = await execution.inspect();
      return { exitCode: inspected.ExitCode ?? -1 };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new VerificationFailure("TEST_TIMEOUT", "Configured verification test timed out");
      }
      throw normalizeDockerFailure(error, "TEST_FAILED");
    } finally {
      clearTimeout(timeout);
    }
  }

  public async collectLogs(
    handle: VerificationSandboxHandle,
    output: BoundedVerificationOutput
  ): Promise<void> {
    try {
      const logs = await this.docker.getContainer(handle.containerId).logs({
        stdout: true,
        stderr: true,
        timestamps: false,
        follow: false,
        tail: 200
      });
      if (Buffer.isBuffer(logs)) output.append(logs.toString("utf8"));
    } catch {
      output.append("Candidate logs were unavailable.\n");
    }
  }

  public async cleanup(resources: Partial<VerificationSandboxHandle> & {
    readonly runId: string;
    readonly imageTag: string;
    readonly containerName: string;
    readonly networkName: string;
  }): Promise<void> {
    const failures: string[] = [];
    const container = this.docker.getContainer(resources.containerId ?? resources.containerName);
    try {
      const inspected = await container.inspect();
      if (!hasManagedLabels(inspected.Config.Labels, resources.runId)) failures.push("container-label");
      else await container.remove({ force: true, v: true });
    } catch (error) {
      if (!isNotFound(error)) failures.push("container");
    }
    const network = this.docker.getNetwork(resources.networkName);
    try {
      const inspected = await network.inspect();
      if (!hasManagedLabels(inspected.Labels, resources.runId)) failures.push("network-label");
      else await network.remove();
    } catch (error) {
      if (!isNotFound(error)) failures.push("network");
    }
    const image = this.docker.getImage(resources.imageTag);
    try {
      const inspected = await image.inspect();
      if (!hasManagedLabels(inspected.Config?.Labels, resources.runId)) failures.push("image-label");
      else await image.remove({ force: true });
    } catch (error) {
      if (!isNotFound(error)) failures.push("image");
    }
    if (failures.length > 0) throw new Error(`Verification cleanup failed: ${failures.join(",")}`);
  }

  private async build(spec: VerificationSandboxSpec): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), spec.buildTimeoutMs);
    let buildError = false;
    try {
      const stream = await this.docker.buildImage({
        context: spec.workspace.path,
        src: [...spec.workspace.buildFiles]
      }, {
        t: spec.imageTag,
        dockerfile: spec.workspace.dockerfilePath,
        rm: true,
        forcerm: true,
        pull: false,
        networkmode: "none",
        memory: 512 * 1_024 * 1_024,
        memswap: 512 * 1_024 * 1_024,
        cpushares: 512,
        labels: verificationLabels(spec.runId),
        abortSignal: controller.signal
      });
      buildError = await consumeBuildStream(stream, spec.output, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new VerificationFailure("BUILD_TIMEOUT", "Candidate image build timed out");
      }
      throw normalizeDockerFailure(error, "BUILD_FAILED");
    } finally {
      clearTimeout(timeout);
    }
    if (buildError) throw new VerificationFailure("BUILD_FAILED", "Candidate image build failed");
  }
}

export function createCandidateContainerOptions(
  spec: VerificationSandboxSpec
): Docker.ContainerCreateOptions {
  const portKey = `${spec.containerPort}/tcp`;
  return {
    name: spec.containerName,
    Image: spec.imageTag,
    Env: Object.entries(spec.workspace.environment).map(([name, value]) => `${name}=${value}`),
    Labels: verificationLabels(spec.runId),
    ExposedPorts: { [portKey]: {} },
    HostConfig: {
      NetworkMode: spec.networkName,
      Binds: [],
      Mounts: [],
      Privileged: false,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      ReadonlyRootfs: true,
      Tmpfs: { "/tmp": "rw,noexec,nosuid,size=16m" },
      Memory: 256 * 1_024 * 1_024,
      MemorySwap: 256 * 1_024 * 1_024,
      NanoCpus: 500_000_000,
      PidsLimit: 128,
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 }
    }
  };
}

function verificationLabels(runId: string): Readonly<Record<string, string>> {
  return { [LABEL]: LABEL_VALUE, [RUN_LABEL]: runId };
}

function hasManagedLabels(
  labels: Readonly<Record<string, string>> | undefined,
  runId: string
): boolean {
  return labels?.[LABEL] === LABEL_VALUE && labels[RUN_LABEL] === runId;
}

export function createDockerVerificationSandbox(socketPath?: string): VerificationSandbox {
  const resolved = socketPath ?? (process.platform === "win32"
    ? "//./pipe/dockerDesktopLinuxEngine"
    : undefined);
  return new DockerodeVerificationSandbox(
    resolved === undefined ? new Docker() : new Docker({ socketPath: resolved })
  );
}

async function consumeBuildStream(
  stream: NodeJS.ReadableStream,
  output: BoundedVerificationOutput,
  signal: AbortSignal
): Promise<boolean> {
  let pending = "";
  let failed = false;
  for await (const chunk of stream as AsyncIterable<Uint8Array | string>) {
    if (signal.aborted) throw new VerificationFailure("BUILD_TIMEOUT", "Candidate image build timed out");
    pending += Buffer.from(chunk).toString("utf8");
    const lines = pending.split("\n");
    pending = lines.pop()?.slice(-16_384) ?? "";
    for (const line of lines) {
      const parsed = parseBuildEvent(line);
      if (parsed.error) failed = true;
      output.append(`${parsed.message}\n`);
    }
  }
  if (pending.length > 0) {
    const parsed = parseBuildEvent(pending);
    if (parsed.error) failed = true;
    output.append(`${parsed.message}\n`);
  }
  return failed;
}

async function consumeStream(
  stream: NodeJS.ReadableStream,
  output: BoundedVerificationOutput,
  signal: AbortSignal
): Promise<void> {
  for await (const chunk of stream as AsyncIterable<Uint8Array | string>) {
    if (signal.aborted) throw new VerificationFailure("TEST_TIMEOUT", "Verification test timed out");
    output.append(Buffer.from(chunk).toString("utf8"));
  }
}

function parseBuildEvent(line: string): { readonly message: string; readonly error: boolean } {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value === "object" && value !== null) {
      const record = value as Readonly<Record<string, unknown>>;
      const error = typeof record.error === "string" ? record.error : null;
      const message = error ?? (typeof record.stream === "string"
        ? record.stream
        : typeof record.status === "string" ? record.status : "Docker build progress");
      return { message, error: error !== null };
    }
  } catch {
    return { message: "Docker build progress", error: false };
  }
  return { message: "Docker build progress", error: false };
}

function normalizeDockerFailure(
  error: unknown,
  fallback: "BUILD_FAILED" | "STARTUP_FAILED" | "TEST_FAILED"
): VerificationFailure {
  if (error instanceof VerificationFailure) return error;
  if (hasDockerUnavailableCode(error)) {
    return new VerificationFailure("DOCKER_UNAVAILABLE", "Docker verification runtime is unavailable");
  }
  return new VerificationFailure(fallback, "Docker verification operation failed");
}

function hasDockerUnavailableCode(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = Reflect.get(error, "code");
  if (["ECONNREFUSED", "ENOENT", "EPIPE", "ECONNRESET"].includes(String(code))) return true;
  const cause = Reflect.get(error, "cause");
  return cause !== undefined && cause !== error && hasDockerUnavailableCode(cause);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "statusCode" in error &&
    error.statusCode === 404;
}
