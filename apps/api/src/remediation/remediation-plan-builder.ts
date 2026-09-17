import { z } from "zod";
import {
  diagnosisResultSchema,
  sanitizeDiagnosisResult
} from "../diagnosis/diagnosis-types";
import { EvidenceSanitizer } from "../evidence/evidence-sanitizer";
import { compareCanonicalStrings, sha256Canonical, sha256Text } from "./canonical-hash";
import {
  computeRemediationPlanHash,
  validateRemediationPlanIntegrity
} from "./remediation-validation";
import {
  PLAN_SCHEMA_VERSION,
  type ControlledRemediationAction,
  type EnvironmentPlanChange,
  type FilePlanChange,
  type PlanningDeployment,
  type RemediationPlanDraft,
  type RemediationPlanningCandidate,
  type RemediationPlanningDecision
} from "./remediation-types";

const MAX_PATCH_BYTES = 64 * 1_024;
const MAX_PATCH_DIFF_BYTES = 96 * 1_024;
const SENSITIVE_ENVIRONMENT_NAME = /(?:PASSWORD|PASSWD|PWD|TOKEN|SECRET|API_?KEY|DATABASE_?URL|CREDENTIAL|PRIVATE_?KEY|JWT)/i;
const SAFE_CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SAFE_IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,254}$/;
const CREDENTIAL_SHAPED_IMAGE_REFERENCE = /(?:^|\/)[^/:@]+:[^/@]+@/;
const configurationSnapshotSchema = z.object({
  safeEnvironment: z.record(z.string(), z.string().max(256)).optional(),
  applicationFiles: z.array(z.object({
    relativePath: z.string().min(1).max(240),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    binary: z.boolean().optional(),
    generated: z.boolean().optional(),
    protected: z.boolean().optional(),
    symlink: z.boolean().optional()
  }).strict()).max(256).optional()
}).passthrough();

type Proposal = NonNullable<ReturnType<typeof diagnosisResultSchema.parse>["proposedRemediation"]>;

export class RemediationPlanBuilder {
  public constructor(private readonly sanitizer = new EvidenceSanitizer()) {}

  public build(candidate: RemediationPlanningCandidate): RemediationPlanningDecision {
    const parsed = diagnosisResultSchema.safeParse(candidate.diagnosisResult);
    if (!parsed.success) return notActionable("INVALID_DIAGNOSIS_RESULT");
    const diagnosis = sanitizeDiagnosisResult(parsed.data, this.sanitizer);
    if (diagnosis.manualInvestigationRecommended) {
      return notActionable("MANUAL_INVESTIGATION_REQUIRED");
    }
    const proposal = diagnosis.proposedRemediation;
    if (proposal === null) return notActionable("NO_REMEDIATION_SUGGESTED");
    const affected = candidate.affectedDeployment;
    if (affected === null) return notActionable("INCIDENT_DEPLOYMENT_REQUIRED");
    if (affected.projectId !== candidate.projectId) {
      return notActionable("INCIDENT_DEPLOYMENT_MISMATCH");
    }
    if (!hasSafeDeploymentIdentity(affected)) {
      return notActionable("UNSAFE_DEPLOYMENT_IDENTITY");
    }

    const actionResult = this.buildAction(candidate, affected, proposal);
    if ("code" in actionResult) return notActionable(actionResult.code);

    const diagnosisResultHash = sha256Canonical(diagnosis);
    const targetBaseline = {
      affectedDeployment: deploymentIdentity(affected),
      action: actionResult.baseline
    };
    const baseline = {
      diagnosisId: candidate.diagnosisId,
      diagnosisResultHash,
      evidenceReferences: [...diagnosis.supportingEvidenceReferences].sort(),
      ...targetBaseline
    };
    const targetSnapshotHash = sha256Canonical({
      projectId: candidate.projectId,
      deploymentId: affected.id,
      baseline: targetBaseline
    });
    const action = actionResult.action;
    const planContent = {
      schemaVersion: PLAN_SCHEMA_VERSION,
      version: 1,
      incidentId: candidate.incidentId,
      diagnosisId: candidate.diagnosisId,
      projectId: candidate.projectId,
      deploymentId: affected.id,
      actionTypes: [action.type] as const,
      actions: [action],
      baseline,
      targetSnapshotHash,
      summary: actionResult.summary,
      rollbackSupported: actionResult.rollbackSupported,
      rollbackDescription: actionResult.rollbackDescription
    } satisfies Omit<RemediationPlanDraft, "planHash">;
    const draft = validateRemediationPlanIntegrity({
      ...planContent,
      planHash: computeRemediationPlanHash(planContent)
    });
    if (draft === null) throw new Error("Generated remediation plan failed integrity validation");
    return { kind: "PLAN", plan: draft };
  }

