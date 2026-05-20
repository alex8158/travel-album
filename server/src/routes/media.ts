// Media routes (P2.T4 upload + P2.T5 read).
//
// Mounted at `/api`, so this file owns:
//
//   POST /api/trips/:tripId/media/upload     (P2.T4, requirements §9.2)
//   GET  /api/trips/:tripId/media            (P2.T5, requirements §9.2)
//   GET  /api/media/:id                      (P2.T5, requirements §9.2)
//
// P7.T1 added soft-delete; P7.T2 added restore:
//
//   DELETE /api/media/:id                    (P7.T1, requirements §7.18)
//   POST   /api/media/:id/restore            (P7.T2, requirements §7.18)
//
// Originals / thumbnails / previews stay on disk through both
// (CLAUDE.md §2.4 / design.md §4.3).
//
// Path note: the canonical paths come from requirements §9.2 + design.md
// §3.3. The Trip CRUD router is mounted at `/api/trips`, so this
// router is mounted at `/api` to avoid path collisions between the
// two.

import { Router } from "express";
import { z } from "zod";

import type { MediaService } from "../media/index.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { entityIdSchema } from "../trips/index.js";
import type { UploadService } from "../upload/index.js";
import { parseOrThrow } from "../util/zodParse.js";

export interface MediaRouterDeps {
  readonly uploadService: UploadService;
  readonly mediaService: MediaService;
}

/**
 * Route-level query schema for `GET /api/trips/:tripId/media`.
 * Stricter than the Service-level `listMediaOptionsSchema` (which
 * caps limit at 200) — the public HTTP surface holds page sizes to
 * 1..100, same as the trips list route (P1.T3). Unknown query keys
 * are silently dropped (default zod `strip`) so future cache-busters
 * / instrumentation params don't trigger 400s here.
 */
const listMediaQuerySchema = z.object({
  limit: z.coerce
    .number({ invalid_type_error: "limit must be a number" })
    .int("limit must be an integer")
    .min(1, "limit must be >= 1")
    .max(100, "limit must be <= 100")
    .default(50),
  offset: z.coerce
    .number({ invalid_type_error: "offset must be a number" })
    .int("offset must be an integer")
    .nonnegative("offset must be >= 0")
    .default(0),
});

export function makeMediaRouter(deps: MediaRouterDeps): Router {
  const router = Router();

  // POST /api/trips/:tripId/media/upload — multipart upload (P2.T4).
  // Always 200 unless the whole request is invalid (trip missing →
  // 404, empty payload → 400). Per-file errors live in
  // response.results[] (design.md §3.3).
  router.post(
    "/trips/:tripId/media/upload",
    asyncHandler(async (req, res) => {
      const tripId = parseOrThrow(entityIdSchema, getTripIdParam(req.params), "tripId");
      const result = await deps.uploadService.handleUpload({
        tripId,
        headers: req.headers,
        body: req,
      });
      res.status(200).json(result);
    }),
  );

  // GET /api/trips/:tripId/media — list active media for a trip (P2.T5).
  // 404 when the trip is missing or soft-deleted (mirrors
  // GET /api/trips/:id). Pagination defaults: limit=50, offset=0.
  router.get(
    "/trips/:tripId/media",
    asyncHandler((req, res) => {
      const tripId = parseOrThrow(entityIdSchema, getTripIdParam(req.params), "tripId");
      const query = parseOrThrow(listMediaQuerySchema, req.query, "query parameters");
      const media = deps.mediaService.listMediaForTrip(tripId, query);
      res.json({ media });
    }),
  );

  // GET /api/media/:id — fetch a single media item by id (P2.T5 + P3.T6).
  // 404 for missing / soft-deleted rows. Does NOT cross-check the
  // owning trip's deletion state — direct fetches by id should still
  // work even if the trip was later soft-deleted (the media row
  // itself is the source of truth here).
  //
  // P3.T6 bundles the media_versions rows alongside the media row
  // under `versions`. Top-level shape `{ media, versions }` keeps
  // `MediaItem` type-clean and matches the response type
  // `MediaDetail`. The list endpoint above intentionally does NOT
  // carry versions (keeps Gallery payload small).
  router.get(
    "/media/:id",
    asyncHandler((req, res) => {
      const id = parseOrThrow(entityIdSchema, getIdParam(req.params), "id");
      const detail = deps.mediaService.getMediaDetailById(id);
      res.json(detail);
    }),
  );

  // POST /api/media/:id/reprocess (P3.T7).
  //
  // Re-queue the image-channel jobs (`image_thumbnail`, `image_metadata`)
  // for one media. Each slot independently resolves to:
  //   * "created" — no prior job existed; one was inserted as pending
  //   * "reset"   — prior failed / success / retrying / cancelled row
  //                 was flipped back to pending
  //   * "skipped" — prior pending / running row left alone
  //                 (or lost a write race; see `reason`)
  //
  // Always returns 200 with `{ mediaId, results: [...] }`.
  // 404 when the media is missing / soft-deleted.
  // 400 when the media is not an image (video reprocess lives in P9).
  //
  // Synchronous from the API's perspective: the actual work is left
  // for the P3.T2 executor to drain on its next tick — this endpoint
  // only manipulates the queue.
  router.post(
    "/media/:id/reprocess",
    asyncHandler((req, res) => {
      const id = parseOrThrow(entityIdSchema, getIdParam(req.params), "id");
      const result = deps.mediaService.reprocess(id);
      res.status(200).json(result);
    }),
  );

  // DELETE /api/media/:id — soft delete (P7.T1).
  //
  // Writes `media_items.deleted_at` + flips `status` to 'deleted';
  // clears any `duplicate_groups.recommended_media_id` pointing at
  // this media; clears any `trips.cover_media_id` pointing at it
  // and releases the user-pin so the auto-cover selector can
  // immediately pick a substitute. Files on disk are NOT removed
  // (CLAUDE.md §2.4 / design.md §4.3).
  //
  // Idempotent: 200 on already-soft-deleted media (with
  // `alreadyDeleted: true`); 404 only when the row is genuinely
  // missing.
  router.delete(
    "/media/:id",
    asyncHandler((req, res) => {
      const id = parseOrThrow(entityIdSchema, getIdParam(req.params), "id");
      const result = deps.mediaService.softDeleteMedia(id);
      res.status(200).json(result);
    }),
  );

  // POST /api/media/:id/restore — restore a soft-deleted media (P7.T2).
  //
  // Clears `deleted_at` + resets `status` to 'processed', then
  // enqueues a trip-scope `quality_selector_run` job so the restored
  // media is re-considered by dedup ranking (skipping user-confirmed
  // groups) and the trip cover auto-refresh runs.
  //
  // Idempotent: 200 on already-active media (with
  // `alreadyRestored: true`); 404 only when the row is genuinely
  // missing.
  router.post(
    "/media/:id/restore",
    asyncHandler((req, res) => {
      const id = parseOrThrow(entityIdSchema, getIdParam(req.params), "id");
      const result = deps.mediaService.restoreMedia(id);
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
 * noUncheckedIndexedAccess. The route definition guarantees `:tripId`
 * is present; coalesce to "" so the value is always a string and
 * entityIdSchema renders a clean VALIDATION_FAILED if the value is
 * somehow blank.
 */
function getTripIdParam(params: Record<string, string | undefined>): string {
  return params.tripId ?? "";
}

function getIdParam(params: Record<string, string | undefined>): string {
  return params.id ?? "";
}
