import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import type { DiagnosisProvider } from "./diagnosis-provider";
import { DiagnosisService } from "./diagnosis-service";
import type { DiagnosisResult } from "./diagnosis-types";
import { MockDiagnosisProvider } from "./mock-diagnosis-provider";
import { PrismaDiagnosisRepository } from "./prisma-diagnosis-repository";

const databaseTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeDatabase = databaseTestsEnabled ? describe : describe.skip;

describeDatabase("Prisma diagnosis workflow integration", () => {
  it("atomically claims once, persists a validated diagnosis, and transitions to FIX_PROPOSED", async () => {
    const prisma = new PrismaClient();
    try {
      const fixture = await createDiagnosingIncident(prisma, new Date("1960-01-01T00:00:00.000Z"));
      const first = new PrismaDiagnosisRepository(prisma);
      const second = new PrismaDiagnosisRepository(prisma);
      const claims = await Promise.all([first.claimNext(), second.claimNext()]);
      const work = claims.find((claim) => claim?.incidentId === fixture.incidentId);

      expect(claims.filter((claim) => claim?.incidentId === fixture.incidentId)).toHaveLength(1);
      if (work === undefined || work === null) throw new Error("Diagnosis was not claimed");
      expect(work.input.evidence[0]?.content).not.toContain("raw-database-secret");

      const completions = await Promise.all([
        first.complete(work, { provider: "mock", model: "deterministic-v1" }, result(fixture.evidenceId)),
        second.complete(work, { provider: "mock", model: "deterministic-v1" }, result(fixture.evidenceId))
      ]);

      expect(completions.filter(Boolean)).toHaveLength(1);
      await expect(prisma.incident.findUniqueOrThrow({ where: { id: fixture.incidentId } }))
        .resolves.toMatchObject({ state: "FIX_PROPOSED", version: 5, diagnosisClaimedAt: null });
      await expect(prisma.diagnosis.findUniqueOrThrow({ where: { incidentId: fixture.incidentId } }))
        .resolves.toMatchObject({
          provider: "mock",
          providerVersion: "deterministic-v1",
          rootCauseCode: "CONTAINER_CRASH",
          confidence: 0.85,
          evidenceReferences: [fixture.evidenceId]
        });
    } finally {
      await prisma.$disconnect();
    }
  });

  it("rejects a stale worker after atomic lease reclamation", async () => {
    const prisma = new PrismaClient();
    try {
      const fixture = await createDiagnosingIncident(prisma, new Date("1959-01-01T00:00:00.000Z"));
      const repository = new PrismaDiagnosisRepository(prisma);
      const stale = await repository.claimNext();
      if (stale === null || stale.incidentId !== fixture.incidentId) throw new Error("Wrong claim");
      await prisma.incident.update({
        where: { id: fixture.incidentId },
        data: { diagnosisClaimedAt: new Date("1959-01-02T00:00:00.000Z") }
      });
      const reclaimed = await repository.reclaimInterrupted(new Date("1959-01-03T00:00:00.000Z"));
      if (reclaimed === null || reclaimed.incidentId !== fixture.incidentId) {
        throw new Error("Lease was not reclaimed");
      }

      await expect(repository.complete(
        stale,
        { provider: "mock", model: "deterministic-v1" },
        result(fixture.evidenceId, "Stale result")
      )).resolves.toBe(false);
      await expect(repository.complete(
        reclaimed,
        { provider: "mock", model: "deterministic-v1" },
        result(fixture.evidenceId, "Reclaimed result")
      )).resolves.toBe(true);
      await expect(prisma.diagnosis.findMany({ where: { incidentId: fixture.incidentId } }))
        .resolves.toEqual([expect.objectContaining({ summary: "Reclaimed result" })]);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("moves provider failure to DIAGNOSIS_FAILED without persisting raw errors", async () => {
    const prisma = new PrismaClient();
    try {
      const fixture = await createDiagnosingIncident(prisma, new Date("1958-01-01T00:00:00.000Z"));
      const repository = new PrismaDiagnosisRepository(prisma);
      const work = await repository.claimNext();
      if (work === null || work.incidentId !== fixture.incidentId) throw new Error("Wrong claim");
      const provider: DiagnosisProvider = {
        provider: "mock",
        model: "deterministic-v1",
        analyzeIncident: async () => { throw new Error("socket password=provider-secret"); }
      };

      await expect(new DiagnosisService(repository, provider).process(work)).resolves.toBe(true);

      await expect(prisma.incident.findUniqueOrThrow({ where: { id: fixture.incidentId } }))
        .resolves.toMatchObject({ state: "DIAGNOSIS_FAILED", diagnosisClaimedAt: null });
      await expect(prisma.diagnosis.count({ where: { incidentId: fixture.incidentId } }))
        .resolves.toBe(0);
      const audits = await prisma.auditEvent.findMany({ where: { incidentId: fixture.incidentId } });
      expect(JSON.stringify(audits)).not.toContain("provider-secret");
      expect(audits).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: "DIAGNOSIS_FAILED", outcome: "FAILURE" })
      ]));
    } finally {
      await prisma.$disconnect();
    }
  });

  it("rejects a supporting evidence reference owned by another Incident", async () => {
    const prisma = new PrismaClient();
    try {
      const fixture = await createDiagnosingIncident(prisma, new Date("1957-01-01T00:00:00.000Z"));
      const other = await createDiagnosingIncident(prisma, new Date("2026-09-18T00:00:00.000Z"));
      const repository = new PrismaDiagnosisRepository(prisma);
      const work = await repository.claimNext();
      if (work === null || work.incidentId !== fixture.incidentId) throw new Error("Wrong claim");
      await expect(repository.complete(
        work,
        { provider: "mock", model: "deterministic-v1" },
        result(other.evidenceId)
      )).resolves.toBe(true);

      await expect(prisma.incident.findUniqueOrThrow({ where: { id: fixture.incidentId } }))
        .resolves.toMatchObject({ state: "DIAGNOSIS_FAILED" });
      await expect(prisma.diagnosis.count({ where: { incidentId: fixture.incidentId } }))
        .resolves.toBe(0);
      await prisma.incident.update({
        where: { id: other.incidentId },
        data: { state: "DIAGNOSIS_FAILED" }
      });
    } finally {
      await prisma.$disconnect();
    }
  });

  it("persists mock provider metadata and no raw evidence secret", async () => {
    const prisma = new PrismaClient();
    try {
      const fixture = await createDiagnosingIncident(prisma, new Date("1956-01-01T00:00:00.000Z"));
      const repository = new PrismaDiagnosisRepository(prisma);
      const work = await repository.claimNext();
      if (work === null || work.incidentId !== fixture.incidentId) throw new Error("Wrong claim");

      await expect(
        new DiagnosisService(repository, new MockDiagnosisProvider()).process(work)
      ).resolves.toBe(true);

      const diagnosis = await prisma.diagnosis.findUniqueOrThrow({
        where: { incidentId: fixture.incidentId }
      });
      expect(diagnosis).toMatchObject({
        provider: "mock",
        providerVersion: "deterministic-v1",
        rootCauseCode: "CONTAINER_CRASH"
      });
      expect(JSON.stringify(diagnosis)).not.toContain("raw-database-secret");
    } finally {
      await prisma.$disconnect();
    }
  });
});

