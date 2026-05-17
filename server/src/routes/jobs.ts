// Job API routes (P4.T4).
//
// Mounted at `/api/jobs`. Backs:
//
//   GET    /api/jobs              — filtered + paginated list
//   GET    /api/jobs/:id          — single job
//   POST   /api/jobs/:id/retry    — manual retry (failed/success/cancelled/retrying → retrying)
//   POST   /api/jobs/:id/cancel   — manual cancel (pending/retrying/running → cancelled)
//
// Filters on GET /api/jobs (all optional, AND-combined):
//   * status   — one of pending/running/success/failed/retrying/cancelled
//   * jobType  — exact match (e.g. "image_thumbnail")
//   * mediaId  — exact match
//   * tripId   — joins through media_items.trip_id
//   * limit    — 1..100, default 50
//   * offset   — >=0,    default 0
//
// Responses:
//   * GET single / retry / cancel → `{ job: JobView }`.
//   * GET list                    → `{ jobs: JobView[] }`.
//   * Errors are rendered by the global error middleware (P0.T6)
//     using the AppError code carried by the thrown error:
//       - NotFoundError              → 404 NOT_FOUND
//       - ValidationError            → 400 VALIDATION_FAILED
//       - INVALID_STATE_TRANSITION   → 400 / 409 (race-loss case)
//
// All handlers go through `asyncHandler` so a thrown AppError reaches
// the global error pipeline (same convention as Trip / Media routes).
// The router is otherwise a thin pass-through — domain rules live in
// `JobService`.

import { Router } from "express";

import type { JobService } from "../jobs/index.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

export interface JobsRouterDeps {
  readonly service: JobService;
}

export function makeJobsRouter(deps: JobsRouterDeps): Router {
  const router = Router();
  const { service } = deps;

  // GET /api/jobs — filtered + paginated list.
  router.get(
    "/",
    asyncHandler((req, res) => {
      const jobs = service.listJobs(req.query);
      res.json({ jobs });
    }),
  );

  // GET /api/jobs/:id — fetch a single job by id.
  router.get(
    "/:id",
    asyncHandler((req, res) => {
      const job = service.getJobById(getIdParam(req.params));
      res.json({ job });
    }),
  );

  // POST /api/jobs/:id/retry — flip a terminal-ish row back to
  // `retrying` so the JobQueue picks it up on its next tick. Does
  // NOT execute the handler in-line — control stays with the
  // scheduler so concurrency caps + the §4.3 state graph are
  // observed end-to-end.
  router.post(
    "/:id/retry",
    asyncHandler((req, res) => {
      const job = service.retryJob(getIdParam(req.params));
      res.status(200).json({ job });
    }),
  );

  // POST /api/jobs/:id/cancel — flip a non-terminal row to `cancelled`.
  // For `running` rows we do NOT kill the in-flight handler: the
  // status flag becomes the source of truth, and when the handler
  // later tries markSuccess/markFailed/markRetrying those `WHERE
  // status='running'` guards turn into no-ops.
  router.post(
    "/:id/cancel",
    asyncHandler((req, res) => {
      const job = service.cancelJob(getIdParam(req.params));
      res.status(200).json({ job });
    }),
  );

  return router;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Pull `id` out of `req.params` while satisfying
 * noUncheckedIndexedAccess. The route definition guarantees `:id`,
 * but TS doesn't know; coalesce to "" so JobService.entityIdSchema
 * surfaces a clean VALIDATION_FAILED if somehow blank.
 */
function getIdParam(params: Record<string, string | undefined>): string {
  return params.id ?? "";
}
