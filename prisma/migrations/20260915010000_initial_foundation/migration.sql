-- CreateEnum
CREATE TYPE "IncidentType" AS ENUM ('CONTAINER_CRASH', 'HEALTH_CHECK_FAILURE', 'DATABASE_CONNECTION_FAILURE', 'MISSING_OR_INVALID_ENV', 'PORT_CONFIGURATION_FAILURE');

-- CreateEnum
CREATE TYPE "IncidentState" AS ENUM ('DETECTED', 'COLLECTING_EVIDENCE', 'DIAGNOSING', 'FIX_PROPOSED', 'VERIFYING', 'AWAITING_APPROVAL', 'RECOVERING', 'RESOLVED', 'DIAGNOSIS_FAILED', 'VERIFICATION_FAILED', 'RECOVERY_FAILED');

-- CreateEnum
CREATE TYPE "RemediationActionType" AS ENUM ('RESTART_CONTAINER', 'ROLLBACK_DEPLOYMENT', 'UPDATE_ALLOWED_ENV', 'PATCH_APPLICATION_FILE');

-- CreateEnum
CREATE TYPE "VerificationState" AS ENUM ('PENDING', 'PREPARING', 'RUNNING', 'PASSED', 'FAILED');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "RecoveryState" AS ENUM ('PENDING', 'REVALIDATING', 'APPLYING', 'HEALTH_CHECKING', 'SUCCEEDED', 'ROLLING_BACK', 'ROLLED_BACK', 'ROLLBACK_FAILED', 'ABORTED');

