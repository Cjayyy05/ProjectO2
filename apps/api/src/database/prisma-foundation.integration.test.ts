import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { PrismaUserRepository } from "../auth/prisma-user-repository";
import { PrismaIncidentTransitionRepository } from "../incidents/prisma-incident-transition-repository";

const databaseTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeDatabase = databaseTestsEnabled ? describe : describe.skip;

describeDatabase("Prisma foundation integration", () => {
  it("records user registration and its audit event atomically", async () => {
    const prisma = new PrismaClient();

    try {
      const unique = randomUUID();
      const repository = new PrismaUserRepository(prisma);
      const user = await repository.register(
        `registered-${unique}@example.com`,
        "not-used-by-this-test",
        `request-${unique}`
      );

      await expect(
        prisma.auditEvent.findMany({ where: { userId: user.id } })
      ).resolves.toEqual([
        expect.objectContaining({
          action: "AUTH_REGISTERED",
          outcome: "SUCCESS",
          requestId: `request-${unique}`
        })
      ]);
      await expect(
        repository.register(user.email, "another-unused-hash")
      ).rejects.toMatchObject({ code: "EMAIL_ALREADY_REGISTERED", statusCode: 409 });
      await expect(prisma.auditEvent.count({ where: { userId: user.id } })).resolves.toBe(1);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("creates and queries the complete minimum domain graph", async () => {
    const prisma = new PrismaClient();

    try {
      const unique = randomUUID();
      const user = await prisma.user.create({
        data: {
          email: `integration-${unique}@example.com`,
          passwordHash: "$2b$10$integration.test.hash.not.a.real.password"
        }
      });
      const project = await prisma.project.create({
        data: { userId: user.id, name: "Integration project" }
      });
      const deployment = await prisma.deployment.create({
        data: {
          projectId: project.id,
          name: "production",
          containerName: `selfheal-integration-${unique}`,
          imageReference: "example@sha256:integration"
        }
      });
      const incident = await prisma.incident.create({
        data: {
          projectId: project.id,
          deploymentId: deployment.id,
          type: "CONTAINER_CRASH",
          fingerprint: `crash-${unique}`
        }
      });
      await prisma.incidentEvidence.create({
        data: {
          incidentId: incident.id,
          kind: "LOG",
          source: "integration-test",
          content: "sanitized bounded evidence",
          byteCount: 26,
          lineCount: 1,
          contentHash: "integration-hash",
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000)
        }
      });
      const diagnosis = await prisma.diagnosis.create({
        data: {
          incidentId: incident.id,
          provider: "phase-1-placeholder",
          providerVersion: "none",
          rootCauseCode: "NOT_DIAGNOSED",
          summary: "Phase 1 graph test",
          confidence: 0,
          evidenceReferences: [],
          result: {}
        }
      });
      const plan = await prisma.remediationPlan.create({
        data: {
          projectId: project.id,
          incidentId: incident.id,
          diagnosisId: diagnosis.id,
          deploymentId: deployment.id,
          actionTypes: ["RESTART_CONTAINER"],
          actions: [{ type: "RESTART_CONTAINER", deploymentId: deployment.id }],
          baseline: {},
          summary: "Domain persistence test only",
          planHash: "a".repeat(64),
          targetSnapshotHash: "b".repeat(64)
        }
      });
      const verification = await prisma.verificationRun.create({
        data: {
          incidentId: incident.id,
          remediationPlanId: plan.id,
          planHash: plan.planHash,
          targetSnapshotHash: plan.targetSnapshotHash
        }
      });
      const approval = await prisma.approval.create({
        data: {
          remediationPlanId: plan.id,
          verificationRunId: verification.id,
          userId: user.id,
          decision: "APPROVED",
          planHash: plan.planHash,
          targetSnapshotHash: plan.targetSnapshotHash,
          expiresAt: new Date(Date.now() + 60 * 60 * 1_000)
        }
      });
      await prisma.recoveryAttempt.create({
        data: {
          projectId: project.id,
          incidentId: incident.id,
          remediationPlanId: plan.id,
          approvalId: approval.id,
          idempotencyKey: `recovery-${unique}`
        }
      });
      await prisma.auditEvent.create({
        data: {
          userId: user.id,
          projectId: project.id,
          incidentId: incident.id,
          action: "INTEGRATION_GRAPH_CREATED",
          resourceType: "Incident",
          resourceId: incident.id,
          outcome: "SUCCESS"
        }
      });

      const graph = await prisma.incident.findFirstOrThrow({
        where: { id: incident.id, project: { userId: user.id } },
        include: {
          evidence: true,
          diagnosis: true,
          remediationPlans: { include: { verificationRuns: true, approvals: true } },
          recoveryAttempts: true,
          auditEvents: true
        }
      });

      expect(graph.evidence).toHaveLength(1);
      expect(graph.diagnosis?.incidentId).toBe(incident.id);
      expect(graph.remediationPlans[0]?.verificationRuns).toHaveLength(1);
      expect(graph.remediationPlans[0]?.approvals).toHaveLength(1);
      expect(graph.recoveryAttempts).toHaveLength(1);
      expect(graph.auditEvents).toHaveLength(1);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("allows only one concurrent transition for the same state and version", async () => {
    const prisma = new PrismaClient();

    try {
      const unique = randomUUID();
      const user = await prisma.user.create({
        data: { email: `race-${unique}@example.com`, passwordHash: "not-used-by-this-test" }
      });
      const project = await prisma.project.create({
        data: { userId: user.id, name: "Race project" }
      });
      const incident = await prisma.incident.create({
        data: {
          projectId: project.id,
          type: "HEALTH_CHECK_FAILURE",
          fingerprint: `race-${unique}`
        }
      });
      const repository = new PrismaIncidentTransitionRepository(prisma);
      const transition = {
        incidentId: incident.id,
        ownerId: user.id,
        expectedState: "DETECTED" as const,
        expectedVersion: 1,
        targetState: "COLLECTING_EVIDENCE" as const,
        reason: "concurrency test"
      };

      const results = await Promise.all([
        repository.transition(transition),
        repository.transition(transition)
      ]);

      expect(results.filter((result) => result !== null)).toHaveLength(1);
      expect(results.filter((result) => result === null)).toHaveLength(1);
      await expect(
        prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })
      ).resolves.toMatchObject({ state: "COLLECTING_EVIDENCE", version: 2 });
      await expect(
        prisma.auditEvent.count({
          where: { incidentId: incident.id, action: "INCIDENT_STATE_TRANSITIONED" }
        })
      ).resolves.toBe(1);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("does not transition an incident for a different project owner", async () => {
    const prisma = new PrismaClient();

    try {
      const unique = randomUUID();
      const [owner, otherUser] = await Promise.all([
        prisma.user.create({
          data: { email: `owner-${unique}@example.com`, passwordHash: "not-used-by-this-test" }
        }),
        prisma.user.create({
          data: { email: `other-${unique}@example.com`, passwordHash: "not-used-by-this-test" }
        })
      ]);
      const project = await prisma.project.create({
        data: { userId: owner.id, name: "Private transition project" }
      });
      const incident = await prisma.incident.create({
        data: {
          projectId: project.id,
          type: "CONTAINER_CRASH",
          fingerprint: `ownership-${unique}`
        }
      });
      const repository = new PrismaIncidentTransitionRepository(prisma);

      await expect(
        repository.transition({
          incidentId: incident.id,
          ownerId: otherUser.id,
          expectedState: "DETECTED",
          expectedVersion: 1,
          targetState: "COLLECTING_EVIDENCE",
          reason: "unauthorized transition test"
        })
      ).resolves.toBeNull();
      await expect(
        prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })
      ).resolves.toMatchObject({ state: "DETECTED", version: 1 });
    } finally {
      await prisma.$disconnect();
    }
  });

  it("enforces one open incident per project, type, and fingerprint", async () => {
    const prisma = new PrismaClient();

    try {
      const unique = randomUUID();
      const user = await prisma.user.create({
        data: { email: `dedupe-${unique}@example.com`, passwordHash: "not-used-by-this-test" }
      });
      const project = await prisma.project.create({
        data: { userId: user.id, name: "Dedupe project" }
      });
      const incidentData = {
        projectId: project.id,
        type: "PORT_CONFIGURATION_FAILURE" as const,
        fingerprint: `duplicate-${unique}`
      };
      const first = await prisma.incident.create({ data: incidentData });

      await expect(prisma.incident.create({ data: incidentData })).rejects.toMatchObject({
        code: "P2002"
      });

      await prisma.incident.update({
        where: { id: first.id },
        data: { state: "RESOLVED", resolvedAt: new Date(), version: { increment: 1 } }
      });
      await expect(prisma.incident.create({ data: incidentData })).resolves.toMatchObject({
        state: "DETECTED"
      });
    } finally {
      await prisma.$disconnect();
    }
  });
});