  private buildAction(
    candidate: RemediationPlanningCandidate,
    affected: PlanningDeployment,
    proposal: Proposal
  ): ActionResult | ActionFailure {
    const safeReason = this.sanitizer.sanitizeText(proposal.reason);
    switch (proposal.type) {
      case "RESTART_CONTAINER":
        return {
          action: { type: "RESTART_CONTAINER", deploymentId: affected.id, reason: safeReason },
          baseline: { deployment: deploymentIdentity(affected) },
          summary: "Restart the registered Incident deployment after isolated verification and approval.",
          rollbackSupported: false,
          rollbackDescription: null
        };
      case "ROLLBACK_DEPLOYMENT":
        return buildRollback(candidate, affected, proposal, safeReason);
      case "UPDATE_ALLOWED_ENV":
        return buildEnvironmentUpdate(candidate, affected, proposal, safeReason);
      case "PATCH_APPLICATION_FILE":
        return this.buildFilePatch(affected, proposal, safeReason);
    }
  }

  private buildFilePatch(
    affected: PlanningDeployment,
    proposal: Extract<Proposal, { readonly type: "PATCH_APPLICATION_FILE" }>,
    safeReason: string
  ): ActionResult | ActionFailure {
    if (proposal.files === undefined || proposal.files.length === 0) {
      return { code: "PATCH_FILE_NOT_REGISTERED" };
    }
    const snapshot = configurationSnapshotSchema.safeParse(affected.configurationSnapshot);
    const manifest = snapshot.success ? snapshot.data.applicationFiles ?? [] : [];
    let totalBytes = 0;
    let totalDiffBytes = 0;
    const files: FilePlanChange[] = [];
    const paths = new Set<string>();

    for (const file of proposal.files) {
      if (!isSafeRelativePath(file.relativePath) || paths.has(file.relativePath)) {
        return { code: "INVALID_PATCH_PATH" };
      }
      paths.add(file.relativePath);
      const registered = manifest.find((entry) => entry.relativePath === file.relativePath);
      if (registered === undefined) return { code: "PATCH_FILE_NOT_REGISTERED" };
      if (registered.binary || registered.generated || registered.protected || registered.symlink ||
        isProtectedPath(file.relativePath)) {
        return { code: "PATCH_FILE_NOT_SAFE" };
      }
      if (file.originalContent.includes("\0") || file.replacementContent.includes("\0")) {
        return { code: "PATCH_FILE_NOT_SAFE" };
      }
      if (/\[REDACTED(?:_|\])/i.test(file.originalContent) ||
        /\[REDACTED(?:_|\])/i.test(file.replacementContent) ||
        this.sanitizer.sanitizeText(file.originalContent) !== file.originalContent ||
        this.sanitizer.sanitizeText(file.replacementContent) !== file.replacementContent) {
        return { code: "PATCH_CONTAINS_SECRET" };
      }
      const calculated = sha256Text(file.originalContent);
      if (calculated !== file.expectedContentHash || calculated !== registered.contentHash) {
        return { code: "PATCH_BASELINE_MISMATCH" };
      }
      totalBytes += Buffer.byteLength(file.originalContent, "utf8") +
        Buffer.byteLength(file.replacementContent, "utf8");
      if (totalBytes > MAX_PATCH_BYTES) return { code: "PATCH_TOO_LARGE" };
      const unifiedDiff = createUnifiedDiff(
        file.relativePath,
        file.originalContent,
        file.replacementContent
      );
      totalDiffBytes += Buffer.byteLength(unifiedDiff, "utf8");
      if (totalDiffBytes > MAX_PATCH_DIFF_BYTES) {
        return { code: "PATCH_TOO_LARGE" };
      }
      files.push({
        relativePath: file.relativePath,
        expectedContentHash: calculated,
        replacementContent: file.replacementContent,
        unifiedDiff
      });
    }

    return {
      action: {
        type: "PATCH_APPLICATION_FILE",
        deploymentId: affected.id,
        files,
        reason: safeReason
      },
      baseline: { files: files.map((file) => ({
        relativePath: file.relativePath,
        expectedContentHash: file.expectedContentHash
      })) },
      summary: "Stage a bounded structured application-file patch for later verification and approval.",
      rollbackSupported: false,
      rollbackDescription: null
    };
  }
}

interface ActionResult {
  readonly action: ControlledRemediationAction;
  readonly baseline: Readonly<Record<string, unknown>>;
  readonly summary: string;
  readonly rollbackSupported: boolean;
  readonly rollbackDescription: string | null;
}

