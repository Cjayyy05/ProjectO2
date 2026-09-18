-- Earlier phases defined VerificationRun for the approved domain graph but exposed no
-- verification path. Do not reinterpret manually inserted legacy rows as trusted runs.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "VerificationRun") THEN
    RAISE EXCEPTION
      'Phase 6 migration requires review of legacy VerificationRun rows before they can be trusted';
  END IF;
END $$;

ALTER TABLE "VerificationRun"
ADD COLUMN "claimToken" UUID,
ADD COLUMN "claimedAt" TIMESTAMPTZ(3),
ADD COLUMN "failureCode" TEXT;

CREATE UNIQUE INDEX "RemediationPlan_id_incidentId_key"
ON "RemediationPlan"("id", "incidentId");

DROP INDEX "VerificationRun_remediationPlanId_state_idx";
CREATE UNIQUE INDEX "VerificationRun_remediationPlanId_key"
ON "VerificationRun"("remediationPlanId");
CREATE INDEX "VerificationRun_state_claimedAt_idx"
ON "VerificationRun"("state", "claimedAt");

ALTER TABLE "VerificationRun" DROP CONSTRAINT "VerificationRun_remediationPlanId_fkey";
ALTER TABLE "VerificationRun"
ADD CONSTRAINT "VerificationRun_remediationPlanId_incidentId_fkey"
FOREIGN KEY ("remediationPlanId", "incidentId")
REFERENCES "RemediationPlan"("id", "incidentId")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "VerificationRun"
ADD CONSTRAINT "VerificationRun_planHash_check" CHECK ("planHash" ~ '^[a-f0-9]{64}$'),
ADD CONSTRAINT "VerificationRun_targetSnapshotHash_check" CHECK ("targetSnapshotHash" ~ '^[a-f0-9]{64}$');

-- A proposed plan is the exact human-review unit. Once created, every field is
-- immutable; later phases create new plans rather than editing approved input.
CREATE FUNCTION "prevent_remediation_plan_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'RemediationPlan is immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RemediationPlan_immutable_update"
BEFORE UPDATE ON "RemediationPlan"
FOR EACH ROW EXECUTE FUNCTION "prevent_remediation_plan_update"();
