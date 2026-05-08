// Express app factory (P0.T6).
//
// Middleware order (matters):
//   1. express.json (small limit; tighten/expand per route in later tasks)
//   2. requestIdMiddleware  → req.requestId
//   3. requestLogger        → finish-event structured logs
//   4. application routes
//   5. notFoundHandler      → converts unmatched routes into NotFoundError
//   6. errorHandler         → renders unified error JSON
//
// Real business routes (Trip / Media / Duplicate / Video / Job, see
// docs/design.md §3.3) land in their own files starting with P1.T3.
//
// `/__debug/*` endpoints are deliberately gated to non-production so the
// P0.T6 verification can hit AppError and unknown-error paths without
// shipping demo handlers to production. They will be removed once real
// routes exist if no longer needed.

import express, { type Express } from "express";
import { AppError } from "./errors/AppError.js";
import { ERROR_CODES } from "./errors/errorCodes.js";
import type { Logger } from "./logger.js";
import { makeErrorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { requestIdMiddleware } from "./middleware/requestId.js";
import { makeRequestLogger } from "./middleware/requestLogger.js";

export interface CreateAppOptions {
  readonly logger: Logger;
  /**
   * Mount `/__debug/*` verification endpoints. Should be true only for
   * development/test environments — never in production.
   */
  readonly debugRoutes: boolean;
}

export function createApp(opts: CreateAppOptions): Express {
  const { logger, debugRoutes } = opts;

  const app = express();
  app.disable("x-powered-by");

  app.use(express.json({ limit: "1mb" }));
  app.use(requestIdMiddleware);
  app.use(makeRequestLogger(logger));

  // Minimal liveness probe. The richer health check that surfaces ffmpeg
  // availability and feature flags lands in P0.T8 at /api/health.
  app.get("/api/ping", (_req, res) => {
    res.json({ status: "ok", time: new Date().toISOString() });
  });

  if (debugRoutes) {
    // Demonstrates the AppError path: chosen status, code, message, details.
    app.get("/__debug/app-error", (_req, _res, next) => {
      next(
        new AppError(ERROR_CODES.BAD_REQUEST, "demo bad request", {
          statusCode: 400,
          details: { hint: "this route only exists when NODE_ENV !== production" },
        }),
      );
    });
    // Demonstrates the unknown-error path: must NOT leak the message or
    // stack to the client. The stack is only logged server-side.
    app.get("/__debug/throw", () => {
      throw new Error("demo unexpected error: secret stack info");
    });
  }

  app.use(notFoundHandler);
  app.use(makeErrorHandler(logger));

  return app;
}
