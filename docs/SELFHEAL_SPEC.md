# SelfHeal MVP Specification

Status: Phase 0 approved architecture baseline  
Last updated: 2026-09-15  
Scope: one-month hackathon MVP; documentation only

## 1. Product definition

SelfHeal monitors Docker-deployed applications, detects supported failures, collects bounded diagnostic evidence, proposes a typed recovery plan, verifies that plan in isolation, requires the project owner to approve the exact verified plan, applies it through controlled Docker operations, verifies recovery, and rolls back where feasible.

AI is advisory. It never receives Docker access and cannot approve or execute production changes.

## 2. Repository assessment

The Phase 0 inspection found an empty Git repository with no commits or application files. There is no existing application code, deployment configuration, Docker integration, database, authentication, logging, monitoring, realtime implementation, or test suite to reuse or reconcile.

The project is therefore a greenfield implementation. The main architectural concern is keeping the first implementation small while establishing the safety boundaries that would be expensive to retrofit later.

## 3. Locked MVP technology decisions

| Area | Decision |
| --- | --- |
| Package manager | npm |
| Backend | Node.js, TypeScript, Express |
| Frontend | Next.js, TypeScript |
| Database | PostgreSQL with Prisma |
| Authentication | JWT-based authentication |
| Ownership | A `Project` belongs to one `User`; no organizations, workspaces, memberships, or enterprise tenancy |
| Docker | Express backend accesses the local Docker Engine only through a controlled Docker adapter |
| Realtime | Socket.IO; REST/database state remains authoritative |
| AI | `MockDiagnosisProvider` initially; Gemini is a later adapter |
| Evidence | Bounded and sanitized evidence stored in PostgreSQL |
| Approval | The authenticated project owner must approve the exact verified plan before recovery |

The MVP is a modular monolith. It does not use Kafka, Redis, Kubernetes, microservices, a generic workflow engine, or a transactional outbox.

## 4. MVP goals

1. Register a project representing one locally deployed Docker application.
2. Monitor its container and configured health endpoint.
3. Detect and deduplicate the five supported incident types.
4. Collect bounded, sanitized evidence into PostgreSQL.
5. Produce a deterministic mock diagnosis and typed recovery proposal.
6. Reject recovery actions outside the server-defined allow-list.
7. Verify the proposed plan in an isolated Docker container/network.
8. Require the project owner to approve the exact verified plan.
9. Revalidate the target immediately before recovery.
10. Apply idempotent recovery actions and check application health.
11. Roll back where the selected action supports it.
12. Record an append-only audit timeline.

## 5. Non-goals

- Kubernetes or non-Docker orchestrators.
- Remote Docker fleet management.
- Enterprise multi-tenancy, organizations, teams, invitations, or generic RBAC.
- Kafka, Redis, distributed scheduling, or a reusable workflow platform.
- Arbitrary shell commands, AI-generated scripts, autonomous code changes, or database migrations.
- A general observability/APM platform.
- Guaranteed rollback for actions that cannot be safely reversed.
- Gemini integration during the initial implementation.

## 6. Supported incident types

| Type | Detection signal | Minimum useful evidence |
| --- | --- | --- |
| `CONTAINER_CRASH` | Container exited, died, or repeatedly restarted | Inspect result, exit code, OOM flag, restart count, bounded logs, image ID |
| `HEALTH_CHECK_FAILURE` | Docker or configured HTTP health check fails past threshold | Health history, status/latency, bounded response excerpt, recent logs |
| `DATABASE_CONNECTION_FAILURE` | Known sanitized log signature or configured dependency probe fails | Error category, sanitized log excerpt, host reachability result, env-key presence |
| `MISSING_OR_INVALID_ENV` | Required key absent/empty or fails registered format rule | Key names and validation results only; never values |
| `PORT_CONFIGURATION_FAILURE` | Expected/exposed/bound ports disagree or listener is unavailable | Expected port, Docker port mapping, probe target, sanitized bind-error logs |

## 7. End-to-end flow

1. A simple in-process monitor loop checks due projects.
2. A deterministic detector records or updates an incident using a stable fingerprint.
3. The backend collects incident-specific evidence, sanitizes it before persistence, and enforces byte/line limits.
4. `MockDiagnosisProvider` returns a structured diagnosis and proposed actions.
5. The backend validates the proposal against a typed server-side allow-list.
6. The verifier recreates the relevant conditions in an isolated Docker sandbox and runs deterministic checks.
7. On success, SelfHeal stores the plan hash, target snapshot hash, verification result, and expiry.
8. The project owner reviews and approves that exact plan.
9. Recovery rechecks ownership, approval, hashes, expiry, target identity, and current Docker state.
10. The recovery service records pre-change state, applies actions one at a time, and persists each result.
11. Health checks confirm recovery. A failure invokes the documented rollback action where feasible.
12. Each state change, approval, Docker mutation, verification result, and rollback result is written to the audit history.

## 8. Safety invariants