interface ActionFailure {
  readonly code: Exclude<RemediationPlanningDecision, { readonly kind: "PLAN" }>["code"];
}

function buildRollback(
  candidate: RemediationPlanningCandidate,
  affected: PlanningDeployment,
  proposal: Extract<Proposal, { readonly type: "ROLLBACK_DEPLOYMENT" }>,
  safeReason: string
): ActionResult | ActionFailure {
  const eligible = candidate.projectDeployments
    .filter((deployment) => deployment.projectId === candidate.projectId &&
      deployment.id !== affected.id && !deployment.isCurrent &&
      deployment.createdAt.getTime() < affected.createdAt.getTime() &&
      hasSafeDeploymentIdentity(deployment))
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  const target = proposal.targetDeploymentId === undefined
    ? eligible[0]
    : eligible.find((deployment) => deployment.id === proposal.targetDeploymentId);
  if (target === undefined) {
    return { code: proposal.targetDeploymentId === undefined
      ? "ROLLBACK_TARGET_UNAVAILABLE"
      : "INVALID_ROLLBACK_TARGET" };
  }
  return {
    action: {
      type: "ROLLBACK_DEPLOYMENT",
      affectedDeploymentId: affected.id,
      targetDeploymentId: target.id,
      reason: safeReason
    },
    baseline: {
      affectedDeployment: deploymentIdentity(affected),
      rollbackTarget: deploymentIdentity(target)
    },
    summary: "Roll back to a validated historical Deployment from the same Project.",
    rollbackSupported: true,
    rollbackDescription: "Restore the affected Deployment identity if later verification supports compensation."
  };
}

function buildEnvironmentUpdate(
  candidate: RemediationPlanningCandidate,
  affected: PlanningDeployment,
  proposal: Extract<Proposal, { readonly type: "UPDATE_ALLOWED_ENV" }>,
  safeReason: string
): ActionResult | ActionFailure {
  for (const name of proposal.variableNames) {
    if (SENSITIVE_ENVIRONMENT_NAME.test(name)) return { code: "SENSITIVE_ENVIRONMENT_VARIABLE" };
    if (!isAllowedEnvironmentName(name)) return { code: "ENVIRONMENT_VARIABLE_NOT_ALLOWED" };
  }
  if (proposal.changes === undefined || proposal.changes.length === 0) {
    return { code: "ENVIRONMENT_CHANGE_REQUIRED" };
  }
  const requested = new Set(proposal.variableNames);
  if (requested.size !== proposal.variableNames.length || proposal.changes.length !== requested.size ||
    proposal.changes.some((change) => !requested.has(change.name))) {
    return { code: "INVALID_ENVIRONMENT_VALUE" };
  }
  const snapshot = configurationSnapshotSchema.safeParse(affected.configurationSnapshot);
  const current = snapshot.success ? snapshot.data.safeEnvironment ?? {} : {};
  const changes: EnvironmentPlanChange[] = [];
  for (const change of proposal.changes) {
    if (SENSITIVE_ENVIRONMENT_NAME.test(change.name)) return { code: "SENSITIVE_ENVIRONMENT_VARIABLE" };
    if (!isAllowedEnvironmentName(change.name) ||
      !isAllowedEnvironmentValue(change.name, change.proposedValue, candidate.projectExpectedPort)) {
      return { code: isAllowedEnvironmentName(change.name)
        ? "INVALID_ENVIRONMENT_VALUE"
        : "ENVIRONMENT_VARIABLE_NOT_ALLOWED" };
    }
    const expectedValue = current[change.name] ?? null;
    if (expectedValue !== null && !isSafeSnapshotEnvironmentValue(change.name, expectedValue)) {
      return { code: "INVALID_ENVIRONMENT_VALUE" };
    }
    changes.push({
      name: change.name,
      expectedValue,
      proposedValue: change.proposedValue
    });
  }
  changes.sort((left, right) => compareCanonicalStrings(left.name, right.name));
  return {
    action: {
      type: "UPDATE_ALLOWED_ENV",
      deploymentId: affected.id,
      changes,
      reason: safeReason
    },
    baseline: { safeEnvironment: Object.fromEntries(
      changes.map((change) => [change.name, change.expectedValue])
    ) },
    summary: "Stage an allow-listed non-secret environment update for later verification and approval.",
    rollbackSupported: true,
    rollbackDescription: "Restore the captured allow-listed baseline values."
  };
}

function isAllowedEnvironmentName(name: string): name is EnvironmentPlanChange["name"] {
  return ["NODE_ENV", "APP_ENV", "LOG_LEVEL", "HOST", "PORT"].includes(name);
}

