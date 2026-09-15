import type { RequestHandler } from "express";
import { AuthenticationError } from "../errors/app-error";
import type { JwtService } from "./jwt-service";

export function requireAuthentication(jwtService: JwtService, cookieName: string): RequestHandler {
  return (request, _response, next) => {
    const token: unknown = request.cookies?.[cookieName];

    if (typeof token !== "string" || token.length === 0) {
      next(new AuthenticationError());
      return;
    }

    try {
      request.auth = jwtService.verify(token);
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function authenticatedUserId(request: Express.Request): string {
  if (request.auth === undefined) {
    throw new AuthenticationError();
  }

  return request.auth.userId;
}

