import { Readable } from "node:stream";
import Docker from "dockerode";
import {
  DockerEvidenceError,
  type ContainerEvidenceSnapshot,
  type ContainerRuntimeState,
  type DockerEvidenceSource
} from "./docker-service";

const LOG_IDLE_TIMEOUT_MS = 500;
const SAFE_ENVIRONMENT_VALUES = new Set(["NODE_ENV", "APP_ENV", "APPLICATION_MODE"]);
const MAX_ENVIRONMENT_NAMES = 256;
const MAX_PUBLISHED_HOST_PORTS = 256;

export class DockerodeEvidenceSource implements DockerEvidenceSource {
  public constructor(
    private readonly docker: Docker,
    private readonly timeoutMs: number
  ) {}

  public async inspectEvidence(containerIdentifier: string): Promise<ContainerEvidenceSnapshot> {
    try {
      const result = await withTimeout(
        this.docker.getContainer(containerIdentifier).inspect(),
        this.timeoutMs
      );
      const environment = extractSafeEnvironment(result.Config.Env ?? []);
      return {
        state: normalizeState(result.State.Running, result.State.Status),
        publishedHostPorts: extractPublishedHostPorts(result.NetworkSettings.Ports),
        exitCode: Number.isInteger(result.State.ExitCode) ? result.State.ExitCode : null,
        restartCount: Number.isInteger(result.RestartCount) ? result.RestartCount : null,
        oomKilled: typeof result.State.OOMKilled === "boolean" ? result.State.OOMKilled : null,
        startedAt: normalizeTimestamp(result.State.StartedAt),
        finishedAt: normalizeTimestamp(result.State.FinishedAt),
        imageId: normalizeImageId(result.Image),
        dockerHealthStatus: normalizeHealthStatus(result.State.Health?.Status),
        environmentNames: environment.names,
        allowlistedEnvironment: environment.allowlistedValues
      };
    } catch (error) {
      if (isNotFoundError(error)) {
        return missingSnapshot();
      }
      throw normalizeDockerError(error);
    }
  }

  public async *streamRecentLogs(
    containerIdentifier: string,
    tailLines: number
  ): AsyncIterable<Uint8Array> {
    const container = this.docker.getContainer(containerIdentifier);
    let stream: Readable;
    let multiplexed: boolean;
    try {
      const inspected = await withTimeout(container.inspect(), this.timeoutMs);
      const rawStream = await withTimeout(
        container.logs({
          follow: true,
          stdout: true,
          stderr: true,
          timestamps: true,
          tail: tailLines
        }),
        this.timeoutMs
      );
      stream = Buffer.isBuffer(rawStream) ? Readable.from([rawStream]) : Readable.from(rawStream);
      multiplexed = !inspected.Config.Tty;
    } catch (error) {
      throw normalizeDockerError(error, "DOCKER_LOGS_FAILED");
    }

    const chunks = readUntilIdle(stream, LOG_IDLE_TIMEOUT_MS, this.timeoutMs);
    try {
      if (multiplexed) {
        yield* demultiplexDockerChunks(chunks);
      } else {
        yield* chunks;
      }
    } catch (error) {
      if (error instanceof DockerEvidenceError) {
        throw error;
      }
      throw new DockerEvidenceError("DOCKER_LOGS_FAILED");
    }
  }
}

export function createDockerEvidenceSource(
  timeoutMs: number,
  socketPath?: string
): DockerEvidenceSource {
  const resolvedSocketPath =
    socketPath ?? (process.platform === "win32" ? "//./pipe/dockerDesktopLinuxEngine" : undefined);
  const docker =
    resolvedSocketPath === undefined ? new Docker() : new Docker({ socketPath: resolvedSocketPath });
  return new DockerodeEvidenceSource(docker, timeoutMs);
}

export async function* readUntilIdle(
  stream: Readable,
  idleTimeoutMs: number,
  absoluteTimeoutMs: number
): AsyncIterable<Uint8Array> {
  const iterator = stream[Symbol.asyncIterator]();
  const deadline = Date.now() + absoluteTimeoutMs;
  try {
    while (Date.now() < deadline) {
      const waitMs = Math.min(idleTimeoutMs, Math.max(1, deadline - Date.now()));
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        iterator.next().then((value) => ({ type: "chunk" as const, value })),
        new Promise<{ readonly type: "idle" }>((resolve) => {
          idleTimer = setTimeout(() => resolve({ type: "idle" }), waitMs);
        })
      ]).finally(() => {
        if (idleTimer !== undefined) clearTimeout(idleTimer);
      });
      if (result.type === "idle" || result.value.done) {
        return;
      }
      const value = result.value.value;
      yield Buffer.isBuffer(value) ? value : Buffer.from(value);
    }
    throw new DockerEvidenceError("DOCKER_TIMEOUT");
  } finally {
    stream.destroy();
  }
}

