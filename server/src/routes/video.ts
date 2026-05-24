// Video API routes (P9.T8).
//
// Mounted at `/api`, so this router owns:
//
//   GET   /api/media/:mediaId/video-segments
//   GET   /api/media/:mediaId/video-segments/:segmentId
//   PATCH /api/video-segments/:segmentId/user-decision
//   POST  /api/media/:mediaId/process-video-segments
//
// Mirrors the conventions of `routes/media.ts` (P2.T5 / P8.T4):
//   * One `Router` per file, mounted under `/api`.
//   * Service-layer validation via `parseOrThrow(entityIdSchema)` for
//     path params; zod-driven body validation lives on the service so
//     malformed bodies surface as a single `ValidationError` through
//     the global error middleware.
//   * `asyncHandler` so any thrown AppError reaches the unified
//     error envelope.
//   * Active-only reads at the Service layer (P7 contract). Recycle-bin
//     media surface as 404 here so a soft-deleted video's segments
//     cannot be enumerated or mutated until the parent is restored.

import { Router } from "express";

import { NotFoundError } from "../errors/AppError.js";
import type { VideoService } from "../media/index.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { entityIdSchema } from "../trips/index.js";
import { parseOrThrow } from "../util/zodParse.js";

export interface VideoRouterDeps {
  readonly videoService: VideoService;
}

export function makeVideoRouter(deps: VideoRouterDeps): Router {
  const router = Router();

  // GET /api/media/:mediaId/video-segments
  //
  // List all segments for one media plus the P9.T5 keyframes
  // manifest summary (when present on disk). Response shape:
  //   {
  //     mediaId,
  //     mediaDurationSec,
  //     segments: [{ ...VideoSegment, filePath }],
  //     keyframes: { workerVersion, intervalSec, frameCount,
  //                  sourceDurationSec, generatedAt, frames }
  //                | null
  //   }
  //
  // 404 when the media is missing / soft-deleted / non-video.
  // Returns 200 with `segments: []` when the media is a video but
  // P9.T6 has not yet produced segments — the empty array is a
  // valid, expected response for "pipeline still pending".
  router.get(
    "/media/:mediaId/video-segments",
    asyncHandler(async (req, res) => {
      const mediaId = parseOrThrow(entityIdSchema, getMediaIdParam(req.params), "mediaId");
      const result = await deps.videoService.listSegments(mediaId);
      res.status(200).json(result);
    }),
  );

  // GET /api/media/:mediaId/video-segments/:segmentId
  //
  // Fetch one segment by id. The `:mediaId` path component is for
  // URL cosmetics + RBAC future-proofing; the service cross-checks
  // that the segment really does belong to that media so a
  // forged URL like
  // `/api/media/{otherMedia}/video-segments/{realSegment}` returns
  // 404 instead of silently returning the segment from the wrong
  // parent. Response shape: `{ mediaId, segment }`.
  //
  // 404 when:
  //   * segment id missing
  //   * parent media missing / soft-deleted / non-video
  //   * segment.media_id !== :mediaId
  router.get(
    "/media/:mediaId/video-segments/:segmentId",
    asyncHandler((req, res) => {
      const mediaId = parseOrThrow(entityIdSchema, getMediaIdParam(req.params), "mediaId");
      const segmentId = parseOrThrow(
        entityIdSchema,
        getSegmentIdParam(req.params),
        "segmentId",
      );
      const result = deps.videoService.getSegmentDetail(segmentId);
      if (result.mediaId !== mediaId) {
        // Mismatched URL — pretend the segment doesn't exist
        // under THIS media (which is true from the caller's
        // POV). Matches the "no enumeration across parents"
        // principle of the rest of the API.
        throw new NotFoundError(
          `Video segment not found under media ${mediaId}: ${segmentId}`,
          { mediaId, segmentId, actualMediaId: result.mediaId },
        );
      }
      res.status(200).json(result);
    }),
  );

  // PATCH /api/video-segments/:segmentId/user-decision
  //
  // Body: `{ "userDecision": "keep" | "remove" | "undecided" }`.
  // Response shape:
  //   {
  //     segmentId, mediaId,
  //     previousUserDecision, userDecision,
  //     alreadyApplied, updatedAt
  //   }
  //
  // 200 on success. Idempotent — sending the current value is a
  // no-op (alreadyApplied=true; no DB write; updatedAt is the
  // previous value).
  // 400 on malformed body (zod .strict()): unknown body keys,
  // missing userDecision, or unknown enum value.
  // 404 on segment / media missing / soft-deleted / non-video.
  router.patch(
    "/video-segments/:segmentId/user-decision",
    asyncHandler((req, res) => {
      const segmentId = parseOrThrow(
        entityIdSchema,
        getSegmentIdParam(req.params),
        "segmentId",
      );
      const result = deps.videoService.updateUserDecision(segmentId, req.body);
      res.status(200).json(result);
    }),
  );

  // POST /api/media/:mediaId/process-video-segments
  //
  // Body: `{ "force"?: boolean }` (default false).
  //   * `force=false` (default): re-run the pipeline; the segments
  //     worker preserves any non-`undecided` user_decision via the
  //     R-107 time-overlap mapping.
  //   * `force=true`: operator explicitly asks for a clean
  //     reanalysis; user_decision is wiped along with the old rows.
  //
  // Response shape:
  //   { mediaId, force, results: [{ jobType, outcome, jobId, reason? }] }
  //
  // The three job types cycled (in this order) are:
  //   1. `video_segments`        (P9.T6)
  //   2. `video_keyframes`       (P9.T5)
  //   3. `video_segment_quality` (P9.T7)
  //
  // Idempotency: per-slot outcomes mirror `MediaService.reprocess`:
  //   * created — no prior job existed; a pending row was inserted
  //   * reset   — prior terminal-ish row flipped to retrying (when
  //               force=false; preserves the same job id)
  //   * skipped — prior pending/running row left alone
  //
  // When `force=true` the segments slot always inserts a NEW row
  // (the worker reads its `payload`, which `resetToRetrying` does
  // NOT change), so a re-issued force=true creates a fresh job —
  // this is intentional: the operator explicitly opted into
  // re-running with new semantics.
  //
  // Synchronous from the API's POV: returns 200 once the rows are
  // in the queue. The actual ffmpeg work happens in the video
  // channel executor on its next tick.
  //
  // 404 on missing / soft-deleted media. 400 on `media.type !==
  // 'video'` or malformed body.
  router.post(
    "/media/:mediaId/process-video-segments",
    asyncHandler((req, res) => {
      const mediaId = parseOrThrow(entityIdSchema, getMediaIdParam(req.params), "mediaId");
      const result = deps.videoService.processVideoSegments(mediaId, req.body ?? {});
      res.status(200).json(result);
    }),
  );

  return router;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function getMediaIdParam(params: Record<string, string | undefined>): string {
  return params.mediaId ?? "";
}

function getSegmentIdParam(params: Record<string, string | undefined>): string {
  return params.segmentId ?? "";
}
