import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import type { Logger } from "pino";
import { createAuthRouter } from "./auth/auth-router";
import type { AuthService } from "./auth/auth-service";
import { requireAuthentication } from "./auth/auth-middleware";
import type { JwtService } from "./auth/jwt-service";
import type { AppConfig } from "./config/environment";
import { createErrorHandler, notFoundHandler } from "./errors/error-handler";
import { requestContext } from "./middleware/request-context";
import { createProjectRouter } from "./projects/project-router";
import type { ProjectService } from "./projects/project-service";

export interface ApplicationDependencies {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly authService: AuthService;
  readonly jwtService: JwtService;
  readonly projectService: ProjectService;
}

export function createApp(dependencies: ApplicationDependencies): Express {
  const { config, logger, authService, jwtService, projectService } = dependencies;
  const app = express();

  if (config.trustProxy) {
    app.set("trust proxy", 1);
  }

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(
    cors({
      origin: (requestOrigin, callback) => {
        callback(null, requestOrigin === undefined || requestOrigin === config.frontendOrigin);
      },
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
    })
  );
  app.use(express.json({ limit: "32kb" }));
  app.use(cookieParser());
  app.use(requestContext(logger));

  app.get("/api/health", (_request, response) => {
    response.status(200).json({
      status: "ok",
      service: "selfheal-api",
      timestamp: new Date().toISOString()
    });
  });

  app.use("/api/auth", createAuthRouter(authService, jwtService, config));
  app.use(
    "/api/projects",
    requireAuthentication(jwtService, config.jwt.cookieName),
    createProjectRouter(projectService)
  );

  app.use(notFoundHandler());
  app.use(createErrorHandler(logger, config.nodeEnv === "production"));

  return app;
}
