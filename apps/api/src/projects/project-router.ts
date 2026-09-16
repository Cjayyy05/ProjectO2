import { Router } from "express";
import { MONITORING_LIMITS } from "@selfheal/shared";
import { z } from "zod";
import { authenticatedUserId } from "../auth/auth-middleware";
import { healthCheckPathSchema } from "../monitoring/health-check-path";
import type { ProjectService } from "./project-service";

const projectIdSchema = z.uuid();
const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1_000).optional(),
  healthCheckPath: healthCheckPathSchema.optional(),
  expectedPort: z.number().int().min(1).max(65_535).optional()
}).strict();
const registerDeploymentSchema = z.object({
  name: z.string().trim().min(1).max(100),
  containerName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
  imageReference: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,254}$/)
}).strict();
const monitoringConfigurationSchema = z.discriminatedUnion("monitoringEnabled", [
  z.object({ monitoringEnabled: z.literal(false) }).strict(),
  z.object({
    monitoringEnabled: z.literal(true),
    healthCheckPath: healthCheckPathSchema,
    expectedPort: z.number().int().min(1).max(65_535),
    monitoringIntervalMs: z.number().int()
      .min(MONITORING_LIMITS.intervalMs.min)
      .max(MONITORING_LIMITS.intervalMs.max)
      .optional(),
    healthCheckTimeoutMs: z.number().int()
      .min(MONITORING_LIMITS.healthCheckTimeoutMs.min)
      .max(MONITORING_LIMITS.healthCheckTimeoutMs.max)
      .optional(),
    incidentFailureThreshold: z.number().int()
      .min(MONITORING_LIMITS.incidentFailureThreshold.min)
      .max(MONITORING_LIMITS.incidentFailureThreshold.max)
      .optional()
  }).strict()
]);

export function createProjectRouter(projectService: ProjectService): Router {
  const router = Router();

  router.get("/", async (request, response) => {
    const projects = await projectService.list(authenticatedUserId(request));
    response.status(200).json({ projects });
  });

  router.post("/", async (request, response) => {
    const input = createProjectSchema.parse(request.body);
    const project = await projectService.create(
      authenticatedUserId(request),
      {
        name: input.name,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.healthCheckPath === undefined ? {} : { healthCheckPath: input.healthCheckPath }),
        ...(input.expectedPort === undefined ? {} : { expectedPort: input.expectedPort })
      },
      request.requestId
    );
    response.status(201).json({ project });
  });

  router.post("/:projectId/deployments", async (request, response) => {
    const projectId = projectIdSchema.parse(request.params.projectId);
    const input = registerDeploymentSchema.parse(request.body);
    const deployment = await projectService.registerDeployment(
      authenticatedUserId(request),
      projectId,
      input,
      request.requestId
    );
    response.status(201).json({ deployment });
  });

  router.patch("/:projectId/monitoring", async (request, response) => {
    const projectId = projectIdSchema.parse(request.params.projectId);
    const input = monitoringConfigurationSchema.parse(request.body);
    const configuration = input.monitoringEnabled
      ? {
          monitoringEnabled: true as const,
          healthCheckPath: input.healthCheckPath,
          expectedPort: input.expectedPort,
          ...(input.monitoringIntervalMs === undefined
            ? {}
            : { monitoringIntervalMs: input.monitoringIntervalMs }),
          ...(input.healthCheckTimeoutMs === undefined
            ? {}
            : { healthCheckTimeoutMs: input.healthCheckTimeoutMs }),
          ...(input.incidentFailureThreshold === undefined
            ? {}
            : { incidentFailureThreshold: input.incidentFailureThreshold })
        }
      : { monitoringEnabled: false as const };
    const project = await projectService.configureMonitoring(
      authenticatedUserId(request),
      projectId,
      configuration,
      request.requestId
    );
    response.status(200).json({ project });
  });

  router.get("/:projectId", async (request, response) => {
    const projectId = projectIdSchema.parse(request.params.projectId);
    const project = await projectService.get(authenticatedUserId(request), projectId);
    response.status(200).json({ project });
  });

  return router;
}
