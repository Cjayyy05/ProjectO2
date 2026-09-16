import type { ContainerRuntimeState } from "../docker/docker-service";
import type { HealthCheckResult } from "./http-health-checker";

export interface MonitoringDefaults {
  readonly intervalMs: number;
  readonly healthCheckTimeoutMs: number;
  readonly incidentFailureThreshold: number;
}

export interface MonitoringTarget {
  readonly projectId: string;
  readonly ownerId: string;
  readonly deploymentId: string;
  readonly containerName: string;
  readonly healthCheckPath: string;
  readonly expectedPort: number;
  readonly monitoringIntervalMs: number;
  readonly healthCheckTimeoutMs: number;
  readonly incidentFailureThreshold: number;
}

export interface MonitoringObservation {
  readonly containerState: ContainerRuntimeState;
  readonly healthCheck?: HealthCheckResult;
  readonly observedAt: Date;
}

export interface MonitoringRecordResult {
  readonly consecutiveFailures: number;
  readonly incidentId?: string;
  readonly incidentCreated: boolean;
}

export interface MonitoringRepository {
  claimDueTargets(now: Date): Promise<readonly MonitoringTarget[]>;
  recordObservation(
    target: MonitoringTarget,
    observation: MonitoringObservation
  ): Promise<MonitoringRecordResult>;
  recordMonitoringError(
    target: MonitoringTarget,
    errorCode: string,
    observedAt: Date,
    containerState?: ContainerRuntimeState
  ): Promise<void>;
}
