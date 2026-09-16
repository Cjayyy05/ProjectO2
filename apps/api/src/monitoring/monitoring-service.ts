import type { Logger } from "pino";
import { DockerInspectionError, type ContainerInspector } from "../docker/docker-service";
import type { HealthChecker } from "./http-health-checker";
import type { MonitoringRepository, MonitoringTarget } from "./monitoring-repository";

export interface TargetMonitor {
  check(target: MonitoringTarget): Promise<void>;
}

export class MonitoringService implements TargetMonitor {
  public constructor(
    private readonly repository: MonitoringRepository,
    private readonly containers: ContainerInspector,
    private readonly healthChecker: HealthChecker,
    private readonly logger: Logger
  ) {}

  public async check(target: MonitoringTarget): Promise<void> {
    const observedAt = new Date();
    let inspection;
    try {
      inspection = await this.containers.inspect(target.containerName);
    } catch (error) {
      const errorCode =
        error instanceof DockerInspectionError ? error.code : "DOCKER_INSPECTION_FAILED";
      await this.repository.recordMonitoringError(target, errorCode, observedAt);
      this.logger.warn(
        { projectId: target.projectId, deploymentId: target.deploymentId, errorCode },
        "Container inspection failed"
      );
      return;
    }

    if (
      inspection.state === "RUNNING" &&
      !inspection.publishedHostPorts.includes(target.expectedPort)
    ) {
      const errorCode = "PORT_NOT_PUBLISHED";
      await this.repository.recordMonitoringError(target, errorCode, observedAt, inspection.state);
      this.logger.warn(
        { projectId: target.projectId, deploymentId: target.deploymentId, errorCode },
        "Configured health-check port is not published by the registered container"
      );
      return;
    }

    const healthCheck =
      inspection.state === "RUNNING"
        ? await this.healthChecker.check({
            port: target.expectedPort,
            path: target.healthCheckPath,
            timeoutMs: target.healthCheckTimeoutMs
          })
        : undefined;

    const result = await this.repository.recordObservation(target, {
      containerState: inspection.state,
      ...(healthCheck === undefined ? {} : { healthCheck }),
      observedAt
    });
    if (result.incidentCreated) {
      this.logger.info(
        {
          projectId: target.projectId,
          deploymentId: target.deploymentId,
          incidentId: result.incidentId
        },
        "Monitoring incident detected"
      );
    }
  }
}
