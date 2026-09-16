export interface ProjectRecord {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly description: string | null;
  readonly healthCheckUrl: string | null;
  readonly healthCheckPath: string | null;
  readonly expectedPort: number | null;
  readonly monitoringEnabled: boolean;
  readonly monitoringIntervalMs: number | null;
  readonly healthCheckTimeoutMs: number | null;
  readonly incidentFailureThreshold: number | null;
  readonly nextCheckAt: Date | null;
  readonly lastCheckedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateProjectInput {
  readonly name: string;
  readonly description?: string;
  readonly healthCheckPath?: string;
  readonly expectedPort?: number;
}

export interface DeploymentRecord {
  readonly id: string;
  readonly projectId: string;
  readonly isCurrent: boolean;
  readonly name: string;
  readonly containerName: string;
  readonly imageReference: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface RegisterDeploymentInput {
  readonly name: string;
  readonly containerName: string;
  readonly imageReference: string;
}

export interface MonitoringConfigurationInput {
  readonly monitoringEnabled: boolean;
  readonly healthCheckPath?: string;
  readonly expectedPort?: number;
  readonly monitoringIntervalMs?: number;
  readonly healthCheckTimeoutMs?: number;
  readonly incidentFailureThreshold?: number;
}

export interface ProjectRepository {
  createForOwner(ownerId: string, input: CreateProjectInput, requestId?: string): Promise<ProjectRecord>;
  listForOwner(ownerId: string): Promise<readonly ProjectRecord[]>;
  findByIdForOwner(projectId: string, ownerId: string): Promise<ProjectRecord | null>;
  registerDeploymentForOwner(
    ownerId: string,
    projectId: string,
    input: RegisterDeploymentInput,
    requestId?: string
  ): Promise<DeploymentRecord | null>;
  configureMonitoringForOwner(
    ownerId: string,
    projectId: string,
    input: MonitoringConfigurationInput,
    requestId?: string
  ): Promise<ProjectRecord | null>;
}
