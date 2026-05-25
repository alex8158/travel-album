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

import type { AIProvider } from "../ai/index.js";
import { AppError } from "../errors/AppError.js";
import { ERROR_CODES } from "../errors/errorCodes.js";
import type { MediaService } from "../media/index.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { entityIdSchema } from "../trips/index.js";
import type { UploadService } from "../upload/index.js";
import { parseOrThrow } from "../util/zodParse.js";

export interface MediaRouterDeps {
  readonly uploadService: UploadService;
  readonly mediaService: MediaService;
  /**
   * P10.T3 — read at the `POST /api/media/:id/ai-refine` entry point
   * to gate availability. `available === false` short-circuits to
   * 501 + `AI_NOT_CONFIGURED` BEFORE touching the queue, so the
   * disabled default state (CLAUDE.md §2.8) cannot accidentally
   * enqueue jobs for a worker that will never run.
   */
  readonly aiProvider: AIProvider;
}

/**
 * Route-level query schema for `GET /api/trips/:tripId/media`.
 * Stricter than the Service-level `listMediaOptionsSchema` (which
 * caps limit at 200) — the public HTTP surface holds page sizes to
 * 1..100, same as the trips list route (P1.T3). Unknown query keys
 * are silently dropped (default zod `strip`) so future cache-busters
 * / instrumentation params don't trigger 400s here.
 *
 * `onlyDeleted` (P7.T4) is the public "recycle bin" knob. When true
 * the response contains ONLY soft-deleted media for this trip, ordered
 * by `deleted_at DESC`. We deliberately do NOT expose `includeDeleted`
 * at the route layer — that flag is the admin / combined view and
 * stays internal (mirrors the existing comment block in
 * `mediaSchemas.ts`). Default is `false`, so the regular gallery
 * endpoint keeps hiding deleted rows.
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
  onlyDeleted: z.coerce.boolean().default(false),
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

  // POST /api/media/:id/enhance (P8.T1).
  //
  // Enqueue an `image_enhance` job for one image media. Single-slot
  // enqueue (unlike reprocess, which covers two job types) — the
  // response is the flat `EnhanceMediaResult` envelope:
  //   * `outcome: "created"` — no prior row; one was inserted pending
  //   * `outcome: "reset"`   — terminal/retrying prior row flipped
  //                            back to retrying (P4.T2 R-40 path)
  //   * `outcome: "skipped"` — prior pending/running row left alone;
  //                            `reason` carries the explanation
  //
  // Always returns 200 on the enqueue. 404 when the media is missing
  // or soft-deleted (recycle-bin members cannot be enhanced; the
  // user must restore first). 400 when media.type !== 'image' (video
  // enhance is out of P8 scope per design.md §6.2.2; AI refine is
  // §7.10).
  //
  // Synchronous from the API's perspective: the actual sharp pipeline
  // is P8.T2 and runs in the image channel executor on the next
  // pending tick. P8.T1 only manipulates the queue.
  router.post(
    "/media/:id/enhance",
    asyncHandler((req, res) => {
      const id = parseOrThrow(entityIdSchema, getIdParam(req.params), "id");
      const result = deps.mediaService.enhanceMedia(id);
      res.status(200).json(result);
    }),
  );

  // POST /api/media/:id/ai-refine (P10.T3).
  //
  // Enqueue an `image_ai_refine` job for one image media. The
  // response mirrors `EnhanceMediaResult` — flat envelope with
  // `outcome`, `jobId`, optional `reason`.
  //
  // Availability gate (BEFORE touching the queue):
  //   * `AI_ENABLED=false` (default) ⇒ provider is the `NoopProvider`
  //     and `available === false`. Returns 501 + `AI_NOT_CONFIGURED`.
  //   * `AI_ENABLED=true` + unknown / unwired provider id ⇒ factory
  //     also returns `NoopProvider`. Same 501.
  //   * `available === true` ⇒ continue into the service.
  // The 501 status follows design.md §11.2 "功能未启用" rubric —
  // distinct from `BAD_REQUEST` (400) and `NOT_FOUND` (404), which
  // are domain errors raised by the service. P10.T7 acceptance
  // will surface the same condition via `/api/health`.
  //
  // Domain gates (in MediaService.aiRefineMedia):
  //   * Media missing or soft-deleted ⇒ 404. Recycle-bin members
  //     cannot be ai-refined; the user must restore first
  //     (matches the P7 contract used everywhere else).
  //   * Media not an image ⇒ 400. AI refine is image-only per
  //     requirements §7.10; video AI is design.md §8.3 (later
  //     phase) and `unknown`-typed media have no original bytes.
  //
  // Idempotency:
  //   * Latest `image_ai_refine` row is pending / running ⇒
  //     `outcome='skipped'`. The user cannot accidentally double-
  //     bill themselves with a frantic double-click.
  //   * Terminal-ish row ⇒ `outcome='reset'` (re-routes through
  //     `retrying`; P4.T2 R-40 canonical re-entry).
  //   * No prior row ⇒ `outcome='created'`.
  //
  // Synchronous from the API's POV: returns 200 once the row is
  // in the queue. P10.T3 ships the enqueue path only; the actual
  // AI handler is P10.T5.
  router.post(
    "/media/:id/ai-refine",
    asyncHandler((req, res) => {
      const id = parseOrThrow(entityIdSchema, getIdParam(req.params), "id");
      // R-122-aligned: an unknown / wrong AI_PROVIDER token falls
      // back to NoopProvider with `available === false`, so this
      // single check covers both "AI explicitly disabled" and
      // "AI enabled but no provider implemented yet".
      if (!deps.aiProvider.available) {
        throw new AppError(
          ERROR_CODES.AI_NOT_CONFIGURED,
          "AI provider is not configured. Set AI_ENABLED=true and a supported AI_PROVIDER to enable AI refine.",
          {
            statusCode: 501,
            details: {
              providerName: deps.aiProvider.name,
            },
          },
        );
      }
      const result = deps.mediaService.aiRefineMedia(id);
      res.status(200).json(result);
    }),
  );

  // GET /api/media/:id/versions (P8.T4).
  //
  // Returns the user-selectable versions for one media + the
  // currently-active one. Shape mirrors `MediaVersionsView`:
  //   { mediaId, activeVersionType, versions: [{ ... }] }
  //
  // Always includes a synthesized 'original' entry (even when no
  // bytes exist on disk, e.g. for `type='unknown'` rows — the entry
  // is still present so the UI can render "no original" instead of
  // hiding the row). 'enhanced' / 'ai_refined' entries are included
  // iff a matching media_versions row exists. Operational version
  // types (thumbnail, preview, metadata, video_*) are NOT included —
  // they are worker artefacts, not user-facing choices.
  //
  // 404 when the media is missing or soft-deleted (recycle-bin
  // members cannot have their versions listed — user must restore
  // first). Matches the P7 contract.
  router.get(
    "/media/:id/versions",
    asyncHandler((req, res) => {
      const id = parseOrThrow(entityIdSchema, getIdParam(req.params), "id");
      const result = deps.mediaService.listVersions(id);
      res.status(200).json(result);
    }),
  );

  // POST /api/media/:id/select-version (P8.T4).
  //
  // Body: `{ "versionType": "original" | "enhanced" | "ai_refined" }`.
  // Updates `media_items.active_version_type` and returns
  // `SelectVersionResult { mediaId, activeVersionType,
  // previousVersionType, alreadyActive }`.
  //
  // 400 on:
  //   * malformed body (zod via selectVersionBodySchema, .strict()).
  //   * versionType not in the closed enum.
  //   * version doesn't exist for this media (no media_versions
  //     row of the requested type, or originalPath is NULL when
  //     versionType='original').
  // 404 on missing or soft-deleted media (P7 contract).
  //
  // Idempotent: selecting the already-active version is a no-op
  // (no DB write); response carries `alreadyActive: true` so the
  // UI can decide whether to flash a toast.
  router.post(
    "/media/:id/select-version",
    asyncHandler((req, res) => {
      const id = parseOrThrow(entityIdSchema, getIdParam(req.params), "id");
      const result = deps.mediaService.selectVersion(id, req.body);
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
