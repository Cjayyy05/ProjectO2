import { randomUUID } from "node:crypto";
import type { AuditEventInput, AuditWriter } from "../audit/audit";
import { ConflictError } from "../errors/app-error";
import type { UserRecord, UserRepository } from "../auth/user-repository";
import type {
  CreateProjectInput,
  ProjectRecord,
  ProjectRepository
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
      healthCheckUrl: input.healthCheckUrl ?? null,
      expectedPort: input.expectedPort ?? null,
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
}
