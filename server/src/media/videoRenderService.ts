// VideoRenderService — business surface for the P11.T5 render
// endpoint `POST /api/trips/:tripId/render`.
//
// Responsibilities:
//   * Validate the body via zod (`renderTripBodySchema`).
//   * Resolve the trip via `TripService.getTripById` (404 mapping).
//   * Resolve the plan: explicit `planId` or "latest for this trip"
//     fallback; 404 with `EDIT_PLAN_NOT_FOUND` when nothing
//     matches.
//   * Validate the plan can actually be rendered:
//       - has at least one clip
//       - clips[0].mediaId still exists + is active video media
//         (the worker also checks; the service surface gives a
//         friendlier 400 up-front)
//   * Enqueue a `video_render` job with the planId + mode + force
//     flag in the payload. Synchronous-from-HTTP — actual ffmpeg
//     work runs on the video channel executor.
//
// Red lines (P11.T5 prompt):
//   * NEVER renders inline. The HTTP request enqueues a job and
//     returns; the worker does the heavy lifting on the video
//     channel (CLAUDE.md §3.6).
//   * Idempotent re-renders: per-trip `(media_id='clips[0].mediaId',
//     job_type='video_render')` flows through the same
//     created/reset/skipped pattern used by enhance / aiRefine /
//     optimize. `overwrite=true` inserts a fresh row instead of
//     reusing the previous job id.

import { randomUUID } from "node:crypto";

import { AppError, BadRequestError } from "../errors/AppError.js";
import { ERROR_CODES } from "../errors/errorCodes.js";
import type { JobRepository } from "../jobs/jobRepository.js";
import type { Logger } from "../logger.js";
import { entityIdSchema, type TripService } from "../trips/index.js";
import { parseOrThrow } from "../util/zodParse.js";

import { EditPlansRepository } from "./editPlansRepository.js";
import { MediaRepository } from "./mediaRepository.js";
import type { VideoEditPlan } from "./videoEditPlan.js";
import { renderTripBodySchema } from "./videoRenderSchemas.js";

/** Closed job_type constant for the render worker. Inlined here
 * to avoid the same cross-module circular import the video
 * pipeline already documents (workers value-import storage
 * helpers from `media/index.js`; mirror that convention). */
export const VIDEO_RENDER_JOB_TYPE = "video_render";

/** Outcome of {@link VideoRenderService.renderTrip}. Mirrors the
 * `ReprocessOutcome` from `MediaService.enhanceMedia` etc.:
 *   * `created` — no prior job; one inserted as pending
 *   * `reset`   — prior terminal-ish row flipped to retrying
 *   * `skipped` — prior pending/running row left alone
 *   * `forced`  — `overwrite=true` inserted a fresh job (new id)
 */
export type RenderTripOutcome = "created" | "reset" | "skipped" | "forced";

export interface RenderTripResult {
  readonly tripId: string;
  readonly planId: string;
  /** First clip's mediaId — also the row the `video_render` job is
   * keyed on AND the parent of the future `media_versions(version_type='edited')`
   * row. Surfaced so the client can correlate with the
   * `processing_jobs` row. */
  readonly mediaId: string;
  readonly jobId: string;
  readonly mode: "preview" | "final";
  readonly outcome: RenderTripOutcome;
  /** Present when outcome === 'skipped'. */
  readonly reason?: string;
}

/** Worker payload schema written to `processing_jobs.payload`. The
 * P11.T5 worker reads this and resolves the plan / media itself
 * (the row may be claimed by a different process / tick than the
 * one that enqueued). */
export interface VideoRenderJobPayload {
  readonly planId: string;
  readonly mode: "preview" | "final";
  readonly force: boolean;
}

export interface VideoRenderServiceDeps {
  readonly tripService: TripService;
  readonly mediaRepo: MediaRepository;
  readonly editPlansRepo: EditPlansRepository;
  readonly jobRepo: JobRepository;
  readonly logger?: Logger;
}

export class VideoRenderService {
  constructor(private readonly deps: VideoRenderServiceDeps) {}

