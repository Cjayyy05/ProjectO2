# SelfHeal

SelfHeal is an AI-assisted recovery platform for locally deployed Docker applications. This repository currently contains the Phase 5 monitoring, evidence, deterministic diagnosis, and controlled remediation-planning foundation.

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

Docker integration tests are opt-in. Set `RUN_DOCKER_INTEGRATION_TESTS=true` plus `TEST_DOCKER_RUNNING_CONTAINER`, `TEST_DOCKER_RUNNING_PORT`, `TEST_DOCKER_STOPPED_CONTAINER`, `TEST_DOCKER_EVIDENCE_CONTAINER`, and `TEST_DOCKER_EVIDENCE_SECRET` to disposable fixtures. The evidence fixture should contain that seeded non-production secret in its environment/logs so redaction can be verified. The vertical-slice tests also require `RUN_DATABASE_INTEGRATION_TESTS=true` and a disposable migrated database. Run database-backed integration files with `vitest run --no-file-parallelism` because they intentionally share that disposable schema and exercise global work claiming.

Phase 2 includes read-only Docker inspection, bounded HTTP checks, persisted health/failure state, in-process scheduling, and deduplicated `CONTAINER_CRASH` and `HEALTH_CHECK_FAILURE` incidents.

## Phase 3 evidence collection

A separate non-overlapping in-process scheduler atomically claims `DETECTED` incidents, collects evidence for the Deployment linked to the Incident, and advances the Incident through `COLLECTING_EVIDENCE` to `DIAGNOSING`. Evidence categories cover registered deployment metadata, latest monitoring state, safe Docker runtime metadata, environment variable names with a narrow safe-value allowlist, bounded recent logs, collection errors, and an explicit completeness summary.

Docker logs are streamed and persisted up to the configured limits of at most 256 KB and 500 lines. Central sanitization removes known credential patterns before PostgreSQL persistence. Evidence carries a default 30-day expiry; automatic retention deletion is intentionally deferred operational work.

It deliberately does not contain remediation planning or execution, verification, recovery, rollback, realtime product behavior, or dashboard features.

## Phase 4 deterministic diagnosis

Set `AI_PROVIDER=mock`. A non-overlapping scheduler atomically claims `DIAGNOSING` Incidents, builds a bounded input exclusively from persisted sanitized IncidentEvidence, and invokes the provider-neutral diagnosis interface. Mock rules have documented deterministic precedence for missing configuration, port mismatch, database connectivity, container crash, generic health failure, and insufficient evidence.

All provider output is treated as untrusted: strict runtime validation rejects unsupported actions, arbitrary commands/paths, invalid confidence, oversized prose, and foreign evidence references. Valid diagnoses reference evidence IDs and atomically move the Incident to `FIX_PROPOSED`; provider or validation failure moves it to `DIAGNOSIS_FAILED`. The provider suggestion remains advisory until the separate Phase 5 deterministic planning boundary accepts it.

## Phase 5 controlled remediation planning

A separate non-overlapping scheduler processes persisted `FIX_PROPOSED` Diagnoses. Deterministic code resolves every target through the Incident's trusted Project and Deployment relationships, validates the suggestion against the four approved action schemas, captures a trusted drift baseline, and persists one immutable RemediationPlan per Diagnosis. The Incident remains `FIX_PROPOSED`.

Restart targets are derived from the Incident rather than provider input. Rollback targets must be known older Deployments in the same Project. Environment plans permit only `NODE_ENV`, `APP_ENV`, `LOG_LEVEL`, `HOST`, and the Project's registered `PORT`; credential-like names are always rejected. File patches are accepted only for files in a trusted Deployment manifest and reject absolute/traversal paths, symlinks, protected or generated files, `.env` files, SelfHeal source paths, binary content, secrets, more than four files, more than 64 KB of aggregate source/replacement content, or more than 96 KB of aggregate generated diff content.

Plan hashes use canonical JSON and SHA-256 over schema/version, Incident, Diagnosis, Project and affected Deployment identity, action-type identity, the exact typed action, evidence references, diagnosis-result hash, trusted action baseline, review summary, rollback semantics, and target snapshot hash. Creation time is deliberately excluded. Persistence validates the digest again before inserting the plan. Phase 5 reads and writes PostgreSQL only: it does not call Docker, read or write application files, mutate environment configuration, verify, approve, or execute remediation.

Future verification must never use a production database. Database-dependent verification must use a disposable test database or isolated dependency, and verification containers must not receive unnecessary production secrets.

Future production recovery for a project will use one project-scoped PostgreSQL advisory lock. Phase 5 does not implement recovery or a generic lock abstraction.
