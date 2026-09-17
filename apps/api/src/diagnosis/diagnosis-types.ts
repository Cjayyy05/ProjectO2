import { REMEDIATION_ACTION_TYPES, type IncidentType } from "@selfheal/shared";
import { z } from "zod";
import type { EvidenceSanitizer } from "../evidence/evidence-sanitizer";

export interface DiagnosisEvidenceInput {
  readonly id: string;
  readonly kind: string;
  readonly source: string;
  readonly content: string;
  readonly persistedTruncated: boolean;
  readonly inputTruncated: boolean;
  readonly collectedAt: string;
}

export interface DiagnosisInput {
  readonly incidentId: string;
  readonly incidentType: IncidentType;
  readonly evidence: readonly DiagnosisEvidenceInput[];
  readonly evidenceIncomplete: boolean;
  readonly inputTruncated: boolean;
}

export const ROOT_CAUSE_CODES = [
  "DATABASE_CONNECTION_FAILURE",
  "MISSING_OR_INVALID_ENV",
  "PORT_CONFIGURATION_FAILURE",
  "CONTAINER_CRASH",
  "HEALTH_CHECK_FAILURE",
  "INSUFFICIENT_EVIDENCE"
] as const;

const reason = z.string().trim().min(1).max(500);
const environmentVariableName = z.string()
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const sha256Digest = z.string().regex(/^[a-f0-9]{64}$/);
const environmentChangeSuggestion = z.object({
  name: environmentVariableName,
  proposedValue: z.string().max(256)
}).strict();
const filePatchSuggestion = z.object({
  relativePath: z.string().trim().min(1).max(240),
  expectedContentHash: sha256Digest,
  originalContent: z.string().max(32 * 1_024),
  replacementContent: z.string().max(32 * 1_024)
}).strict();
const remediationType = z.enum(REMEDIATION_ACTION_TYPES);
const proposedRemediationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal(remediationType.enum.RESTART_CONTAINER), reason }).strict(),
  z.object({
    type: z.literal(remediationType.enum.ROLLBACK_DEPLOYMENT),
    targetDeploymentId: z.uuid().optional(),
    reason
  }).strict(),
  z.object({
    type: z.literal(remediationType.enum.UPDATE_ALLOWED_ENV),
    variableNames: z.array(environmentVariableName).max(16),
    changes: z.array(environmentChangeSuggestion).max(4).optional(),
    reason
  }).strict(),
  z.object({
    type: z.literal(remediationType.enum.PATCH_APPLICATION_FILE),
    advisoryDescription: z.string().trim().min(1).max(1_000),
    files: z.array(filePatchSuggestion).max(4).optional(),
    reason
  }).strict()
]);

export const diagnosisResultSchema = z.object({
  rootCauseCode: z.enum(ROOT_CAUSE_CODES),
  summary: z.string().trim().min(1).max(300),
  explanation: z.string().trim().min(1).max(2_000),
  supportingEvidenceReferences: z.array(z.uuid()).max(32).superRefine((references, context) => {
    if (new Set(references).size !== references.length) {
      context.addIssue({ code: "custom", message: "Evidence references must be unique" });
    }
  }),
  confidence: z.number().finite().min(0).max(1),
  proposedRemediation: proposedRemediationSchema.nullable(),
  manualInvestigationRecommended: z.boolean()
}).strict();

export const diagnosisProviderIdentitySchema = z.object({
  provider: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
}).strict();

export type DiagnosisResult = z.infer<typeof diagnosisResultSchema>;

export function sanitizeDiagnosisResult(
  result: DiagnosisResult,
  sanitizer: EvidenceSanitizer
): DiagnosisResult {
  const proposed = result.proposedRemediation;
  const proposedRemediation = proposed === null
    ? null
    : proposed.type === "UPDATE_ALLOWED_ENV"
      ? {
          ...proposed,
          changes: proposed.changes?.map((change) => ({
            ...change,
            proposedValue: sanitizer.sanitizeText(change.proposedValue)
          })),
          reason: sanitizer.sanitizeText(proposed.reason)
        }
      : proposed.type === "PATCH_APPLICATION_FILE"
        ? {
            ...proposed,
            advisoryDescription: sanitizer.sanitizeText(proposed.advisoryDescription),
            files: proposed.files?.map((file) => ({
              ...file,
              originalContent: sanitizer.sanitizeText(file.originalContent),
              replacementContent: sanitizer.sanitizeText(file.replacementContent)
            })),
            reason: sanitizer.sanitizeText(proposed.reason)
          }
        : {
            ...proposed,
            reason: sanitizer.sanitizeText(proposed.reason)
          };

  return diagnosisResultSchema.parse({
    ...result,
    summary: sanitizer.sanitizeText(result.summary),
    explanation: sanitizer.sanitizeText(result.explanation),
    proposedRemediation
  });
}
