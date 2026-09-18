# SelfHeal MVP Architecture

Status: approved Phase 0 architecture  
Last updated: 2026-09-15

## 1. Architecture summary

SelfHeal is a TypeScript modular monolith with two applications managed with npm workspaces:

- `apps/api`: one Node.js + Express process containing the REST API, JWT authentication, Socket.IO server, monitor loop, diagnosis, verification, recovery, and audit modules;
- `apps/web`: one Next.js application containing the user interface.

PostgreSQL with Prisma is the only application datastore. The Express backend communicates with the local Docker Engine through a controlled adapter. Bounded sanitized evidence is stored directly in PostgreSQL.

```text
Browser
  | REST + Socket.IO
  v
Next.js frontend
  |
  v
Express modular monolith --------> PostgreSQL + Prisma
  |       |       |                   domain data, evidence,
  |       |       |                   transitions and audit
  |       |       +--> MockDiagnosisProvider
  |       +----------> isolated verification containers
  +------------------> controlled local Docker adapter
```

There is no Kafka, Redis, Kubernetes, microservice split, generic workflow engine, or transactional outbox. Socket.IO improves responsiveness; REST reads from PostgreSQL provide authoritative state and recover from missed events.

## 2. Proposed repository structure

```text
package.json                  # npm workspaces and root scripts
apps/
  api/
    src/
      app.ts                  # Express and Socket.IO composition
      auth/
      projects/
      monitoring/
      incidents/
      evidence/
      diagnosis/
      verification/
      approval/
      recovery/
      audit/
      docker/
  web/
    src/
      app/
      features/
      components/
      lib/
packages/
  shared/                     # shared enums and API DTO types only
prisma/
  schema.prisma
  migrations/
tests/
  fixtures/                   # deliberately broken Docker applications
  integration/
  e2e/
docs/
```

Avoid creating a package for every conceptual layer. Inside `apps/api`, modules expose small service interfaces and keep Express handlers, Prisma access, and domain rules separate by convention. Extract code into `packages/` only when both applications genuinely share it.

## 3. Backend module boundaries

| Module | MVP responsibility |
| --- | --- |
| Auth | Issue/verify JWTs, load the current user, protect routes |
| Projects | User-owned Docker application registration and expected health/configuration |
| Monitoring | In-process polling, container/health observations, detection thresholds |
| Incidents | Fingerprinting, deduplication, lifecycle guards, incident timeline |
| Evidence | Incident-specific collectors, sanitization, size limits, PostgreSQL persistence |
| Diagnosis | `DiagnosisProvider` interface and deterministic `MockDiagnosisProvider` |
| Verification | Isolated Docker sandbox and deterministic checks |
| Approval | Exact-plan approval by the owning user |
| Recovery | Allow-listed actions, revalidation, idempotent steps, health check, rollback |
| Audit | Append-only records for important actions and transitions |
| Docker | The only code allowed to call the local Docker Engine |
| Realtime | Socket.IO notifications emitted after successful commits |

Rules:

- Express route handlers validate input, authenticate, call a service, and format output; they do not contain recovery logic.
- Services enforce project ownership and state-transition guards.
- Only the Docker module imports the Docker client library once one is selected.
- Only the diagnosis module knows which provider is configured.
- The recovery module accepts only typed, validated actions.
- Socket.IO payloads contain presentation-safe IDs/state summaries, not raw evidence or secrets.

## 4. Frontend structure

The Next.js application needs these MVP screens:

- JWT login;
- project list and project registration/edit form;
- project health view;
- incident list;
- incident detail showing evidence, diagnosis, proposed plan, verification, approval, recovery, rollback, and audit timeline;
- approval action with target, action diff, risk, verification result, and rollback capability clearly visible.

The browser calls the Express API for data and commands. It uses Socket.IO to refresh visible incident/project data when events arrive. The client never treats a socket event as authoritative and never carries recovery authority.

## 5. Minimal database model

Use UUID primary keys, `timestamptz`, database foreign keys, and Prisma transactions. Core statuses should be database enums or validated strings with exhaustive TypeScript handling. JSON fields are appropriate for typed snapshots and evidence details; ownership and workflow state remain relational columns.

### `User`

- `id`
- `email` (unique)
- `passwordHash` or external identity reference, depending on the JWT issuance approach selected during Phase 1
- timestamps

