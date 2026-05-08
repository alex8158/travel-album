// asyncHandler middleware (P1.T3).
//
// Express 4 only forwards thrown errors to the error pipeline when the
// route handler is synchronous. An `async` route that rejects bypasses
// the global error handler and surfaces as an `unhandledRejection`,
// which P0.T6 logs but does NOT translate into a unified JSON
// response. Wrap async handlers in this helper so the rejection feeds
// through next() the same way a sync throw would.
//
// Usage:
//   router.get("/foo", asyncHandler(async (req, res) => {
//     const data = await someService.load(req.params.id);
//     res.json({ data });
//   }));
//
// The wrapper accepts handlers that return a Promise OR sync handlers
// (returning unknown), so it can be applied uniformly across a router.

import type { NextFunction, Request, RequestHandler, Response } from "express";

type MaybeAsyncHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<unknown> | unknown;

export function asyncHandler(fn: MaybeAsyncHandler): RequestHandler {
  return (req, res, next) => {
    try {
      Promise.resolve(fn(req, res, next)).catch(next);
    } catch (err) {
      // Defensive: a sync throw before the async path begins also
      // funnels through next() so we never bypass the error pipeline.
      next(err);
    }
  };
}
