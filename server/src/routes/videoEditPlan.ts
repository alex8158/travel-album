// Video edit plan generation route (P11.T4).
//
// Mounted at `/api`, owns:
//
//   POST /api/trips/:tripId/generate-edit-plan
//
// Pure planning endpoint — returns the plan JSON, never renders.
// The future P11.T5 render endpoint will consume this plan.
//
// Conventions match the other media-domain routes (P9.T8
// /api/videos / P8.T4 /api/media/:id/versions):
//   * `parseOrThrow(entityIdSchema)` on the path param (zod
//     rejects malformed tripId before touching the service).
//   * `asyncHandler` so any thrown AppError reaches the unified
//     error envelope.
//   * Service-layer zod validation on the body (`.strict()`
//     rejects unknown keys; closed enums reject unknown values).

import { Router } from "express";

import type { VideoEditPlanService } from "../media/index.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { entityIdSchema } from "../trips/index.js";
import { parseOrThrow } from "../util/zodParse.js";

export interface VideoEditPlanRouterDeps {
  readonly videoEditPlanService: VideoEditPlanService;
}

export function makeVideoEditPlanRouter(deps: VideoEditPlanRouterDeps): Router {
  const router = Router();

  // POST /api/trips/:tripId/generate-edit-plan
  //
  // Body (all fields optional):
  //   {
  //     "targetDurationSec"?: 1..3600,
  //     "style"?:             "short" | "standard" | "long",
  //     "mediaIds"?:          string[] (1..50),
  //     "audioMode"?:         "keep_original" | "mute" | "replace_with_library",
  //     "backgroundAudioId"?: string,
  //     "aspectRatio"?:       "16:9" | "9:16" | "1:1" | "4:5",
  //     "resolution"?:        "720p" | "1080p" | "4k"
  //   }
  //
  // 200 always (when zod + trip exist), with the plan JSON. Warnings
  // surface in `plan.warnings[]` rather than as HTTP errors — the
  // request is "build me a plan", and a plan with warnings is still
  // a usable plan.
  //
  // 404 when the trip is missing / soft-deleted (matches the
  // `GET /api/trips/:id` contract).
  // 400 when the body fails zod (unknown body key, unknown enum
  // value, out-of-range duration, etc.).
  router.post(
    "/trips/:tripId/generate-edit-plan",
    asyncHandler(async (req, res) => {
      const tripId = parseOrThrow(entityIdSchema, getTripIdParam(req.params), "tripId");
      const plan = await deps.videoEditPlanService.generatePlan(tripId, req.body ?? {});
      res.status(200).json(plan);
    }),
  );

  return router;
}

function getTripIdParam(params: Record<string, string | undefined>): string {
  return params.tripId ?? "";
}
