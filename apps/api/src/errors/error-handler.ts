import type { ErrorRequestHandler, RequestHandler } from "express";
import type { Logger } from "pino";
import { ZodError } from "zod";
import { AppError } from "./app-error";

export function notFoundHandler(): RequestHandler {
  return (_request, response) => {
    response.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } });
  };
}

export function createErrorHandler(logger: Logger, isProduction: boolean): ErrorRequestHandler {
  return (error: unknown, request, response, _next) => {
    if (error instanceof ZodError) {
      response.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          details: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message
          }))
        }
      });
      return;
    }

    const parserStatus = getParserErrorStatus(error);
    if (parserStatus !== undefined) {
      response.status(parserStatus).json({
        error: {
          code: parserStatus === 413 ? "PAYLOAD_TOO_LARGE" : "INVALID_JSON",
          message: parserStatus === 413 ? "Request payload is too large" : "Request body is not valid JSON"
        }
      });
      return;
    }

    if (error instanceof AppError) {
      if (error.statusCode >= 500) {
        logger.error(
          { errorName: error.name, errorCode: error.code, requestId: request.requestId },
          "Request failed"
        );
      }

      response.status(error.statusCode).json({
        error: {
          code: error.code,
          message: error.expose ? error.message : "Internal server error"
        }
      });
      return;
    }

    logger.error(
      { errorName: error instanceof Error ? error.name : "UnknownError", requestId: request.requestId },
      "Unhandled request error"
    );
    response.status(500).json({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Internal server error",
        ...(isProduction ? {} : { requestId: request.requestId })
      }
    });
  };
}

function getParserErrorStatus(error: unknown): 400 | 413 | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return undefined;
  }

  const status: unknown = error.status;
  return status === 400 || status === 413 ? status : undefined;
}
