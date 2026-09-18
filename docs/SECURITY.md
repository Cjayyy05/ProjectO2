# SelfHeal MVP Security Model

Status: approved Phase 0 security baseline  
Last updated: 2026-09-15

## 1. Core rule

AI recommends; deterministic code validates and verifies; the authenticated project owner approves; only the controlled Docker adapter executes.

SelfHeal has powerful local Docker access, so a small MVP still requires hard boundaries around identity, evidence, verification, approval, and recovery. Enterprise identity, tenancy, policy engines, and audit infrastructure are not required.

## 2. Trust boundaries

| Boundary | MVP controls |
| --- | --- |
| Browser to Express API | HTTPS outside local development, JWT verification, project ownership check, input validation, request limits |
| User to another user's project | Every project-scoped query/mutation filters by both project ID and JWT user ID |
| Backend to PostgreSQL | Prisma parameterization, transactions, foreign keys, unique constraints, least-privileged database credentials |
| Backend to local Docker Engine | One controlled adapter, registered container targets, typed calls, timeouts, no shell construction |
| Evidence to PostgreSQL/UI | Sanitize before storage, enforce size limits, avoid raw secret values |
| Evidence to diagnosis provider | Send only sanitized structured evidence; treat logs as untrusted data |
| Verification sandbox to host/production | No Docker socket, privileged mode, production secrets/database, or uncontrolled host mounts/networks |
| Approved plan to production recovery | Plan/target hashes, owner approval, expiry, target revalidation, state guard, project recovery lock |
| Socket.IO to browser | Authenticate connection, scope rooms to owner/project, send summaries only; REST remains authoritative |

Local Docker Engine access is root-equivalent in practice. The MVP is suitable for a controlled hackathon/developer host, not an untrusted shared Docker host.

## 3. JWT authentication and ownership

- JWTs identify one `User` by a stable subject/user ID.
- Tokens have an expiry and are verified with a server-held signing key.
- Passwords, if locally issued credentials are chosen, are stored only as strong password hashes.
- JWTs are never logged or included in audit details.
- All project resources are loaded through ownership-aware queries such as `(projectId, userId)`.
- Socket.IO authenticates the JWT during connection and rechecks ownership when joining a project room.
- Logout/revocation sophistication can remain minimal for the hackathon, but short token lifetime and secure storage are required.

There is no MVP role model. The owner can configure, verify, approve, and recover their project. Human approval remains a distinct explicit action even when the same owner initiated diagnosis.

## 4. Exact-plan approval

Approval stores and binds:

- project, incident, and recovery-plan IDs;
- authenticated owner's user ID;
- canonical plan hash;
- target snapshot hash;
- successful verification ID/result;
- decision time and expiry.

Any plan change, target drift, expired verification, or different user invalidates the approval. Immediately before recovery, the backend reloads these records and re-inspects Docker state. It aborts before mutation if anything differs.

The UI must show the exact target, typed actions, expected effect, risk, verification result, and rollback capability. Approval is never implicit or preselected.

## 5. AI boundary

`MockDiagnosisProvider`, and Gemini later, receive only bounded sanitized evidence and registered non-secret expectations. Providers receive no Docker client, recovery function, JWT, database credentials, or general tool access.

Provider output is untrusted. The backend validates it against a strict schema and the server-owned action allow-list. Provider prose is never inserted into a shell command, SQL, Docker API path, URL, or configuration template. Unsupported or uncertain output produces `DIAGNOSIS_FAILED` or an insufficient-evidence result.

Phase 5 adds a second deterministic trust boundary before a suggestion becomes a RemediationPlan. The planning builder has no Docker or filesystem capability. It derives restart targets from the Incident, validates rollback targets through same-Project history, rejects credential-shaped Deployment image identities, accepts only five explicitly non-secret environment keys with narrow value rules, and requires patch paths/hashes to match a trusted Deployment manifest. It stores structured data only; command fields, arbitrary Docker arguments, absolute/traversal paths, symlinks, protected/generated/binary files, secret-bearing patch content, and unbounded payloads are rejected. The persistence boundary revalidates plan structure, target consistency, and the canonical digest; digest mismatch becomes a bounded non-actionable disposition. Plan creation does not execute or verify the action.

Phase 6 is the first execution boundary, but execution is limited to disposable verification resources. It recomputes the canonical plan digest and baseline before staging; Project health configuration and every registered verification behavior are bound to that baseline, and persisted plans are database-immutable. Application source and Docker build output remain untrusted: source is bounded, manifest-bound, secret-scanned, and written beneath a random temp root; patch paths are resolved again and checked against Windows device/alternate-stream syntax and symlink/reparse metadata; build and runtime output are sanitized and byte bounded. Unsafe source is represented only by a constant fail-closed marker rather than a secret-derived digest. The Docker adapter accepts a server-owned sandbox specification rather than plan-supplied flags. It hard-codes an internal network with no host port publishing, zero host mounts, no Docker socket, no privilege, dropped capabilities, read-only root, resource bounds, and a non-restarting container. Build networking is disabled. Health is checked by server-owned exact-argument code against only the plan-bound candidate port on its own loopback interface.

