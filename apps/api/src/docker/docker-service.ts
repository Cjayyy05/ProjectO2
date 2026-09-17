export type ContainerRuntimeState =
  | "RUNNING"
  | "STOPPED"
  | "MISSING"
  | "PAUSED"
  | "RESTARTING";

export interface ContainerInspection {
  readonly state: ContainerRuntimeState;
  readonly publishedHostPorts: readonly number[];
}

export interface ContainerInspector {
  inspect(containerIdentifier: string): Promise<ContainerInspection>;
}

export interface ContainerEvidenceSnapshot extends ContainerInspection {
  readonly exitCode: number | null;
  readonly restartCount: number | null;
  readonly oomKilled: boolean | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly imageId: string | null;
  readonly dockerHealthStatus: "healthy" | "unhealthy" | "starting" | "none";
  readonly environmentNames: readonly string[];
  readonly allowlistedEnvironment: Readonly<Record<string, string>>;
}

export interface DockerEvidenceSource {
  inspectEvidence(containerIdentifier: string): Promise<ContainerEvidenceSnapshot>;
  streamRecentLogs(containerIdentifier: string, tailLines: number): AsyncIterable<Uint8Array>;
}

export class DockerInspectionError extends Error {
  public constructor(
    public readonly code: "DOCKER_UNAVAILABLE" | "DOCKER_TIMEOUT"
  ) {
    super(code === "DOCKER_TIMEOUT" ? "Docker inspection timed out" : "Docker is unavailable");
    this.name = "DockerInspectionError";
  }
}

export class DockerEvidenceError extends Error {
  public constructor(
    public readonly code: "DOCKER_UNAVAILABLE" | "DOCKER_TIMEOUT" | "DOCKER_LOGS_FAILED"
  ) {
    super("Docker evidence collection failed");
    this.name = "DockerEvidenceError";
  }
}
