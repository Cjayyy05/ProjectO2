import { Router, type Response } from "express";
import { z } from "zod";
import type { AppConfig } from "../config/environment";
import type { AuthService } from "./auth-service";
import { authenticatedUserId, requireAuthentication } from "./auth-middleware";
import type { JwtService } from "./jwt-service";

const credentialsSchema = z.object({
  email: z.email().max(254),
  password: z
    .string()
    .min(12)
    .max(128)
    .refine((password) => Buffer.byteLength(password, "utf8") <= 72, "Password must be at most 72 bytes")
});

export function createAuthRouter(authService: AuthService, jwtService: JwtService, config: AppConfig): Router {
  const router = Router();
  const requireAuth = requireAuthentication(jwtService, config.jwt.cookieName);

  router.post("/register", async (request, response) => {
    const input = credentialsSchema.parse(request.body);
    const user = await authService.register(input.email, input.password, request.requestId);
    setAuthCookie(response, jwtService.sign(user.id), config);
    response.status(201).json({ user });
  });

  router.post("/login", async (request, response) => {
    const input = credentialsSchema.parse(request.body);
    const user = await authService.authenticate(input.email, input.password, request.requestId);
    setAuthCookie(response, jwtService.sign(user.id), config);
    response.status(200).json({ user });
  });

  router.post("/logout", (_request, response) => {
    response.clearCookie(config.jwt.cookieName, cookieOptions(config));
    response.status(204).send();
  });

  router.get("/me", requireAuth, async (request, response) => {
    const user = await authService.getUser(authenticatedUserId(request));
    response.status(200).json({ user });
  });

  return router;
}

function setAuthCookie(response: Response, token: string, config: AppConfig): void {
  response.cookie(config.jwt.cookieName, token, {
    ...cookieOptions(config),
    maxAge: config.jwt.ttlHours * 60 * 60 * 1_000
  });
}

function cookieOptions(config: AppConfig) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.nodeEnv === "production",
    path: "/"
  };
}