- Only the authenticated owner can read or mutate a project and its incidents.
- No production recovery runs without a successful verification and explicit approval.
- Approval binds to the current plan hash and target snapshot hash. Any change invalidates it.
- AI output is untrusted until schema and allow-list validation succeeds.
- Recovery executes typed actions, never provider prose or arbitrary shell commands.
- Evidence is sanitized before storage and is size bounded.
- Verification uses no production secrets, production database connection, host mounts, or Docker socket mount.
- Recovery revalidates current Docker state before the first mutation.
- Recovery steps use stable idempotency keys and persisted results.
- One incident and one project cannot have two active recovery attempts.
- Audit records are created in the same database transaction as the corresponding state change where possible.
- Missed Socket.IO messages never affect correctness; the client refetches current REST state.

## 9. Incident state machine

Primary lifecycle:

```text
DETECTED
  -> COLLECTING_EVIDENCE
  -> DIAGNOSING
  -> FIX_PROPOSED
  -> VERIFYING
  -> AWAITING_APPROVAL
  -> RECOVERING
  -> RESOLVED
```

Failure states are `DIAGNOSIS_FAILED`, `VERIFICATION_FAILED`, and `RECOVERY_FAILED`.

| From | To | Guard |
| --- | --- | --- |
| `DETECTED` | `COLLECTING_EVIDENCE` | Collection has started for this incident. |
| `COLLECTING_EVIDENCE` | `DIAGNOSING` | A sanitized evidence bundle is complete. |
| `COLLECTING_EVIDENCE` | `DIAGNOSIS_FAILED` | Required evidence could not be obtained after bounded retry. |
| `DIAGNOSING` | `FIX_PROPOSED` | Diagnosis and proposal pass validation. |
| `DIAGNOSING` | `DIAGNOSIS_FAILED` | Provider or proposal validation fails. |
| `FIX_PROPOSED` | `VERIFYING` | Verification starts for the current plan hash. |
| `VERIFYING` | `AWAITING_APPROVAL` | Verification passes and its result is stored. |
| `VERIFYING` | `VERIFICATION_FAILED` | Sandbox preparation, action, check, or cleanup fails. |
| `AWAITING_APPROVAL` | `RECOVERING` | Owner approval, plan hash, target hash, and expiry are valid. |
| `AWAITING_APPROVAL` | `FIX_PROPOSED` | Plan is rejected, changed, or expires. |
| `RECOVERING` | `RESOLVED` | Recovery and stability checks succeed. |
| `RECOVERING` | `RECOVERY_FAILED` | Recovery or rollback does not produce a healthy target. |
| `DIAGNOSIS_FAILED` | `COLLECTING_EVIDENCE` | Owner requests a new evidence attempt. |
| `VERIFICATION_FAILED` | `FIX_PROPOSED` | A new proposal is created. |
| `RECOVERY_FAILED` | `COLLECTING_EVIDENCE` | Owner begins a new attempt from fresh evidence. |

Transitions use explicit service-layer guards and conditional database updates. Optimistic concurrency is added to the incident row because the monitor loop and owner actions can overlap. No generic state-machine or workflow infrastructure is required.

## 10. Verification lifecycle

```text
PENDING -> PREPARING -> RUNNING -> PASSED
                              \-> FAILED
```

The verification record stores its plan hash, target snapshot hash, sandbox/container ID, check results, bounded output, timestamps, and cleanup result. A pass is approvable only if cleanup succeeded and the verification has not expired.

Verification failure is safe: it changes no production resource and cannot be approved.

## 11. Recovery lifecycle

```text
PENDING -> REVALIDATING -> APPLYING -> HEALTH_CHECKING -> SUCCEEDED
                              |              |
                              +-------> ROLLING_BACK -> ROLLED_BACK
                                                   \-> ROLLBACK_FAILED
```

An invalid or stale approval ends as `ABORTED` before mutation. A rolled-back attempt still maps the incident to `RECOVERY_FAILED` because the proposed recovery did not resolve it.

The demonstrated concurrency risk is two requests recovering the same project. The MVP handles this with a conditional database transition and a short PostgreSQL advisory lock scoped to the project during production recovery. General monitoring and diagnosis use normal transactions and state guards without leases unless testing demonstrates a real need.

## 12. Typed recovery plan

A plan contains:

- diagnosis summary and supporting evidence IDs;
- ordered typed actions and their validated parameters;
- preconditions and expected postconditions;
- deterministic verification checks;
- rollback description and whether rollback is supported;
- risk summary;
- schema version and canonical plan hash.

The initial executable allow-list should be deliberately small:

- `RESTART_CONTAINER`: restart the registered container;
- `RECREATE_CONTAINER`: recreate it from the registered image/configuration snapshot, only when rollback inputs are complete;
- `RUN_HEALTH_CHECK`: read-only verification action.

Environment and port corrections may be proposed as advisory instructions until the MVP has a trustworthy desired-configuration source. Arbitrary images, commands, mounts, networks, privileged mode, Docker socket mounts, and secret values are prohibited.

## 13. Definition of Phase 0 completion

- The technology stack and ownership model are locked.
- State transitions and recovery safety properties are explicit.
- The storage model is small enough for the hackathon.
- No speculative distributed infrastructure is part of the MVP.
- Remaining open values can be selected during implementation without changing the architecture.
- No application code or dependency has been added.
