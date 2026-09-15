import type { Prisma, PrismaClient } from "@prisma/client";
import type { CreateProjectInput, ProjectRecord, ProjectRepository } from "./project-repository";

const projectSelection = {
  id: true,
  userId: true,
  name: true,
  description: true,
  healthCheckUrl: true,
  expectedPort: true,
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
        ...(input.healthCheckUrl === undefined ? {} : { healthCheckUrl: input.healthCheckUrl }),
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
}

