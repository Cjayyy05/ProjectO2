import Docker from "dockerode";
import {
  DockerInspectionError,
  type ContainerInspection,
  type ContainerInspector,
  type ContainerRuntimeState
} from "./docker-service";

export interface RawContainerState {
  readonly running: boolean;
  readonly status?: string;
  readonly publishedHostPorts: readonly number[];
}

export interface ContainerInspectClient {
  inspect(containerIdentifier: string): Promise<RawContainerState>;
}

export class DockerodeContainerInspector implements ContainerInspector {
  public constructor(
    private readonly client: ContainerInspectClient,
    private readonly timeoutMs: number
  ) {}

  public async inspect(containerIdentifier: string): Promise<ContainerInspection> {
    try {
      const raw = await withTimeout(
        this.client.inspect(containerIdentifier),
        this.timeoutMs,
        new DockerInspectionError("DOCKER_TIMEOUT")
      );
      return {
        state: normalizeContainerState(raw),
        publishedHostPorts: raw.publishedHostPorts
      };
    } catch (error) {
      if (error instanceof DockerInspectionError) {
        throw error;
      }
      if (isNotFoundError(error)) {
        return { state: "MISSING", publishedHostPorts: [] };
      }
      throw new DockerInspectionError("DOCKER_UNAVAILABLE");
    }
  }
}

export function createDockerContainerInspector(
  timeoutMs: number,
  socketPath?: string
): ContainerInspector {
  const resolvedSocketPath =
    socketPath ?? (process.platform === "win32" ? "//./pipe/dockerDesktopLinuxEngine" : undefined);
  const docker =
    resolvedSocketPath === undefined ? new Docker() : new Docker({ socketPath: resolvedSocketPath });
  return new DockerodeContainerInspector(
    {
      async inspect(containerIdentifier) {
        const result = await docker.getContainer(containerIdentifier).inspect();
        return {
          running: result.State.Running,
          status: result.State.Status,
          publishedHostPorts: extractPublishedHostPorts(result.NetworkSettings.Ports)
        };
      }
    },
    timeoutMs
  );
}

function extractPublishedHostPorts(
  ports: Record<string, readonly { HostPort: string }[] | null> | undefined
): readonly number[] {
  if (ports === undefined) {
    return [];
  }
  const publishedPorts = Object.values(ports)
    .flatMap((bindings) => bindings ?? [])
    .map((binding) => Number(binding.HostPort))
    .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65_535);
  return [...new Set(publishedPorts)];
}

function normalizeContainerState(raw: RawContainerState): ContainerRuntimeState {
  if (raw.status === "restarting") {
    return "RESTARTING";
  }
  if (raw.status === "paused") {
    return "PAUSED";
  }
  if (raw.running) {
    return "RUNNING";
  }
  return "STOPPED";
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    error.statusCode === 404
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, error: Error): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(error), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
