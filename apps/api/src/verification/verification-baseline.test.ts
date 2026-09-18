import { describe, expect, it } from "vitest";
import { sha256Text } from "../remediation/canonical-hash";
import { validateVerificationBaseline } from "./verification-baseline";
import { createVerificationFixture } from "./verification-test-fixtures";

describe("validateVerificationBaseline", () => {
  it("accepts an unchanged exact restart target", () => {
    const fixture = createVerificationFixture();
    expect(() => validateVerificationBaseline(fixture.candidate)).not.toThrow();
  });

  it("rejects Deployment identity drift", () => {
    const fixture = createVerificationFixture();
    expect(() => validateVerificationBaseline({
      ...fixture.candidate,
      affectedDeployment: { ...fixture.affected, imageReference: "example/app:changed" }
    })).toThrowError(expect.objectContaining({ code: "BASELINE_DRIFT" }));
  });

  it("rejects health path or application port drift after the plan is created", () => {
    const fixture = createVerificationFixture();
    expect(() => validateVerificationBaseline({
      ...fixture.candidate,
      healthCheckPath: "/ready"
    })).toThrowError(expect.objectContaining({ code: "BASELINE_DRIFT" }));
    expect(() => validateVerificationBaseline({
      ...fixture.candidate,
      expectedPort: 9090
    })).toThrowError(expect.objectContaining({ code: "BASELINE_DRIFT" }));
  });

  it("requires the exact eligible historical rollback target", () => {
    const fixture = createVerificationFixture({ action: "ROLLBACK" });
    expect(() => validateVerificationBaseline({
      ...fixture.candidate,
      projectDeployments: [fixture.affected, { ...fixture.historical, isCurrent: true }]
    })).toThrowError(expect.objectContaining({ code: "BASELINE_DRIFT" }));
  });

  it("rejects changed allow-listed environment baselines", () => {
    const fixture = createVerificationFixture({
      affectedSnapshot: { safeEnvironment: { LOG_LEVEL: "info", PORT: "8080" } },
      proposedRemediation: {
        type: "UPDATE_ALLOWED_ENV",
        variableNames: ["LOG_LEVEL"],
        changes: [{ name: "LOG_LEVEL", proposedValue: "debug" }],
        reason: "Use debug logging in the candidate."
      }
    });
    expect(() => validateVerificationBaseline({
      ...fixture.candidate,
      affectedDeployment: {
        ...fixture.affected,
        configurationSnapshot: { safeEnvironment: { LOG_LEVEL: "warn", PORT: "8080" } }
      }
    })).toThrowError(expect.objectContaining({ code: "BASELINE_DRIFT" }));
  });

  it("rejects trusted verification behavior changed after planning", () => {
    const dockerfile = "FROM node:22-alpine\n";
    const snapshot = {
      verificationSource: {
        files: [{ relativePath: "Dockerfile", content: dockerfile, contentHash: sha256Text(dockerfile) }],
        dockerfilePath: "Dockerfile",
        test: { command: ["node", "test-a.js"], mandatory: true, timeoutMs: 1_000 }
      }
    };
    const fixture = createVerificationFixture({ affectedSnapshot: snapshot });
    expect(() => validateVerificationBaseline({
      ...fixture.candidate,
      affectedDeployment: {
        ...fixture.affected,
        configurationSnapshot: {
          verificationSource: {
            ...snapshot.verificationSource,
            test: { ...snapshot.verificationSource.test, command: ["node", "test-b.js"] }
          }
        }
      }
    })).toThrowError(expect.objectContaining({ code: "BASELINE_DRIFT" }));
  });

  it("requires trusted patch content to retain the expected digest", () => {
    const original = "export const port = 8080;\n";
    const fixture = createVerificationFixture({
      affectedSnapshot: {
        applicationFiles: [{ relativePath: "src/config.ts", contentHash: sha256Text(original) }],
        verificationSource: {
          files: [{ relativePath: "src/config.ts", content: original, contentHash: sha256Text(original) }],
          dockerfilePath: "Dockerfile"
        }
      },
      proposedRemediation: {
        type: "PATCH_APPLICATION_FILE",
        advisoryDescription: "Change the registered candidate file.",
        files: [{
          relativePath: "src/config.ts",
          expectedContentHash: sha256Text(original),
          originalContent: original,
          replacementContent: "export const port = 9090;\n"
        }],
        reason: "Correct the candidate port."
      }
    });
    expect(() => validateVerificationBaseline({
      ...fixture.candidate,
      affectedDeployment: {
        ...fixture.affected,
        configurationSnapshot: {
          applicationFiles: [{ relativePath: "src/config.ts", contentHash: sha256Text(original) }],
          verificationSource: {
            files: [{
              relativePath: "src/config.ts",
              content: "tampered",
              contentHash: sha256Text(original)
            }],
            dockerfilePath: "Dockerfile"
          }
        }
      }
    })).toThrowError(expect.objectContaining({ code: "PATCH_BASELINE_MISMATCH" }));
  });
});
