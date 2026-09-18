# SelfHeal One-Month MVP Implementation Plan

Status: Phase 6 isolated verification implemented; approval and recovery remain planned
Last updated: 2026-09-20

## 1. Locked implementation baseline

- npm workspaces
- Node.js + TypeScript + Express backend
- Next.js + TypeScript frontend
- PostgreSQL + Prisma
- JWT authentication
- one `User` owns many `Project` records; each project has one owner
- controlled local Docker Engine adapter
- Socket.IO realtime notifications with REST refetch fallback
- deterministic `MockDiagnosisProvider`
- bounded sanitized PostgreSQL evidence
- exact-plan human approval before every recovery

The MVP is one modular monolith backend plus one frontend. Do not add Kafka, Redis, Kubernetes, microservices, a generic workflow engine, a transactional outbox, enterprise tenancy/RBAC, remote Docker agents, or speculative provider infrastructure.

## 2. Week 1 — Foundation and read-only vertical slice

Planned scope after Phase 1 is authorized:

- scaffold npm workspaces, Express API, Next.js UI, shared TypeScript configuration, tests, and CI;
- configure Prisma/PostgreSQL and the minimal schema;
- implement JWT authentication and ownership-aware project queries;
- implement project registration for a local Docker container;
- implement controlled read-only Docker inspection;
- implement simple monitoring loop, observations, incident fingerprinting, and guarded transitions;
- display projects and detected incidents.

Exit checks:

- build, typecheck, lint, and tests pass;
- one user cannot access another user's project;
- fixture container crash and health failure create one deduplicated incident;
- only the Docker module accesses the Docker Engine;
- no production mutation exists.

## 3. Week 2 — Evidence and mock diagnosis

Planned scope:

- add bounded collectors for inspect data, logs, Docker health, ports, env-key presence, and dependency-probe results;
- sanitize evidence before PostgreSQL insertion;
- implement all five incident detectors;
- implement `DiagnosisProvider` and deterministic `MockDiagnosisProvider`;
- validate typed proposals against the server allow-list;
- display evidence, diagnosis, and proposed plan in the incident timeline;
- record audit events in the same transactions as state changes.

Exit checks:

- seeded secrets do not appear in the database, application logs, API, Socket.IO events, or provider input;
- all five fixture failures produce stable expected diagnoses;
- malformed or malicious provider output cannot produce an executable action;
- incident states reach `FIX_PROPOSED` or `DIAGNOSIS_FAILED` correctly.

## 4. Week 3 — Isolated verification and approval

Phase 6 completed verification scope:

- implemented temporary workspaces and isolated Docker verification images, containers, and networks;
- implemented exact-plan/baseline revalidation, action staging, build/start, trusted tests, required HTTP health check, bounded logs, cleanup, leases, persistence, and audit;
- store verification result, plan hash, target snapshot hash, cleanup status, and expiry transactionally;

Still deferred to Phase 7:

- build exact-plan approval UI and API;
- enforce owner identity, current verification, hash matching, and expiry;
- add Socket.IO incident/verification/approval notifications with REST refetch behavior.

Exit checks:

- sandbox has no Docker socket, privileged mode, host mounts, or production credentials (implemented and tested);
- failed or unclean verification cannot be approved;
- changed/stale plans and cross-user requests cannot be approved;
- reconnecting clients recover current state without an event outbox;
- no production mutation exists yet.

## 5. Week 4 — Recovery, rollback, audit, and demo hardening

Planned scope:

- implement the smallest typed action set: container restart, carefully bounded recreate if feasible, and read-only health check;
- implement approval revalidation, target drift detection, guarded state transition, and project-scoped advisory lock;
- persist recovery attempts and step states with idempotency keys;
- implement deterministic health/stability checks and feasible rollback;
- reconcile interrupted `STARTED` steps using observed Docker state;
- finish audit timeline and recovery progress UI;
- run end-to-end failure, concurrency, interruption, and rollback tests;
- prepare demo fixtures for all five incident types.

Exit checks:

- recovery is impossible without current successful verification and exact-plan owner approval;
- two concurrent recovery requests produce one execution;
- target drift aborts before mutation;
- interrupted actions are not blindly replayed;
- recovery failure rolls back where supported and reports rollback failure clearly;
- every privileged action is present in audit history.

## 6. Complexity policy during implementation

Start with:

- normal Prisma transactions;
- explicit transition functions and conditional updates;
- database uniqueness constraints;
- one in-process monitor loop;
- one advisory lock only for production recovery;
- direct Socket.IO emit after commit;
- direct PostgreSQL evidence storage with configured limits.

Add complexity only after a failing test or observed requirement demonstrates the need. In particular:

- add a monitor lease only if overlapping checks actually occur;
- split a worker process only if Docker/verification work harms API responsiveness;
- add an outbox only if guaranteed event delivery becomes a requirement;
- add object storage only if evidence volume exceeds safe PostgreSQL limits;
- add additional roles/tenancy only if the product scope changes;
- add a distributed queue only if multiple backend instances become necessary.

Any such change requires a short ADR stating the measured problem and why the simpler design is insufficient.

## 7. Primary risks

| Risk | MVP mitigation |
| --- | --- |
| Local Docker access can control the host | Controlled adapter, registered targets, no shell, developer-host scope, typed actions |
| Verification differs from the real deployment | Pin target/image snapshot, disclose limits, deterministic production health check |
| Logs expose secrets | Sanitize before storage, strict byte/line limits, seeded leak tests |
| Duplicate recovery | Guarded state transition, unique active attempt, project advisory lock |
| Crash after Docker side effect | Persist `STARTED`, inspect actual state, use idempotency key/label |
| Rollback cannot restore every change | Small action allow-list and explicit per-action rollback capability |
| User approves the wrong plan | Exact hashes, clear target/action UI, expiry, drift revalidation |
| Socket.IO event is lost | REST is authoritative; reconnect and active screens refetch |
| Hackathon scope expands | Defer enterprise/distributed concerns and protect the vertical slice |

## 8. Deferred work

- Gemini provider and its security/data review;
- remote Docker targets;
- multiple backend replicas and distributed coordination;
- enterprise roles, teams, organizations, or workspace tenancy;
- durable event publication/outbox;
- external evidence or audit storage;
- additional recovery actions and orchestrators.

## 9. Remaining Phase 1 inputs

The locked decisions remove the architecture blockers to beginning Phase 1. Before implementing the affected feature, choose these small configuration/product values:

- how JWTs are issued for the demo (local email/password or another simple issuer), token lifetime, and secure client storage approach;
- exact evidence byte/line limits and retention duration;
- exact first recovery action set—`RESTART_CONTAINER` is required; `RECREATE_CONTAINER` should be included only if its rollback snapshot is reliable;
- sandbox treatment of database-dependent applications, with unsafe production database access prohibited;
- supported local operating system/Docker Desktop setup and container registration method;
- health-check timeout, failure threshold, and post-recovery stability window.

These do not require new architecture. They should be recorded as implementation configuration or narrow ADRs when selected. Phase 1 must not begin until explicitly authorized.
