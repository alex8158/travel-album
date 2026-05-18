// Dedup API routes (P5.T5 + P5.T6).
//
// Mounted at `/api`. Owns the per-trip dedup invocation endpoints
// and the read endpoints backing the duplicate-groups UI:
//
//   POST /api/trips/:tripId/dedup/exact         — DedupEngine.runExactForTrip
//   POST /api/trips/:tripId/dedup/similar       — DedupEngine.runSimilarForTrip
//   POST /api/trips/:tripId/dedup/run           — exact then similar
//   GET  /api/trips/:tripId/duplicate-groups    — list groups + items + media
//   GET  /api/duplicate-groups/:id              — single group + items + media
//
// Path-binding rules:
//   * `tripId` ALWAYS comes from the URL path; there is no body
//     selector that can broaden the scope to other trips.
//   * Body for `/similar` and `/run` only accepts an optional
//     `hammingThreshold` integer in [0, 64].
//
// Errors flow through the global error middleware:
//   * 400 VALIDATION_FAILED — malformed tripId / bad body
//   * 404 NOT_FOUND         — trip / group missing or soft-deleted
//   * 500 INTERNAL_ERROR    — unexpected, swallowed message
//
// All handlers wrap in `asyncHandler` so a thrown AppError reaches
// the unified error envelope (same convention as routes/jobs.ts).

import { Router } from "express";

import type { DedupService } from "../dedup/index.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

export interface DedupRouterDeps {
  readonly service: DedupService;
}

export function makeDedupRouter(deps: DedupRouterDeps): Router {
  const router = Router();
  const { service } = deps;

  router.post(
    "/trips/:tripId/dedup/exact",
    asyncHandler((req, res) => {
      const result = service.runExact(getTripIdParam(req.params));
      res.status(200).json(result);
    }),
  );

  router.post(
    "/trips/:tripId/dedup/similar",
    asyncHandler((req, res) => {
      const result = service.runSimilar(getTripIdParam(req.params), req.body);
      res.status(200).json(result);
    }),
  );

  router.post(
    "/trips/:tripId/dedup/run",
    asyncHandler((req, res) => {
      const result = service.runAll(getTripIdParam(req.params), req.body);
      res.status(200).json(result);
    }),
  );

  // P5.T6 read endpoints — back the frontend duplicate group list /
  // detail pages. Synchronous DB read, no side effects.
  router.get(
    "/trips/:tripId/duplicate-groups",
    asyncHandler((req, res) => {
      const result = service.listForTrip(getTripIdParam(req.params));
      res.status(200).json(result);
    }),
  );

  router.get(
    "/duplicate-groups/:id",
    asyncHandler((req, res) => {
      const result = service.getById(getIdParam(req.params));
      res.status(200).json(result);
    }),
  );

  return router;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Pull `tripId` out of `req.params` while satisfying
 * `noUncheckedIndexedAccess`. The route definition guarantees
 * `:tripId`, but TS doesn't know; coalesce to "" so the Service's
 * `entityIdSchema` surfaces a clean VALIDATION_FAILED if blank.
 */
function getTripIdParam(params: Record<string, string | undefined>): string {
  return params.tripId ?? "";
}

function getIdParam(params: Record<string, string | undefined>): string {
  return params.id ?? "";
}
