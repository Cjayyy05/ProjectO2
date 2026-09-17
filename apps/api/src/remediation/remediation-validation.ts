import { z } from "zod";
import { sha256Canonical } from "./canonical-hash";
import type { RemediationPlanDraft } from "./remediation-types";

const uuid = z.uuid();
const reason = z.string().trim().min(1).max(500);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const environmentName = z.enum(["NODE_ENV", "APP_ENV", "LOG_LEVEL", "HOST", "PORT"]);

export const controlledRemediationActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("RESTART_CONTAINER"),
    deploymentId: uuid,
    reason
  }).strict(),
  z.object({
    type: z.literal("ROLLBACK_DEPLOYMENT"),
    affectedDeploymentId: uuid,
    targetDeploymentId: uuid,
    reason
  }).strict(),
  z.object({
    type: z.literal("UPDATE_ALLOWED_ENV"),
    deploymentId: uuid,
    changes: z.array(z.object({
      name: environmentName,
      expectedValue: z.string().max(256).nullable(),
      proposedValue: z.string().min(1).max(256)
    }).strict()).min(1).max(4),
    reason
  }).strict(),
  z.object({
    type: z.literal("PATCH_APPLICATION_FILE"),
    deploymentId: uuid,
    files: z.array(z.object({
      relativePath: z.string().min(1).max(240),
      expectedContentHash: digest,
      replacementContent: z.string().max(32 * 1_024),
      unifiedDiff: z.string().max(96 * 1_024)
    }).strict()).min(1).max(4),
    reason
  }).strict()
]);

export const remediationPlanDraftSchema = z.object({
  schemaVersion: z.literal(1),
  incidentId: uuid,
  diagnosisId: uuid,
  projectId: uuid,
  deploymentId: uuid,
  version: z.literal(1),
  actionTypes: z.tuple([z.enum([
    "RESTART_CONTAINER",
    "ROLLBACK_DEPLOYMENT",
    "UPDATE_ALLOWED_ENV",
    "PATCH_APPLICATION_FILE"
  ])]),
  actions: z.tuple([controlledRemediationActionSchema]),
  baseline: z.record(z.string(), z.unknown()),
  summary: z.string().trim().min(1).max(500),
  rollbackSupported: z.boolean(),
  rollbackDescription: z.string().trim().min(1).max(500).nullable(),
  planHash: digest,
  targetSnapshotHash: digest
}).strict().superRefine((plan, context) => {
  const action = plan.actions[0];
  if (plan.actionTypes[0] !== action.type) {
    context.addIssue({ code: "custom", message: "Action type identity does not match" });
  }
  const affectedDeploymentId = action.type === "ROLLBACK_DEPLOYMENT"
    ? action.affectedDeploymentId
    : action.deploymentId;
  if (affectedDeploymentId !== plan.deploymentId) {
    context.addIssue({ code: "custom", message: "Action target does not match the plan Deployment" });
  }
  if (action.type === "ROLLBACK_DEPLOYMENT" && action.targetDeploymentId === plan.deploymentId) {
    context.addIssue({ code: "custom", message: "Rollback target cannot be the affected Deployment" });
  }
  const rollbackExpected = action.type === "ROLLBACK_DEPLOYMENT" ||
    action.type === "UPDATE_ALLOWED_ENV";
  if (plan.rollbackSupported !== rollbackExpected ||
    (rollbackExpected ? plan.rollbackDescription === null : plan.rollbackDescription !== null)) {
    context.addIssue({ code: "custom", message: "Rollback metadata does not match the action" });
  }
});

type PlanHashContent = Omit<RemediationPlanDraft, "planHash">;

export function computeRemediationPlanHash(plan: PlanHashContent): string {
  return sha256Canonical({
    schemaVersion: plan.schemaVersion,
    version: plan.version,
    incidentId: plan.incidentId,
    diagnosisId: plan.diagnosisId,
    projectId: plan.projectId,
    deploymentId: plan.deploymentId,
    actionTypes: plan.actionTypes,
    actions: plan.actions,
    baseline: plan.baseline,
    summary: plan.summary,
    rollbackSupported: plan.rollbackSupported,
    rollbackDescription: plan.rollbackDescription,
    targetSnapshotHash: plan.targetSnapshotHash
  });
}

export function validateRemediationPlanIntegrity(value: unknown): RemediationPlanDraft | null {
  const parsed = remediationPlanDraftSchema.safeParse(value);
  if (!parsed.success) return null;
  const plan = parsed.data as RemediationPlanDraft;
  return computeRemediationPlanHash(plan) === plan.planHash ? plan : null;
}
