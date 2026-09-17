import type { DiagnosisProvider } from "./diagnosis-provider";
import type { DiagnosisEvidenceInput, DiagnosisInput, DiagnosisResult } from "./diagnosis-types";

interface DiagnosisContext {
  readonly input: DiagnosisInput;
  readonly combinedText: string;
  readonly deployment: Readonly<Record<string, unknown>> | null;
  readonly runtime: Readonly<Record<string, unknown>> | null;
  readonly health: Readonly<Record<string, unknown>> | null;
}

interface DiagnosisRule {
  readonly name: string;
  matches(context: DiagnosisContext): boolean;
  create(context: DiagnosisContext): DiagnosisResult;
}

export const MOCK_DIAGNOSIS_RULE_PRECEDENCE = [
  "MISSING_OR_INVALID_ENV",
  "PORT_CONFIGURATION_FAILURE",
  "DATABASE_CONNECTION_FAILURE",
  "CONTAINER_CRASH",
  "HEALTH_CHECK_FAILURE",
  "INSUFFICIENT_EVIDENCE"
] as const;

const rules: readonly DiagnosisRule[] = [
  {
    name: "MISSING_OR_INVALID_ENV",
    matches: ({ input, combinedText }) =>
      input.incidentType === "MISSING_OR_INVALID_ENV" ||
      /missing (?:required )?(?:environment|env) variable/.test(combinedText) ||
      /(?:environment|env) variable [a-z_][a-z0-9_]* (?:is )?(?:required|missing|undefined)/.test(combinedText) ||
      /required (?:environment )?variable [a-z_][a-z0-9_]*/.test(combinedText),
    create: (context) => knownResult(context, {
      rootCauseCode: "MISSING_OR_INVALID_ENV",
      summary: "Required application configuration is missing or invalid.",
      explanation: "Persisted evidence contains a deterministic missing or invalid environment/configuration signal. Secret values were not available to the provider.",
      confidence: 0.92,
      evidenceKinds: ["ENVIRONMENT", "DOCKER_LOG", "COLLECTION_SUMMARY"],
      proposedRemediation: {
        type: "UPDATE_ALLOWED_ENV",
        variableNames: missingEnvironmentNames(context.input),
        reason: "Review and supply the required configuration through the approved environment update workflow."
      }
    })
  },
  {
    name: "PORT_CONFIGURATION_FAILURE",
    matches: (context) =>
      context.input.incidentType === "PORT_CONFIGURATION_FAILURE" ||
      context.combinedText.includes("port_not_published") ||
      /(?:listen|bind|port).*(?:mismatch|not published|address already in use)/.test(context.combinedText) ||
      hasExpectedPortMismatch(context),
    create: (context) => knownResult(context, {
      rootCauseCode: "PORT_CONFIGURATION_FAILURE",
      summary: "The application port configuration does not match the registered deployment.",
      explanation: "The expected application port, published Docker ports, or persisted listen/bind evidence indicates a deterministic port mismatch.",
      confidence: 0.9,
      evidenceKinds: ["DEPLOYMENT", "CONTAINER_RUNTIME", "HEALTH_CHECK", "DOCKER_LOG"],
      proposedRemediation: {
        type: "PATCH_APPLICATION_FILE",
        advisoryDescription: "Align the application listen port with the registered expected port without introducing arbitrary commands or paths.",
        reason: "The port configuration must be corrected before deterministic verification."
      }
    })
  },
  {
    name: "DATABASE_CONNECTION_FAILURE",
    matches: ({ input, combinedText }) =>
      input.incidentType === "DATABASE_CONNECTION_FAILURE" ||
      /database (?:connection|connect).*(?:failed|refused|unavailable)/.test(combinedText) ||
      (/econnrefused/.test(combinedText) && /(?:localhost|127\.0\.0\.1|:5432|:3306|:27017|:6379)/.test(combinedText)),
    create: (context) => knownResult(context, {
      rootCauseCode: "DATABASE_CONNECTION_FAILURE",
      summary: "The application cannot reach its configured database dependency.",
      explanation: "Persisted sanitized evidence contains a database connection refusal or a database-specific incident signal. No database credential values were provided to the diagnosis provider.",
      confidence: 0.88,
      evidenceKinds: ["DOCKER_LOG", "HEALTH_CHECK", "ENVIRONMENT", "COLLECTION_SUMMARY"],
      proposedRemediation: {
        type: "UPDATE_ALLOWED_ENV",
        variableNames: [],
        reason: "Review the approved database endpoint configuration without exposing or inventing credential values."
      }
    })
  },
  {
    name: "CONTAINER_CRASH",
    matches: (context) =>
      context.input.incidentType === "CONTAINER_CRASH" || hasCrashRuntime(context.runtime) ||
      /(?:application|process|container).*(?:crashed|exited|terminated)/.test(context.combinedText),
    create: (context) => knownResult(context, {
      rootCauseCode: "CONTAINER_CRASH",
      summary: "The application container or process exited unexpectedly.",
      explanation: "Persisted runtime evidence reports a stopped container, a non-zero exit code, or an explicit application crash signal.",
      confidence: 0.85,
      evidenceKinds: ["CONTAINER_RUNTIME", "DOCKER_LOG", "DEPLOYMENT"],
      proposedRemediation: {
        type: "RESTART_CONTAINER",
        reason: "A controlled restart may restore the registered container after verification and approval."
      }
    })
  },
  {
    name: "HEALTH_CHECK_FAILURE",
    matches: (context) =>
      hasFailingHealth(context.health) ||
      /health(?:-| )?check.*(?:failed|unhealthy|timeout)/.test(context.combinedText),
    create: (context) => knownResult(context, {
      rootCauseCode: "HEALTH_CHECK_FAILURE",
      summary: "The application repeatedly failed its configured health check.",
      explanation: "Persisted monitoring evidence reports an unhealthy state or repeated health-check failures without a stronger supported root cause.",
      confidence: 0.68,
      evidenceKinds: ["HEALTH_CHECK", "CONTAINER_RUNTIME", "DOCKER_LOG"],
      proposedRemediation: {
        type: "RESTART_CONTAINER",
        reason: "A controlled restart may be evaluated after the health failure is reproduced in verification."
      }
    })
  }
];

