import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import { AuthenticationError } from "../errors/app-error";
import { JwtService } from "./jwt-service";

const secret = "test-secret-with-at-least-32-characters";

describe("JwtService", () => {
  it("round-trips a signed user identity", () => {
    const service = new JwtService(secret, 8);

    expect(service.verify(service.sign("user-1"))).toEqual({ userId: "user-1" });
  });

  it("rejects expired tokens", () => {
    const service = new JwtService(secret, 8);
    const expired = jwt.sign({}, secret, {
      algorithm: "HS256",
      subject: "user-1",
      issuer: "selfheal-api",
      audience: "selfheal-web",
      expiresIn: -1
    });

    expect(() => service.verify(expired)).toThrow(AuthenticationError);
  });

  it("rejects tokens issued for a different audience", () => {
    const service = new JwtService(secret, 8);
    const wrongAudience = jwt.sign({}, secret, {
      algorithm: "HS256",
      subject: "user-1",
      issuer: "selfheal-api",
      audience: "another-application",
      expiresIn: "8h"
    });

    expect(() => service.verify(wrongAudience)).toThrow(AuthenticationError);
  });

  it("rejects a tampered token", () => {
    const service = new JwtService(secret, 8);
    const token = service.sign("user-1");
    const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;

    expect(() => service.verify(tampered)).toThrow(AuthenticationError);
  });
});
