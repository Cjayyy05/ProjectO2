import { NotFoundError } from "../errors/app-error";
import type {
  CreateProjectInput,
  DeploymentRecord,
  MonitoringConfigurationInput,
  ProjectRecord,
  ProjectRepository,
  RegisterDeploymentInput
} from "./project-repository";

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

  public async registerDeployment(
    ownerId: string,
    projectId: string,
    input: RegisterDeploymentInput,
    requestId?: string
  ): Promise<DeploymentRecord> {
    const deployment = await this.projects.registerDeploymentForOwner(
      ownerId,
      projectId,
      input,
      requestId
    );
    if (deployment === null) {
      throw new NotFoundError("Project");
    }
    return deployment;
  }

  public async configureMonitoring(
    ownerId: string,
    projectId: string,
    input: MonitoringConfigurationInput,
    requestId?: string
  ): Promise<ProjectRecord> {
    const project = await this.projects.configureMonitoringForOwner(
      ownerId,
      projectId,
      input,
      requestId
    );
    if (project === null) {
      throw new NotFoundError("Project");
    }
    return project;
  }
}
