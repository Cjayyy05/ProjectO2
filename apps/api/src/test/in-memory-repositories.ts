import { randomUUID } from "node:crypto";
import type { AuditEventInput, AuditWriter } from "../audit/audit";
import { ConflictError } from "../errors/app-error";
import type { UserRecord, UserRepository } from "../auth/user-repository";
import type {
  CreateProjectInput,
  DeploymentRecord,
  MonitoringConfigurationInput,
  ProjectRecord,
  ProjectRepository,
  RegisterDeploymentInput
} from "../projects/project-repository";

export class InMemoryAuditWriter implements AuditWriter {
  public readonly events: AuditEventInput[] = [];

  public async record(event: AuditEventInput): Promise<void> {
    this.events.push(event);
  }
}

export class InMemoryUserRepository implements UserRepository {
  public readonly users: UserRecord[] = [];

  public constructor(private readonly audit: AuditWriter) {}

  public async findByEmail(email: string): Promise<UserRecord | null> {
    return this.users.find((user) => user.email === email) ?? null;
  }

  public async findById(id: string): Promise<UserRecord | null> {
    return this.users.find((user) => user.id === id) ?? null;
  }

  public async register(email: string, passwordHash: string, requestId?: string): Promise<UserRecord> {
    if (this.users.some((user) => user.email === email)) {
      throw new ConflictError("EMAIL_ALREADY_REGISTERED", "An account with this email already exists");
    }

    const now = new Date();
    const user = { id: randomUUID(), email, passwordHash, createdAt: now, updatedAt: now };
    this.users.push(user);

    try {
      await this.audit.record({
        userId: user.id,
        action: "AUTH_REGISTERED",
        resourceType: "User",
        resourceId: user.id,
        outcome: "SUCCESS",
        ...(requestId === undefined ? {} : { requestId })
      });
      return user;
    } catch (error) {
      this.users.pop();
      throw error;
    }
  }
}

export class InMemoryProjectRepository implements ProjectRepository {
  public readonly projects: ProjectRecord[] = [];
  public readonly deployments: DeploymentRecord[] = [];

  public async createForOwner(
    ownerId: string,
    input: CreateProjectInput,
    _requestId?: string
  ): Promise<ProjectRecord> {
    const now = new Date();
    const project: ProjectRecord = {
      id: randomUUID(),
      userId: ownerId,
      name: input.name,
      description: input.description ?? null,
      healthCheckUrl: null,
      healthCheckPath: input.healthCheckPath ?? null,
      expectedPort: input.expectedPort ?? null,
      monitoringEnabled: false,
      monitoringIntervalMs: null,
      healthCheckTimeoutMs: null,
      incidentFailureThreshold: null,
      nextCheckAt: null,
      lastCheckedAt: null,
      createdAt: now,
      updatedAt: now
    };
    this.projects.push(project);
    return project;
  }

  public async listForOwner(ownerId: string): Promise<readonly ProjectRecord[]> {
    return this.projects.filter((project) => project.userId === ownerId);
  }

  public async findByIdForOwner(projectId: string, ownerId: string): Promise<ProjectRecord | null> {
    return (
      this.projects.find((project) => project.id === projectId && project.userId === ownerId) ?? null
    );
  }

  public async registerDeploymentForOwner(
    ownerId: string,
    projectId: string,
    input: RegisterDeploymentInput,
    _requestId?: string
  ): Promise<DeploymentRecord | null> {
    const project = await this.findByIdForOwner(projectId, ownerId);
    if (project === null) {
      return null;
    }
    if (
      this.deployments.some(
        (deployment) =>
          deployment.containerName === input.containerName ||
          (deployment.projectId === projectId && deployment.name === input.name)
      )
    ) {
      throw new ConflictError(
        "DEPLOYMENT_ALREADY_REGISTERED",
        "The deployment name or container is already registered"
      );
    }
    this.deployments.forEach((deployment, index) => {
      if (deployment.projectId === projectId && deployment.isCurrent) {
        this.deployments[index] = { ...deployment, isCurrent: false, updatedAt: new Date() };
      }
    });
    const now = new Date();
    const deployment = {
      id: randomUUID(),
      projectId,
      isCurrent: true,
      ...input,
      createdAt: now,
      updatedAt: now
    };
    this.deployments.push(deployment);
    return deployment;
  }

  public async configureMonitoringForOwner(
    ownerId: string,
    projectId: string,
    input: MonitoringConfigurationInput,
    _requestId?: string
  ): Promise<ProjectRecord | null> {
    const index = this.projects.findIndex(
      (project) => project.id === projectId && project.userId === ownerId
    );
    const existing = this.projects[index];
    if (existing === undefined) {
      return null;
    }
    if (
      input.monitoringEnabled &&
      !this.deployments.some((item) => item.projectId === projectId && item.isCurrent)
    ) {
      throw new ConflictError("DEPLOYMENT_REQUIRED", "Register a deployment before enabling monitoring");
    }
    const updated: ProjectRecord = {
      ...existing,
      monitoringEnabled: input.monitoringEnabled,
      healthCheckPath: input.healthCheckPath ?? existing.healthCheckPath,
      expectedPort: input.expectedPort ?? existing.expectedPort,
      monitoringIntervalMs: input.monitoringIntervalMs ?? existing.monitoringIntervalMs,
      healthCheckTimeoutMs: input.healthCheckTimeoutMs ?? existing.healthCheckTimeoutMs,
      incidentFailureThreshold:
        input.incidentFailureThreshold ?? existing.incidentFailureThreshold,
      nextCheckAt: input.monitoringEnabled ? new Date() : null,
      updatedAt: new Date()
    };
    this.projects[index] = updated;
    return updated;
  }
}