### `Project`

- `id`, `userId`
- `name`
- registered container name/ID selector
- expected image/configuration metadata
- health-check URL or port configuration
- monitoring interval/thresholds
- `monitoringEnabled`, `nextCheckAt`, `lastCheckedAt`
- timestamps

Every project query includes `userId`. There is no `Workspace`, `Organization`, `Membership`, `Role`, or tenant hierarchy.

### `Deployment`

- `id`, `projectId`, registered container name, image reference
- `isCurrent` lifecycle marker
- latest normalized container/health state, status code, failure count, and check timestamp
- timestamps

The MVP permits at most one current deployment per project, enforced by a partial unique database index. Registering a replacement atomically makes the previous current deployment historical. Project-level health-check configuration applies only to the current deployment, and historical deployments are never selected or updated by monitoring. Phase 2 stores only the latest bounded observation fields on the deployment; historical evidence collection remains a later phase.

### `Incident`

- `id`, `projectId`, type, state, severity
- stable fingerprint
- first/last detected timestamps and occurrence count
- `version` for guarded concurrent updates
- resolution fields

A database uniqueness rule should prevent more than one open incident with the same project/type/fingerprint if Prisma migration support permits the required partial index. Otherwise, enforce it with a transaction plus integration tests.

### `Evidence`

- `id`, `incidentId`, kind, source
- sanitized `content` as bounded text or JSON
- byte count, truncation flag, SHA-256 digest
- collection timestamp

Evidence is immutable after insertion. Define per-item and per-incident limits in configuration.

### `Diagnosis`

- `id`, `incidentId`
- provider name/version (`MockDiagnosisProvider` initially)
- root-cause code, summary, confidence, evidence references
- structured provider result and timestamps

### `RecoveryPlan`

- `id`, `incidentId`, version
- typed actions JSON and human-readable summary
- rollback description/support flag
- target snapshot hash and canonical plan hash
- created timestamp

### `VerificationRun`

- `id`, `recoveryPlanId`, state
- plan and target hashes
- sandbox identity, structured check results, bounded output
- cleanup result, started/completed/expiry timestamps

### `Approval`

- `id`, `recoveryPlanId`, `userId`
- decision and optional reason
- verified plan hash and target snapshot hash
- decision/expiry timestamps

Approval records are not updated to point at a changed plan. A changed plan requires a new verification and approval.

### `RecoveryAttempt` and `RecoveryStep`

- attempt links incident, plan, and approval;
- attempt stores lifecycle state, unique idempotency key, pre-change snapshot, result/error, timestamps;
- steps store order, typed action, step state, stable idempotency key, observed before/after values, result/error.

A uniqueness constraint permits only one active recovery attempt per project. A PostgreSQL advisory lock scoped to `projectId` is held while production recovery executes because duplicate production mutation is a demonstrated safety risk.

### `AuditEvent`

- `id`, `userId` where applicable, `projectId` where applicable
- action, resource type/ID, outcome
- sanitized details JSON
- request/correlation ID and timestamp

Audit rows are append-only by application convention and are never cascaded away with projects or incidents. Hash chains, immutable external exports, and separate audit infrastructure are not MVP requirements.

## 6. Monitoring architecture

The Express process runs a small polling loop:

1. Query enabled projects whose `nextCheckAt` is due.
2. Atomically advance `nextCheckAt` before starting the check so overlapping timer ticks do not duplicate it.
3. Call read-only methods on the Docker adapter and optional registered health probe.
4. Store an observation and update/create the matching incident in a transaction.
5. Start evidence/diagnosis processing only when the incident transition guard permits it.

The hackathon deployment runs one backend instance. On startup, it queries incidents in nonterminal states and safely resumes only operations whose persisted state makes resumption unambiguous. Uncertain recovery steps are inspected against actual Docker state and never replayed blindly.

Do not build a job table, leases, retry scheduler, or worker framework initially. A small bounded retry helper is sufficient for read-only transient operations. Add a lease or dedicated worker only if tests demonstrate overlapping work or event-loop responsiveness problems.

## 7. Diagnosis provider

The provider abstraction is required because Gemini is explicitly planned later, but it remains narrow:

