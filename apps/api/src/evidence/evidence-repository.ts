import type { IncidentType } from "@selfheal/shared";
import type { EvidenceDraft } from "./evidence-types";

export interface EvidenceCollectionTarget {
  readonly incidentId: string;
  readonly incidentType: IncidentType;
  readonly incidentVersion: number;
  readonly projectId: string;
  readonly ownerId: string;
  readonly deployment: {
    readonly id: string;
    readonly isCurrent: boolean;
    readonly name: string;
    readonly containerName: string;
    readonly imageReference: string;
    readonly lastContainerState: string;
    readonly lastHealthState: string;
    readonly lastHttpStatus: number | null;
    readonly consecutiveFailures: number;
    readonly lastCheckErrorCode: string | null;
    readonly lastCheckedAt: Date | null;
    readonly createdAt: Date;
  };
  readonly expectedPort: number | null;
}

export interface EvidenceCompletion {
  readonly items: readonly EvidenceDraft[];
  readonly incomplete: boolean;
  readonly failedSources: readonly string[];
}

export interface EvidenceRepository {
  claimNextDetected(): Promise<EvidenceCollectionTarget | null>;
  findInterruptedCollection(before: Date): Promise<EvidenceCollectionTarget | null>;
  complete(target: EvidenceCollectionTarget, completion: EvidenceCompletion): Promise<boolean>;
}
