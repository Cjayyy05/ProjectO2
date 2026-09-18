import { mkdir, lstat, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, win32, posix } from "node:path";
import { z } from "zod";
import { EvidenceSanitizer } from "../evidence/evidence-sanitizer";
import { isProtectedPath, isSafeRelativePath } from "../remediation/remediation-plan-builder";
import { sha256Text } from "../remediation/canonical-hash";
import type { ControlledRemediationAction, PlanningDeployment } from "../remediation/remediation-types";
import {
  type TrustedVerificationSource,
  VerificationFailure,
  type VerificationCandidate
} from "./verification-types";

const MAX_SOURCE_BYTES = 1_024 * 1_024;
const SAFE_ENVIRONMENT_NAMES = new Set(["NODE_ENV", "APP_ENV", "LOG_LEVEL", "HOST", "PORT"]);
const SENSITIVE_ENVIRONMENT_NAME = /(?:PASSWORD|PASSWD|PWD|TOKEN|SECRET|API_?KEY|DATABASE_?URL|CREDENTIAL|PRIVATE_?KEY|JWT)/i;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sourceSchema = z.object({
  files: z.array(z.object({
    relativePath: z.string().min(1).max(240),
    content: z.string().max(64 * 1_024),
    contentHash: digest
  }).strict()).min(1).max(128),
  dockerfilePath: z.string().min(1).max(240),
  safeEnvironment: z.record(z.string(), z.string().max(256)).optional(),
  test: z.object({
    command: z.array(z.string().min(1).max(256)).min(1).max(16),
    mandatory: z.boolean(),
    timeoutMs: z.number().int().min(100).max(300_000)
  }).strict().optional(),
  requiresDatabase: z.boolean().optional()
}).strict();
const snapshotSchema = z.object({
  applicationFiles: z.array(z.object({
    relativePath: z.string().min(1).max(240),
    contentHash: digest,
    binary: z.boolean().optional(),
    generated: z.boolean().optional(),
    protected: z.boolean().optional(),
    symlink: z.boolean().optional()
  }).strict()).max(256).optional(),
  verificationSource: sourceSchema.optional()
}).passthrough();

export interface PreparedVerificationWorkspace {
  readonly path: string;
  readonly buildFiles: readonly string[];
  readonly dockerfilePath: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly test: TrustedVerificationSource["test"];
}

export interface VerificationWorkspace {
  prepare(candidate: VerificationCandidate): Promise<PreparedVerificationWorkspace>;
  cleanup(workspace: string): Promise<void>;
  cleanupOrphans(): Promise<void>;
}

export class VerificationWorkspaceManager implements VerificationWorkspace {
  private readonly baseDirectory = resolve(tmpdir(), "selfheal-verification");

  public constructor(private readonly sanitizer = new EvidenceSanitizer()) {}

  public async prepare(candidate: VerificationCandidate): Promise<PreparedVerificationWorkspace> {
    await mkdir(this.baseDirectory, { recursive: true });
    const workspace = await mkdtemp(join(this.baseDirectory, "run-"));
    try {
      const action = candidate.plan.actions[0];
      const sourceDeployment = selectSourceDeployment(candidate, action);
      const registeredSource = this.parseOptionalTrustedSource(sourceDeployment);
      const source = action.type === "PATCH_APPLICATION_FILE"
        ? registeredSource ?? this.missingTrustedSource()
        : createImageDerivedSource(sourceDeployment, registeredSource);
      if (source.requiresDatabase) {
        throw new VerificationFailure(
          "UNSAFE_DEPENDENCY",
          "A disposable database is required but no isolated dependency is configured"
        );
      }
      const environment = applyEnvironmentAction(source.safeEnvironment, action);
      await this.writeSource(workspace, source);
      if (action.type === "PATCH_APPLICATION_FILE") {
        await this.applyPatch(workspace, action, source);
      }
      return {
        path: workspace,
        buildFiles: source.files.map((file) => file.relativePath),
        dockerfilePath: source.dockerfilePath,
        environment,
        test: source.test
      };
    } catch (error) {
      try {
        await this.cleanup(workspace);
      } catch {
        const failure = error instanceof VerificationFailure
          ? error
          : new VerificationFailure("INTERNAL_VERIFICATION_ERROR", "Workspace preparation failed");
        throw new VerificationFailure(failure.code, failure.message, true);
      }
      throw error;
    }
  }

