export interface ProjectRecord {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly description: string | null;
  readonly healthCheckUrl: string | null;
  readonly expectedPort: number | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateProjectInput {
  readonly name: string;
  readonly description?: string;
  readonly healthCheckUrl?: string;
  readonly expectedPort?: number;
}

export interface ProjectRepository {
  createForOwner(ownerId: string, input: CreateProjectInput, requestId?: string): Promise<ProjectRecord>;
  listForOwner(ownerId: string): Promise<readonly ProjectRecord[]>;
  findByIdForOwner(projectId: string, ownerId: string): Promise<ProjectRecord | null>;
}

