import { z } from "zod";
import { healthCheckPathSchema } from "../monitoring/health-check-path";
import { sha256Canonical, sha256Text } from "../remediation/canonical-hash";
import {
  deploymentIdentity,
  safeConfigurationSnapshot
} from "../remediation/remediation-plan-builder";
import { validateRemediationPlanIntegrity } from "../remediation/remediation-validation";
import type { PlanningDeployment } from "../remediation/remediation-types";
import { VerificationFailure, type VerificationCandidate } from "./verification-types";

const snapshotSchema = z.object({
  safeEnvironment: z.record(z.string(), z.string().max(256)).optional(),
  applicationFiles: z.array(z.object({
    relativePath: z.string(),
    contentHash: z.string(),
    binary: z.boolean().optional(),
    generated: z.boolean().optional(),
    protected: z.boolean().optional(),
    symlink: z.boolean().optional()
  }).passthrough()).optional(),
  verificationSource: z.object({
    files: z.array(z.object({
      relativePath: z.string(),
      content: z.string(),
      contentHash: z.string()
    }).passthrough()).optional()
  }).passthrough().optional()
}).passthrough();

export interface BoundVerificationTarget {
  readonly healthCheckPath: string;
  readonly expectedPort: number;
}

export function validateVerificationBaseline(candidate: VerificationCandidate): BoundVerificationTarget {
  if (validateRemediationPlanIntegrity(candidate.plan) === null) {
    throw new VerificationFailure("PLAN_INTEGRITY_MISMATCH", "Stored plan integrity validation failed");
  }
  if (candidate.plan.projectId !== candidate.projectId ||
    candidate.plan.incidentId !== candidate.incidentId ||
    candidate.plan.deploymentId !== candidate.affectedDeployment.id ||
    candidate.affectedDeployment.projectId !== candidate.projectId) {
    throw new VerificationFailure("BASELINE_INVALID", "Plan ownership or target identity is invalid");
  }

  const action = candidate.plan.actions[0];
  const affectedIdentity = deploymentIdentity(candidate.affectedDeployment);
  const verification = z.object({
    healthCheckPath: healthCheckPathSchema.nullable(),
    expectedPort: z.number().int().min(1).max(65_535).nullable()
  }).strict().safeParse(candidate.plan.baseline.verification);
  if (!verification.success || verification.data.healthCheckPath === null ||
    verification.data.expectedPort === null) {
    throw new VerificationFailure("BASELINE_INVALID", "Trusted health-check baseline is incomplete");
  }
  if (verification.data.healthCheckPath !== candidate.healthCheckPath ||
    verification.data.expectedPort !== candidate.expectedPort) {
    throw new VerificationFailure("BASELINE_DRIFT", "Trusted health-check configuration changed");
  }
  let actionBaseline: Readonly<Record<string, unknown>>;
  switch (action.type) {
    case "RESTART_CONTAINER":
      actionBaseline = { deployment: affectedIdentity };
      break;
    case "ROLLBACK_DEPLOYMENT": {
      if (action.affectedDeploymentId !== candidate.affectedDeployment.id) {
        throw new VerificationFailure("BASELINE_INVALID", "Rollback affected Deployment is invalid");
      }
      const target = findEligibleRollbackTarget(candidate, action.targetDeploymentId);
      actionBaseline = {
        affectedDeployment: affectedIdentity,
        rollbackTarget: deploymentIdentity(target)
      };
      break;
    }
    case "UPDATE_ALLOWED_ENV": {
      const snapshot = parseSnapshot(candidate.affectedDeployment);
      const current = snapshot.safeEnvironment ?? {};
      for (const change of action.changes) {
        if ((current[change.name] ?? null) !== change.expectedValue) {
          throw new VerificationFailure("BASELINE_DRIFT", "Safe environment baseline changed");
        }
      }
      actionBaseline = {
        safeEnvironment: Object.fromEntries(
          action.changes.map((change) => [change.name, change.expectedValue])
        )
      };
      break;
    }
    case "PATCH_APPLICATION_FILE": {
      const snapshot = parseSnapshot(candidate.affectedDeployment);
      const manifest = snapshot.applicationFiles ?? [];
      const sourceFiles = snapshot.verificationSource?.files ?? [];
      for (const file of action.files) {
        const registered = manifest.find((entry) => entry.relativePath === file.relativePath);
        const source = sourceFiles.find((entry) => entry.relativePath === file.relativePath);
        if (registered === undefined || registered.contentHash !== file.expectedContentHash ||
          registered.binary || registered.generated || registered.protected || registered.symlink ||
          source === undefined || source.contentHash !== file.expectedContentHash ||
          sha256Text(source.content) !== file.expectedContentHash) {
          throw new VerificationFailure("PATCH_BASELINE_MISMATCH", "Patch baseline changed");
        }
      }
      actionBaseline = {
        files: action.files.map((file) => ({
          relativePath: file.relativePath,
          expectedContentHash: file.expectedContentHash
        }))
      };
      break;
    }
  }

  const targetBaseline = {
    affectedDeployment: affectedIdentity,
    action: actionBaseline,
    verification: verification.data
  };
  const targetSnapshotHash = sha256Canonical({
    projectId: candidate.projectId,
    deploymentId: candidate.affectedDeployment.id,
    baseline: targetBaseline
  });
  if (targetSnapshotHash !== candidate.plan.targetSnapshotHash ||
    sha256Canonical(safeConfigurationSnapshot(candidate.affectedDeployment.configurationSnapshot)) !==
      String(affectedIdentity.configurationSnapshotHash)) {
    throw new VerificationFailure("BASELINE_DRIFT", "Target snapshot no longer matches the plan");
  }
  return {
    healthCheckPath: verification.data.healthCheckPath,
    expectedPort: verification.data.expectedPort
  };
}

function findEligibleRollbackTarget(
  candidate: VerificationCandidate,
  targetDeploymentId: string
): PlanningDeployment {
  const target = candidate.projectDeployments.find((deployment) =>
    deployment.id === targetDeploymentId &&
    deployment.projectId === candidate.projectId &&
    deployment.id !== candidate.affectedDeployment.id &&
    !deployment.isCurrent &&
    deployment.createdAt.getTime() < candidate.affectedDeployment.createdAt.getTime());
  if (target === undefined) {
    throw new VerificationFailure("BASELINE_DRIFT", "Rollback target is no longer eligible");
  }
  return target;
}

function parseSnapshot(deployment: PlanningDeployment): z.infer<typeof snapshotSchema> {
  const result = snapshotSchema.safeParse(deployment.configurationSnapshot);
  if (!result.success) {
    throw new VerificationFailure("BASELINE_INVALID", "Deployment configuration snapshot is invalid");
  }
  return result.data;
}