function isAllowedEnvironmentValue(
  name: EnvironmentPlanChange["name"],
  value: string,
  expectedPort: number | null
): boolean {
  switch (name) {
    case "NODE_ENV":
    case "APP_ENV":
      return ["development", "test", "staging", "production"].includes(value);
    case "LOG_LEVEL":
      return ["trace", "debug", "info", "warn", "error", "fatal"].includes(value);
    case "HOST":
      return ["0.0.0.0", "127.0.0.1", "localhost"].includes(value);
    case "PORT":
      return expectedPort !== null && value === String(expectedPort);
  }
}

function isSafeSnapshotEnvironmentValue(
  name: EnvironmentPlanChange["name"],
  value: string
): boolean {
  if (name === "PORT") {
    if (!/^\d{1,5}$/.test(value)) return false;
    const port = Number(value);
    return Number.isInteger(port) && port >= 1 && port <= 65_535;
  }
  return isAllowedEnvironmentValue(name, value, null);
}

function deploymentIdentity(deployment: PlanningDeployment): Readonly<Record<string, unknown>> {
  return {
    id: deployment.id,
    projectId: deployment.projectId,
    isCurrent: deployment.isCurrent,
    containerName: deployment.containerName,
    imageReference: deployment.imageReference,
    configurationSnapshotHash: sha256Canonical(safeConfigurationSnapshot(deployment.configurationSnapshot)),
    createdAt: deployment.createdAt.toISOString()
  };
}

function hasSafeDeploymentIdentity(deployment: PlanningDeployment): boolean {
  return SAFE_CONTAINER_NAME.test(deployment.containerName) &&
    SAFE_IMAGE_REFERENCE.test(deployment.imageReference) &&
    !deployment.imageReference.includes("://") &&
    !CREDENTIAL_SHAPED_IMAGE_REFERENCE.test(deployment.imageReference);
}

function safeConfigurationSnapshot(value: unknown): Readonly<Record<string, unknown>> {
  const parsed = configurationSnapshotSchema.safeParse(value);
  if (!parsed.success) return {};
  const safeEnvironment = Object.fromEntries(
    Object.entries(parsed.data.safeEnvironment ?? {})
      .filter((entry): entry is [EnvironmentPlanChange["name"], string] =>
        isAllowedEnvironmentName(entry[0]) &&
        isSafeSnapshotEnvironmentValue(entry[0], entry[1]))
      .sort(([left], [right]) => compareCanonicalStrings(left, right))
  );
  const applicationFiles = [...(parsed.data.applicationFiles ?? [])]
    .map((file) => ({
      relativePath: file.relativePath,
      contentHash: file.contentHash,
      binary: file.binary ?? false,
      generated: file.generated ?? false,
      protected: file.protected ?? false,
      symlink: file.symlink ?? false
    }))
    .sort((left, right) => compareCanonicalStrings(left.relativePath, right.relativePath));
  return { safeEnvironment, applicationFiles };
}

function isSafeRelativePath(path: string): boolean {
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path) || path.includes("\\")) {
    return false;
  }
  const segments = path.split("/");
  return segments.length > 0 && segments.every((segment) =>
    segment.length > 0 && segment !== "." && segment !== ".." && !segment.includes("\0")
  );
}

function isProtectedPath(path: string): boolean {
  const lower = path.toLowerCase();
  const segments = lower.split("/");
  const fileName = segments.at(-1) ?? "";
  const extension = fileName.includes(".") ? `.${fileName.split(".").at(-1)}` : "";
  const allowedExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".json", ".yaml", ".yml", ".toml", ".css", ".html", ".txt", ".md"]);
  return fileName === ".env" || fileName.startsWith(".env.") ||
    [".git", "node_modules", ".next", "dist", "build", "coverage"].some((part) => segments.includes(part)) ||
    lower.startsWith("apps/api/") || lower.startsWith("apps/web/") ||
    lower.startsWith("packages/shared/") || lower.startsWith("prisma/") || lower.startsWith("docs/") ||
    ["package.json", "package-lock.json", "dockerfile", "compose.yaml", "docker-compose.yml", "docker-compose.yaml"].includes(fileName) ||
    !allowedExtensions.has(extension);
}

function createUnifiedDiff(path: string, original: string, replacement: string): string {
  const oldLines = splitLines(original);
  const newLines = splitLines(replacement);
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`)
  ].join("\n");
}

function splitLines(value: string): readonly string[] {
  return value.replace(/\r\n/g, "\n").split("\n");
}

function notActionable(code: ActionFailure["code"]): RemediationPlanningDecision {
  return { kind: "NOT_ACTIONABLE", code };
}
