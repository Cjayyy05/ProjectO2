import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ContainerEvidenceSnapshot, DockerEvidenceSource } from "../docker/docker-service";
import type {
  EvidenceCollectionTarget,
  EvidenceCompletion,
  EvidenceRepository
} from "./evidence-repository";
import { EvidenceService } from "./evidence-service";

const target: EvidenceCollectionTarget = {
  incidentId: "incident-1",
  incidentType: "CONTAINER_CRASH",
  incidentVersion: 2,
  projectId: "project-1",
  ownerId: "owner-1",
  deployment: {
    id: "historical-deployment",
    isCurrent: false,
    name: "production-v1",
    containerName: "historical-container",
    imageReference: "example/app:v1",
    lastContainerState: "STOPPED",
    lastHealthState: "UNHEALTHY",
    lastHttpStatus: 503,
    consecutiveFailures: 3,
    lastCheckErrorCode: "CONTAINER_STOPPED",
    lastCheckedAt: new Date("2026-09-17T00:00:00.000Z"),
    createdAt: new Date("2026-09-16T00:00:00.000Z")
  },
  expectedPort: 8080
};

const snapshot: ContainerEvidenceSnapshot = {
  state: "STOPPED",
  publishedHostPorts: [8080],
  exitCode: 137,
  restartCount: 4,
  oomKilled: true,
  startedAt: "2026-09-17T00:00:00.000Z",
  finishedAt: "2026-09-17T00:01:00.000Z",
  imageId: "sha256:abcdefabcdef",
  dockerHealthStatus: "unhealthy",
  environmentNames: ["API_KEY", "NODE_ENV"],
  allowlistedEnvironment: { NODE_ENV: "production" }
};

class RecordingEvidenceRepository implements EvidenceRepository {
  public completion: EvidenceCompletion | undefined;
  public completedTarget: EvidenceCollectionTarget | undefined;

  public async claimNextDetected(): Promise<EvidenceCollectionTarget | null> { return null; }
  public async findInterruptedCollection(): Promise<EvidenceCollectionTarget | null> { return null; }
  public async complete(
    completedTarget: EvidenceCollectionTarget,
    completion: EvidenceCompletion
  ): Promise<boolean> {
    this.completedTarget = completedTarget;
    this.completion = completion;
    return true;
  }
}

describe("EvidenceService", () => {
  it("collects structured evidence for the incident-linked historical deployment", async () => {
    const repository = new RecordingEvidenceRepository();
    const requestedContainers: string[] = [];
    const docker: DockerEvidenceSource = {
      inspectEvidence: async (container) => {
        requestedContainers.push(container);
        return snapshot;
      },
      streamRecentLogs: (container) => {
        requestedContainers.push(container);
        return chunks("first\nAuthorization: Bearer secret-token\nthird");
      }
    };
    const service = new EvidenceService(
      repository,
      docker,
      { maxBytes: 256 * 1_024, maxLines: 500, retentionDays: 30 }
    );

    await expect(service.collect(target)).resolves.toBe(true);

    expect(requestedContainers).toEqual(["historical-container", "historical-container"]);
    expect(repository.completedTarget?.deployment.id).toBe("historical-deployment");
    expect(content(repository.completion, "DEPLOYMENT")).toMatchObject({
      deploymentId: "historical-deployment",
      isCurrent: false,
      expectedPort: 8080
    });
    expect(content(repository.completion, "HEALTH_CHECK")).toMatchObject({
      healthState: "UNHEALTHY",
      httpStatus: 503,
      monitoringErrorCode: "CONTAINER_STOPPED",
      consecutiveFailures: 3
    });
    expect(content(repository.completion, "CONTAINER_RUNTIME")).toMatchObject({
      state: "STOPPED",
      exitCode: 137,
      restartCount: 4,
      publishedHostPorts: [8080]
    });
    expect(content(repository.completion, "ENVIRONMENT")).toEqual({
      variableNames: ["API_KEY", "NODE_ENV"],
      allowlistedValues: { NODE_ENV: "production" }
    });
    const logEvidence = repository.completion?.items.find((item) => item.kind === "DOCKER_LOG");
    expect(logEvidence?.content).toBe("first\nAuthorization: [REDACTED]\nthird");
    expect(logEvidence?.contentHash).toBe(
      createHash("sha256").update(logEvidence?.content ?? "").digest("hex")
    );
    expect(repository.completion?.incomplete).toBe(false);
  });

  it("persists successful evidence and a sanitized error when log collection fails", async () => {
    const repository = new RecordingEvidenceRepository();
    const docker: DockerEvidenceSource = {
      inspectEvidence: async () => snapshot,
      streamRecentLogs: () => failingChunks()
    };
    const service = new EvidenceService(
      repository,
      docker,
      { maxBytes: 256 * 1_024, maxLines: 500, retentionDays: 30 }
    );

    await expect(service.collect(target)).resolves.toBe(true);

    expect(repository.completion?.items.some((item) => item.kind === "CONTAINER_RUNTIME")).toBe(true);
    expect(content(repository.completion, "COLLECTION_ERROR")).toEqual({
      code: "DOCKER_LOGS_FAILED"
    });
    expect(JSON.stringify(repository.completion)).not.toContain("raw-secret");
    expect(repository.completion).toMatchObject({
      incomplete: true,
      failedSources: ["DOCKER_LOGS"]
    });
  });

  it("preserves baseline evidence and advances with an incomplete summary when Docker is unavailable", async () => {
    const repository = new RecordingEvidenceRepository();
    const docker: DockerEvidenceSource = {
      inspectEvidence: async () => { throw new Error("socket password=raw-inspect-secret"); },
      streamRecentLogs: () => failingChunks()
    };
    const service = new EvidenceService(
      repository,
      docker,
      { maxBytes: 256 * 1_024, maxLines: 500, retentionDays: 30 }
    );

    await expect(service.collect(target)).resolves.toBe(true);

    expect(repository.completion?.items.map((item) => item.kind)).toEqual([
      "DEPLOYMENT",
      "HEALTH_CHECK",
      "COLLECTION_ERROR",
      "COLLECTION_ERROR",
      "COLLECTION_SUMMARY"
    ]);
    expect(content(repository.completion, "COLLECTION_SUMMARY")).toEqual({
      complete: false,
      failedSources: ["DOCKER_INSPECT", "DOCKER_LOGS"]
    });
    expect(JSON.stringify(repository.completion)).not.toContain("raw-inspect-secret");
    expect(JSON.stringify(repository.completion)).not.toContain("raw-secret");
  });
});

function content(completion: EvidenceCompletion | undefined, kind: string): Record<string, unknown> {
  const item = completion?.items.find((candidate) => candidate.kind === kind);
  if (item === undefined) throw new Error(`Missing evidence kind ${kind}`);
  return JSON.parse(item.content) as Record<string, unknown>;
}

async function* chunks(value: string): AsyncIterable<Uint8Array> {
  yield Buffer.from(value);
}

async function* failingChunks(): AsyncIterable<Uint8Array> {
  throw { code: "DOCKER_LOGS_FAILED", message: "password=raw-secret socket=private" };
}