```ts
interface DiagnosisProvider {
  diagnose(input: SanitizedDiagnosisInput): Promise<DiagnosisResult>;
}
```

`MockDiagnosisProvider` maps deterministic evidence signals for the five incident types to structured root-cause codes and typed proposal templates. Unknown/conflicting evidence returns `INSUFFICIENT_EVIDENCE`. It has no Docker object, executor callback, credentials, or arbitrary tool access.

Provider results are validated before persistence. Gemini can later implement the same interface without changing approval or recovery.

Phase 4 processes `DIAGNOSING` incidents with a separate non-overlapping in-process scheduler. An optimistic `diagnosisClaimedAt`/Incident-version lease provides immediate atomic claiming and bounded reclamation after interruption. Provider input contains at most 32 persisted evidence items and 384 KB of re-sanitized content. Success creates the single Diagnosis and transitions to `FIX_PROPOSED` in one transaction; provider, schema, or evidence-reference failure transitions to `DIAGNOSIS_FAILED`. A stale worker cannot persist after its version is reclaimed.

The deterministic mock precedence is explicit and stable:

1. missing or invalid environment/configuration;
2. port configuration failure;
3. database connection failure;
4. container/application crash;
5. generic health-check failure;
6. insufficient evidence.

Concrete persisted signals therefore override generic health failure. Incomplete or input-truncated evidence reduces confidence and recommends manual investigation. Provider output uses a strict runtime schema, references IncidentEvidence IDs rather than copying evidence, and can propose only the existing remediation categories. These suggestions do not create a RemediationPlan and cannot execute anything.

### Phase 5 remediation planning

The remediation-planning module consumes only the persisted validated Diagnosis. A deterministic builder validates the suggestion again, resolves targets through trusted Incident/Project/Deployment relations, and either produces one typed plan or records a bounded non-actionable code on the Diagnosis. Manual-investigation and missing-detail diagnoses do not fabricate plans. The Incident remains `FIX_PROPOSED`.

The allowed planning types are `RESTART_CONTAINER`, `ROLLBACK_DEPLOYMENT`, `UPDATE_ALLOWED_ENV`, and `PATCH_APPLICATION_FILE`. Restart always targets the Incident Deployment. Rollback selects or validates an older same-Project historical Deployment. Deployment baselines include stable identity, image, safe configuration digest, creation time, and current/historical lifecycle status; the monitoring-driven `updatedAt` timestamp is deliberately excluded to avoid false drift. Environment updates use a server-owned non-secret name/value allow-list and capture safe expected values from the registered configuration snapshot. Patch planning performs no filesystem access: paths must be relative entries in a trusted application-file manifest, symlinks/protected/generated/binary entries are rejected, and original content must match the registered SHA-256 baseline before a bounded structured replacement and unified diff can be stored.

Every plan stores its Diagnosis, Project, Incident, and affected Deployment IDs with composite foreign keys, action-type identity, the exact typed action, a trusted baseline, a target snapshot hash, review summary, rollback semantics, and a canonical plan hash. The baseline also binds the Project health path and container port plus a safe digest of registered verification-source behavior (file identities, Dockerfile path, allow-listed environment, trusted test configuration, and isolated-dependency requirement). Canonical JSON recursively sorts object keys with locale-independent ordinal comparison and preserves meaningful array order. SHA-256 covers every stored field that can affect verification, approval, or recovery: schema/version, immutable IDs, action types and exact actions, evidence references, diagnosis-result hash, target baseline, target snapshot hash, summary, and rollback fields. Only the plan record ID and volatile creation timestamp are excluded. Persistence validates the digest again before inserting the plan. The database rejects every update to a persisted RemediationPlan; changed input requires a new plan. A unique Diagnosis-to-plan relationship plus the Incident version guard gives concurrent creation one winner without a planning lease. Plan persistence, Diagnosis disposition, Incident version increment, and audit creation commit in one transaction.

## 8. Docker abstraction

The Express backend connects to the local Docker Engine. All access is centralized behind a small interface with separate read, sandbox, and production methods:

