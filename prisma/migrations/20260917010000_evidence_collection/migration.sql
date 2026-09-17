-- Evidence collection is idempotent per incident/category/source.
CREATE UNIQUE INDEX "IncidentEvidence_incidentId_kind_source_key"
ON "IncidentEvidence"("incidentId", "kind", "source");

-- Ensure an Incident cannot reference a Deployment owned by a different Project.
ALTER TABLE "Incident" DROP CONSTRAINT "Incident_deploymentId_fkey";
CREATE UNIQUE INDEX "Deployment_id_projectId_key" ON "Deployment"("id", "projectId");
ALTER TABLE "Incident"
ADD CONSTRAINT "Incident_deploymentId_projectId_fkey"
FOREIGN KEY ("deploymentId", "projectId")
REFERENCES "Deployment"("id", "projectId")
ON DELETE RESTRICT ON UPDATE CASCADE;
