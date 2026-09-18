import { randomUUID } from "node:crypto";
import { RemediationPlanBuilder } from "../remediation/remediation-plan-builder";
import type {
  PlanningDeployment,
  RemediationPlanDraft,
  RemediationPlanningCandidate
} from "../remediation/remediation-types";
import type { ClaimedVerificationCandidate, VerificationCandidate } from "./verification-types";

export interface VerificationFixture {
  readonly claimed: ClaimedVerificationCandidate;
  readonly candidate: VerificationCandidate;
  readonly plan: RemediationPlanDraft;
  readonly affected: PlanningDeployment;
  readonly historical: PlanningDeployment;
}

export function createVerificationFixture(options: {
  readonly proposedRemediation?: Readonly<Record<string, unknown>>;
  readonly affectedSnapshot?: unknown;
  readonly historicalSnapshot?: unknown;
  readonly healthCheckPath?: string | null;
  readonly expectedPort?: number | null;
  readonly action?: "RESTART" | "ROLLBACK";
} = {}): VerificationFixture {
  const projectId = randomUUID();
  const incidentId = randomUUID();
  const diagnosisId = randomUUID();
  const affected: PlanningDeployment = {
    id: randomUUID(),
    projectId,
    isCurrent: true,
    containerName: `app-${randomUUID()}`,
    imageReference: "example/app:current",
    configurationSnapshot: options.affectedSnapshot ?? { safeEnvironment: { PORT: "8080" } },
    createdAt: new Date("2026-09-18T00:00:00.000Z"),
    updatedAt: new Date("2026-09-18T00:00:00.000Z")
  };
  const historical: PlanningDeployment = {
    id: randomUUID(),
    projectId,
    isCurrent: false,
    containerName: `app-old-${randomUUID()}`,
    imageReference: "example/app:previous",
    configurationSnapshot: options.historicalSnapshot ?? { safeEnvironment: { PORT: "8080" } },
    createdAt: new Date("2026-09-17T00:00:00.000Z"),
    updatedAt: new Date("2026-09-17T00:00:00.000Z")
  };
  const planningCandidate: RemediationPlanningCandidate = {
    incidentId,
    incidentVersion: 7,
    projectId,
    ownerId: randomUUID(),
    diagnosisId,
    diagnosisResult: diagnosisResult(
      options.proposedRemediation ?? (options.action === "ROLLBACK" ? {
        type: "ROLLBACK_DEPLOYMENT",
        targetDeploymentId: historical.id,
        reason: "Verify the registered previous deployment."
      } : undefined)
    ),
    affectedDeployment: affected,
    projectHealthCheckPath: options.healthCheckPath === undefined ? "/health" : options.healthCheckPath,
    projectExpectedPort: options.expectedPort === undefined ? 8080 : options.expectedPort,
    projectDeployments: [affected, historical]
  };
  const decision = new RemediationPlanBuilder().build(planningCandidate);
  if (decision.kind !== "PLAN") throw new Error(`Test fixture was not actionable: ${decision.code}`);
  const base = {
    runId: randomUUID(),
    claimToken: randomUUID(),
    incidentId,
    incidentVersion: 8,
    ownerId: planningCandidate.ownerId,
    projectId,
    healthCheckPath: options.healthCheckPath === undefined ? "/health" : options.healthCheckPath,
    expectedPort: options.expectedPort === undefined ? 8080 : options.expectedPort,
    planId: randomUUID(),
    affectedDeployment: affected,
    projectDeployments: [affected, historical]
  };
  return {
    plan: decision.plan,
    affected,
    historical,
    claimed: { ...base, planValue: decision.plan },
    candidate: { ...base, plan: decision.plan }
  };
}

function diagnosisResult(
  proposedRemediation: Readonly<Record<string, unknown>> | undefined
): Readonly<Record<string, unknown>> {
  return {
    rootCauseCode: "CONTAINER_CRASH",
    summary: "Candidate needs controlled verification.",
    explanation: "Persisted evidence supports an allow-listed candidate action.",
    supportingEvidenceReferences: [],
    confidence: 0.85,
    proposedRemediation: proposedRemediation ?? {
      type: "RESTART_CONTAINER",
      reason: "Verify equivalent startup in isolation."
    },
    manualInvestigationRecommended: false
  };
}