async function* demultiplexDockerChunks(
  chunks: AsyncIterable<Uint8Array>
): AsyncIterable<Uint8Array> {
  const header = Buffer.alloc(8);
  let headerBytes = 0;
  let payloadBytes = 0;

  for await (const value of chunks) {
    const chunk = Buffer.from(value);
    let offset = 0;
    while (offset < chunk.length) {
      if (payloadBytes === 0) {
        const headerCopy = Math.min(8 - headerBytes, chunk.length - offset);
        chunk.copy(header, headerBytes, offset, offset + headerCopy);
        headerBytes += headerCopy;
        offset += headerCopy;
        if (headerBytes < 8) {
          continue;
        }
        payloadBytes = header.readUInt32BE(4);
        headerBytes = 0;
        if (payloadBytes === 0) {
          continue;
        }
      }

      const payloadCopy = Math.min(payloadBytes, chunk.length - offset);
      yield chunk.subarray(offset, offset + payloadCopy);
      payloadBytes -= payloadCopy;
      offset += payloadCopy;
    }
  }
}

export function extractSafeEnvironment(entries: readonly string[]): {
  readonly names: readonly string[];
  readonly allowlistedValues: Readonly<Record<string, string>>;
} {
  const names = new Set<string>();
  const allowlistedValues: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.length > 1_024) {
      continue;
    }
    const separator = entry.indexOf("=");
    const name = separator === -1 ? entry : entry.slice(0, separator);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      continue;
    }
    if (names.size >= MAX_ENVIRONMENT_NAMES && !names.has(name)) break;
    names.add(name);
    if (SAFE_ENVIRONMENT_VALUES.has(name) && separator !== -1) {
      const value = entry.slice(separator + 1);
      if (/^[A-Za-z0-9._-]{1,64}$/.test(value)) {
        allowlistedValues[name] = value;
      }
    }
  }
  return { names: [...names].sort(), allowlistedValues };
}

export function extractPublishedHostPorts(
  ports: Record<string, readonly { HostPort: string }[] | null> | undefined
): readonly number[] {
  if (ports === undefined) {
    return [];
  }
  const result = new Set<number>();
  for (const bindings of Object.values(ports)) {
    for (const binding of bindings ?? []) {
      const port = Number(binding.HostPort);
      if (Number.isInteger(port) && port >= 1 && port <= 65_535) {
        result.add(port);
        if (result.size >= MAX_PUBLISHED_HOST_PORTS) return [...result];
      }
    }
  }
  return [...result];
}

function normalizeState(running: boolean, status?: string): ContainerRuntimeState {
  if (status === "restarting") return "RESTARTING";
  if (status === "paused") return "PAUSED";
  return running ? "RUNNING" : "STOPPED";
}

function normalizeHealthStatus(
  status: string | undefined
): ContainerEvidenceSnapshot["dockerHealthStatus"] {
  return status === "healthy" || status === "unhealthy" || status === "starting" ? status : "none";
}

function normalizeTimestamp(value: string | undefined): string | null {
  if (value === undefined || value.startsWith("0001-01-01")) {
    return null;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function normalizeImageId(value: string | undefined): string | null {
  return value !== undefined && /^[A-Za-z0-9]+:[A-Fa-f0-9]{12,128}$/.test(value) ? value : null;
}

function missingSnapshot(): ContainerEvidenceSnapshot {
  return {
    state: "MISSING",
    publishedHostPorts: [],
    exitCode: null,
    restartCount: null,
    oomKilled: null,
    startedAt: null,
    finishedAt: null,
    imageId: null,
    dockerHealthStatus: "none",
    environmentNames: [],
    allowlistedEnvironment: {}
  };
}

function normalizeDockerError(
  error: unknown,
  fallback: DockerEvidenceError["code"] = "DOCKER_UNAVAILABLE"
): DockerEvidenceError {
  if (error instanceof DockerEvidenceError) {
    return error;
  }
  return new DockerEvidenceError(fallback);
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 404;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new DockerEvidenceError("DOCKER_TIMEOUT")), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
