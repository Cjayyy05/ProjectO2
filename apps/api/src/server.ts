import "dotenv/config";
import { createServer } from "node:http";
import { createApp } from "./app";
import { PrismaAuditWriter } from "./audit/prisma-audit-writer";
import { AuthService } from "./auth/auth-service";
import { JwtService } from "./auth/jwt-service";
import { PrismaUserRepository } from "./auth/prisma-user-repository";
import { loadEnvironment } from "./config/environment";
import { createPrismaClient } from "./database/prisma";
import { createLogger } from "./logging/logger";
import { PrismaProjectRepository } from "./projects/prisma-project-repository";
import { ProjectService } from "./projects/project-service";

const config = loadEnvironment(process.env);
const logger = createLogger(config.nodeEnv);
const prisma = createPrismaClient();
const audit = new PrismaAuditWriter(prisma);
const authService = new AuthService(
  new PrismaUserRepository(prisma),
  audit,
  config.passwordHashRounds
);
const jwtService = new JwtService(config.jwt.secret, config.jwt.ttlHours);
const projectService = new ProjectService(new PrismaProjectRepository(prisma));
const app = createApp({ config, logger, authService, jwtService, projectService });
const server = createServer(app);

server.listen(config.port, () => {
  logger.info({ port: config.port }, "SelfHeal API listening");
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  logger.info({ signal }, "Shutting down SelfHeal API");

  server.close(async (serverError) => {
    try {
      await prisma.$disconnect();
    } catch (databaseError) {
      logger.error(
        { errorName: databaseError instanceof Error ? databaseError.name : "UnknownError" },
        "Failed to disconnect Prisma cleanly"
      );
    }

    if (serverError) {
      logger.error({ errorName: serverError.name }, "HTTP server shutdown failed");
      process.exitCode = 1;
    }
  });
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
