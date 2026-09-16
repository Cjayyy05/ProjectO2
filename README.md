# SelfHeal

SelfHeal is an AI-assisted recovery platform for locally deployed Docker applications. This repository currently contains the Phase 2 monitoring and incident-detection foundation.

## Development prerequisites

- Windows with Node.js 22.13 or newer and npm
- Docker Desktop configured for Linux containers with the WSL2 backend
- PostgreSQL 16, normally through `compose.yaml`

Copy `.env.example` to `.env`, replace every placeholder secret, then run:

```powershell
npm install
docker compose up -d postgres
npm run prisma:generate
npm run prisma:migrate:dev
npm run dev:api
```

The API process must be able to reach the local Docker Desktop engine. On Windows it uses Docker Desktop's Linux-engine named pipe by default; `DOCKER_SOCKET_PATH` may be set by the server operator when a different local endpoint is required.

Run the frontend separately with `npm run dev:web`. It is served on port 3000 by default; the API is served on port 4000.

Run the PostgreSQL-backed domain integration test against a migrated disposable/test database with:

```powershell
$env:RUN_DATABASE_INTEGRATION_TESTS = "true"
npm run test -w @selfheal/api
```

Never point this integration test at a production database.

## Phase 2 monitoring

Create a project, register its Docker deployment with `POST /api/projects/:projectId/deployments`, then configure monitoring with `PATCH /api/projects/:projectId/monitoring`. A project has at most one current deployment: registering a replacement atomically marks the previous deployment historical, and monitoring selects only the current deployment. Health checks accept a path such as `/health`, never a URL. The backend targets only `127.0.0.1`, verifies that the configured host port is published by the registered container, and never follows redirects.

Docker integration tests are opt-in. Set `RUN_DOCKER_INTEGRATION_TESTS=true` plus `TEST_DOCKER_RUNNING_CONTAINER`, `TEST_DOCKER_RUNNING_PORT`, and `TEST_DOCKER_STOPPED_CONTAINER` to disposable fixtures. The vertical-slice test also requires `RUN_DATABASE_INTEGRATION_TESTS=true` and a disposable migrated database.

Phase 2 includes read-only Docker inspection, bounded HTTP checks, persisted health/failure state, in-process scheduling, and deduplicated `CONTAINER_CRASH` and `HEALTH_CHECK_FAILURE` incidents.

It deliberately does not contain evidence collection, diagnosis providers, remediation planning or execution, verification, recovery, rollback, realtime product behavior, or dashboard features.

Future verification must never use a production database. Database-dependent verification must use a disposable test database or isolated dependency, and verification containers must not receive unnecessary production secrets.

Future production recovery for a project will use one project-scoped PostgreSQL advisory lock. Phase 1 does not implement recovery or a generic lock abstraction.
