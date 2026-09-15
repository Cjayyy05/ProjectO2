import { getRounds } from "bcryptjs";
import { describe, expect, it } from "vitest";
import { InMemoryAuditWriter, InMemoryUserRepository } from "../test/in-memory-repositories";
import { AuthService } from "./auth-service";
import { verifyPassword } from "./password";

describe("AuthService", () => {
  it("normalizes email and stores a secure password hash instead of the password", async () => {
    const audit = new InMemoryAuditWriter();
    const users = new InMemoryUserRepository(audit);
    const service = new AuthService(users, audit, 10);

    const created = await service.register("  OWNER@Example.com ", "correct horse battery staple");
    const stored = users.users[0];

    expect(created.email).toBe("owner@example.com");
    expect(stored).toBeDefined();
    expect(stored?.passwordHash).not.toBe("correct horse battery staple");
    expect(getRounds(stored?.passwordHash ?? "")).toBe(10);
    await expect(verifyPassword("correct horse battery staple", stored?.passwordHash ?? "")).resolves.toBe(
      true
    );
    expect(audit.events).toContainEqual(
      expect.objectContaining({ action: "AUTH_REGISTERED", userId: created.id, outcome: "SUCCESS" })
    );
  });

  it("authenticates the correct password and rejects an incorrect password", async () => {
    const audit = new InMemoryAuditWriter();
    const users = new InMemoryUserRepository(audit);
    const service = new AuthService(users, audit, 10);
    await service.register("owner@example.com", "correct horse battery staple");

    await expect(
      service.authenticate("OWNER@example.com", "correct horse battery staple")
    ).resolves.toMatchObject({ email: "owner@example.com" });
    await expect(service.authenticate("owner@example.com", "incorrect password value")).rejects.toThrow(
      "Invalid email or password"
    );
    expect(audit.events).toContainEqual(
      expect.objectContaining({ action: "AUTH_LOGIN_FAILED", outcome: "FAILURE" })
    );
  });

  it("uses the same public failure for an unknown email and records no credentials", async () => {
    const audit = new InMemoryAuditWriter();
    const users = new InMemoryUserRepository(audit);
    const service = new AuthService(users, audit, 10);

    await expect(
      service.authenticate("missing@example.com", "candidate password value")
    ).rejects.toThrow("Invalid email or password");

    expect(audit.events).toContainEqual(
      expect.objectContaining({ action: "AUTH_LOGIN_FAILED", outcome: "FAILURE" })
    );
    expect(JSON.stringify(audit.events)).not.toContain("candidate password value");
  });

  it("rolls back registration when its audit event cannot be recorded", async () => {
    const failingAudit = {
      async record(): Promise<void> {
        throw new Error("audit unavailable");
      }
    };
    const users = new InMemoryUserRepository(failingAudit);
    const service = new AuthService(users, failingAudit, 10);

    await expect(
      service.register("owner@example.com", "correct horse battery staple")
    ).rejects.toThrow("audit unavailable");
    expect(users.users).toHaveLength(0);
  });
});
