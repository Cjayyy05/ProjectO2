export const REMEDIATION_ACTION_TYPES = [
  "RESTART_CONTAINER",
  "ROLLBACK_DEPLOYMENT",
  "UPDATE_ALLOWED_ENV",
  "PATCH_APPLICATION_FILE"
] as const;

export type RemediationActionType = (typeof REMEDIATION_ACTION_TYPES)[number];

export interface RestartContainerAction {
  readonly type: "RESTART_CONTAINER";
  readonly deploymentId: string;
}

export interface RollbackDeploymentAction {
  readonly type: "ROLLBACK_DEPLOYMENT";
  readonly targetDeploymentId: string;
}

export interface UpdateAllowedEnvAction {
  readonly type: "UPDATE_ALLOWED_ENV";
  readonly key: string;
  readonly valueReference: string;
}

export interface PatchApplicationFileAction {
  readonly type: "PATCH_APPLICATION_FILE";
  readonly relativePath: string;
  readonly patchArtifactId: string;
}

export type RemediationAction =
  | RestartContainerAction
  | RollbackDeploymentAction
  | UpdateAllowedEnvAction
  | PatchApplicationFileAction;

