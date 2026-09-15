export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly expose: boolean;

  public constructor(statusCode: number, code: string, message: string, expose = true) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.expose = expose;
  }
}

export class AuthenticationError extends AppError {
  public constructor(message = "Authentication required") {
    super(401, "AUTHENTICATION_REQUIRED", message);
  }
}

export class ConflictError extends AppError {
  public constructor(code: string, message: string) {
    super(409, code, message);
  }
}

export class NotFoundError extends AppError {
  public constructor(resource: string) {
    super(404, "NOT_FOUND", `${resource} not found`);
  }
}