  public async cleanupOrphans(): Promise<void> {
    await mkdir(this.baseDirectory, { recursive: true });
    const entries = await readdir(this.baseDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith("run-") && (entry.isDirectory() || entry.isSymbolicLink())) {
        await this.cleanup(join(this.baseDirectory, entry.name));
      }
    }
  }

  public async cleanup(workspace: string): Promise<void> {
    const base = resolve(this.baseDirectory);
    const target = resolve(workspace);
    if (target === base || relative(base, target).startsWith("..") || !target.startsWith(`${base}\\`) &&
      !target.startsWith(`${base}/`)) {
      throw new VerificationFailure("UNSAFE_SOURCE", "Workspace cleanup target escaped its base");
    }
    await rm(target, { recursive: true, force: true });
  }

  private parseTrustedSource(deployment: PlanningDeployment): TrustedVerificationSource {
    const snapshot = snapshotSchema.safeParse(deployment.configurationSnapshot);
    if (!snapshot.success || snapshot.data.verificationSource === undefined) {
      throw new VerificationFailure("TRUSTED_SOURCE_UNAVAILABLE", "Trusted verification source is unavailable");
    }
    const parsed = snapshot.data.verificationSource;
    const manifest = snapshot.data.applicationFiles ?? [];
    if (!isSafeSourcePath(parsed.dockerfilePath)) {
      throw new VerificationFailure("UNSAFE_SOURCE", "Dockerfile path is unsafe");
    }
    const paths = new Set<string>();
    let totalBytes = 0;
    for (const file of parsed.files) {
      const normalizedKey = file.relativePath.toLowerCase();
      if (!isSafeSourcePath(file.relativePath) || paths.has(normalizedKey)) {
        throw new VerificationFailure("UNSAFE_SOURCE", "Source contains an unsafe or duplicate path");
      }
      paths.add(normalizedKey);
      const registered = manifest.find((entry) => entry.relativePath === file.relativePath);
      totalBytes += Buffer.byteLength(file.content, "utf8");
      if (registered === undefined || registered.contentHash !== file.contentHash ||
        registered.binary || registered.generated || registered.protected || registered.symlink ||
        totalBytes > MAX_SOURCE_BYTES || sha256Text(file.content) !== file.contentHash ||
        this.sanitizer.sanitizeText(file.content) !== file.content) {
        throw new VerificationFailure("UNSAFE_SOURCE", "Source content is invalid, oversized, or secret-bearing");
      }
    }
    if (!paths.has(parsed.dockerfilePath.toLowerCase())) {
      throw new VerificationFailure("TRUSTED_SOURCE_UNAVAILABLE", "Trusted Dockerfile is missing");
    }
    const safeEnvironment = validateSafeEnvironment(parsed.safeEnvironment ?? {});
    if (parsed.test?.command.some((part) => this.sanitizer.sanitizeText(part) !== part)) {
      throw new VerificationFailure("UNSAFE_SOURCE", "Configured test command contains sensitive content");
    }
    return {
      files: parsed.files,
      dockerfilePath: parsed.dockerfilePath,
      safeEnvironment,
      test: parsed.test ?? null,
      requiresDatabase: parsed.requiresDatabase ?? false
    };
  }

  private parseOptionalTrustedSource(
    deployment: PlanningDeployment
  ): TrustedVerificationSource | null {
    const snapshot = snapshotSchema.safeParse(deployment.configurationSnapshot);
    if (!snapshot.success || snapshot.data.verificationSource === undefined) return null;
    return this.parseTrustedSource(deployment);
  }

  private missingTrustedSource(): never {
    throw new VerificationFailure("TRUSTED_SOURCE_UNAVAILABLE", "Trusted verification source is unavailable");
  }

  private async writeSource(workspace: string, source: TrustedVerificationSource): Promise<void> {
    for (const file of source.files) {
      const target = resolveInside(workspace, file.relativePath);
      await mkdir(dirname(target), { recursive: true });
      await assertNoSymlinkPath(workspace, target);
      await writeFile(target, file.content, { encoding: "utf8", flag: "wx" });
    }
  }

  private async applyPatch(
    workspace: string,
    action: Extract<ControlledRemediationAction, { readonly type: "PATCH_APPLICATION_FILE" }>,
    source: TrustedVerificationSource
  ): Promise<void> {
    for (const patch of action.files) {
      if (!isSafeRelativePath(patch.relativePath) || isProtectedPath(patch.relativePath)) {
        throw new VerificationFailure("UNSAFE_SOURCE", "Patch path failed workspace validation");
      }
      const sourceFile = source.files.find((file) => file.relativePath === patch.relativePath);
      if (sourceFile === undefined || sourceFile.contentHash !== patch.expectedContentHash ||
        sha256Text(sourceFile.content) !== patch.expectedContentHash) {
        throw new VerificationFailure("PATCH_BASELINE_MISMATCH", "Patch source no longer matches its baseline");
      }
      const target = resolveInside(workspace, patch.relativePath);
      await assertNoSymlinkPath(workspace, target);
      const metadata = await lstat(target);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new VerificationFailure("UNSAFE_SOURCE", "Patch target is not a regular workspace file");
      }
      await writeFile(target, patch.replacementContent, { encoding: "utf8", flag: "w" });
      if (sha256Text(patch.replacementContent) !== sha256Text(await readFile(target, "utf8"))) {
        throw new VerificationFailure("PATCH_APPLY_MISMATCH", "Applied patch content does not match the plan");
      }
    }
  }
}

