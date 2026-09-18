import { describe, expect, it } from "vitest";
import { BoundedVerificationOutput } from "../verification/bounded-output";
import type { VerificationSandboxSpec } from "./verification-sandbox";
import { createCandidateContainerOptions } from "./dockerode-verification-sandbox";

describe("Docker verification candidate options", () => {
  it("hard-codes production isolation instead of accepting Docker flags from a plan", () => {
    const options = createCandidateContainerOptions(spec());

    expect(options.Image).toBe("selfheal-verification:fixture");
    expect(options.Labels).toEqual({
      "selfheal.verification": "managed",
      "selfheal.verification.run": "00000000-0000-4000-8000-000000000001"
    });
    expect(options.Env).toEqual(["PORT=8080", "LOG_LEVEL=info"]);
    expect(options.HostConfig).toMatchObject({
      NetworkMode: "selfheal-verification-network",
      Binds: [],
      Mounts: [],
      Privileged: false,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      ReadonlyRootfs: true,
      Memory: 256 * 1_024 * 1_024,
      MemorySwap: 256 * 1_024 * 1_024,
      NanoCpus: 500_000_000,
      PidsLimit: 128,
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 }
    });
    expect(JSON.stringify(options)).not.toContain("docker.sock");
    expect(JSON.stringify(options)).not.toContain("DATABASE_URL");
    expect(options.HostConfig?.PortBindings).toBeUndefined();
  });
});

function spec(): VerificationSandboxSpec {
  return {
    runId: "00000000-0000-4000-8000-000000000001",
    imageTag: "selfheal-verification:fixture",
    containerName: "selfheal-verification-fixture",
    networkName: "selfheal-verification-network",
    workspace: {
      path: "C:/isolated/workspace",
      buildFiles: ["Dockerfile"],
      dockerfilePath: "Dockerfile",
      environment: { PORT: "8080", LOG_LEVEL: "info" },
      test: null
    },
    containerPort: 8080,
    buildTimeoutMs: 1_000,
    output: new BoundedVerificationOutput(1_024)
  };
}
