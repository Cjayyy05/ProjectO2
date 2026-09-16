import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import { AuthService } from "./auth/auth-service";
import { JwtService } from "./auth/jwt-service";
import { loadEnvironment } from "./config/environment";
import { createLogger } from "./logging/logger";
import { ProjectService } from "./projects/project-service";
import {
  InMemoryAuditWriter,
  InMemoryProjectRepository,
  InMemoryUserRepository
} from "./test/in-memory-repositories";

function createTestApplication() {
  const config = loadEnvironment({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://selfheal:test@localhost:5432/selfheal_test",
    JWT_SECRET: "test-secret-with-at-least-32-characters",
    PASSWORD_HASH_ROUNDS: "10"
  });
  const audit = new InMemoryAuditWriter();
  const users = new InMemoryUserRepository(audit);
  const projects = new InMemoryProjectRepository();
  const jwtService = new JwtService(config.jwt.secret, config.jwt.ttlHours);
  const app = createApp({
    config,
    logger: createLogger("test"),
    authService: new AuthService(users, audit, config.passwordHashRounds),
    jwtService,
    projectService: new ProjectService(projects)
  });

  return { app, users, projects, audit };
}

const validCredentials = {
  email: "owner@example.com",
  password: "correct horse battery staple"
};

describe("Express application foundation", () => {
  it("serves the health endpoint without authentication", async () => {
    const { app } = createTestApplication();

    const response = await request(app).get("/api/health").expect(200);

    expect(response.body).toMatchObject({ status: "ok", service: "selfheal-api" });
    expect(response.headers["x-request-id"]).toBeTypeOf("string");
  });

  it("rejects project access without the HttpOnly JWT cookie", async () => {
    const { app } = createTestApplication();

    const response = await request(app).get("/api/projects").expect(401);

    expect(response.body).toEqual({
      error: { code: "AUTHENTICATION_REQUIRED", message: "Authentication required" }
    });
  });

  it("rejects malformed JSON with a client error", async () => {
    const { app } = createTestApplication();

    const response = await request(app)
      .post("/api/auth/register")
      .set("content-type", "application/json")
      .send('{"email":')
      .expect(400);

    expect(response.body).toEqual({
      error: { code: "INVALID_JSON", message: "Request body is not valid JSON" }
    });
  });

  it("rejects request bodies above the configured parser limit", async () => {
    const { app } = createTestApplication();

    const response = await request(app)
      .post("/api/auth/register")
      .send({ email: "owner@example.com", password: "x".repeat(33_000) })
      .expect(413);

    expect(response.body).toEqual({
      error: { code: "PAYLOAD_TOO_LARGE", message: "Request payload is too large" }
    });
  });

  it("sets authentication only in an HttpOnly SameSite cookie", async () => {
    const { app } = createTestApplication();

    const response = await request(app).post("/api/auth/register").send(validCredentials).expect(201);
    const setCookie = response.headers["set-cookie"];

    expect(Array.isArray(setCookie)).toBe(true);
    expect(setCookie?.[0]).toContain("selfheal_token=");
    expect(setCookie?.[0]).toContain("HttpOnly");
    expect(setCookie?.[0]).toContain("SameSite=Lax");
    expect(response.body.user).not.toHaveProperty("passwordHash");
    expect(response.body).not.toHaveProperty("token");
  });

  it("sets the Secure cookie flag in production", async () => {
    const foundation = createTestApplication();
    const productionConfig = loadEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://selfheal:test@localhost:5432/selfheal_test",
      JWT_SECRET: "test-secret-with-at-least-32-characters",
      PASSWORD_HASH_ROUNDS: "10"
    });
    const app = createApp({
      config: productionConfig,
      logger: createLogger("test"),
      authService: new AuthService(foundation.users, foundation.audit, 10),
      jwtService: new JwtService(productionConfig.jwt.secret, productionConfig.jwt.ttlHours),
      projectService: new ProjectService(foundation.projects)
    });

    const response = await request(app).post("/api/auth/register").send(validCredentials).expect(201);
    const setCookie = response.headers["set-cookie"];

    expect(setCookie?.[0]).toContain("Secure");
  });

  it("allows an authenticated owner to create and query their project", async () => {
    const { app } = createTestApplication();
    const owner = request.agent(app);
    await owner.post("/api/auth/register").send(validCredentials).expect(201);

    const created = await owner
      .post("/api/projects")
      .send({ name: "Demo API", healthCheckPath: "/health", expectedPort: 8080 })
      .expect(201);
    const projectId = created.body.project.id as string;

    const response = await owner.get(`/api/projects/${projectId}`).expect(200);
    expect(response.body.project).toMatchObject({
      id: projectId,
      name: "Demo API",
      healthCheckPath: "/health",
      expectedPort: 8080
    });
  });

  it("does not reveal another user's project", async () => {
    const { app } = createTestApplication();
    const owner = request.agent(app);
    const otherUser = request.agent(app);
    await owner.post("/api/auth/register").send(validCredentials).expect(201);
    await otherUser
      .post("/api/auth/register")
      .send({ email: "other@example.com", password: "another secure password value" })
      .expect(201);

    const created = await owner.post("/api/projects").send({ name: "Private project" }).expect(201);
    const projectId = created.body.project.id as string;

    await otherUser.get(`/api/projects/${projectId}`).expect(404);
    const ownList = await owner.get("/api/projects").expect(200);
    const otherList = await otherUser.get("/api/projects").expect(200);
    expect(ownList.body.projects).toHaveLength(1);
    expect(otherList.body.projects).toHaveLength(0);
  });

  it("rejects a caller-supplied owner field", async () => {
    const { app } = createTestApplication();
    const owner = request.agent(app);
    await owner.post("/api/auth/register").send(validCredentials).expect(201);

    await owner
      .post("/api/projects")
      .send({ name: "Owned project", userId: "00000000-0000-0000-0000-000000000000" })
      .expect(400);
  });

  it.each([
    "https://attacker.example/health",
    "//attacker.example/health",
    "/health?token=value",
    "/health#details",
    "\\\\attacker.example\\health",
    "/../health"
  ])("rejects unsafe health-check path %s", async (healthCheckPath) => {
    const { app } = createTestApplication();
    const owner = request.agent(app);
    await owner.post("/api/auth/register").send(validCredentials).expect(201);

    const response = await owner
      .post("/api/projects")
      .send({ name: "Unsafe project", healthCheckPath })
      .expect(400);

    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("registers a deployment and enables bounded monitoring", async () => {
    const { app } = createTestApplication();
    const owner = request.agent(app);
    await owner.post("/api/auth/register").send(validCredentials).expect(201);
    const created = await owner.post("/api/projects").send({ name: "Monitored project" }).expect(201);
    const projectId = created.body.project.id as string;

    await owner
      .post(`/api/projects/${projectId}/deployments`)
      .send({ name: "production", containerName: "demo-api", imageReference: "demo/api:latest" })
      .expect(201);
    const configured = await owner
      .patch(`/api/projects/${projectId}/monitoring`)
      .send({
        monitoringEnabled: true,
        healthCheckPath: "/api/health",
        expectedPort: 8080,
        monitoringIntervalMs: 10_000,
        healthCheckTimeoutMs: 2_000,
        incidentFailureThreshold: 3
      })
      .expect(200);

    expect(configured.body.project).toMatchObject({
      monitoringEnabled: true,
      healthCheckPath: "/api/health",
      expectedPort: 8080,
      incidentFailureThreshold: 3
    });
  });

  it("keeps exactly one current deployment when a replacement is registered", async () => {
    const { app, projects } = createTestApplication();
    const owner = request.agent(app);
    await owner.post("/api/auth/register").send(validCredentials).expect(201);
    const created = await owner.post("/api/projects").send({ name: "Replacement project" }).expect(201);
    const projectId = created.body.project.id as string;

    const first = await owner
      .post(`/api/projects/${projectId}/deployments`)
      .send({ name: "production-v1", containerName: "demo-v1", imageReference: "demo/api:v1" })
      .expect(201);
    const second = await owner
      .post(`/api/projects/${projectId}/deployments`)
      .send({ name: "production-v2", containerName: "demo-v2", imageReference: "demo/api:v2" })
      .expect(201);

    expect(first.body.deployment.isCurrent).toBe(true);
    expect(second.body.deployment.isCurrent).toBe(true);
    expect(projects.deployments.filter((deployment) => deployment.isCurrent)).toEqual([
      expect.objectContaining({ id: second.body.deployment.id, projectId })
    ]);
    expect(projects.deployments.find((deployment) => deployment.id === first.body.deployment.id))
      .toMatchObject({ isCurrent: false });
  });

  it("rejects unsafe Docker identifiers and monitoring bounds", async () => {
    const { app } = createTestApplication();
    const owner = request.agent(app);
    await owner.post("/api/auth/register").send(validCredentials).expect(201);
    const created = await owner.post("/api/projects").send({ name: "Validated monitor" }).expect(201);
    const projectId = created.body.project.id as string;

    await owner
      .post(`/api/projects/${projectId}/deployments`)
      .send({ name: "production", containerName: "../../docker.sock", imageReference: "demo:latest" })
      .expect(400);
    await owner
      .post(`/api/projects/${projectId}/deployments`)
      .send({ name: "production", containerName: "safe-container", imageReference: "demo:latest" })
      .expect(201);
    await owner
      .patch(`/api/projects/${projectId}/monitoring`)
      .send({
        monitoringEnabled: true,
        healthCheckPath: "/health",
        expectedPort: 8080,
        monitoringIntervalMs: 999,
        healthCheckTimeoutMs: 2_000,
        incidentFailureThreshold: 3
      })
      .expect(400);
  });

  it("requires a registered deployment before monitoring can be enabled", async () => {
    const { app } = createTestApplication();
    const owner = request.agent(app);
    await owner.post("/api/auth/register").send(validCredentials).expect(201);
    const created = await owner.post("/api/projects").send({ name: "No deployment" }).expect(201);

    const response = await owner
      .patch(`/api/projects/${created.body.project.id}/monitoring`)
      .send({ monitoringEnabled: true, healthCheckPath: "/health", expectedPort: 8080 })
      .expect(409);

    expect(response.body.error.code).toBe("DEPLOYMENT_REQUIRED");
  });

  it("prevents another user from configuring monitoring", async () => {
    const { app } = createTestApplication();
    const owner = request.agent(app);
    const other = request.agent(app);
    await owner.post("/api/auth/register").send(validCredentials).expect(201);
    await other
      .post("/api/auth/register")
      .send({ email: "other-monitor@example.com", password: "another secure password value" })
      .expect(201);
    const created = await owner.post("/api/projects").send({ name: "Private monitor" }).expect(201);

    await other
      .patch(`/api/projects/${created.body.project.id}/monitoring`)
      .send({ monitoringEnabled: false })
      .expect(404);
  });

  it("allows only the configured browser origin to read credentialed responses", async () => {
    const { app } = createTestApplication();

    const allowed = await request(app)
      .get("/api/health")
      .set("origin", "http://localhost:3000")
      .expect(200);
    const disallowed = await request(app)
      .get("/api/health")
      .set("origin", "https://attacker.example")
      .expect(200);

    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(disallowed.headers["access-control-allow-origin"]).toBeUndefined();
    expect(allowed.headers["access-control-allow-credentials"]).toBe("true");
  });
});
