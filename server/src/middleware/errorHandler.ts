// Error handler & 404 middleware (P0.T6).
//
// Pipeline expectations:
//   - requestIdMiddleware must run first so every response can include
//     the requestId in both the body and the x-request-id header.
//   - notFoundHandler is mounted AFTER all real routes; it converts the
//     "no route matched" condition into a NotFoundError that flows into
//     the error handler.
//   - makeErrorHandler returns a 4-arity function so Express recognises
//     it as an error-handling middleware.
//
// Response shape (per task spec):
//   {
//     "error": {
//       "code":      "INTERNAL_ERROR",
//       "message":   "...",
//       "requestId": "...",
//       "details":   { ... }   // optional; only present for AppError with details
//     }
//   }

import type { NextFunction, Request, Response } from "express";
import { AppError, NotFoundError } from "../errors/AppError.js";
import { ERROR_CODES } from "../errors/errorCodes.js";
import type { Logger } from "../logger.js";

interface ErrorResponseBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(
    new NotFoundError(`Route not found: ${req.method} ${req.originalUrl}`, {
      method: req.method,
      path: req.originalUrl,
    }),
  );
}

export function makeErrorHandler(logger: Logger) {
  return function errorHandler(
    err: unknown,
    req: Request,
    res: Response,
    _next: NextFunction,
  ): void {
    // Branch 1: a controlled AppError. Render its fields as-is.
    if (err instanceof AppError) {
      logger.warn(
        {
          requestId: req.requestId,
          code: err.code,
          statusCode: err.statusCode,
          method: req.method,
          path: req.originalUrl,
          details: err.details,
        },
        err.message,
      );
      const body: ErrorResponseBody = {
        error: {
          code: err.code,
          message: err.message,
          requestId: req.requestId,
        },
      };
      if (err.details !== undefined) {
        body.error.details = err.details;
      }
      res.status(err.statusCode).json(body);
      return;
    }

    // Branch 2: an unexpected error. Log the FULL detail server-side
    // (including stack), but never include those internals in the response.
    const realErr = err instanceof Error ? err : new Error(String(err));
    logger.error(
      {
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl,
        err: {
          name: realErr.name,
          message: realErr.message,
          stack: realErr.stack,
        },
      },
      "unhandled error",
    );

    const body: ErrorResponseBody = {
      error: {
        code: ERROR_CODES.INTERNAL_ERROR,
        message: "Internal server error",
        requestId: req.requestId,
      },
    };
    res.status(500).json(body);
  };
}
