// Request logger middleware (P0.T6).
//
// Emits one structured log line per completed response with:
//   - requestId   (set by requestIdMiddleware, must run before this)
//   - method
//   - path        (originalUrl, includes query string)
//   - statusCode
//   - durationMs  (high-resolution monotonic timing)
//
// Log level is chosen per status: 5xx → error, 4xx → warn, else info.
// This mirrors the convention used by most HTTP access logs and lets
// alerting filter on level alone.

import type { NextFunction, Request, Response } from "express";
import type { Logger } from "../logger.js";

const NS_PER_MS = 1_000_000n;

export function makeRequestLogger(logger: Logger) {
  return function requestLogger(req: Request, res: Response, next: NextFunction): void {
    const startNs = process.hrtime.bigint();

    res.on("finish", () => {
      const durationMs = Number((process.hrtime.bigint() - startNs) / NS_PER_MS);
      const fields = {
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        durationMs,
      };

      if (res.statusCode >= 500) {
        logger.error(fields, "request completed");
      } else if (res.statusCode >= 400) {
        logger.warn(fields, "request completed");
      } else {
        logger.info(fields, "request completed");
      }
    });

    next();
  };
}
