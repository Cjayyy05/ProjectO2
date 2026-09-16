-- Add the explicit MVP lifecycle invariant: each Project has at most one current Deployment.
ALTER TABLE "Deployment" ADD COLUMN "isCurrent" BOOLEAN NOT NULL DEFAULT false;

-- Existing Phase 1/early Phase 2 databases may contain several deployments per project.
-- Preserve all rows and select the most recently created row as the current deployment.
WITH ranked_deployments AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "projectId"
      ORDER BY "createdAt" DESC, "id" DESC
    ) AS position
  FROM "Deployment"
)
UPDATE "Deployment" AS deployment
SET "isCurrent" = true
FROM ranked_deployments
WHERE deployment."id" = ranked_deployments."id"
  AND ranked_deployments.position = 1;

ALTER TABLE "Deployment" ALTER COLUMN "isCurrent" SET DEFAULT true;

CREATE UNIQUE INDEX "Deployment_one_current_per_project_key"
ON "Deployment"("projectId")
WHERE "isCurrent" = true;
