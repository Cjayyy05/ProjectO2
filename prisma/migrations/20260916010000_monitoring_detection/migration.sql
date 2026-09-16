-- CreateEnum
CREATE TYPE "DeploymentHealthState" AS ENUM ('UNKNOWN', 'HEALTHY', 'UNHEALTHY');

-- CreateEnum
CREATE TYPE "ContainerRuntimeState" AS ENUM ('UNKNOWN', 'RUNNING', 'STOPPED', 'MISSING', 'PAUSED', 'RESTARTING');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN "healthCheckPath" TEXT;

-- AlterTable
ALTER TABLE "Deployment"
ADD COLUMN "lastContainerState" "ContainerRuntimeState" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN "lastHealthState" "DeploymentHealthState" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN "lastHttpStatus" INTEGER,
ADD COLUMN "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lastCheckErrorCode" TEXT,
ADD COLUMN "lastCheckedAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "Incident"
ADD COLUMN "detectionSource" TEXT,
ADD COLUMN "detectionReason" TEXT;

-- CreateIndex
CREATE INDEX "Project_monitoringEnabled_nextCheckAt_idx" ON "Project"("monitoringEnabled", "nextCheckAt");
