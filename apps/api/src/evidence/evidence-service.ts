import type { DockerEvidenceSource } from "../docker/docker-service";
import {
  collectBoundedLogChunks,
  createEvidenceDraft,
  createLogEvidenceDraft
} from "./bounded-evidence";
import type {
  EvidenceCollectionTarget,
  EvidenceRepository
} from "./evidence-repository";
import { EvidenceSanitizer, safeCollectionErrorCode } from "./evidence-sanitizer";
import type { EvidenceDraft, EvidenceLimits } from "./evidence-types";

export class EvidenceService {
  public constructor(
    private readonly repository: EvidenceRepository,
    private readonly docker: DockerEvidenceSource,
    private readonly limits: EvidenceLimits,
    private readonly sanitizer = new EvidenceSanitizer()
  ) {}

  public async collect(target: EvidenceCollectionTarget): Promise<boolean> {
    const collectedAt = new Date();
    const items: EvidenceDraft[] = [
      this.structuredDraft(
        "DEPLOYMENT",
        "REGISTERED_DEPLOYMENT",
        {
          projectId: target.projectId,
          deploymentId: target.deployment.id,
          name: target.deployment.name,
          containerIdentifier: target.deployment.containerName,
          imageReference: target.deployment.imageReference,
          isCurrent: target.deployment.isCurrent,
          expectedPort: target.expectedPort,
          createdAt: target.deployment.createdAt.toISOString()
        },
        target,
        collectedAt
      ),
      this.structuredDraft(
        "HEALTH_CHECK",
        "MONITORING_STATE",
        {
          healthState: target.deployment.lastHealthState,
          httpStatus: target.deployment.lastHttpStatus,
          monitoringErrorCode: target.deployment.lastCheckErrorCode,
          checkedAt: target.deployment.lastCheckedAt?.toISOString() ?? null,
          consecutiveFailures: target.deployment.consecutiveFailures
        },
        target,
        collectedAt
      )
    ];
    const failedSources: string[] = [];

    const [inspectionResult, logResult] = await Promise.allSettled([
      this.docker.inspectEvidence(target.deployment.containerName),
      collectBoundedLogChunks(
        this.docker.streamRecentLogs(target.deployment.containerName, this.limits.maxLines + 1),
        this.limits,
        this.sanitizer
      )
    ]);

    if (inspectionResult.status === "fulfilled") {
      const snapshot = inspectionResult.value;
      items.push(
        this.structuredDraft(
          "CONTAINER_RUNTIME",
          "DOCKER_INSPECT",
          {
            state: snapshot.state,
            exitCode: snapshot.exitCode,
            restartCount: snapshot.restartCount,
            oomKilled: snapshot.oomKilled,
            startedAt: snapshot.startedAt,
            finishedAt: snapshot.finishedAt,
            imageId: snapshot.imageId,
            dockerHealthStatus: snapshot.dockerHealthStatus,
            publishedHostPorts: snapshot.publishedHostPorts
          },
          target,
          collectedAt
        ),
        this.structuredDraft(
          "ENVIRONMENT",
          "DOCKER_INSPECT_ENV",
          {
            variableNames: snapshot.environmentNames,
            allowlistedValues: snapshot.allowlistedEnvironment
          },
          target,
          collectedAt
        )
      );
    } else {
      this.addCollectionError(items, failedSources, "DOCKER_INSPECT", inspectionResult.reason, target, collectedAt);
    }

    if (logResult.status === "fulfilled") {
      items.push(
        createLogEvidenceDraft(
          "DOCKER_LOGS",
          logResult.value,
          { deploymentId: target.deployment.id },
          this.limits,
          collectedAt
        )
      );
    } else {
      this.addCollectionError(items, failedSources, "DOCKER_LOGS", logResult.reason, target, collectedAt);
    }

    const incomplete = failedSources.length > 0;
    items.push(
      this.structuredDraft(
        "COLLECTION_SUMMARY",
        "EVIDENCE_PIPELINE",
        { complete: !incomplete, failedSources },
        target,
        collectedAt,
        { incomplete }
      )
    );
    return this.repository.complete(target, { items, incomplete, failedSources });
  }

  private structuredDraft(
    kind: EvidenceDraft["kind"],
    source: string,
    value: unknown,
    target: EvidenceCollectionTarget,
    collectedAt: Date,
    metadata: EvidenceDraft["metadata"] = {}
  ): EvidenceDraft {
    return createEvidenceDraft(
      kind,
      source,
      JSON.stringify(value) ?? "null",
      { deploymentId: target.deployment.id, ...metadata },
      this.limits,
      this.sanitizer,
      collectedAt
    );
  }

  private addCollectionError(
    items: EvidenceDraft[],
    failedSources: string[],
    source: string,
    error: unknown,
    target: EvidenceCollectionTarget,
    collectedAt: Date
  ): void {
    failedSources.push(source);
    items.push(
      this.structuredDraft(
        "COLLECTION_ERROR",
        source,
        { code: safeCollectionErrorCode(error) },
        target,
        collectedAt,
        { incomplete: true }
      )
    );
  }
}
