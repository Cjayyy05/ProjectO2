import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import type { Logger } from "pino";

export function requestContext(logger: Logger): RequestHandler {
  return (request, response, next) => {
    const incomingRequestId = request.header("x-request-id");
    request.requestId =
      incomingRequestId && /^[A-Za-z0-9._:-]{1,128}$/.test(incomingRequestId)
        ? incomingRequestId
        : randomUUID();
    response.setHeader("x-request-id", request.requestId);

    const startedAt = Date.now();
    response.on("finish", () => {
      logger.info(
        {
          requestId: request.requestId,
          method: request.method,
          path: request.path,
          statusCode: response.statusCode,
          durationMs: Date.now() - startedAt
        },
        "Request completed"
      );
    });

    next();
  };
}
