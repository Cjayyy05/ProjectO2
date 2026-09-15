import { NotFoundError } from "../errors/app-error";
import type { CreateProjectInput, ProjectRecord, ProjectRepository } from "./project-repository";

export class ProjectService {
  public constructor(private readonly projects: ProjectRepository) {}

  public async create(ownerId: string, input: CreateProjectInput, requestId?: string): Promise<ProjectRecord> {
    return this.projects.createForOwner(ownerId, input, requestId);
  }

  public async list(ownerId: string): Promise<readonly ProjectRecord[]> {
    return this.projects.listForOwner(ownerId);
  }

  public async get(ownerId: string, projectId: string): Promise<ProjectRecord> {
    const project = await this.projects.findByIdForOwner(projectId, ownerId);

    if (project === null) {
      throw new NotFoundError("Project");
    }

    return project;
  }
}

