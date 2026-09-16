import { Prisma, type PrismaClient } from "@prisma/client";
import { ConflictError } from "../errors/app-error";
import type {
  CreateProjectInput,
  DeploymentRecord,
  MonitoringConfigurationInput,
  ProjectRecord,
  ProjectRepository,
  RegisterDeploymentInput
} from "./project-repository";

const projectSelection = {
  id: true,
  userId: true,
  name: true,
  description: true,
  healthCheckUrl: true,
  healthCheckPath: true,
  expectedPort: true,
  monitoringEnabled: true,
  monitoringIntervalMs: true,
  healthCheckTimeoutMs: true,
  incidentFailureThreshold: true,
  nextCheckAt: true,
  lastCheckedAt: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.ProjectSelect;

export class PrismaProjectRepository implements ProjectRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async createForOwner(
    ownerId: string,
    input: CreateProjectInput,
    requestId?: string
  ): Promise<ProjectRecord> {
    return this.prisma.project.create({
      data: {
        userId: ownerId,
        name: input.name,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.healthCheckPath === undefined ? {} : { healthCheckPath: input.healthCheckPath }),
        ...(input.expectedPort === undefined ? {} : { expectedPort: input.expectedPort }),
        auditEvents: {
          create: {
            userId: ownerId,
            action: "PROJECT_CREATED",
            resourceType: "Project",
            outcome: "SUCCESS",
            ...(requestId === undefined ? {} : { requestId }),
            details: { name: input.name }
          }
        }
      },
      select: projectSelection
    });
  }

  public async listForOwner(ownerId: string): Promise<readonly ProjectRecord[]> {
    return this.prisma.project.findMany({
      where: { userId: ownerId },
      orderBy: { createdAt: "desc" },
      select: projectSelection
    });
  }

  public async findByIdForOwner(projectId: string, ownerId: string): Promise<ProjectRecord | null> {
    return this.prisma.project.findFirst({
      where: { id: projectId, userId: ownerId },
      select: projectSelection
    });
  }

  public async registerDeploymentForOwner(
    ownerId: string,
    projectId: string,
    input: RegisterDeploymentInput,
    requestId?: string
  ): Promise<DeploymentRecord | null> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const project = await transaction.project.findFirst({
          where: { id: projectId, userId: ownerId },
          select: { id: true }
        });
        if (project === null) {
          return null;
        }

        await transaction.deployment.updateMany({
          where: { projectId, isCurrent: true },
          data: { isCurrent: false }
        });
        const deployment = await transaction.deployment.create({
          data: { projectId, isCurrent: true, ...input }
        });
        await transaction.auditEvent.create({
          data: {
            userId: ownerId,
            projectId,
            action: "DEPLOYMENT_REGISTERED",
            resourceType: "Deployment",
            resourceId: deployment.id,
            outcome: "SUCCESS",
            ...(requestId === undefined ? {} : { requestId }),
            details: { name: input.name, containerName: input.containerName }
          }
        });
        return deployment;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictError(
          "DEPLOYMENT_ALREADY_REGISTERED",
          "The deployment name or container is already registered"
        );
      }
      throw error;
    }
  }

  public async configureMonitoringForOwner(
    ownerId: string,
    projectId: string,
    input: MonitoringConfigurationInput,
    requestId?: string
  ): Promise<ProjectRecord | null> {
    return this.prisma.$transaction(async (transaction) => {
      const project = await transaction.project.findFirst({
        where: { id: projectId, userId: ownerId },
        select: {
          id: true,
          _count: { select: { deployments: { where: { isCurrent: true } } } }
        }
      });
      if (project === null) {
        return null;
      }
      if (input.monitoringEnabled && project._count.deployments === 0) {
        throw new ConflictError(
          "DEPLOYMENT_REQUIRED",
          "Register a deployment before enabling monitoring"
        );
      }

      const updated = await transaction.project.update({
        where: { id: projectId },
        data: {
          monitoringEnabled: input.monitoringEnabled,
          ...(input.healthCheckPath === undefined ? {} : { healthCheckPath: input.healthCheckPath }),
          ...(input.expectedPort === undefined ? {} : { expectedPort: input.expectedPort }),
          ...(input.monitoringIntervalMs === undefined
            ? {}
            : { monitoringIntervalMs: input.monitoringIntervalMs }),
          ...(input.healthCheckTimeoutMs === undefined
            ? {}
            : { healthCheckTimeoutMs: input.healthCheckTimeoutMs }),
          ...(input.incidentFailureThreshold === undefined
            ? {}
            : { incidentFailureThreshold: input.incidentFailureThreshold }),
          nextCheckAt: input.monitoringEnabled ? new Date() : null
        },
        select: projectSelection
      });
      await transaction.auditEvent.create({
        data: {
          userId: ownerId,
          projectId,
          action: "MONITORING_CONFIGURATION_CHANGED",
          resourceType: "Project",
          resourceId: projectId,
          outcome: "SUCCESS",
          ...(requestId === undefined ? {} : { requestId }),
          details: {
            monitoringEnabled: input.monitoringEnabled,
            healthCheckPath: input.healthCheckPath ?? null,
            expectedPort: input.expectedPort ?? null,
            monitoringIntervalMs: input.monitoringIntervalMs ?? null,
            healthCheckTimeoutMs: input.healthCheckTimeoutMs ?? null,
            incidentFailureThreshold: input.incidentFailureThreshold ?? null
          }
        }
      });
      return updated;
    });
  }
}
