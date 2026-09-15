import { Router } from "express";
import { z } from "zod";
import { authenticatedUserId } from "../auth/auth-middleware";
import type { ProjectService } from "./project-service";

const projectIdSchema = z.uuid();
const healthCheckUrlSchema = z
  .url()
  .max(2_048)
  .refine((value) => {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username.length === 0 &&
      parsed.password.length === 0
    );
  }, "Health check URL must use HTTP(S) and must not contain credentials");
const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1_000).optional(),
  healthCheckUrl: healthCheckUrlSchema.optional(),
  expectedPort: z.number().int().min(1).max(65_535).optional()
});

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
        ...(input.healthCheckUrl === undefined ? {} : { healthCheckUrl: input.healthCheckUrl }),
        ...(input.expectedPort === undefined ? {} : { expectedPort: input.expectedPort })
      },
      request.requestId
    );
    response.status(201).json({ project });
  });

  router.get("/:projectId", async (request, response) => {
    const projectId = projectIdSchema.parse(request.params.projectId);
    const project = await projectService.get(authenticatedUserId(request), projectId);
    response.status(200).json({ project });
  });

  return router;
}
