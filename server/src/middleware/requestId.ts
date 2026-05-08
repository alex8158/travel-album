// requestId middleware (P0.T6).
//
// - If the inbound request carries a sane `x-request-id` header (≤ 128
//   chars), use it as-is so callers can correlate across services.
// - Otherwise, mint a fresh UUID via Node's built-in randomUUID.
// - Always echo the chosen value back in the response header.
// - Attach to `req.requestId` so the request logger and the error
//   handler can include it in their structured output.

import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const HEADER_NAME = "x-request-id";
const MAX_INBOUND_ID_LENGTH = 128;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers[HEADER_NAME];
  let id: string;
  if (
    typeof incoming === "string" &&
    incoming.length > 0 &&
    incoming.length <= MAX_INBOUND_ID_LENGTH
  ) {
    id = incoming;
  } else {
    id = randomUUID();
  }
  req.requestId = id;
  res.setHeader(HEADER_NAME, id);
  next();
}
