import { describe, expect, it } from "vitest";
import { EvidenceSanitizer, safeCollectionErrorCode } from "./evidence-sanitizer";

describe("EvidenceSanitizer", () => {
  const sanitizer = new EvidenceSanitizer();

  it.each([
    ["PASSWORD=my-password", "my-password"],
    ["API_KEY=abc123", "abc123"],
    ["Authorization: Bearer ey.secret.token", "ey.secret.token"],
    ["Cookie: session=private-session", "private-session"],
    ["DATABASE_URL=postgres://user:db-password@host/db", "db-password"],
    ["token=eyJheader.eyJpayload.signature", "eyJheader.eyJpayload.signature"],
    ["AWS_SECRET_ACCESS_KEY=cloud-secret", "cloud-secret"],
    ["AWS_SESSION_TOKEN=cloud-session-token", "cloud-session-token"],
    ["AZURE_CLIENT_SECRET=azure-secret", "azure-secret"],
    ['{"password":"json-secret","safe":"visible"}', "json-secret"],
    ["postgresql://host/db?password=query-secret&sslmode=require", "query-secret"],
    ["provider key sk-proj-abcdefghijklmnopqrstuv", "sk-proj-abcdefghijklmnopqrstuv"],
    ["google key AIzaabcdefghijklmnopqrstuvwx", "AIzaabcdefghijklmnopqrstuvwx"],
    ["github token ghp_abcdefghijklmnopqrstuvwxyz", "ghp_abcdefghijklmnopqrstuvwxyz"],
    [
      "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----",
      "private-material"
    ]
  ])("redacts sensitive evidence %s", (input, secret) => {
    const sanitized = sanitizer.sanitizeText(input);

    expect(sanitized).not.toContain(secret);
    expect(sanitized).toContain("REDACTED");
  });

  it("never persists a raw error message as an error code", () => {
    expect(safeCollectionErrorCode(new Error("socket \\.\\pipe\\docker password=secret")))
      .toBe("COLLECTION_FAILED");
    expect(safeCollectionErrorCode({ code: "DOCKER_LOGS_FAILED", message: "password=secret" }))
      .toBe("DOCKER_LOGS_FAILED");
    expect(safeCollectionErrorCode({ code: "AKIA1234567890ABCDEF" }))
      .toBe("COLLECTION_FAILED");
  });

  it("preserves valid JSON while redacting quoted values", () => {
    const sanitized = sanitizer.sanitizeText('{"password":"json-secret","safe":"visible"}');

    expect(JSON.parse(sanitized)).toEqual({ password: "[REDACTED]", safe: "visible" });
  });
});
