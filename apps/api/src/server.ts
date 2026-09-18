import "dotenv/config";
import { createServer } from "node:http";
import { createApp } from "./app";
import { PrismaAuditWriter } from "./audit/prisma-audit-writer";
import { AuthService } from "./auth/auth-service";
import { JwtService } from "./auth/jwt-service";
import { PrismaUserRepository } from "./auth/prisma-user-repository";
import { loadEnvironment } from "./config/environment";
import { createPrismaClient } from "./database/prisma";
import { DiagnosisCoordinator } from "./diagnosis/diagnosis-coordinator";
import { createDiagnosisProvider } from "./diagnosis/diagnosis-provider-factory";
import { PrismaDiagnosisRepository } from "./diagnosis/prisma-diagnosis-repository";
import { DiagnosisScheduler } from "./diagnosis/diagnosis-scheduler";
import { DiagnosisService } from "./diagnosis/diagnosis-service";
import { createDockerContainerInspector } from "./docker/dockerode-container-inspector";
import { createDockerEvidenceSource } from "./docker/dockerode-evidence-source";
import { createDockerVerificationSandbox } from "./docker/dockerode-verification-sandbox";
import { EvidenceCoordinator } from "./evidence/evidence-coordinator";
import { PrismaEvidenceRepository } from "./evidence/prisma-evidence-repository";
import { EvidenceScheduler } from "./evidence/evidence-scheduler";
import { EvidenceService } from "./evidence/evidence-service";
import { createLogger } from "./logging/logger";
import { HttpHealthChecker } from "./monitoring/http-health-checker";
import { MonitoringCoordinator } from "./monitoring/monitoring-coordinator";
import { PrismaMonitoringRepository } from "./monitoring/prisma-monitoring-repository";
import { MonitoringScheduler } from "./monitoring/monitoring-scheduler";
import { MonitoringService } from "./monitoring/monitoring-service";
import { PrismaProjectRepository } from "./projects/prisma-project-repository";
import { ProjectService } from "./projects/project-service";
import { PrismaRemediationPlanningRepository } from "./remediation/prisma-remediation-planning-repository";
import { RemediationPlanBuilder } from "./remediation/remediation-plan-builder";
import { RemediationPlanningScheduler } from "./remediation/remediation-planning-scheduler";
import { RemediationPlanningService } from "./remediation/remediation-planning-service";
import { PrismaVerificationRepository } from "./verification/prisma-verification-repository";
import { VerificationScheduler } from "./verification/verification-scheduler";
import { VerificationService } from "./verification/verification-service";
import { VerificationWorkspaceManager } from "./verification/verification-workspace";

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
const diagnosisRepository = new PrismaDiagnosisRepository(prisma);
const diagnosisService = new DiagnosisService(
  diagnosisRepository,
  createDiagnosisProvider(config.diagnosis.provider)
);
const diagnosisScheduler = new DiagnosisScheduler(
  new DiagnosisCoordinator(
    diagnosisRepository,
    diagnosisService,
    logger,
    config.diagnosis.leaseMs
  ),
  config.monitoring.pollIntervalMs,
  logger
);
const remediationPlanningRepository = new PrismaRemediationPlanningRepository(prisma);
const remediationPlanningScheduler = new RemediationPlanningScheduler(
  new RemediationPlanningService(remediationPlanningRepository, new RemediationPlanBuilder()),
  config.monitoring.pollIntervalMs,
  logger
);
const verificationRepository = new PrismaVerificationRepository(prisma);
const verificationScheduler = new VerificationScheduler(
  new VerificationService(
    verificationRepository,
    new VerificationWorkspaceManager(),
    createDockerVerificationSandbox(config.monitoring.dockerSocketPath),
    config.verification,
    logger
  ),
  config.monitoring.pollIntervalMs,
  logger
);
const evidenceRepository = new PrismaEvidenceRepository(prisma);
const evidenceService = new EvidenceService(
  evidenceRepository,
  createDockerEvidenceSource(
    config.monitoring.dockerInspectionTimeoutMs,
    config.monitoring.dockerSocketPath
  ),
  config.evidence
);
const evidenceScheduler = new EvidenceScheduler(
  new EvidenceCoordinator(
    evidenceRepository,
    evidenceService,
    logger,
    Math.max(
      config.monitoring.dockerInspectionTimeoutMs * 3,
      config.monitoring.pollIntervalMs * 2
    )
  ),
  config.monitoring.pollIntervalMs,
  logger
);
const monitoringRepository = new PrismaMonitoringRepository(prisma, config.monitoring);
const monitoringService = new MonitoringService(
  monitoringRepository,
  createDockerContainerInspector(
    config.monitoring.dockerInspectionTimeoutMs,
    config.monitoring.dockerSocketPath
  ),
  new HttpHealthChecker(),
  logger
);
const monitoringScheduler = new MonitoringScheduler(
  new MonitoringCoordinator(monitoringRepository, monitoringService, logger),
  config.monitoring.pollIntervalMs,
  logger
);
const app = createApp({ config, logger, authService, jwtService, projectService });
const server = createServer(app);

server.listen(config.port, () => {
  logger.info({ port: config.port }, "SelfHeal API listening");
  diagnosisScheduler.start();
  remediationPlanningScheduler.start();
  verificationScheduler.start();
  evidenceScheduler.start();
  monitoringScheduler.start();
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  logger.info({ signal }, "Shutting down SelfHeal API");

  const schedulerStops = await Promise.allSettled([
    monitoringScheduler.stop(),
    evidenceScheduler.stop(),
    diagnosisScheduler.stop(),
    remediationPlanningScheduler.stop(),
    verificationScheduler.stop()
  ]);
  schedulerStops.forEach((result, index) => {
    if (result.status === "rejected") {
      logger.error(
        { errorName: result.reason instanceof Error ? result.reason.name : "UnknownError" },
        index === 0
          ? "Failed to stop monitoring cleanly"
          : index === 1
            ? "Failed to stop evidence collection cleanly"
            : index === 2
              ? "Failed to stop diagnosis cleanly"
              : index === 3
                ? "Failed to stop remediation planning cleanly"
                : "Failed to stop verification cleanly"
      );
      process.exitCode = 1;
    }
  });

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