```ts
interface DockerService {
  inspectRegisteredContainer(project: ProjectTarget): Promise<ContainerSnapshot>;
  readBoundedLogs(project: ProjectTarget, limits: LogLimits): Promise<SanitizedLogSlice>;
  createVerificationSandbox(spec: SandboxSpec): Promise<SandboxHandle>;
  runVerification(handle: SandboxHandle, plan: TypedRecoveryPlan): Promise<CheckResult[]>;
  removeVerificationSandbox(handle: SandboxHandle): Promise<void>;
  applyApprovedAction(target: ProjectTarget, action: AllowedRecoveryAction): Promise<ActionResult>;
  inspectRecoveryResult(target: ProjectTarget): Promise<ContainerSnapshot>;
  rollback(target: ProjectTarget, snapshot: RecoverySnapshot): Promise<RollbackResult>;
}
```

Implementation rules:

- Resolve only the container registered to the authenticated user's project.
- Use Docker API calls, not shell command construction.
- Bound calls with timeouts and log/output limits.
- Never expose the Docker service to the browser or diagnosis provider.
- Never mount the Docker socket into monitored or verification containers.
- Reject arbitrary images, commands, privileged mode, devices, capabilities, host paths, and networks.
- Label temporary resources and clean them on success, failure, and startup reconciliation.
- Verification uses isolated networking and no production secrets.

Local Docker access remains highly privileged. For the hackathon, deployment instructions must state that SelfHeal should run only on a controlled developer host and monitor explicitly registered containers.

## 9. Evidence architecture

Collectors are simple functions selected by incident type. They collect container inspection data, bounded recent logs, Docker health output, registered-versus-observed port facts, required environment-key presence/format status, and configured dependency probe results.

Sanitization happens before the Prisma create call. It removes secret-like keys, credentials in URLs, authorization/cookie tokens, private keys, and configured patterns. Store only key presence and validation status for environment variables. Each item records its source, collection time, digest, byte count, and whether it was truncated.

Phase 3 uses a separate non-overlapping in-process scheduler. An atomic guarded transition claims `DETECTED` incidents as `COLLECTING_EVIDENCE`; persistence and the transition to `DIAGNOSING` commit together. A time-bounded optimistic lease lets the scheduler atomically reclaim interrupted collection without concurrent persistence. Collection always targets the Deployment linked on the Incident, even if that Deployment has since become historical. A unique `(incidentId, kind, source)` key and the Incident state/version guard prevent duplicate or stale evidence. Partial collector failures produce sanitized error and completeness records rather than discarding successful evidence. Expiry metadata supports the 30-day retention target; automatic deletion remains deferred operational work.

PostgreSQL is the only evidence store for the MVP. Object storage, evidence manifests, retention services, and generic collector frameworks are deferred until actual volume requires them.

## 10. Verification architecture

Phase 6 uses a separate non-overlapping scheduler. A transaction conditionally moves one actionable Incident from `FIX_PROPOSED` to `VERIFYING`, creates the plan's unique `VerificationRun`, and writes `VERIFICATION_STARTED`. A random claim token, Incident version, renewable bounded lease, and unique `remediationPlanId` prevent duplicate finalization; reclamation changes both token and Incident version so an old worker cannot persist.

The verifier reuses the Phase 5 canonical integrity validator before any workspace or Docker work, then recomputes the trusted target baseline, including the plan-bound health target and verification-source behavior. It creates a random directory beneath the operating-system SelfHeal verification temp root. Restart and environment candidates use the affected Deployment image; rollback uses the exact eligible older same-Project Deployment; patch candidates require bounded source content matching the registered application-file manifest and apply only the exact structured replacement in that temporary directory. Absolute/traversal paths, Windows alternate-data-stream or reserved-device paths, trailing-dot/space paths, reparse/symlink metadata, protected files, unregistered content, secrets, unsafe environment values, and unavailable trusted source fail closed.

Docker builds receive only the generated/trusted workspace file list, no build arguments, no build network, a unique tag, bounded timeout, and bounded sanitized output. Candidate containers use a unique internal network with no host port exposure, no privileged mode, no host namespaces or mounts, no Docker socket, all capabilities dropped, `no-new-privileges`, a read-only root filesystem, bounded temporary storage, CPU/memory/PID limits, and only allow-listed non-secret environment values. Database-dependent candidates fail unless an isolated dependency exists; Phase 6 does not provision one and never supplies a production database URL.

