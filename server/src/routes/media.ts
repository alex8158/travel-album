// Media routes (P2.T4 scope: upload only).
//
// Mounted at `/api`, so this file owns:
//
//   POST /api/trips/:tripId/media/upload    (requirements §9.2)
//
// The read side of §9.2 (`GET /api/trips/:tripId/media`,
// `GET /api/media/:id`) lands in P2.T5; the soft-delete / restore /
// reprocess endpoints land in their respective phases. Until then this
// router contains the single POST.
//
// Path note: the canonical path per requirements §9.2 + design.md §3.3
// is `.../media/upload`. The Trip CRUD router is mounted at
// `/api/trips`, so this router is mounted at `/api` to avoid path
// collisions between the two.

import { Router } from "express";

import { asyncHandler } from "../middleware/asyncHandler.js";
import { entityIdSchema } from "../trips/index.js";
import type { UploadService } from "../upload/index.js";
import { parseOrThrow } from "../util/zodParse.js";

export interface MediaRouterDeps {
  readonly uploadService: UploadService;
}

export function makeMediaRouter(deps: MediaRouterDeps): Router {
  const router = Router();

  // POST /api/trips/:tripId/media/upload — accept multipart/form-data
  // with one or more file parts. Always 200 unless the whole request is
  // invalid (trip missing → 404, empty payload → 400, multipart parse
  // error → 400/500). Per-file errors live in the response body's
  // `results[]` (design.md §3.3).
  router.post(
    "/trips/:tripId/media/upload",
    asyncHandler(async (req, res) => {
      const rawTripId = getTripIdParam(req.params);
      const tripId = parseOrThrow(entityIdSchema, rawTripId, "tripId");
      const result = await deps.uploadService.handleUpload({
        tripId,
        headers: req.headers,
        body: req,
      });
      res.status(200).json(result);
    }),
  );

  return router;
}

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