async function createDiagnosingIncident(
  prisma: PrismaClient,
  updatedAt: Date
): Promise<{ readonly incidentId: string; readonly evidenceId: string }> {
  const unique = randomUUID();
  const user = await prisma.user.create({
    data: { email: `diagnosis-${unique}@example.com`, passwordHash: "not-used" }
  });
  const project = await prisma.project.create({
    data: { userId: user.id, name: `Diagnosis ${unique}` }
  });
  const deployment = await prisma.deployment.create({
    data: {
      projectId: project.id,
      name: "production",
      containerName: `diagnosis-${unique}`,
      imageReference: "example/app:latest"
    }
  });
  const incident = await prisma.incident.create({
    data: {
      projectId: project.id,
      deploymentId: deployment.id,
      type: "CONTAINER_CRASH",
      state: "DIAGNOSING",
      version: 3,
      fingerprint: `diagnosis-${unique}`,
      createdAt: updatedAt,
      updatedAt
    }
  });
  const evidence = await prisma.incidentEvidence.create({
    data: {
      incidentId: incident.id,
      kind: "CONTAINER_RUNTIME",
      source: "DOCKER_INSPECT",
      content: '{"state":"STOPPED","exitCode":1,"password":"raw-database-secret"}',
      metadata: {},
      byteCount: 72,
      lineCount: 1,
      truncated: false,
      contentHash: "test-only",
      expiresAt: new Date("2099-01-01T00:00:00.000Z")
    }
  });
  return { incidentId: incident.id, evidenceId: evidence.id };
}

function result(evidenceId: string, summary = "Container exited."): DiagnosisResult {
  return {
    rootCauseCode: "CONTAINER_CRASH",
    summary,
    explanation: "Runtime evidence records a non-zero exit.",
    supportingEvidenceReferences: [evidenceId],
    confidence: 0.85,
    proposedRemediation: {
      type: "RESTART_CONTAINER",
      reason: "Evaluate a controlled restart."
    },
    manualInvestigationRecommended: false
  };
}