function selectSourceDeployment(
  candidate: VerificationCandidate,
  action: ControlledRemediationAction
): PlanningDeployment {
  if (action.type !== "ROLLBACK_DEPLOYMENT") return candidate.affectedDeployment;
  const target = candidate.projectDeployments.find((deployment) =>
    deployment.id === action.targetDeploymentId && deployment.projectId === candidate.projectId);
  if (target === undefined) {
    throw new VerificationFailure("BASELINE_DRIFT", "Rollback target is unavailable");
  }
  return target;
}

function createImageDerivedSource(
  deployment: PlanningDeployment,
  registered: TrustedVerificationSource | null
): TrustedVerificationSource {
  const content = `FROM ${deployment.imageReference}\n`;
  return {
    files: [{ relativePath: "Dockerfile", content, contentHash: sha256Text(content) }],
    dockerfilePath: "Dockerfile",
    safeEnvironment: registered?.safeEnvironment ?? extractTopLevelSafeEnvironment(
      deployment.configurationSnapshot
    ),
    test: registered?.test ?? null,
    requiresDatabase: registered?.requiresDatabase ?? false
  };
}

function applyEnvironmentAction(
  original: Readonly<Record<string, string>>,
  action: ControlledRemediationAction
): Readonly<Record<string, string>> {
  const result = { ...validateSafeEnvironment(original) };
  if (action.type === "UPDATE_ALLOWED_ENV") {
    for (const change of action.changes) result[change.name] = change.proposedValue;
  }
  return result;
}

function validateSafeEnvironment(value: Readonly<Record<string, string>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, environmentValue] of Object.entries(value)) {
    if (!SAFE_ENVIRONMENT_NAMES.has(name) || SENSITIVE_ENVIRONMENT_NAME.test(name) ||
      !isSafeEnvironmentValue(name, environmentValue)) {
      throw new VerificationFailure("UNSAFE_SOURCE", "Verification environment is not allow-listed");
    }
    result[name] = environmentValue;
  }
  return result;
}

function extractTopLevelSafeEnvironment(value: unknown): Record<string, string> {
  const parsed = z.object({
    safeEnvironment: z.record(z.string(), z.string().max(256)).optional()
  }).passthrough().safeParse(value);
  return validateSafeEnvironment(parsed.success ? parsed.data.safeEnvironment ?? {} : {});
}

function isSafeEnvironmentValue(name: string, value: string): boolean {
  switch (name) {
    case "NODE_ENV":
    case "APP_ENV":
      return ["development", "test", "staging", "production"].includes(value);
    case "LOG_LEVEL":
      return ["trace", "debug", "info", "warn", "error", "fatal"].includes(value);
    case "HOST":
      return ["0.0.0.0", "127.0.0.1", "localhost"].includes(value);
    case "PORT": {
      if (!/^\d{1,5}$/.test(value)) return false;
      const port = Number(value);
      return Number.isInteger(port) && port >= 1 && port <= 65_535;
    }
    default:
      return false;
  }
}

function isSafeSourcePath(path: string): boolean {
  return isSafeRelativePath(path) && !posix.isAbsolute(path) && !win32.isAbsolute(path);
}

function resolveInside(workspace: string, path: string): string {
  if (!isSafeSourcePath(path)) throw new VerificationFailure("UNSAFE_SOURCE", "Source path is unsafe");
  const root = resolve(workspace);
  const target = resolve(root, path);
  const fromRoot = relative(root, target);
  if (fromRoot.startsWith("..") || fromRoot === "" || posix.isAbsolute(fromRoot) || win32.isAbsolute(fromRoot)) {
    throw new VerificationFailure("UNSAFE_SOURCE", "Source path escaped the workspace");
  }
  return target;
}

async function assertNoSymlinkPath(workspace: string, target: string): Promise<void> {
  const root = await realpath(workspace);
  let current = dirname(target);
  while (current !== workspace && current.startsWith(workspace)) {
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new VerificationFailure("UNSAFE_SOURCE", "Workspace path contains a symbolic link");
    }
    current = dirname(current);
  }
  if (await realpath(workspace) !== root) {
    throw new VerificationFailure("UNSAFE_SOURCE", "Workspace root changed during preparation");
  }
}
