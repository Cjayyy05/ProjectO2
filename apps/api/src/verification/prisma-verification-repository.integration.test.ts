import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { RemediationPlanBuilder } from "../remediation/remediation-plan-builder";
import type { RemediationPlanningCandidate } from "../remediation/remediation-types";
import { PrismaVerificationRepository } from "./prisma-verification-repository";
import type { VerificationExecutionResult } from "./verification-types";

const databaseTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeDatabase = databaseTestsEnabled ? describe : describe.skip;

describeDatabase("Prisma verification repository integration", () => {
  it("has one transactional claim winner and persists the exact verified digest", async () => {
    const prisma = new PrismaClient();
    try {
      const fixture = await createFixture(prisma);
      const first = new PrismaVerificationRepository(prisma);
      const second = new PrismaVerificationRepository(prisma);
      const claims = await Promise.all([first.claimNext(30_000), second.claimNext(30_000)]);
      const winners = claims.filter((claim) => claim !== null);

      expect(winners).toHaveLength(1);
      const winner = winners[0];
      if (winner === undefined) throw new Error("Verification claim missing");
      await expect(first.markRunning(winner)).resolves.toBe(true);
      await expect(first.complete(winner, successfulResult(fixture), 60_000)).resolves.toBe(true);

      await expect(prisma.verificationRun.findUniqueOrThrow({
        where: { remediationPlanId: fixture.planId }
      })).resolves.toMatchObject({
        state: "PASSED",
        planHash: fixture.planHash,
        targetSnapshotHash: fixture.targetSnapshotHash,
        cleanupSucceeded: true
      });
      await expect(prisma.incident.findUniqueOrThrow({ where: { id: fixture.incidentId } }))
        .resolves.toMatchObject({ state: "AWAITING_APPROVAL", version: 10 });
      await expect(prisma.auditEvent.count({
        where: { incidentId: fixture.incidentId, action: "VERIFICATION_STARTED" }
      })).resolves.toBe(1);
      await expect(prisma.auditEvent.count({
        where: { incidentId: fixture.incidentId, action: "VERIFICATION_PASSED" }
      })).resolves.toBe(1);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("reclaims an expired lease and prevents the stale worker from renewing or persisting", async () => {
    const prisma = new PrismaClient();
    try {
      const fixture = await createFixture(prisma);
      const repository = new PrismaVerificationRepository(prisma);
      const stale = await repository.claimNext(30_000);
      if (stale === null) throw new Error("Initial claim missing");
      await expect(repository.markRunning(stale)).resolves.toBe(true);
      await prisma.verificationRun.update({
        where: { id: stale.runId },
        data: { claimedAt: new Date("2000-01-01T00:00:00.000Z") }
      });

      const reclaimed = await repository.claimNext(1_000);
      if (reclaimed === null) throw new Error("Reclaimed claim missing");
      expect(reclaimed.runId).toBe(stale.runId);
      expect(reclaimed.claimToken).not.toBe(stale.claimToken);
      expect(reclaimed.incidentVersion).toBe(stale.incidentVersion + 1);
      await expect(repository.renewClaim(stale)).resolves.toBe(false);
      await expect(repository.complete(stale, successfulResult(fixture), 60_000)).resolves.toBe(false);
      await expect(repository.markRunning(reclaimed)).resolves.toBe(true);
      await expect(repository.complete(reclaimed, successfulResult(fixture), 60_000)).resolves.toBe(true);

      await expect(prisma.verificationRun.findUniqueOrThrow({ where: { id: stale.runId } }))
        .resolves.toMatchObject({ state: "PASSED", claimToken: null, claimedAt: null });
    } finally {
      await prisma.$disconnect();
    }
  });

  it("rolls back run and Incident completion when the audit write fails", async () => {
    const prisma = new PrismaClient();
    try {
      const fixture = await createFixture(prisma);
      const repository = new PrismaVerificationRepository(prisma);
      const claim = await repository.claimNext(30_000);
      if (claim === null) throw new Error("Verification claim missing");
      await repository.markRunning(claim);
      await prisma.$executeRawUnsafe(`
        CREATE FUNCTION reject_phase6_audit() RETURNS trigger AS $$
        BEGIN
          IF NEW."action" = 'VERIFICATION_PASSED' THEN
            RAISE EXCEPTION 'intentional audit failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER reject_phase6_audit_trigger
        BEFORE INSERT ON "AuditEvent"
        FOR EACH ROW EXECUTE FUNCTION reject_phase6_audit()
      `);
      try {
        await expect(repository.complete(claim, successfulResult(fixture), 60_000)).rejects.toBeDefined();
      } finally {
        await prisma.$executeRawUnsafe(
          `DROP TRIGGER IF EXISTS reject_phase6_audit_trigger ON "AuditEvent"`
        );
        await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS reject_phase6_audit()`);
      }

      await expect(prisma.verificationRun.findUniqueOrThrow({ where: { id: claim.runId } }))
        .resolves.toMatchObject({ state: "RUNNING", completedAt: null });
      await expect(prisma.incident.findUniqueOrThrow({ where: { id: fixture.incidentId } }))
        .resolves.toMatchObject({ state: "VERIFYING", version: claim.incidentVersion });
    } finally {
      await prisma.$disconnect();
    }
  });

  it("makes plans immutable and invalidates an active worker whose run binding changes", async () => {
    const prisma = new PrismaClient();
    try {
      const fixture = await createFixture(prisma);
      const repository = new PrismaVerificationRepository(prisma);
      const claim = await repository.claimNext(30_000);
      if (claim === null) throw new Error("Verification claim missing");
      await repository.markRunning(claim);
      await expect(prisma.remediationPlan.update({
        where: { id: fixture.planId },
        data: { summary: "Tampered non-digest behavior input" }
      })).rejects.toBeDefined();
      await prisma.verificationRun.update({
        where: { id: claim.runId },
        data: { planHash: "f".repeat(64) }
      });

      await expect(repository.renewClaim(claim)).resolves.toBe(false);
      await expect(repository.complete(claim, successfulResult(fixture), 60_000)).resolves.toBe(false);

      await prisma.verificationRun.update({
        where: { id: claim.runId },
        data: { planHash: fixture.planHash }
      });
      await expect(repository.complete(claim, successfulResult(fixture), 60_000)).resolves.toBe(true);
    } finally {
      await prisma.$disconnect();
    }
  });
});

interface Fixture {
  readonly incidentId: string;
  readonly planId: string;
  readonly planHash: string;
  readonly targetSnapshotHash: string;
}

async function createFixture(prisma: PrismaClient): Promise<Fixture> {
  await prisma.incident.updateMany({
    where: {
      state: { in: ["FIX_PROPOSED", "VERIFYING"] },
      project: { user: { email: { startsWith: "verification-" } } }
    },
    data: { state: "VERIFICATION_FAILED", version: { increment: 1 } }
  });
  const unique = randomUUID();
  const user = await prisma.user.create({
    data: { email: `verification-${unique}@example.com`, passwordHash: "not-used" }
  });
  const project = await prisma.project.create({
    data: {
      userId: user.id,
      name: `Verification ${unique}`,
      healthCheckPath: "/health",
      expectedPort: 8080
    }
  });
  const deployment = await prisma.deployment.create({
    data: {
      projectId: project.id,
      name: "current",
      containerName: `verification-${unique}`,
      imageReference: "example/app:current",
      configurationSnapshot: { safeEnvironment: { PORT: "8080" } }
    }
  });
  const incident = await prisma.incident.create({
    data: {
      projectId: project.id,
      deploymentId: deployment.id,
      type: "CONTAINER_CRASH",
      state: "FIX_PROPOSED",
      version: 8,
      fingerprint: `verification-${unique}`,
      createdAt: new Date("1900-01-01T00:00:00.000Z"),
      updatedAt: new Date("1900-01-01T00:00:00.000Z")
    }
  });
  const diagnosisResult = {
    rootCauseCode: "CONTAINER_CRASH",
    summary: "Container exited",
    explanation: "Persisted evidence supports an isolated startup check.",
    supportingEvidenceReferences: [],
    confidence: 0.85,
    proposedRemediation: { type: "RESTART_CONTAINER", reason: "Verify startup in isolation." },
    manualInvestigationRecommended: false
  };
  const diagnosis = await prisma.diagnosis.create({
    data: {
      incidentId: incident.id,
      provider: "mock",
      providerVersion: "deterministic-v1",
      rootCauseCode: "CONTAINER_CRASH",
      summary: "Container exited",
      confidence: 0.85,
      evidenceReferences: [],
      result: diagnosisResult,
      remediationPlanningCompletedAt: new Date(),
      remediationPlanningCode: "PLAN_CREATED"
    }
  });
  const candidate: RemediationPlanningCandidate = {
    incidentId: incident.id,
    incidentVersion: incident.version,
    projectId: project.id,
    ownerId: user.id,
    diagnosisId: diagnosis.id,
    diagnosisResult,
    affectedDeployment: deployment,
    projectHealthCheckPath: project.healthCheckPath,
    projectExpectedPort: project.expectedPort,
    projectDeployments: [deployment]
  };
  const decision = new RemediationPlanBuilder().build(candidate);
  if (decision.kind !== "PLAN") throw new Error(`Fixture plan failed: ${decision.code}`);
  const action = decision.plan.actions[0];
  if (action.type !== "RESTART_CONTAINER") throw new Error("Restart plan expected");
  const plan = await prisma.remediationPlan.create({
    data: {
      projectId: project.id,
      incidentId: incident.id,
      diagnosisId: diagnosis.id,
      deploymentId: deployment.id,
      version: 1,
      schemaVersion: 1,
      actionTypes: ["RESTART_CONTAINER"],
      actions: [{ type: action.type, deploymentId: action.deploymentId, reason: action.reason }],
      baseline: decision.plan.baseline as Prisma.InputJsonValue,
      summary: decision.plan.summary,
      rollbackSupported: decision.plan.rollbackSupported,
      rollbackDescription: decision.plan.rollbackDescription,
      planHash: decision.plan.planHash,
      targetSnapshotHash: decision.plan.targetSnapshotHash
    }
  });
  return {
    incidentId: incident.id,
    planId: plan.id,
    planHash: decision.plan.planHash,
    targetSnapshotHash: decision.plan.targetSnapshotHash
  };
}

function successfulResult(fixture: Fixture): VerificationExecutionResult {
  const passed = { status: "PASSED" as const, code: "PASSED", summary: "Gate passed." };
  return {
    passed: true,
    failureCode: null,
    planHash: fixture.planHash,
    targetSnapshotHash: fixture.targetSnapshotHash,
    sandboxIdentifier: `selfheal-verification-${randomUUID()}`,
    checkResults: {
      schemaVersion: 1,
      planIntegrity: passed,
      baseline: passed,
      application: passed,
      build: passed,
      startup: passed,
      tests: { status: "NOT_CONFIGURED", code: "NOT_CONFIGURED", summary: "No tests." },
      healthCheck: passed,
      candidateLogs: passed
    },
    boundedOutput: "bounded output",
    cleanupSucceeded: true
  };
}