export class MockDiagnosisProvider implements DiagnosisProvider {
  public readonly provider = "mock";
  public readonly model = "deterministic-v1";

  public async analyzeIncident(input: DiagnosisInput): Promise<DiagnosisResult> {
    const context = createContext(input);
    const matchingRule = rules.find((rule) => rule.matches(context));
    return matchingRule?.create(context) ?? insufficientEvidence(context);
  }
}

function knownResult(
  context: DiagnosisContext,
  definition: Omit<DiagnosisResult, "supportingEvidenceReferences" | "manualInvestigationRecommended" | "confidence"> & {
    readonly confidence: number;
    readonly evidenceKinds: readonly string[];
  }
): DiagnosisResult {
  const incomplete = context.input.evidenceIncomplete || context.input.inputTruncated;
  return {
    rootCauseCode: definition.rootCauseCode,
    summary: definition.summary,
    explanation: definition.explanation,
    supportingEvidenceReferences: referencesForKinds(context.input.evidence, definition.evidenceKinds),
    confidence: adjustedConfidence(definition.confidence, incomplete),
    proposedRemediation: definition.proposedRemediation,
    manualInvestigationRecommended: incomplete
  };
}

function insufficientEvidence(context: DiagnosisContext): DiagnosisResult {
  const incomplete = context.input.evidenceIncomplete || context.input.inputTruncated;
  return {
    rootCauseCode: "INSUFFICIENT_EVIDENCE",
    summary: "The persisted evidence does not support a deterministic root cause.",
    explanation: "No supported concrete failure rule matched. Manual investigation is required rather than fabricating a diagnosis or remediation parameters.",
    supportingEvidenceReferences: context.input.evidence
      .filter((item) => item.kind === "COLLECTION_SUMMARY" || item.kind === "COLLECTION_ERROR")
      .map((item) => item.id),
    confidence: incomplete ? 0.1 : 0.2,
    proposedRemediation: null,
    manualInvestigationRecommended: true
  };
}

function createContext(input: DiagnosisInput): DiagnosisContext {
  return {
    input,
    combinedText: input.evidence.map((item) => item.content.toLowerCase()).join("\n"),
    deployment: structuredEvidence(input.evidence, "DEPLOYMENT"),
    runtime: structuredEvidence(input.evidence, "CONTAINER_RUNTIME"),
    health: structuredEvidence(input.evidence, "HEALTH_CHECK")
  };
}

function structuredEvidence(
  evidence: readonly DiagnosisEvidenceInput[],
  kind: string
): Readonly<Record<string, unknown>> | null {
  const item = evidence.find((candidate) => candidate.kind === kind);
  if (item === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(item.content);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasExpectedPortMismatch(context: DiagnosisContext): boolean {
  const expectedPort = context.deployment?.expectedPort;
  const publishedPorts = context.runtime?.publishedHostPorts;
  return typeof expectedPort === "number" && Array.isArray(publishedPorts) &&
    !publishedPorts.some((port) => port === expectedPort);
}

function hasCrashRuntime(runtime: Readonly<Record<string, unknown>> | null): boolean {
  if (runtime === null) return false;
  return runtime.state === "STOPPED" ||
    (typeof runtime.exitCode === "number" && runtime.exitCode !== 0);
}

function hasFailingHealth(health: Readonly<Record<string, unknown>> | null): boolean {
  if (health === null) return false;
  return health.healthState === "UNHEALTHY" ||
    (typeof health.consecutiveFailures === "number" && health.consecutiveFailures > 0);
}

function referencesForKinds(
  evidence: readonly DiagnosisEvidenceInput[],
  kinds: readonly string[]
): string[] {
  const accepted = new Set(kinds);
  return evidence.filter((item) => accepted.has(item.kind)).map((item) => item.id);
}

function missingEnvironmentNames(input: DiagnosisInput): string[] {
  const names = new Set<string>();
  for (const evidence of input.evidence) {
    const patterns = [
      /missing (?:required )?(?:environment|env) variable[:\s]+([A-Za-z_][A-Za-z0-9_]*)/gi,
      /(?:environment|env) variable ([A-Za-z_][A-Za-z0-9_]*) (?:is )?(?:required|missing|undefined)/gi,
      /required (?:environment )?variable[:\s]+([A-Za-z_][A-Za-z0-9_]*)/gi
    ];
    for (const pattern of patterns) {
      for (const match of evidence.content.matchAll(pattern)) {
        const name = match[1];
        if (name !== undefined) names.add(name);
        if (names.size >= 16) return [...names];
      }
    }
  }
  return [...names];
}

function adjustedConfidence(confidence: number, incomplete: boolean): number {
  return incomplete ? Math.max(0, Number((confidence - 0.15).toFixed(2))) : confidence;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