-- CreateEnum
CREATE TYPE "AuditOutcome" AS ENUM ('SUCCESS', 'FAILURE');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "healthCheckUrl" TEXT,
    "expectedPort" INTEGER,
    "monitoringEnabled" BOOLEAN NOT NULL DEFAULT false,
    "monitoringIntervalMs" INTEGER,
    "healthCheckTimeoutMs" INTEGER,
    "incidentFailureThreshold" INTEGER,
    "candidateStartupTimeoutMs" INTEGER,
    "nextCheckAt" TIMESTAMPTZ(3),
    "lastCheckedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deployment" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "containerName" TEXT NOT NULL,
    "imageReference" TEXT NOT NULL,
    "configurationSnapshot" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Incident" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "deploymentId" UUID,
    "type" "IncidentType" NOT NULL,
    "state" "IncidentState" NOT NULL DEFAULT 'DETECTED',
    "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
    "fingerprint" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "firstDetectedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastDetectedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidentEvidence" (
    "id" UUID NOT NULL,
    "incidentId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "byteCount" INTEGER NOT NULL,
    "lineCount" INTEGER NOT NULL,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "contentHash" TEXT NOT NULL,
    "collectedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "IncidentEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Diagnosis" (
    "id" UUID NOT NULL,
    "incidentId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "providerVersion" TEXT NOT NULL,
    "rootCauseCode" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "evidenceReferences" JSONB NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "Diagnosis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RemediationPlan" (
    "id" UUID NOT NULL,
    "incidentId" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "actionTypes" "RemediationActionType"[],
    "actions" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "rollbackSupported" BOOLEAN NOT NULL DEFAULT false,
    "rollbackDescription" TEXT,
    "planHash" TEXT NOT NULL,
    "targetSnapshotHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RemediationPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationRun" (
    "id" UUID NOT NULL,
    "incidentId" UUID NOT NULL,
    "remediationPlanId" UUID NOT NULL,
    "state" "VerificationState" NOT NULL DEFAULT 'PENDING',
    "planHash" TEXT NOT NULL,
    "targetSnapshotHash" TEXT NOT NULL,
    "sandboxIdentifier" TEXT,
    "checkResults" JSONB,
    "boundedOutput" TEXT,
    "cleanupSucceeded" BOOLEAN,
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "VerificationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" UUID NOT NULL,
    "remediationPlanId" UUID NOT NULL,
    "verificationRunId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "decision" "ApprovalDecision" NOT NULL,
    "reason" TEXT,
    "planHash" TEXT NOT NULL,
    "targetSnapshotHash" TEXT NOT NULL,
    "decidedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryAttempt" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "incidentId" UUID NOT NULL,
    "remediationPlanId" UUID NOT NULL,
    "approvalId" UUID NOT NULL,
    "state" "RecoveryState" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "preChangeSnapshot" JSONB,
    "result" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "RecoveryAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "projectId" UUID,
    "incidentId" UUID,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "outcome" "AuditOutcome" NOT NULL,
    "requestId" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "Project_userId_idx" ON "Project"("userId");
CREATE UNIQUE INDEX "Deployment_containerName_key" ON "Deployment"("containerName");
CREATE UNIQUE INDEX "Deployment_projectId_name_key" ON "Deployment"("projectId", "name");
CREATE INDEX "Deployment_projectId_idx" ON "Deployment"("projectId");
CREATE INDEX "Incident_projectId_state_idx" ON "Incident"("projectId", "state");
CREATE INDEX "Incident_deploymentId_idx" ON "Incident"("deploymentId");
CREATE UNIQUE INDEX "Incident_one_open_fingerprint_key" ON "Incident"("projectId", "type", "fingerprint") WHERE "state" <> 'RESOLVED';
CREATE INDEX "IncidentEvidence_incidentId_collectedAt_idx" ON "IncidentEvidence"("incidentId", "collectedAt");
CREATE INDEX "IncidentEvidence_expiresAt_idx" ON "IncidentEvidence"("expiresAt");
CREATE UNIQUE INDEX "Diagnosis_incidentId_key" ON "Diagnosis"("incidentId");
CREATE UNIQUE INDEX "RemediationPlan_incidentId_version_key" ON "RemediationPlan"("incidentId", "version");
CREATE INDEX "RemediationPlan_incidentId_idx" ON "RemediationPlan"("incidentId");
CREATE INDEX "VerificationRun_incidentId_idx" ON "VerificationRun"("incidentId");
CREATE INDEX "VerificationRun_remediationPlanId_state_idx" ON "VerificationRun"("remediationPlanId", "state");
CREATE INDEX "Approval_remediationPlanId_decidedAt_idx" ON "Approval"("remediationPlanId", "decidedAt");
CREATE INDEX "Approval_userId_idx" ON "Approval"("userId");
CREATE UNIQUE INDEX "RecoveryAttempt_approvalId_key" ON "RecoveryAttempt"("approvalId");
CREATE UNIQUE INDEX "RecoveryAttempt_idempotencyKey_key" ON "RecoveryAttempt"("idempotencyKey");
CREATE INDEX "RecoveryAttempt_incidentId_idx" ON "RecoveryAttempt"("incidentId");
CREATE INDEX "RecoveryAttempt_projectId_state_idx" ON "RecoveryAttempt"("projectId", "state");
CREATE UNIQUE INDEX "RecoveryAttempt_one_active_project_key" ON "RecoveryAttempt"("projectId") WHERE "state" IN ('PENDING', 'REVALIDATING', 'APPLYING', 'HEALTH_CHECKING', 'ROLLING_BACK');
CREATE INDEX "AuditEvent_projectId_createdAt_idx" ON "AuditEvent"("projectId", "createdAt");
CREATE INDEX "AuditEvent_incidentId_createdAt_idx" ON "AuditEvent"("incidentId", "createdAt");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IncidentEvidence" ADD CONSTRAINT "IncidentEvidence_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Diagnosis" ADD CONSTRAINT "Diagnosis_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RemediationPlan" ADD CONSTRAINT "RemediationPlan_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VerificationRun" ADD CONSTRAINT "VerificationRun_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VerificationRun" ADD CONSTRAINT "VerificationRun_remediationPlanId_fkey" FOREIGN KEY ("remediationPlanId") REFERENCES "RemediationPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_remediationPlanId_fkey" FOREIGN KEY ("remediationPlanId") REFERENCES "RemediationPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_verificationRunId_fkey" FOREIGN KEY ("verificationRunId") REFERENCES "VerificationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecoveryAttempt" ADD CONSTRAINT "RecoveryAttempt_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecoveryAttempt" ADD CONSTRAINT "RecoveryAttempt_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecoveryAttempt" ADD CONSTRAINT "RecoveryAttempt_remediationPlanId_fkey" FOREIGN KEY ("remediationPlanId") REFERENCES "RemediationPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecoveryAttempt" ADD CONSTRAINT "RecoveryAttempt_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "Approval"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE SET NULL ON UPDATE CASCADE;

