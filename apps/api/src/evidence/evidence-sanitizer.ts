const SENSITIVE_KEY_FRAGMENT = [
  "password",
  "passwd",
  "pwd",
  "api[_-]?key",
  "secret",
  "token",
  "authorization",
  "cookie",
  "session(?:[_-]?id)?",
  "database[_-]?url",
  "credential",
  "private[_-]?key"
].join("|");

const SENSITIVE_ASSIGNMENT = new RegExp(
  `(^|[\\s,{;?&])((?:"|')?[A-Za-z0-9_.-]{0,128}(?:${SENSITIVE_KEY_FRAGMENT})[A-Za-z0-9_.-]{0,128}(?:"|')?\\s*(?:=|:)\\s*)("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\r\\n,;}]+)`,
  "gim"
);

const SAFE_COLLECTION_ERROR_CODES = new Set([
  "DOCKER_UNAVAILABLE",
  "DOCKER_TIMEOUT",
  "DOCKER_LOGS_FAILED"
]);

export class EvidenceSanitizer {
  public sanitizeText(input: string): string {
    return input
      .replace(
        /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi,
        "[REDACTED_PRIVATE_KEY]"
      )
      .replace(
        /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*$/gi,
        "[REDACTED_PRIVATE_KEY]"
      )
      .replace(/(\bAuthorization\s*:\s*Bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
      .replace(/(^|[\r\n])((?:Set-)?Cookie\s*:\s*)[^\r\n]*/gi, "$1$2[REDACTED]")
      .replace(
        /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/([^:\s/@]+):([^@\s/]+)@/gi,
        "$1://$2:[REDACTED]@"
      )
      .replace(SENSITIVE_ASSIGNMENT, (_match, delimiter: string, assignment: string, value: string) => {
        const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
        return `${delimiter}${assignment}${quote}[REDACTED]${quote}`;
      })
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]")
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_CLOUD_CREDENTIAL]")
      .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_PROVIDER_CREDENTIAL]")
      .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[REDACTED_PROVIDER_CREDENTIAL]")
      .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED_PROVIDER_CREDENTIAL]");
  }
}

export function safeCollectionErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    SAFE_COLLECTION_ERROR_CODES.has(error.code)
  ) {
    return error.code;
  }
  return "COLLECTION_FAILED";
}
