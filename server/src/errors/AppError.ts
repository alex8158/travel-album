// AppError base class (P0.T6).
//
// Anything that should produce a controlled HTTP response should throw
// (or `next()`) an AppError. The error handler middleware reads `code`,
// `statusCode`, and `details` directly to build the JSON response.
//
// Unknown errors (anything that is NOT an AppError) are treated as bugs:
// they are logged with full stack and rendered as INTERNAL_ERROR with a
// generic message — never leaking implementation details to the client.

import { ERROR_CODES, type ErrorCode } from "./errorCodes.js";

export interface AppErrorOptions {
  /** HTTP status code; defaults to 500 if omitted. */
  readonly statusCode?: number | undefined;
  /** Extra structured detail safe to expose to clients. */
  readonly details?: Record<string, unknown> | undefined;
  /** Original error to chain (sets `Error.prototype.cause`). */
  readonly cause?: unknown;
}

export class AppError extends Error {
  override readonly name: string = "AppError";
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, opts: AppErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.code = code;
    this.statusCode = opts.statusCode ?? 500;
    this.details = opts.details;
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found", details?: Record<string, unknown>) {
    super(ERROR_CODES.NOT_FOUND, message, { statusCode: 404, details });
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Bad request", details?: Record<string, unknown>) {
    super(ERROR_CODES.BAD_REQUEST, message, { statusCode: 400, details });
  }
}

export class ValidationError extends AppError {
  constructor(message = "Validation failed", details?: Record<string, unknown>) {
    super(ERROR_CODES.VALIDATION_FAILED, message, { statusCode: 422, details });
  }
}
