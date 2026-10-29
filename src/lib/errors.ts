/**
 * Application error hierarchy. Every error carries a stable machine-readable `code` and maps to
 * exactly one HTTP status in the central error handler (see src/http/error-handler.ts).
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** 400 – malformed or invalid input. */
export class ValidationError extends AppError {
  constructor(message: string, details?: unknown, code = 'VALIDATION_ERROR') {
    super(400, code, message, details);
  }
}

/** 401 – missing or invalid credentials. */
export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, 'UNAUTHORIZED', message);
  }
}

/** 404 – resource does not exist (or is not visible to the caller). */
export class NotFoundError extends AppError {
  constructor(message: string, code = 'NOT_FOUND') {
    super(404, code, message);
  }
}

/** 409 – idempotency conflicts and invalid state transitions. */
export class ConflictError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(409, code, message, details);
  }
}

/** 422 – well-formed request that violates a business rule (funds, position, minimums). */
export class BusinessRuleError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(422, code, message, details);
  }
}

/** 503 – trading temporarily unavailable (circuit breaker, no market data). */
export class ServiceUnavailableError extends AppError {
  constructor(
    code: string,
    message: string,
    readonly retryAfterSeconds?: number,
    details?: unknown,
  ) {
    super(503, code, message, details);
  }
}
