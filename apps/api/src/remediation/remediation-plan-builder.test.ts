import { describe, expect, it } from "vitest";
import { sha256Text } from "./canonical-hash";
import { RemediationPlanBuilder } from "./remediation-plan-builder";
import {
  computeRemediationPlanHash,
  validateRemediationPlanIntegrity
} from "./remediation-validation";
import type {
  PlanningDeployment,
  RemediationPlanDraft,
  RemediationPlanningCandidate
} from "./remediation-types";

const builder = new RemediationPlanBuilder();
const projectId = uuid(1);
const incidentId = uuid(2);
const diagnosisId = uuid(3);
const affectedId = uuid(4);
const historicalId = uuid(5);

describe("RemediationPlanBuilder", () => {
  it("creates a restart plan resolved only from the Incident Deployment", () => {
    const decision = builder.build(candidate(restartSuggestion()));
    expect(decision).toMatchObject({
      kind: "PLAN",
      plan: {
        incidentId,
        diagnosisId,
        projectId,
        deploymentId: affectedId,
        actions: [{ type: "RESTART_CONTAINER", deploymentId: affectedId }]
      }
    });
  });

  it("re-sanitizes provider prose before it can enter a plan", () => {
    const decision = builder.build(candidate(suggestion({
      type: "RESTART_CONTAINER",
      reason: "PASSWORD=provider-secret"
    })));
    expect(JSON.stringify(decision)).not.toContain("provider-secret");
    expect(JSON.stringify(decision)).toContain("REDACTED");
  });

  it("rejects provider-supplied restart targets and commands", () => {
    const result = restartSuggestion() as Record<string, unknown>;
    result.proposedRemediation = {
      type: "RESTART_CONTAINER",
      reason: "restart",
      deploymentId: uuid(90),
      command: "docker restart arbitrary"
    };
    expect(builder.build(candidate(result))).toEqual({
      kind: "NOT_ACTIONABLE",
      code: "INVALID_DIAGNOSIS_RESULT"
    });
  });

  it("requires an Incident Deployment", () => {
    expect(builder.build({ ...candidate(restartSuggestion()), affectedDeployment: null })).toEqual({
      kind: "NOT_ACTIONABLE",
      code: "INCIDENT_DEPLOYMENT_REQUIRED"
    });
  });

  it("rejects a cross-Project Incident Deployment", () => {
    const base = candidate(restartSuggestion());
    expect(builder.build({
      ...base,
      affectedDeployment: { ...base.affectedDeployment!, projectId: uuid(99) }
    })).toEqual({
      kind: "NOT_ACTIONABLE",
      code: "INCIDENT_DEPLOYMENT_MISMATCH"
    });
  });

  it("rejects credential-shaped Deployment image identities before baseline persistence", () => {
    const base = candidate(restartSuggestion());
    const decision = builder.build({
      ...base,
      affectedDeployment: {
        ...base.affectedDeployment!,
        imageReference: "user:registry-secret@registry.example/app:current"
      }
    });

    expect(decision).toEqual({ kind: "NOT_ACTIONABLE", code: "UNSAFE_DEPLOYMENT_IDENTITY" });
    expect(JSON.stringify(decision)).not.toContain("registry-secret");
  });

  it("allows credential-free registry ports and digest image references", () => {
    const base = candidate(restartSuggestion());
    expect(builder.build({
      ...base,
      affectedDeployment: {
        ...base.affectedDeployment!,
        imageReference: `registry.example:5000/app@sha256:${"a".repeat(64)}`
      }
    }).kind).toBe("PLAN");
  });

  it("creates rollback only to an eligible same-Project historical Deployment", () => {
    const decision = builder.build(candidate(suggestion({
      type: "ROLLBACK_DEPLOYMENT",
      targetDeploymentId: historicalId,
      reason: "Use the known previous deployment."
    })));
    expect(decision).toMatchObject({
      kind: "PLAN",
      plan: { actions: [{
        type: "ROLLBACK_DEPLOYMENT",
        affectedDeploymentId: affectedId,
        targetDeploymentId: historicalId
      }] }
    });
  });

  it("rejects an arbitrary or cross-Project rollback target", () => {
    expect(builder.build(candidate(suggestion({
      type: "ROLLBACK_DEPLOYMENT",
      targetDeploymentId: uuid(99),
      reason: "rollback"
    })))).toEqual({ kind: "NOT_ACTIONABLE", code: "INVALID_ROLLBACK_TARGET" });
  });

  it("rejects a historical rollback target with a credential-shaped image identity", () => {
    const base = candidate(suggestion({
      type: "ROLLBACK_DEPLOYMENT",
      targetDeploymentId: historicalId,
      reason: "rollback"
    }));
    expect(builder.build({
      ...base,
      projectDeployments: base.projectDeployments.map((deploymentValue) =>
        deploymentValue.id === historicalId
          ? { ...deploymentValue, imageReference: "user:registry-secret@registry.example/app:old" }
          : deploymentValue)
    })).toEqual({ kind: "NOT_ACTIONABLE", code: "INVALID_ROLLBACK_TARGET" });
  });

  it("handles a missing rollback target without fabricating one", () => {
    const base = candidate(suggestion({ type: "ROLLBACK_DEPLOYMENT", reason: "rollback" }));
    expect(builder.build({ ...base, projectDeployments: [base.affectedDeployment!] })).toEqual({
      kind: "NOT_ACTIONABLE",
      code: "ROLLBACK_TARGET_UNAVAILABLE"
    });
  });

  it("creates a bounded allow-listed environment plan with its safe baseline", () => {
    const decision = builder.build(candidate(suggestion({
      type: "UPDATE_ALLOWED_ENV",
      variableNames: ["LOG_LEVEL", "PORT"],
      changes: [
        { name: "PORT", proposedValue: "8080" },
        { name: "LOG_LEVEL", proposedValue: "debug" }
      ],
      reason: "Align non-secret runtime configuration."
    })));
    expect(decision).toMatchObject({
      kind: "PLAN",
      plan: { actions: [{
        type: "UPDATE_ALLOWED_ENV",
        deploymentId: affectedId,
        changes: [
          { name: "LOG_LEVEL", expectedValue: "info", proposedValue: "debug" },
          { name: "PORT", expectedValue: "3000", proposedValue: "8080" }
        ]
      }] }
    });
  });

  it.each(["PASSWORD", "DATABASE_URL", "JWT_SECRET", "API_KEY"])(
    "rejects sensitive environment variable %s",
    (name) => {
      expect(builder.build(candidate(suggestion({
        type: "UPDATE_ALLOWED_ENV",
        variableNames: [name],
        changes: [{ name, proposedValue: "not-persisted" }],
        reason: "unsafe"
      })))).toEqual({ kind: "NOT_ACTIONABLE", code: "SENSITIVE_ENVIRONMENT_VARIABLE" });
    }
  );

  it("rejects an unknown environment variable", () => {
    expect(builder.build(candidate(suggestion({
      type: "UPDATE_ALLOWED_ENV",
      variableNames: ["CUSTOM_SETTING"],
      changes: [{ name: "CUSTOM_SETTING", proposedValue: "value" }],
      reason: "unknown"
    })))).toEqual({ kind: "NOT_ACTIONABLE", code: "ENVIRONMENT_VARIABLE_NOT_ALLOWED" });
  });

  it("rejects invalid or missing environment values", () => {
    expect(builder.build(candidate(suggestion({
      type: "UPDATE_ALLOWED_ENV",
      variableNames: ["PORT"],
      changes: [{ name: "PORT", proposedValue: "9999" }],
      reason: "wrong port"
    })))).toEqual({ kind: "NOT_ACTIONABLE", code: "INVALID_ENVIRONMENT_VALUE" });
    expect(builder.build(candidate(suggestion({
      type: "UPDATE_ALLOWED_ENV",
      variableNames: ["LOG_LEVEL"],
      reason: "missing value"
    })))).toEqual({ kind: "NOT_ACTIONABLE", code: "ENVIRONMENT_CHANGE_REQUIRED" });
  });

  it("rejects an unsafe existing value instead of persisting it as an environment baseline", () => {
    const base = candidate(suggestion({
      type: "UPDATE_ALLOWED_ENV",
      variableNames: ["LOG_LEVEL"],
      changes: [{ name: "LOG_LEVEL", proposedValue: "debug" }],
      reason: "Align logging."
    }));
    const input = {
      ...base,
      affectedDeployment: {
        ...base.affectedDeployment!,
        configurationSnapshot: { safeEnvironment: { LOG_LEVEL: "provider-secret-value" } }
      }
    };

    expect(builder.build(input)).toEqual({
      kind: "NOT_ACTIONABLE",
      code: "INVALID_ENVIRONMENT_VALUE"
    });
  });

  it("rejects oversized environment parameters through the strict diagnosis schema", () => {
    expect(builder.build(candidate(suggestion({
      type: "UPDATE_ALLOWED_ENV",
      variableNames: [`A${"B".repeat(128)}`],
      changes: [{ name: "LOG_LEVEL", proposedValue: "x".repeat(257) }],
      reason: "oversized"
    })))).toEqual({ kind: "NOT_ACTIONABLE", code: "INVALID_DIAGNOSIS_RESULT" });
  });

  it("creates a structured patch and human-readable unified diff", () => {
    const original = "export const port = 3000;\n";
    const replacement = "export const port = 8080;\n";
    const decision = builder.build(candidate(patchSuggestion("src/config.ts", original, replacement)));
    expect(decision).toMatchObject({
      kind: "PLAN",
      plan: { actions: [{
        type: "PATCH_APPLICATION_FILE",
        deploymentId: affectedId,
        files: [{
          relativePath: "src/config.ts",
          expectedContentHash: sha256Text(original),
          replacementContent: replacement
        }]
      }] }
    });
    if (decision.kind !== "PLAN") throw new Error("Expected a patch plan");
    expect(decision.plan).toMatchObject({ rollbackSupported: false, rollbackDescription: null });
    expect(decision.plan.actions[0]).toMatchObject({
      files: [expect.objectContaining({ unifiedDiff: expect.stringContaining("+++ b/src/config.ts") })]
    });
  });

  it.each([
    "/etc/passwd", "C:/Windows/system.ini", "../secret.ts", "src/../secret.ts", "src\\file.ts",
    "src/file.ts:secret", "src/CON.txt", "src/trailing."
  ])(
    "rejects unsafe patch path %s",
    (path) => {
      expect(builder.build(candidate(patchSuggestion(path, "old", "new")))).toEqual({
        kind: "NOT_ACTIONABLE",
        code: "INVALID_PATCH_PATH"
      });
    }
  );

  it.each([".env", ".env.production", "apps/api/src/server.ts", "node_modules/a.js", "dist/a.js", "package.json", "script.exe"])(
    "rejects protected/generated/SelfHeal/binary path %s",
    (path) => {
      const base = candidate(patchSuggestion(path, "old", "new"));
      const input = { ...base, affectedDeployment: deployment(affectedId, true, new Date("2026-09-18T00:00:00Z"), {
        safeEnvironment: {},
        applicationFiles: [{ relativePath: path, contentHash: sha256Text("old") }]
      }) };
      expect(builder.build(input)).toEqual({ kind: "NOT_ACTIONABLE", code: "PATCH_FILE_NOT_SAFE" });
    }
  );

  it("rejects an unregistered file and a symlink manifest entry", () => {
    expect(builder.build(candidate(patchSuggestion("src/other.ts", "old", "new")))).toEqual({
      kind: "NOT_ACTIONABLE",
      code: "PATCH_FILE_NOT_REGISTERED"
    });
    const base = candidate(patchSuggestion("src/config.ts", "old", "new"));
    const input = { ...base, affectedDeployment: deployment(affectedId, true, new Date("2026-09-18T00:00:00Z"), {
      applicationFiles: [{
        relativePath: "src/config.ts",
        contentHash: sha256Text("old"),
        symlink: true
      }]
    }) };
    expect(builder.build(input)).toEqual({ kind: "NOT_ACTIONABLE", code: "PATCH_FILE_NOT_SAFE" });
  });

  it("rejects patch baseline drift and secret-bearing content", () => {
    expect(builder.build(candidate(patchSuggestion(
      "src/config.ts",
      "unexpected baseline",
      "new"
    )))).toEqual({ kind: "NOT_ACTIONABLE", code: "PATCH_BASELINE_MISMATCH" });
    expect(builder.build(candidate(patchSuggestion(
      "src/config.ts",
      "export const port = 3000;\n",
      "PASSWORD=provider-secret"
    )))).toEqual({ kind: "NOT_ACTIONABLE", code: "PATCH_CONTAINS_SECRET" });
  });

  it("rejects an oversized aggregate patch and too many files", () => {
    const original = "é".repeat(32 * 1_024);
    const replacement = "b".repeat(32 * 1_024);
    const oversizedBase = candidate(patchSuggestion("src/config.ts", original, replacement));
    const oversized = { ...oversizedBase, affectedDeployment: deployment(affectedId, true, new Date("2026-09-18T00:00:00Z"), {
      applicationFiles: [{ relativePath: "src/config.ts", contentHash: sha256Text(original) }]
    }) };
    expect(builder.build(oversized)).toEqual({ kind: "NOT_ACTIONABLE", code: "PATCH_TOO_LARGE" });

    const tooMany = patchSuggestion("src/config.ts", "old", "new") as Record<string, unknown>;
    const proposed = tooMany.proposedRemediation as Record<string, unknown>;
    proposed.files = Array.from({ length: 5 }, (_value, index) => ({
      relativePath: `src/${index}.ts`,
      expectedContentHash: sha256Text("old"),
      originalContent: "old",
      replacementContent: "new"
    }));
    expect(builder.build(candidate(tooMany))).toEqual({
      kind: "NOT_ACTIONABLE",
      code: "INVALID_DIAGNOSIS_RESULT"
    });
  });

  it("caps generated unified diffs across all patch files", () => {
    const original = "a\n".repeat(4_096);
    const replacement = "b\n".repeat(4_096);
    const files = Array.from({ length: 4 }, (_value, index) => ({
      relativePath: `src/config-${index}.ts`,
      expectedContentHash: sha256Text(original),
      originalContent: original,
      replacementContent: replacement
    }));
    const base = candidate(suggestion({
      type: "PATCH_APPLICATION_FILE",
      advisoryDescription: "Change registered files.",
      files,
      reason: "Apply a bounded patch."
    }));
    const input = {
      ...base,
      affectedDeployment: deployment(
        affectedId,
        true,
        new Date("2026-09-18T00:00:00Z"),
        { applicationFiles: files.map((file) => ({
          relativePath: file.relativePath,
          contentHash: file.expectedContentHash
        })) }
      )
    };

    expect(builder.build(input)).toEqual({ kind: "NOT_ACTIONABLE", code: "PATCH_TOO_LARGE" });
  });

  it("produces deterministic hashes and excludes volatile execution time", () => {
    const first = builder.build(candidate(restartSuggestion()));
    const second = builder.build(candidate(restartSuggestion()));
    expect(first).toEqual(second);
  });

  it("excludes unknown and secret-bearing configuration fields from the target digest", () => {
    const clean = candidate(restartSuggestion());
    const withSecretBase = candidate(restartSuggestion());
    const cleanSnapshot = clean.affectedDeployment?.configurationSnapshot as Record<string, unknown>;
    const withSecret = {
      ...withSecretBase,
      affectedDeployment: {
        ...withSecretBase.affectedDeployment!,
        configurationSnapshot: {
          ...cleanSnapshot,
          DATABASE_URL: "postgresql://user:database-secret@example/db"
        }
      }
    };
    const first = builder.build(clean);
    const second = builder.build(withSecret);

    expect(hash(first, "targetSnapshotHash")).toBe(hash(second, "targetSnapshotHash"));
    expect(JSON.stringify(second)).not.toContain("database-secret");
  });

  it("changes hashes for actionable or target changes but ignores monitoring timestamps", () => {
    const first = builder.build(candidate(restartSuggestion()));
    const monitoringUpdateBase = candidate(restartSuggestion());
    const monitoringUpdate = {
      ...monitoringUpdateBase,
      affectedDeployment: {
        ...monitoringUpdateBase.affectedDeployment!,
        updatedAt: new Date("2026-09-18T00:02:00Z")
      }
    };
    const monitoringResult = builder.build(monitoringUpdate);
    expect(hash(first, "planHash")).toBe(hash(monitoringResult, "planHash"));
    expect(hash(first, "targetSnapshotHash")).toBe(hash(monitoringResult, "targetSnapshotHash"));

    const changedTargetBase = candidate(restartSuggestion());
    const changedTarget = builder.build({
      ...changedTargetBase,
      affectedDeployment: {
        ...changedTargetBase.affectedDeployment!,
        imageReference: "example/app:replacement"
      }
    });
    expect(hash(first, "planHash")).not.toBe(hash(changedTarget, "planHash"));
    expect(hash(first, "targetSnapshotHash")).not.toBe(hash(changedTarget, "targetSnapshotHash"));

    const lifecycleChangeBase = candidate(restartSuggestion());
    const lifecycleChange = builder.build({
      ...lifecycleChangeBase,
      affectedDeployment: { ...lifecycleChangeBase.affectedDeployment!, isCurrent: false }
    });
    expect(hash(first, "targetSnapshotHash")).not.toBe(hash(lifecycleChange, "targetSnapshotHash"));

    const differentAction = builder.build(candidate(suggestion({
      type: "RESTART_CONTAINER",
      reason: "A different bounded action reason."
    })));
    expect(hash(first, "planHash")).not.toBe(hash(differentAction, "planHash"));
    expect(hash(first, "targetSnapshotHash")).toBe(hash(differentAction, "targetSnapshotHash"));
  });

  it("binds health configuration and trusted verification behavior into the exact plan", () => {
    const firstCandidate = candidate(restartSuggestion());
    const first = builder.build(firstCandidate);
    const changedHealth = builder.build({
      ...candidate(restartSuggestion()),
      projectHealthCheckPath: "/ready",
      projectExpectedPort: 9090
    });
    expect(hash(first, "planHash")).not.toBe(hash(changedHealth, "planHash"));
    expect(hash(first, "targetSnapshotHash")).not.toBe(hash(changedHealth, "targetSnapshotHash"));

    const source = {
      files: [{ relativePath: "Dockerfile", content: "FROM node:22-alpine\n", contentHash: sha256Text("FROM node:22-alpine\n") }],
      dockerfilePath: "Dockerfile",
      test: { command: ["node", "test-a.js"], mandatory: true, timeoutMs: 1_000 }
    };
    const withSource = builder.build({
      ...firstCandidate,
      affectedDeployment: {
        ...firstCandidate.affectedDeployment!,
        configurationSnapshot: { verificationSource: source }
      }
    });
    const withChangedTest = builder.build({
      ...firstCandidate,
      affectedDeployment: {
        ...firstCandidate.affectedDeployment!,
        configurationSnapshot: {
          verificationSource: { ...source, test: { ...source.test, command: ["node", "test-b.js"] } }
        }
      }
    });
    expect(hash(withSource, "targetSnapshotHash")).not.toBe(hash(withChangedTest, "targetSnapshotHash"));
  });

  it("commits every stored plan field that can affect later verification or recovery", () => {
    const decision = builder.build(candidate(restartSuggestion()));
    if (decision.kind !== "PLAN") throw new Error("Expected plan");
    const { planHash, ...content } = decision.plan;
    const variants: Array<Omit<RemediationPlanDraft, "planHash">> = [
      { ...content, actionTypes: ["PATCH_APPLICATION_FILE"] },
      { ...content, summary: `${content.summary} Changed.` },
      { ...content, rollbackSupported: !content.rollbackSupported },
      { ...content, rollbackDescription: "Different rollback semantics." },
      { ...content, targetSnapshotHash: "f".repeat(64) }
    ];

    for (const changed of variants) {
      expect(computeRemediationPlanHash(changed)).not.toBe(planHash);
    }
    expect(validateRemediationPlanIntegrity({
      ...decision.plan,
      summary: `${decision.plan.summary} Tampered.`
    })).toBeNull();
    const mismatchedRollback = {
      ...content,
      rollbackSupported: true,
      rollbackDescription: "Invented rollback support."
    };
    expect(validateRemediationPlanIntegrity({
      ...mismatchedRollback,
      planHash: computeRemediationPlanHash(mismatchedRollback)
    })).toBeNull();
  });

  it("does not fabricate a plan for no suggestion or manual investigation", () => {
    expect(builder.build(candidate({ ...restartSuggestion(), proposedRemediation: null }))).toEqual({
      kind: "NOT_ACTIONABLE",
      code: "NO_REMEDIATION_SUGGESTED"
    });
    expect(builder.build(candidate({ ...restartSuggestion(), manualInvestigationRecommended: true }))).toEqual({
      kind: "NOT_ACTIONABLE",
      code: "MANUAL_INVESTIGATION_REQUIRED"
    });
  });
});

