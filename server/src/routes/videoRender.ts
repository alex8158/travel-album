// Video render route (P11.T5).
//
// Mounted at `/api`, owns:
//
//   POST /api/trips/:tripId/render
//
// Enqueues a `video_render` job and returns immediately — the
// actual ffmpeg work runs on the video channel executor on its
// next tick. The client polls `GET /api/jobs/:id` to follow
// progress.
//
// Conventions match the rest of the API surface:
//   * `parseOrThrow(entityIdSchema)` on the tripId path param.
//   * `asyncHandler` so any thrown AppError reaches the unified
//     error envelope.
//   * Service-layer zod validation on the body (`.strict()`
//     rejects unknown keys).

import { Router } from "express";

import type { VideoRenderService } from "../media/index.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { entityIdSchema } from "../trips/index.js";
import { parseOrThrow } from "../util/zodParse.js";

export interface VideoRenderRouterDeps {
  readonly videoRenderService: VideoRenderService;
}

export function makeVideoRenderRouter(deps: VideoRenderRouterDeps): Router {
  const router = Router();

  // POST /api/trips/:tripId/render
  //
  // Body (all fields optional):
  //   {
  //     "planId"?:    string  (uses latest plan when omitted),
  //     "mode"?:      "preview" | "final"  (default "final"),
  //     "overwrite"?: boolean  (default false; true → fresh job row)
  //   }
  //
  // Responses:
  //   200 — { tripId, planId, mediaId, jobId, mode, outcome, reason? }
  //   404 — trip missing/soft-deleted OR (planId given and missing) OR
  //         (no planId and trip has no plans yet)
  //   400 — body fails zod / plan has 0 clips / clips[0] media missing
  router.post(
    "/trips/:tripId/render",
    asyncHandler((req, res) => {
      const tripId = parseOrThrow(entityIdSchema, getTripIdParam(req.params), "tripId");
      const result = deps.videoRenderService.renderTrip(tripId, req.body ?? {});
      res.status(200).json(result);
    }),
  );

  return router;
}

function getTripIdParam(params: Record<string, string | undefined>): string {
  return params.tripId ?? "";
}
