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

export class DockerInspectionError extends Error {
  public constructor(
    public readonly code: "DOCKER_UNAVAILABLE" | "DOCKER_TIMEOUT"
  ) {
    super(code === "DOCKER_TIMEOUT" ? "Docker inspection timed out" : "Docker is unavailable");
    this.name = "DockerInspectionError";
  }
}
