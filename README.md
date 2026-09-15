# SelfHeal

SelfHeal is an AI-assisted recovery platform for locally deployed Docker applications. This repository currently contains the Phase 1 engineering foundation and domain model only.

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

Run the frontend separately with `npm run dev:web`. It is served on port 3000 by default; the API is served on port 4000.

Run the PostgreSQL-backed domain integration test against a migrated disposable/test database with:

```powershell
$env:RUN_DATABASE_INTEGRATION_TESTS = "true"
npm run test -w @selfheal/api
```

Never point this integration test at a production database.

## Phase 1 boundaries

This foundation includes JWT authentication in an HttpOnly cookie, User-to-Project ownership, Prisma models, guarded incident transitions, audit persistence support, environment validation, structured logging, and health/auth/project API foundations.

It deliberately does not contain Docker access, monitoring, detection, evidence collection, diagnosis providers, verification execution, remediation execution, recovery, rollback, or realtime product behavior.

Future verification must never use a production database. Database-dependent verification must use a disposable test database or isolated dependency, and verification containers must not receive unnecessary production secrets.

Future production recovery for a project will use one project-scoped PostgreSQL advisory lock. Phase 1 does not implement recovery or a generic lock abstraction.