The only allowed test execution is an operator-registered exact argument array from the trusted Deployment snapshot. Provider prose, RemediationPlan reason text, and patch content are never interpreted as commands. Verification never receives `DATABASE_URL`, JWT/provider credentials, cookies, production environment values, or ambient HTTP credentials. A candidate declaring a database dependency fails closed until a disposable dependency implementation exists. Cleanup failures are sanitized, isolated, audited, and make the result non-approvable in the later approval phase.

Gemini requires a later review of data handling, redaction, credentials, structured output, prompt injection, timeouts, and cost. That adapter must not change the approval or recovery boundary.

## 6. Evidence and secret handling

- Capture only the recent lines/bytes needed for the incident.
- Sanitize before writing to PostgreSQL, logs, Socket.IO, or provider input.
- Remove authorization headers, cookies, tokens, connection-string passwords, private keys, and configured secret patterns.
- Store environment key name, presence, and validation status—not the value.
- Record truncation and collection failure explicitly so missing evidence is not mistaken for absence of a problem.
- Do not keep an unredacted backup.
- Do not log request bodies for evidence or authentication endpoints.
- Use a simple configurable retention period; cleanup can be a direct scheduled database deletion while preserving audit metadata.

## 7. Docker safety

- Only the Docker module accesses the local engine.
- Resolve targets from the authenticated user's registered project, not from arbitrary action parameters.
- Use Docker API methods rather than generated shell commands.
- Allow only typed recovery actions and server-validated parameters.
- Do not permit arbitrary images, entrypoints, commands, host paths, devices, capabilities, privileged mode, or Docker socket mounts.
- Apply timeouts and output limits.
- Label verification images, containers, and networks with exact managed and run ownership labels; verify both labels before per-run deletion and use the exact managed label for startup reconciliation.
- Verification containers use isolated networking and no production credentials.
- Capture current Docker state immediately before mutation and abort on drift.

The Docker endpoint/socket and its credentials must never be reachable from the Next.js frontend or verification containers.

## 8. Recovery safety

- Successful isolated verification is mandatory.
- Explicit owner approval of the exact plan is mandatory.
- A guarded database transition and project-scoped PostgreSQL advisory lock prevent overlapping recoveries.
- Recovery steps have stable idempotency keys and persisted states.
- A step left `STARTED` after interruption is reconciled against Docker state before retry.
- Deterministic health checks, not AI judgment, decide success.
- Rollback executes only when the action has a validated compensation and complete pre-change snapshot.
- Rollback failure stops automation and requires manual intervention.
- Every approval, attempted action, result, and rollback is audited.

## 9. Health-probe safety

Configured health URLs can create SSRF risk. For the MVP:

- accept only `http`/`https` health URLs associated with the registered local application;
- reject cloud metadata, Docker control, file, and unsupported schemes;
- restrict redirects, response size, and timeout;
- do not attach ambient credentials;
- sanitize response excerpts before storage.

If arbitrary URL registration cannot be safely constrained during implementation, support container/Docker health status and registered localhost ports first.

## 10. Audit history

`AuditEvent` is an append-only application table. Record:

- login failures and significant authentication events;
- project and monitor configuration changes;
- incident transitions and retry requests;
- evidence collection outcomes;
- diagnosis and proposal creation;
- verification and sandbox cleanup results;
- approval/rejection;
- recovery precondition checks, actions, health results, and rollback;
- ownership failures on sensitive commands.

Create the audit record in the same Prisma transaction as its domain change where possible. Audit details are sanitized summaries and identifiers, not tokens, passwords, or full evidence bodies. The MVP does not require hash chaining, a separate audit service, or immutable external export.

## 11. MVP security tests and launch gates

Production recovery remains disabled until tests demonstrate:

- invalid/expired JWT rejection and cross-user isolation;
- evidence redaction and size limits using seeded secrets;
- malicious logs/provider output cannot create unsupported actions;
- verification cannot access Docker socket or configured production dependencies;
- stale, changed, expired, or unverified plans cannot be approved/recovered;
- concurrent recovery requests result in one executor;
- interrupted recovery steps reconcile without blind replay;
- recovery failure exercises rollback or clearly reports that rollback is unsupported;
- audit rows exist for every privileged path.

These are safety gates, not an enterprise compliance program.
