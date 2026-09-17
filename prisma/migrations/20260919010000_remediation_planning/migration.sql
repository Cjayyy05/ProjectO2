-- Plans are immutable records tied to the exact trusted ownership and target graph.
-- Earlier phases defined this table but exposed no supported plan-creation path. Refuse
-- to reinterpret manually inserted legacy rows as trusted Phase 5 plans because their
-- Diagnosis, Deployment, baseline, and canonical digest cannot be reconstructed safely.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "RemediationPlan") THEN
    RAISE EXCEPTION
      'Phase 5 migration requires review of legacy RemediationPlan rows before they can be trusted';
  END IF;
END $$;

-- Persist the terminal disposition of the bounded remediation-planning attempt.
ALTER TABLE "Diagnosis"
ADD COLUMN "remediationPlanningCompletedAt" TIMESTAMPTZ(3),
ADD COLUMN "remediationPlanningCode" TEXT;

ALTER TABLE "RemediationPlan"
ADD COLUMN "projectId" UUID NOT NULL,
ADD COLUMN "diagnosisId" UUID NOT NULL,
ADD COLUMN "deploymentId" UUID NOT NULL,
ADD COLUMN "schemaVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "baseline" JSONB NOT NULL;

CREATE UNIQUE INDEX "Incident_id_projectId_key" ON "Incident"("id", "projectId");
CREATE UNIQUE INDEX "Diagnosis_id_incidentId_key" ON "Diagnosis"("id", "incidentId");
CREATE UNIQUE INDEX "RemediationPlan_diagnosisId_key" ON "RemediationPlan"("diagnosisId");
CREATE UNIQUE INDEX "RemediationPlan_diagnosisId_incidentId_key" ON "RemediationPlan"("diagnosisId", "incidentId");
CREATE INDEX "RemediationPlan_projectId_idx" ON "RemediationPlan"("projectId");
CREATE INDEX "RemediationPlan_deploymentId_idx" ON "RemediationPlan"("deploymentId");

ALTER TABLE "RemediationPlan" DROP CONSTRAINT "RemediationPlan_incidentId_fkey";
ALTER TABLE "RemediationPlan"
ADD CONSTRAINT "RemediationPlan_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RemediationPlan"
ADD CONSTRAINT "RemediationPlan_incidentId_projectId_fkey"
FOREIGN KEY ("incidentId", "projectId") REFERENCES "Incident"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RemediationPlan"
ADD CONSTRAINT "RemediationPlan_diagnosisId_incidentId_fkey"
FOREIGN KEY ("diagnosisId", "incidentId") REFERENCES "Diagnosis"("id", "incidentId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RemediationPlan"
ADD CONSTRAINT "RemediationPlan_deploymentId_projectId_fkey"
FOREIGN KEY ("deploymentId", "projectId") REFERENCES "Deployment"("id", "projectId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RemediationPlan"
ADD CONSTRAINT "RemediationPlan_schemaVersion_check" CHECK ("schemaVersion" = 1),
ADD CONSTRAINT "RemediationPlan_planHash_check" CHECK ("planHash" ~ '^[a-f0-9]{64}$'),
ADD CONSTRAINT "RemediationPlan_targetSnapshotHash_check" CHECK ("targetSnapshotHash" ~ '^[a-f0-9]{64}$');
