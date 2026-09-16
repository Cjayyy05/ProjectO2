import { describe, expect, it } from "vitest";
import { DockerInspectionError } from "./docker-service";
import {
  DockerodeContainerInspector,
  type ContainerInspectClient,
  type RawContainerState
} from "./dockerode-container-inspector";

describe("DockerodeContainerInspector", () => {
  it.each([
    [{ running: true, status: "running", publishedHostPorts: [8080] }, "RUNNING"],
    [{ running: false, status: "exited", publishedHostPorts: [] }, "STOPPED"],
    [{ running: true, status: "paused", publishedHostPorts: [] }, "PAUSED"],
    [{ running: false, status: "restarting", publishedHostPorts: [] }, "RESTARTING"],
    [{ running: true, status: "restarting", publishedHostPorts: [] }, "RESTARTING"]
  ] satisfies readonly [RawContainerState, string][])("normalizes container state", async (raw, state) => {
    const inspector = new DockerodeContainerInspector(clientReturning(raw), 100);
    await expect(inspector.inspect("registered-container")).resolves.toMatchObject({ state });
  });

  it("normalizes a missing registered container without leaking Docker errors", async () => {
    const inspector = new DockerodeContainerInspector({
      async inspect() {
        throw { statusCode: 404, reason: "sensitive Docker endpoint detail" };
      }
    }, 100);

    await expect(inspector.inspect("missing-container")).resolves.toEqual({
      state: "MISSING",
      publishedHostPorts: []
    });
  });

  it("bounds an unresponsive Docker inspection", async () => {
    const inspector = new DockerodeContainerInspector({
      inspect: () => new Promise<RawContainerState>(() => undefined)
    }, 10);

    await expect(inspector.inspect("registered-container")).rejects.toMatchObject({
      name: "DockerInspectionError",
      code: "DOCKER_TIMEOUT"
    } satisfies Partial<DockerInspectionError>);
  });
});

function clientReturning(state: RawContainerState): ContainerInspectClient {
  return { inspect: async () => state };
}
