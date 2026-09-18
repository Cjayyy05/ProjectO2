import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Text } from "../remediation/canonical-hash";
import { computeRemediationPlanHash } from "../remediation/remediation-validation";
import { createVerificationFixture } from "./verification-test-fixtures";
import { VerificationWorkspaceManager } from "./verification-workspace";

describe("VerificationWorkspaceManager", () => {
  it("uses the exact rollback image without touching either registered container", async () => {
    const fixture = createVerificationFixture({ action: "ROLLBACK" });
    const manager = new VerificationWorkspaceManager();
    const workspace = await manager.prepare(fixture.candidate);
    try {
      await expect(readFile(join(workspace.path, "Dockerfile"), "utf8"))
        .resolves.toBe(`FROM ${fixture.historical.imageReference}\n`);
      expect(workspace.environment).toEqual({ PORT: "8080" });
    } finally {
      await manager.cleanup(workspace.path);
    }
  });

  it("applies only the exact allow-listed environment values", async () => {
    const fixture = createVerificationFixture({
      affectedSnapshot: { safeEnvironment: { PORT: "8080", LOG_LEVEL: "info" } },
      proposedRemediation: {
        type: "UPDATE_ALLOWED_ENV",
        variableNames: ["LOG_LEVEL"],
        changes: [{ name: "LOG_LEVEL", proposedValue: "debug" }],
        reason: "Verify a safe logging change."
      }
    });
    const manager = new VerificationWorkspaceManager();
    const workspace = await manager.prepare(fixture.candidate);
    try {
      expect(workspace.environment).toEqual({ PORT: "8080", LOG_LEVEL: "debug" });
      expect(JSON.stringify(workspace.environment)).not.toContain("DATABASE_URL");
    } finally {
      await manager.cleanup(workspace.path);
    }
  });

  it("patches only the disposable workspace and removes it afterward", async () => {
    const original = "export const port = 8080;\n";
    const replacement = "export const port = 9090;\n";
    const dockerfile = "FROM example/app:current\n";
    const productionDirectory = await mkdtemp(join(tmpdir(), "selfheal-production-fixture-"));
    const productionFile = join(productionDirectory, "config.ts");
    await writeFile(productionFile, original, "utf8");
    const fixture = createPatchFixture(original, replacement, dockerfile);
    const manager = new VerificationWorkspaceManager();
    const workspace = await manager.prepare(fixture.candidate);
    try {
      await expect(readFile(join(workspace.path, "src", "config.ts"), "utf8"))
        .resolves.toBe(replacement);
      await expect(readFile(productionFile, "utf8")).resolves.toBe(original);
    } finally {
      await manager.cleanup(workspace.path);
      await expect(access(workspace.path)).rejects.toBeDefined();
      await rm(productionDirectory, { recursive: true, force: true });
    }
  });

  it("rejects traversal even when a recomputed plan digest makes it structurally trusted", async () => {
    const original = "export const port = 8080;\n";
    const fixture = createPatchFixture(original, "changed\n", "FROM example/app:current\n");
    const action = fixture.plan.actions[0];
    if (action.type !== "PATCH_APPLICATION_FILE") throw new Error("Patch fixture expected");
    const file = action.files[0];
    if (file === undefined) throw new Error("Patch file expected");
    const unsafeContent = {
      ...fixture.plan,
      actions: [{ ...action, files: [{ ...file, relativePath: "../outside.ts" }] }] as const
    };
    const unsafePlan = {
      ...unsafeContent,
      planHash: computeRemediationPlanHash(unsafeContent)
    };
    const manager = new VerificationWorkspaceManager();

    await expect(manager.prepare({ ...fixture.candidate, plan: unsafePlan }))
      .rejects.toMatchObject({ code: "UNSAFE_SOURCE" });
  });

  it("rejects manifests that identify a source path as a symlink", async () => {
    const original = "export const port = 8080;\n";
    const replacement = "export const port = 9090;\n";
    const dockerfile = "FROM example/app:current\n";
    const snapshot = trustedPatchSnapshot(original, dockerfile);
    const unsafeSnapshot = {
      ...snapshot,
      applicationFiles: snapshot.applicationFiles.map((file) =>
        file.relativePath === "src/config.ts" ? { ...file, symlink: true } : file)
    };
    expect(() => createVerificationFixture({
      affectedSnapshot: unsafeSnapshot,
      proposedRemediation: patchProposal(original, replacement)
    })).toThrow(/not actionable/i);
  });

  it("fails a patch safely when trusted source content is unavailable", async () => {
    const original = "export const port = 8080;\n";
    const fixture = createVerificationFixture({
      affectedSnapshot: {
        applicationFiles: [{ relativePath: "src/config.ts", contentHash: sha256Text(original) }]
      },
      proposedRemediation: patchProposal(original, "changed\n")
    });
    await expect(new VerificationWorkspaceManager().prepare(fixture.candidate))
      .rejects.toMatchObject({ code: "TRUSTED_SOURCE_UNAVAILABLE" });
  });

  it("reconciles verification workspaces left by an interrupted process", async () => {
    const manager = new VerificationWorkspaceManager();
    const workspace = await manager.prepare(createVerificationFixture().candidate);

    await manager.cleanupOrphans();

    await expect(access(workspace.path)).rejects.toBeDefined();
  });
});

function createPatchFixture(original: string, replacement: string, dockerfile: string) {
  return createVerificationFixture({
    affectedSnapshot: trustedPatchSnapshot(original, dockerfile),
    proposedRemediation: patchProposal(original, replacement)
  });
}

function trustedPatchSnapshot(original: string, dockerfile: string) {
  return {
    safeEnvironment: { PORT: "8080" },
    applicationFiles: [
      { relativePath: "src/config.ts", contentHash: sha256Text(original) },
      { relativePath: "Dockerfile", contentHash: sha256Text(dockerfile) }
    ],
    verificationSource: {
      files: [
        { relativePath: "src/config.ts", content: original, contentHash: sha256Text(original) },
        { relativePath: "Dockerfile", content: dockerfile, contentHash: sha256Text(dockerfile) }
      ],
      dockerfilePath: "Dockerfile",
      safeEnvironment: { PORT: "8080" },
      requiresDatabase: false
    }
  };
}

function patchProposal(original: string, replacement: string) {
  return {
    type: "PATCH_APPLICATION_FILE",
    advisoryDescription: "Change the registered candidate file.",
    files: [{
      relativePath: "src/config.ts",
      expectedContentHash: sha256Text(original),
      originalContent: original,
      replacementContent: replacement
    }],
    reason: "Apply a bounded structured patch."
  };
}