function candidate(diagnosisResult: unknown): RemediationPlanningCandidate {
  const affected = deployment(affectedId, true, new Date("2026-09-18T00:00:00Z"), {
    safeEnvironment: { LOG_LEVEL: "info", PORT: "3000" },
    applicationFiles: [{
      relativePath: "src/config.ts",
      contentHash: sha256Text("export const port = 3000;\n")
    }]
  });
  return {
    incidentId,
    incidentVersion: 7,
    projectId,
    ownerId: uuid(6),
    diagnosisId,
    diagnosisResult,
    affectedDeployment: affected,
    projectHealthCheckPath: "/health",
    projectExpectedPort: 8080,
    projectDeployments: [
      affected,
      deployment(historicalId, false, new Date("2026-09-17T00:00:00Z"), {})
    ]
  };
}

function deployment(
  id: string,
  isCurrent: boolean,
  createdAt: Date,
  configurationSnapshot: unknown
): PlanningDeployment {
  return {
    id,
    projectId,
    isCurrent,
    containerName: `container-${id}`,
    imageReference: `example/app:${id}`,
    configurationSnapshot,
    createdAt,
    updatedAt: new Date("2026-09-18T00:01:00Z")
  };
}

function restartSuggestion(): Record<string, unknown> {
  return suggestion({ type: "RESTART_CONTAINER", reason: "Restart after verification." });
}

function suggestion(proposedRemediation: Record<string, unknown>): Record<string, unknown> {
  return {
    rootCauseCode: "CONTAINER_CRASH",
    summary: "Validated diagnosis",
    explanation: "Bounded persisted evidence supports this result.",
    supportingEvidenceReferences: [uuid(20)],
    confidence: 0.9,
    proposedRemediation,
    manualInvestigationRecommended: false
  };
}

function patchSuggestion(path: string, original: string, replacement: string): Record<string, unknown> {
  return suggestion({
    type: "PATCH_APPLICATION_FILE",
    advisoryDescription: "Change the registered application file.",
    files: [{
      relativePath: path,
      expectedContentHash: sha256Text(original),
      originalContent: original,
      replacementContent: replacement
    }],
    reason: "Apply a structured bounded patch."
  });
}

function hash(
  decision: ReturnType<RemediationPlanBuilder["build"]>,
  field: "planHash" | "targetSnapshotHash"
): string {
  if (decision.kind !== "PLAN") throw new Error("Expected plan");
  return decision.plan[field];
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}
