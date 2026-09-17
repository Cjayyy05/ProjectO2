-- Track the small in-process diagnosis lease directly on the Incident.
ALTER TABLE "Incident" ADD COLUMN "diagnosisClaimedAt" TIMESTAMPTZ(3);

CREATE INDEX "Incident_state_diagnosisClaimedAt_idx"
ON "Incident"("state", "diagnosisClaimedAt");

-- Keep the database invariant aligned with runtime provider validation.
ALTER TABLE "Diagnosis"
ADD CONSTRAINT "Diagnosis_confidence_check"
CHECK ("confidence" >= 0.0 AND "confidence" <= 1.0);
