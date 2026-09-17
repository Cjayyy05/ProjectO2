import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { createEvidenceDraft } from "./bounded-evidence";
import { PrismaEvidenceRepository } from "./prisma-evidence-repository";
import { EvidenceSanitizer } from "./evidence-sanitizer";

const databaseTestsEnabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const describeDatabase = databaseTestsEnabled ? describe : describe.skip;

describeDatabase("Prisma evidence collection integration", () => {
  it("rejects an Incident linked to a Deployment from another Project", async () => {
    const prisma = new PrismaClient();
    try {
      const unique = randomUUID();
      const user = await prisma.user.create({
        data: { email: `association-${unique}@example.com`, passwordHash: "not-used-by-this-test" }
      });
      const [firstProject, secondProject] = await Promise.all([
        prisma.project.create({ data: { userId: user.id, name: "First project" } }),
        prisma.project.create({ data: { userId: user.id, name: "Second project" } })
      ]);
      const deployment = await prisma.deployment.create({
        data: {
          projectId: firstProject.id,
          name: "production",
          containerName: `association-${unique}`,
          imageReference: "example/app:latest"
        }
      });

      await expect(
        prisma.incident.create({
          data: {
            projectId: secondProject.id,
            deploymentId: deployment.id,
            type: "CONTAINER_CRASH",
            fingerprint: `mismatched-${unique}`
          }
        })
      ).rejects.toMatchObject({ code: "P2003" });
    } finally {
      await prisma.$disconnect();
    }
  });

  it("atomically claims DETECTED once and moves through COLLECTING_EVIDENCE to DIAGNOSING", async () => {
    const prisma = new PrismaClient();
    try {
      const created = await createIncidentWithReplacement(
        prisma,
        new Date("2000-01-01T00:00:00.000Z")
      );
      const firstRepository = new PrismaEvidenceRepository(prisma);
      const secondRepository = new PrismaEvidenceRepository(prisma);

      const claims = await Promise.all([
        firstRepository.claimNextDetected(),
        secondRepository.claimNextDetected()
      ]);
      const claimed = claims.find((claim) => claim?.incidentId === created.incidentId);

      expect(claims.filter((claim) => claim?.incidentId === created.incidentId)).toHaveLength(1);
      expect(claimed).toMatchObject({
        incidentId: created.incidentId,
        incidentVersion: 2,
        deployment: { id: created.affectedDeploymentId, isCurrent: false }
      });
      if (claimed === undefined || claimed === null) throw new Error("Incident was not claimed");

      const draft = createEvidenceDraft(
        "DEPLOYMENT",
        "REGISTERED_DEPLOYMENT",
        JSON.stringify({ deploymentId: claimed.deployment.id }),
        { deploymentId: claimed.deployment.id },
        { maxBytes: 256 * 1_024, maxLines: 500, retentionDays: 30 },
        new EvidenceSanitizer()
      );
      const completions = await Promise.all([
        firstRepository.complete(claimed, { items: [draft], incomplete: false, failedSources: [] }),
        secondRepository.complete(claimed, { items: [draft], incomplete: false, failedSources: [] })
      ]);

      expect(completions.filter(Boolean)).toHaveLength(1);
      await expect(
        prisma.incident.findUniqueOrThrow({ where: { id: created.incidentId } })
      ).resolves.toMatchObject({ state: "DIAGNOSING", version: 3 });
      await expect(
        prisma.incidentEvidence.findMany({ where: { incidentId: created.incidentId } })
      ).resolves.toEqual([
        expect.objectContaining({
          incidentId: created.incidentId,
          kind: "DEPLOYMENT",
          source: "REGISTERED_DEPLOYMENT",
          byteCount: draft.byteCount,
          contentHash: draft.contentHash
        })
      ]);
      await expect(
        prisma.auditEvent.count({
          where: { incidentId: created.incidentId, action: "INCIDENT_STATE_TRANSITIONED" }
        })
      ).resolves.toBe(2);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("does not attach stale evidence after an incompatible state/version change", async () => {
    const prisma = new PrismaClient();
    try {
      const created = await createIncidentWithReplacement(
        prisma,
        new Date("1997-01-01T00:00:00.000Z")
      );
      const repository = new PrismaEvidenceRepository(prisma);
      const claimed = await repository.claimNextDetected();
      if (claimed === null || claimed.incidentId !== created.incidentId) {
        throw new Error("Expected incident was not claimed");
      }
      await prisma.incident.update({
        where: { id: claimed.incidentId },
        data: { state: "DIAGNOSING", version: { increment: 1 } }
      });
      const draft = createEvidenceDraft(
        "COLLECTION_SUMMARY",
        "EVIDENCE_PIPELINE",
        "{}",
        { deploymentId: claimed.deployment.id },
        { maxBytes: 256 * 1_024, maxLines: 500, retentionDays: 30 },
        new EvidenceSanitizer()
      );

      await expect(
        repository.complete(claimed, { items: [draft], incomplete: false, failedSources: [] })
      ).resolves.toBe(false);
      await expect(
        prisma.incidentEvidence.count({ where: { incidentId: claimed.incidentId } })
      ).resolves.toBe(0);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("atomically reclaims an interrupted collection lease once", async () => {
    const prisma = new PrismaClient();
    try {
      const created = await createIncidentWithReplacement(prisma);
      await prisma.incident.update({
        where: { id: created.incidentId },
        data: {
          state: "COLLECTING_EVIDENCE",
          updatedAt: new Date("2026-09-16T00:00:00.000Z")
        }
      });
      const firstRepository = new PrismaEvidenceRepository(prisma);
      const secondRepository = new PrismaEvidenceRepository(prisma);

      const claims = await Promise.all([
        firstRepository.findInterruptedCollection(new Date("2026-09-17T00:00:00.000Z")),
        secondRepository.findInterruptedCollection(new Date("2026-09-17T00:00:00.000Z"))
      ]);

      expect(claims.filter((claim) => claim?.incidentId === created.incidentId)).toHaveLength(1);
      expect(claims.find((claim) => claim !== null)).toMatchObject({
        incidentId: created.incidentId,
        incidentVersion: 2,
        deployment: { id: created.affectedDeploymentId }
      });
      await expect(
        prisma.auditEvent.count({
          where: { incidentId: created.incidentId, action: "EVIDENCE_COLLECTION_RECLAIMED" }
        })
      ).resolves.toBe(1);
      const winner = claims.find((claim) => claim !== null);
      if (winner === undefined || winner === null) throw new Error("Lease was not reclaimed");
      await expect(
        firstRepository.complete(winner, {
          items: [evidenceDraft("COLLECTION_SUMMARY", "EVIDENCE_PIPELINE", "reclaimed")],
          incomplete: false,
          failedSources: []
        })
      ).resolves.toBe(true);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("rejects a stale worker after lease reclamation and persists only the new worker evidence", async () => {
    const prisma = new PrismaClient();
    try {
      const created = await createIncidentWithReplacement(
        prisma,
        new Date("1999-01-01T00:00:00.000Z")
      );
      const repository = new PrismaEvidenceRepository(prisma);
      const staleWorker = await repository.claimNextDetected();
      if (staleWorker === null || staleWorker.incidentId !== created.incidentId) {
        throw new Error("Expected incident was not claimed");
      }
      await prisma.incident.update({
        where: { id: created.incidentId },
        data: { updatedAt: new Date("2000-01-01T00:00:00.000Z") }
      });
      const newWorker = await repository.findInterruptedCollection(
        new Date("2000-01-02T00:00:00.000Z")
      );
      if (newWorker === null || newWorker.incidentId !== created.incidentId) {
        throw new Error("Expected incident lease was not reclaimed");
      }

      await expect(
        repository.complete(staleWorker, {
          items: [evidenceDraft("DEPLOYMENT", "REGISTERED_DEPLOYMENT", "stale-worker")],
          incomplete: false,
          failedSources: []
        })
      ).resolves.toBe(false);
      await expect(
        repository.complete(newWorker, {
          items: [evidenceDraft("DEPLOYMENT", "REGISTERED_DEPLOYMENT", "new-worker")],
          incomplete: false,
          failedSources: []
        })
      ).resolves.toBe(true);

      await expect(
        prisma.incidentEvidence.findMany({ where: { incidentId: created.incidentId } })
      ).resolves.toEqual([
        expect.objectContaining({ content: "new-worker" })
      ]);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("rolls back the state transition instead of silently dropping duplicate evidence identities", async () => {
    const prisma = new PrismaClient();
    try {
      const created = await createIncidentWithReplacement(
        prisma,
        new Date("1998-01-01T00:00:00.000Z")
      );
      const repository = new PrismaEvidenceRepository(prisma);
      const claimed = await repository.claimNextDetected();
      if (claimed === null || claimed.incidentId !== created.incidentId) {
        throw new Error("Expected incident was not claimed");
      }
      const duplicate = evidenceDraft("DEPLOYMENT", "REGISTERED_DEPLOYMENT", "duplicate");

      await expect(
        repository.complete(claimed, {
          items: [duplicate, duplicate],
          incomplete: false,
          failedSources: []
        })
      ).rejects.toMatchObject({ code: "P2002" });
      await expect(
        prisma.incident.findUniqueOrThrow({ where: { id: created.incidentId } })
      ).resolves.toMatchObject({ state: "COLLECTING_EVIDENCE", version: claimed.incidentVersion });
      await expect(
        prisma.incidentEvidence.count({ where: { incidentId: created.incidentId } })
      ).resolves.toBe(0);

      await prisma.incident.update({
        where: { id: created.incidentId },
        data: { state: "DIAGNOSING", version: { increment: 1 } }
      });
    } finally {
      await prisma.$disconnect();
    }
  });
});

async function createIncidentWithReplacement(
  prisma: PrismaClient,
  incidentCreatedAt?: Date
): Promise<{
  readonly incidentId: string;
  readonly affectedDeploymentId: string;
}> {
  const unique = randomUUID();
  const user = await prisma.user.create({
    data: { email: `evidence-${unique}@example.com`, passwordHash: "not-used-by-this-test" }
  });
  const project = await prisma.project.create({
    data: { userId: user.id, name: "Evidence project", expectedPort: 8080 }
  });
  const affected = await prisma.deployment.create({
    data: {
      projectId: project.id,
      isCurrent: false,
      name: "production-v1",
      containerName: `evidence-old-${unique}`,
      imageReference: "example/app:v1",
      lastContainerState: "STOPPED",
      lastHealthState: "UNHEALTHY",
      lastCheckErrorCode: "CONTAINER_STOPPED",
      lastCheckedAt: new Date()
    }
  });
  await prisma.deployment.create({
    data: {
      projectId: project.id,
      isCurrent: true,
      name: "production-v2",
      containerName: `evidence-current-${unique}`,
      imageReference: "example/app:v2"
    }
  });
  const incident = await prisma.incident.create({
    data: {
      projectId: project.id,
      deploymentId: affected.id,
      type: "CONTAINER_CRASH",
      fingerprint: `${affected.id}:CONTAINER_CRASH`,
      ...(incidentCreatedAt === undefined ? {} : { createdAt: incidentCreatedAt })
    }
  });
  return { incidentId: incident.id, affectedDeploymentId: affected.id };
}

function evidenceDraft(
  kind: "COLLECTION_SUMMARY" | "DEPLOYMENT",
  source: string,
  content: string
) {
  return createEvidenceDraft(
    kind,
    source,
    content,
    {},
    { maxBytes: 256 * 1_024, maxLines: 500, retentionDays: 30 },
    new EvidenceSanitizer()
  );
}
