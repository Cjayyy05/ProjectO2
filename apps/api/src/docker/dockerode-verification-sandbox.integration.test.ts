import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Docker from "dockerode";
import { describe, expect, it } from "vitest";
import { BoundedVerificationOutput } from "../verification/bounded-output";
import { DockerodeVerificationSandbox } from "./dockerode-verification-sandbox";

const dockerTestsEnabled = process.env.RUN_DOCKER_INTEGRATION_TESTS === "true";
const describeDocker = dockerTestsEnabled ? describe : describe.skip;

describeDocker("Docker verification sandbox integration", () => {
  it("builds, starts, health-checks, isolates, and removes a disposable candidate", async () => {
    const baseImage = process.env.TEST_DOCKER_VERIFICATION_BASE_IMAGE;
    if (baseImage === undefined || !/^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,254}$/.test(baseImage)) {
      throw new Error("TEST_DOCKER_VERIFICATION_BASE_IMAGE must name a trusted local Node image");
    }
    const suffix = randomUUID();
    const workspace = await mkdtemp(join(tmpdir(), "selfheal-docker-verification-"));
    const imageTag = `selfheal-verification:${suffix}`;
    const containerName = `selfheal-verification-${suffix}`;
    const networkName = `selfheal-verification-${suffix}`;
    const dockerfile = [
      `FROM ${baseImage}`,
      "CMD [\"node\",\"-e\",\"require('http').createServer((q,s)=>{if(q.url==='/redirect'){s.statusCode=302;s.setHeader('location','http://example.com/')}else{s.statusCode=204}s.end()}).listen(8080,'0.0.0.0')\"]",
      ""
    ].join("\n");
    await writeFile(join(workspace, "Dockerfile"), dockerfile, "utf8");
    const output = new BoundedVerificationOutput(16_384);
    const docker = new Docker(process.platform === "win32"
      ? { socketPath: "//./pipe/dockerDesktopLinuxEngine" }
      : undefined);
    const sandbox = new DockerodeVerificationSandbox(docker);
    let handle: Awaited<ReturnType<DockerodeVerificationSandbox["buildAndStart"]>> | undefined;
    try {
      handle = await sandbox.buildAndStart({
        runId: suffix,
        imageTag,
        containerName,
        networkName,
        workspace: {
          path: workspace,
          buildFiles: ["Dockerfile"],
          dockerfilePath: "Dockerfile",
          environment: { PORT: "8080" },
          test: null
        },
        containerPort: 8080,
        buildTimeoutMs: 120_000,
        output
      });
      await sandbox.waitForStartup(handle, 10_000);
      const inspected = await docker.getContainer(handle.containerId).inspect();
      expect(inspected.HostConfig.Privileged).toBe(false);
      expect(inspected.HostConfig.Binds ?? []).toEqual([]);
      expect(inspected.Mounts ?? []).toEqual([]);
      expect(inspected.HostConfig.NetworkMode).toBe(networkName);
      expect(inspected.HostConfig.SecurityOpt).toContain("no-new-privileges:true");
      expect(JSON.stringify(inspected.Config.Env ?? [])).not.toContain("DATABASE_URL");
      expect(inspected.HostConfig.PortBindings ?? {}).toEqual({});
      await expect.poll(
        () => sandbox.checkHealth(handle!, "/health", 2_000),
        { timeout: 10_000, interval: 250 }
      ).toBe(true);
      await expect(sandbox.checkHealth(handle, "/redirect", 2_000)).resolves.toBe(true);
      await expect(sandbox.checkHealth(handle, "http://example.com/", 2_000)).rejects.toBeDefined();
      await sandbox.cleanupOrphans();
    } finally {
      await sandbox.cleanup({
        ...(handle ?? {}),
        runId: suffix,
        imageTag,
        containerName,
        networkName
      });
      await rm(workspace, { recursive: true, force: true });
    }
    await expect(docker.getContainer(containerName).inspect()).rejects.toMatchObject({ statusCode: 404 });
    await expect(docker.getNetwork(networkName).inspect()).rejects.toMatchObject({ statusCode: 404 });
    await expect(docker.getImage(imageTag).inspect()).rejects.toMatchObject({ statusCode: 404 });
    expect(Buffer.byteLength(output.value(), "utf8")).toBeLessThanOrEqual(16_384);
  }, 180_000);

  it("refuses to delete a same-named resource without the exact managed run labels", async () => {
    const docker = new Docker(process.platform === "win32"
      ? { socketPath: "//./pipe/dockerDesktopLinuxEngine" }
      : undefined);
    const sandbox = new DockerodeVerificationSandbox(docker);
    const suffix = randomUUID();
    const networkName = `selfheal-verification-unowned-${suffix}`;
    const network = await docker.createNetwork({ Name: networkName, Internal: true });
    try {
      await expect(sandbox.cleanup({
        runId: suffix,
        imageTag: `selfheal-verification:missing-${suffix}`,
        containerName: `selfheal-verification-missing-${suffix}`,
        networkName
      })).rejects.toThrow("network-label");
      await expect(docker.getNetwork(network.id).inspect()).resolves.toMatchObject({ Name: networkName });
    } finally {
      await network.remove().catch(() => undefined);
    }
  }, 30_000);
});