  /**
   * Enqueue a render job for one trip's edit plan. Returns once
   * the queue row is in place — does NOT block on the actual
   * ffmpeg encode.
   *
   * Throws:
   *   * `NotFoundError` — trip missing / soft-deleted (matches
   *     `GET /api/trips/:id`).
   *   * `AppError(EDIT_PLAN_NOT_FOUND, 404)` — when planId is
   *     supplied but no row matches, OR when planId is omitted
   *     and the trip has no plans.
   *   * `BadRequestError` — plan has 0 clips (no source video to
   *     render) OR the first clip's media row is missing /
   *     soft-deleted / non-video.
   *   * `ValidationError` — body fails zod under `.strict()`.
   */
  renderTrip(tripIdInput: unknown, bodyInput: unknown): RenderTripResult {
    // ---- 1. Validate inputs ------------------------------------------
    const tripId = parseOrThrow(entityIdSchema, tripIdInput, "tripId");
    const body = parseOrThrow(renderTripBodySchema, bodyInput ?? {}, "request body");

    // 404 on missing trip via TripService (consistent error envelope).
    this.deps.tripService.getTripById(tripId);

    // ---- 2. Resolve the plan ------------------------------------------
    const planRow =
      body.planId !== undefined
        ? this.deps.editPlansRepo.findById(body.planId)
        : this.deps.editPlansRepo.findLatestByTripId(tripId);

    if (planRow === null) {
      const message =
        body.planId !== undefined
          ? `Edit plan not found: ${body.planId}`
          : `No edit plan exists for this trip; generate one first via POST /api/trips/${tripId}/generate-edit-plan`;
      throw new AppError(ERROR_CODES.EDIT_PLAN_NOT_FOUND, message, {
        statusCode: 404,
        details: body.planId !== undefined ? { planId: body.planId, tripId } : { tripId },
      });
    }

    if (planRow.tripId !== tripId) {
      // Defensive: an explicit planId pointing at a different
      // trip's plan. We refuse rather than render a stranger's
      // content under this trip's namespace.
      throw new AppError(
        ERROR_CODES.EDIT_PLAN_NOT_FOUND,
        "Edit plan does not belong to this trip",
        {
          statusCode: 404,
          details: { planId: planRow.id, tripId, actualTripId: planRow.tripId },
        },
      );
    }

    // ---- 3. Parse plan + sanity check it has content -----------------
    let plan: VideoEditPlan;
    try {
      plan = JSON.parse(planRow.planJson) as VideoEditPlan;
    } catch (err) {
      // Corrupt JSON on disk → infra-level error. Surface as 500
      // through the catch-all middleware (re-throw without
      // wrapping in an AppError so the unified envelope shows
      // INTERNAL_SERVER_ERROR).
      throw new Error(
        `edit_plans.plan_json is not valid JSON for plan ${planRow.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!Array.isArray(plan.clips) || plan.clips.length === 0) {
      throw new BadRequestError(
        `Edit plan ${planRow.id} has no clips to render; regenerate the plan with valid source videos`,
        { planId: planRow.id, tripId },
      );
    }

    const firstClip = plan.clips[0]!;
    const firstMediaId = firstClip.mediaId;

    // ---- 4. Verify first clip's media still exists --------------------
    // The worker also re-checks this, but rejecting early gives a
    // friendlier 400 instead of a queue-side 'failed' job the user
    // has to poll for.
    const firstMedia = this.deps.mediaRepo.findById(firstMediaId);
    if (firstMedia === null) {
      throw new BadRequestError(
        `Edit plan ${planRow.id} references a media row that no longer exists: ${firstMediaId}`,
        { planId: planRow.id, mediaId: firstMediaId },
      );
    }
    if (firstMedia.type !== "video") {
      throw new BadRequestError(
        `Edit plan ${planRow.id}'s first clip references a non-video media (type='${firstMedia.type}')`,
        { planId: planRow.id, mediaId: firstMediaId, type: firstMedia.type },
      );
    }

    // ---- 5. Enqueue --------------------------------------------------
    const mode: "preview" | "final" = body.mode ?? "final";
    const force = body.overwrite === true;
    const payload: VideoRenderJobPayload = {
      planId: planRow.id,
      mode,
      force,
    };
    const payloadJson = JSON.stringify(payload);
    const now = new Date().toISOString();

    let outcome: RenderTripOutcome;
    let jobId: string;
    let reason: string | undefined;

    if (force) {
      // Always insert a fresh row (mirrors P9.T8 segments force=true).
      jobId = randomUUID();
      this.deps.jobRepo.insert({
        id: jobId,
        mediaId: firstMediaId,
        jobType: VIDEO_RENDER_JOB_TYPE,
        payload: payloadJson,
        createdAt: now,
        updatedAt: now,
      });
      outcome = "forced";
    } else {
      const latest = this.deps.jobRepo.findLatestByMediaIdAndType(
        firstMediaId,
        VIDEO_RENDER_JOB_TYPE,
      );
      if (latest === null) {
        jobId = randomUUID();
        this.deps.jobRepo.insert({
          id: jobId,
          mediaId: firstMediaId,
          jobType: VIDEO_RENDER_JOB_TYPE,
          payload: payloadJson,
          createdAt: now,
          updatedAt: now,
        });
        outcome = "created";
      } else if (latest.status === "pending" || latest.status === "running") {
        jobId = latest.id;
        outcome = "skipped";
        reason = `already ${latest.status}`;
      } else {
        // Terminal-ish (success / failed / retrying / cancelled).
        // resetToRetrying does NOT touch payload, but since the
        // worker reads the plan fresh by planId every tick, the
        // stale payload from the first attempt is fine — the
        // worker uses (planId, mode) from the row. Only `force`
        // semantics change between attempts and force=false rows
        // always agree.
        const changes = this.deps.jobRepo.resetToRetrying(latest.id, now);
        if (changes === 0) {
          jobId = latest.id;
          outcome = "skipped";
          reason = "row no longer eligible for reset (raced with executor)";
        } else {
          jobId = latest.id;
          outcome = "reset";
        }
      }
    }

    this.deps.logger?.info(
      {
        tripId,
        planId: planRow.id,
        mediaId: firstMediaId,
        jobId,
        outcome,
        mode,
        force,
      },
      "video-render: enqueued",
    );

    return reason !== undefined
      ? {
          tripId,
          planId: planRow.id,
          mediaId: firstMediaId,
          jobId,
          mode,
          outcome,
          reason,
        }
      : {
          tripId,
          planId: planRow.id,
          mediaId: firstMediaId,
          jobId,
          mode,
          outcome,
        };
  }
}
