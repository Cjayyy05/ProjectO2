import type { DiagnosisResult } from "../diagnosis/diagnosis-types";

export const PLAN_SCHEMA_VERSION = 1 as const;

export type PlanningDispositionCode =
  | "PLAN_CREATED"
  | "INVALID_DIAGNOSIS_RESULT"
  | "MANUAL_INVESTIGATION_REQUIRED"
  | "NO_REMEDIATION_SUGGESTED"
  | "INCIDENT_DEPLOYMENT_REQUIRED"
  | "INCIDENT_DEPLOYMENT_MISMATCH"
  | "UNSAFE_DEPLOYMENT_IDENTITY"
  | "INVALID_ROLLBACK_TARGET"
  | "ROLLBACK_TARGET_UNAVAILABLE"
  | "SENSITIVE_ENVIRONMENT_VARIABLE"
  | "ENVIRONMENT_VARIABLE_NOT_ALLOWED"
  | "ENVIRONMENT_CHANGE_REQUIRED"
  | "INVALID_ENVIRONMENT_VALUE"
  | "INVALID_PATCH_PATH"
  | "PATCH_FILE_NOT_REGISTERED"
  | "PATCH_FILE_NOT_SAFE"
  | "PATCH_BASELINE_MISMATCH"
  | "PATCH_CONTAINS_SECRET"
  | "PATCH_TOO_LARGE"
  | "PLAN_IDENTITY_MISMATCH"
  | "PLAN_INTEGRITY_MISMATCH";

export interface PlanningDeployment {
  readonly id: string;
  readonly projectId: string;
  readonly isCurrent: boolean;
  readonly containerName: string;
  readonly imageReference: string;
  readonly configurationSnapshot: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface RemediationPlanningCandidate {
  readonly incidentId: string;
  readonly incidentVersion: number;
  readonly projectId: string;
  readonly ownerId: string;
  readonly diagnosisId: string;
  readonly diagnosisResult: unknown;
  readonly affectedDeployment: PlanningDeployment | null;
  readonly projectHealthCheckPath: string | null;
  readonly projectExpectedPort: number | null;
  readonly projectDeployments: readonly PlanningDeployment[];
}

export interface RestartContainerPlanAction {
  readonly type: "RESTART_CONTAINER";
  readonly deploymentId: string;
  readonly reason: string;
}

export interface RollbackDeploymentPlanAction {
  readonly type: "ROLLBACK_DEPLOYMENT";
  readonly affectedDeploymentId: string;
  readonly targetDeploymentId: string;
  readonly reason: string;
}

export interface EnvironmentPlanChange {
  readonly name: "NODE_ENV" | "APP_ENV" | "LOG_LEVEL" | "HOST" | "PORT";
  readonly expectedValue: string | null;
  readonly proposedValue: string;
}

export interface UpdateAllowedEnvPlanAction {
  readonly type: "UPDATE_ALLOWED_ENV";
  readonly deploymentId: string;
  readonly changes: readonly EnvironmentPlanChange[];
  readonly reason: string;
}

export interface FilePlanChange {
  readonly relativePath: string;
  readonly expectedContentHash: string;
  readonly replacementContent: string;
  readonly unifiedDiff: string;
}

export interface PatchApplicationFilePlanAction {
  readonly type: "PATCH_APPLICATION_FILE";
  readonly deploymentId: string;
  readonly files: readonly FilePlanChange[];
  readonly reason: string;
}

export type ControlledRemediationAction =
  | RestartContainerPlanAction
  | RollbackDeploymentPlanAction
  | UpdateAllowedEnvPlanAction
  | PatchApplicationFilePlanAction;

export interface RemediationPlanDraft {
  readonly schemaVersion: typeof PLAN_SCHEMA_VERSION;
  readonly incidentId: string;
  readonly diagnosisId: string;
  readonly projectId: string;
  readonly deploymentId: string;
  readonly version: 1;
  readonly actionTypes: readonly [ControlledRemediationAction["type"]];
  readonly actions: readonly [ControlledRemediationAction];
  readonly baseline: Readonly<Record<string, unknown>>;
  readonly summary: string;
  readonly rollbackSupported: boolean;
  readonly rollbackDescription: string | null;
  readonly planHash: string;
  readonly targetSnapshotHash: string;
}

export type RemediationPlanningDecision =
  | { readonly kind: "PLAN"; readonly plan: RemediationPlanDraft }
  | { readonly kind: "NOT_ACTIONABLE"; readonly code: Exclude<PlanningDispositionCode, "PLAN_CREATED"> };

export interface ValidatedPlanningInput {
  readonly candidate: RemediationPlanningCandidate;
  readonly diagnosis: DiagnosisResult;
}
