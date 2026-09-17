import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { RemediationPlanBuilder } from "./remediation-plan-builder";
import { PrismaRemediationPlanningRepository } from "./prisma-remediation-planning-repository";
import type { RemediationPlanningDecision } from "./remediation-types";

const databaseTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeDatabase = databaseTestsEnabled ? describe : describe.skip;

describeDatabase("Prisma remediation planning integration", () => {
  it("has one transactional winner for concurrent plan creation", async () => {
    const prisma = new PrismaClient();
    try {
      const fixture = await createFixture(prisma, restartResult());
      const firstRepository = new PrismaRemediationPlanningRepository(prisma);
      const secondRepository = new PrismaRemediationPlanningRepository(prisma);
      const firstCandidate = await firstRepository.findNextCandidate(fixture.incidentId);
      const secondCandidate = await secondRepository.findNextCandidate(fixture.incidentId);
      if (firstCandidate === null || secondCandidate === null) throw new Error("Candidate missing");
      const builder = new RemediationPlanBuilder();
      const firstDecision = builder.build(firstCandidate);
      const secondDecision = builder.build(secondCandidate);

      const outcomes = await Promise.all([
        firstRepository.persistDecision(firstCandidate, firstDecision),
        secondRepository.persistDecision(secondCandidate, secondDecision)
      ]);

      expect(outcomes.filter(Boolean)).toHaveLength(1);
      await expect(prisma.remediationPlan.findMany({ where: { incidentId: fixture.incidentId } }))
        .resolves.toEqual([expect.objectContaining({
          projectId: fixture.projectId,
          diagnosisId: fixture.diagnosisId,
          deploymentId: fixture.deploymentId,
          schemaVersion: 1,
          actionTypes: ["RESTART_CONTAINER"]
        })]);
      await expect(prisma.incident.findUniqueOrThrow({ where: { id: fixture.incidentId } }))
        .resolves.toMatchObject({ state: "FIX_PROPOSED", version: 9 });
      await expect(prisma.diagnosis.findUniqueOrThrow({ where: { id: fixture.diagnosisId } }))
        .resolves.toMatchObject({ remediationPlanningCode: "PLAN_CREATED" });
      await expect(prisma.auditEvent.count({
        where: { incidentId: fixture.incidentId, action: "REMEDIATION_PLAN_CREATED" }
      })).resolves.toBe(1);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("records a non-actionable diagnosis once without fabricating a plan", async () => {
    const prisma = new PrismaClient();
    try {
      const fixture = await createFixture(prisma, { ...restartResult(), proposedRemediation: null });
      const repository = new PrismaRemediationPlanningRepository(prisma);
      const candidate = await repository.findNextCandidate(fixture.incidentId);
      if (candidate === null) throw new Error("Candidate missing");
      const decision = new RemediationPlanBuilder().build(candidate);

      await expect(repository.persistDecision(candidate, decision)).resolves.toBe(true);
      await expect(prisma.remediationPlan.count({ where: { incidentId: fixture.incidentId } }))
        .resolves.toBe(0);
      await expect(prisma.diagnosis.findUniqueOrThrow({ where: { id: fixture.diagnosisId } }))
        .resolves.toMatchObject({ remediationPlanningCode: "NO_REMEDIATION_SUGGESTED" });
      await expect(repository.persistDecision(candidate, decision)).resolves.toBe(false);
      await expect(prisma.auditEvent.count({
        where: { incidentId: fixture.incidentId, action: "REMEDIATION_PLAN_NOT_CREATED" }
      })).resolves.toBe(1);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("rejects a cross-Incident/Project plan identity before persistence", async () => {
    const prisma = new PrismaClient();
    try {
      const fixture = await createFixture(prisma, restartResult());
      const repository = new PrismaRemediationPlanningRepository(prisma);
      const candidate = await repository.findNextCandidate(fixture.incidentId);
      if (candidate === null) throw new Error("Candidate missing");
      const decision = new RemediationPlanBuilder().build(candidate);
      if (decision.kind !== "PLAN") throw new Error("Plan missing");
      const forged: RemediationPlanningDecision = {
        kind: "PLAN",
        plan: { ...decision.plan, projectId: randomUUID(), diagnosisId: randomUUID() }
      };

      await expect(repository.persistDecision(candidate, forged)).resolves.toBe(true);
      await expect(prisma.remediationPlan.count({ where: { incidentId: fixture.incidentId } }))
        .resolves.toBe(0);
      await expect(prisma.diagnosis.findUniqueOrThrow({ where: { id: fixture.diagnosisId } }))
        .resolves.toMatchObject({ remediationPlanningCode: "PLAN_IDENTITY_MISMATCH" });
    } finally {
      await prisma.$disconnect();
    }
  });

  it("records a digest-mismatched plan as non-actionable without persisting it", async () => {
    const prisma = new PrismaClient();
    try {
      const fixture = await createFixture(prisma, restartResult());
      const repository = new PrismaRemediationPlanningRepository(prisma);
      const candidate = await repository.findNextCandidate(fixture.incidentId);
      if (candidate === null) throw new Error("Candidate missing");
      const decision = new RemediationPlanBuilder().build(candidate);
      if (decision.kind !== "PLAN") throw new Error("Plan missing");
      const invalid: RemediationPlanningDecision = {
        kind: "PLAN",
        plan: { ...decision.plan, planHash: "not-a-valid-hash" }
      };

      await expect(repository.persistDecision(candidate, invalid)).resolves.toBe(true);
      await expect(prisma.remediationPlan.count({ where: { incidentId: fixture.incidentId } }))
        .resolves.toBe(0);
      await expect(prisma.incident.findUniqueOrThrow({ where: { id: fixture.incidentId } }))
        .resolves.toMatchObject({ version: 9, state: "FIX_PROPOSED" });
      await expect(prisma.diagnosis.findUniqueOrThrow({ where: { id: fixture.diagnosisId } }))
        .resolves.toMatchObject({
          remediationPlanningCode: "PLAN_INTEGRITY_MISMATCH"
        });
    } finally {
      await prisma.$disconnect();
    }
  });

  it("rolls back the plan and guarded updates when audit creation fails", async () => {
    const prisma = new PrismaClient();
    try {
      const fixture = await createFixture(prisma, restartResult());
      const repository = new PrismaRemediationPlanningRepository(prisma);
      const candidate = await repository.findNextCandidate(fixture.incidentId);
      if (candidate === null) throw new Error("Candidate missing");
      const decision = new RemediationPlanBuilder().build(candidate);

      await prisma.$executeRawUnsafe(`
        CREATE FUNCTION reject_phase5_plan_audit() RETURNS trigger AS $$
        BEGIN
          IF NEW."action" = 'REMEDIATION_PLAN_CREATED' THEN
            RAISE EXCEPTION 'intentional audit failure';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER reject_phase5_plan_audit_trigger
        BEFORE INSERT ON "AuditEvent"
        FOR EACH ROW EXECUTE FUNCTION reject_phase5_plan_audit()
      `);
      try {
        await expect(repository.persistDecision(candidate, decision)).rejects.toBeDefined();
      } finally {
        await prisma.$executeRawUnsafe(
          `DROP TRIGGER IF EXISTS reject_phase5_plan_audit_trigger ON "AuditEvent"`
        );
        await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS reject_phase5_plan_audit()`);
      }

      await expect(prisma.remediationPlan.count({ where: { incidentId: fixture.incidentId } }))
        .resolves.toBe(0);
      await expect(prisma.incident.findUniqueOrThrow({ where: { id: fixture.incidentId } }))
        .resolves.toMatchObject({ version: 8, state: "FIX_PROPOSED" });
      await expect(prisma.diagnosis.findUniqueOrThrow({ where: { id: fixture.diagnosisId } }))
        .resolves.toMatchObject({
          remediationPlanningCompletedAt: null,
          remediationPlanningCode: null
        });
    } finally {
      await prisma.$disconnect();
    }
  });
});

async function createFixture(
  prisma: PrismaClient,
  result: Record<string, unknown>
): Promise<{
  readonly projectId: string;
  readonly incidentId: string;
  readonly diagnosisId: string;
  readonly deploymentId: string;
}> {
  const unique = randomUUID();
  const user = await prisma.user.create({
    data: { email: `planning-${unique}@example.com`, passwordHash: "not-used" }
  });
  const project = await prisma.project.create({
    data: { userId: user.id, name: `Planning ${unique}`, expectedPort: 8080 }
  });
  const deployment = await prisma.deployment.create({
    data: {
      projectId: project.id,
      name: "current",
      containerName: `planning-${unique}`,
      imageReference: "example/app:current",
      configurationSnapshot: { safeEnvironment: { LOG_LEVEL: "info" } }
    }
  });
  const incident = await prisma.incident.create({
    data: {
      projectId: project.id,
      deploymentId: deployment.id,
      type: "CONTAINER_CRASH",
      state: "FIX_PROPOSED",
      version: 8,
      fingerprint: `planning-${unique}`,
      createdAt: new Date("1900-01-01T00:00:00.000Z"),
      updatedAt: new Date("1900-01-01T00:00:00.000Z")
    }
  });
  const diagnosis = await prisma.diagnosis.create({
    data: {
      incidentId: incident.id,
      provider: "mock",
      providerVersion: "deterministic-v1",
      rootCauseCode: "CONTAINER_CRASH",
      summary: "Container exited",
      confidence: 0.85,
      evidenceReferences: [],
      result: result as Prisma.InputJsonValue
    }
  });
  return {
    projectId: project.id,
    incidentId: incident.id,
    diagnosisId: diagnosis.id,
    deploymentId: deployment.id
  };
}

function restartResult(): Record<string, unknown> {
  return {
    rootCauseCode: "CONTAINER_CRASH",
    summary: "Container exited",
    explanation: "Runtime evidence shows a stopped container.",
    supportingEvidenceReferences: [],
    confidence: 0.85,
    proposedRemediation: {
      type: "RESTART_CONTAINER",
      reason: "Evaluate a controlled restart."
    },
    manualInvestigationRecommended: false
  };
}