Only a trusted preconfigured exact-argument test command can run. No shell instruction comes from the Diagnosis or RemediationPlan. Tests are honestly `NOT_CONFIGURED` when absent. Docker deliberately does not publish ports from internal networks, so health uses a server-owned exact-argument Node probe inside the candidate. The probe fixes its target to `127.0.0.1` and the registered container port, validates the trusted Project path, never follows redirects, discards bodies, and enforces timeouts. Images without the trusted probe runtime fail safely; supporting a separate probe sidecar is deferred until a concrete non-Node application requires it.

The completion transaction reloads and revalidates the immutable plan, then stores structured gate results, bounded sanitized output, cleanup status, exact plan/target hashes and expiry, transitions to `AWAITING_APPROVAL` or `VERIFICATION_FAILED`, and writes its audit event. Container, network, image, and workspace cleanup is attempted independently after all outcomes. Per-run cleanup inspects both the exact SelfHeal ownership label and run label before deleting a resource. Before the first post-startup claim, the verifier reconciles only Docker resources carrying the exact managed SelfHeal verification label and `run-*` directories below its dedicated temp root; this recovers hard-process interruptions without a generic job engine. Cleanup failure, including failure while unwinding workspace preparation, is recorded; it does not falsify the check outcome, but later approval must require `cleanupSucceeded = true`. Phase 6 exposes no approval or production-recovery path.

## 11. Recovery architecture

Recovery is a small deterministic interpreter for the allow-listed action types.

Before the first Docker mutation it:

1. confirms JWT identity and project ownership;
2. loads the current incident, plan, successful verification, and approval;
3. verifies the plan/target hashes and expiry;
4. atomically changes the incident from `AWAITING_APPROVAL` to `RECOVERING`;
5. acquires a project-scoped PostgreSQL advisory lock;
6. re-inspects Docker state and aborts on drift;
7. stores a sufficient pre-change snapshot.

For each step it stores `STARTED`, calls the typed Docker method with a stable idempotency key/label where Docker supports it, inspects actual state, and stores `APPLIED`, `VERIFIED`, or `FAILED`. Following process interruption, `STARTED` means reconcile observed state before any retry.

After all steps, deterministic health checks and a short stability window must pass. On failure, rollback runs only when the plan declares and validates a feasible compensation. Rollback results are audited even when successful.

## 12. Realtime architecture

Socket.IO is attached to the Express HTTP server. After a successful database transaction, the application emits a small event such as `incident.updated`, `verification.completed`, or `recovery.updated` to a room scoped to the authenticated user/project.

There is intentionally no transactional outbox. A process crash can lose a realtime notification, not domain state. Clients refetch REST state when connecting, reconnecting, receiving an event, or while displaying an active recovery. Add an outbox only if a future requirement makes guaranteed event delivery necessary.

## 13. Concurrency and crash recovery

Use the least complex mechanism that protects the concrete race:

- Prisma transactions for related database writes and audit events;
- conditional state transitions and the incident `version` for monitor/user overlap;
- unique constraints for duplicate incidents and idempotency keys;
- one project-scoped PostgreSQL advisory lock for production recovery;
- persisted recovery step states plus Docker inspection after uncertain outcomes;
- startup cleanup of labeled verification resources and scan of nonterminal incidents.

No general leases or distributed workflow primitives are part of the MVP. Revisit only if the backend must run multiple instances or measured execution behavior requires it.

## 14. Testing focus

- state-transition and ownership unit tests;
- Prisma/PostgreSQL transaction, uniqueness, and concurrent-recovery integration tests;
- fixture containers for all five incident types;
- evidence sanitization and size-limit tests using seeded secrets;
- deterministic mock diagnosis tests;
- verification isolation and cleanup tests;
- exact-plan approval and stale-target rejection tests;
- process-interruption/idempotency tests around each recovery action;
- rollback success and rollback-failure tests;
- JWT route protection and cross-user project access tests;
- Socket.IO reconnect/refetch behavior.

## 15. Deferred extensions, not MVP abstractions

- Gemini provider;
- remote Docker hosts or a host agent;
- multiple backend replicas;
- external evidence storage;
- guaranteed event delivery/outbox;
- teams, roles, organizations, or enterprise audit export;
- additional orchestrators or a distributed queue.

These are documented extension points only. The MVP must not implement supporting infrastructure for them.
