// VideoEditPlanService — business surface backing
// `POST /api/trips/:tripId/generate-edit-plan` (P11.T4).
//
// Responsibilities:
//   * Validate the request body via zod (`generateEditPlanBodySchema`).
//   * Resolve the trip (404 when missing / soft-deleted, via
//     `TripService.getTripById`).
//   * Resolve video candidates: from `mediaIds` when supplied, else
//     "every active video media in the trip". Filter out
//     non-video / null-duration / null-originalPath rows + emit
//     per-row warnings without throwing.
//   * Resolve the background audio (when requested): look up by id
//     in `audio_library`; null / inactive → warning + fallback.
//   * Compose the audio policy via `resolveAudioPolicy`.
//   * Build the plan via `buildEditPlan`.
//   * (Optional) feed the plan through `aiRefinePlan(noop)` — V1
//     this is always a pass-through, gated by
//     `config.video.editPlan.aiEnabled`.
//
// Red lines (P11.T4 prompt):
//   * No render — NEVER calls ffmpeg, NEVER writes `processing_jobs`,
//     NEVER writes `media_versions`.
//   * No real AI — the refiner interface is reserved but never sees
//     a real model in V1.
//   * Soft-deleted trips → 404 (P7 contract).
//   * Soft-deleted media silently skipped (not enumerable through
//     the candidate path); the warning lists "media not found"
//     uniformly for both "missing" and "soft-deleted" since the
//     external caller can't tell them apart anyway.

import type { Logger } from "../logger.js";
import { entityIdSchema, type TripService } from "../trips/index.js";
import { parseOrThrow } from "../util/zodParse.js";

import { randomUUID } from "node:crypto";

import { AudioLibraryRepository, type AudioLibraryView } from "./audioLibraryRepository.js";
import { EditPlansRepository } from "./editPlansRepository.js";
import { MediaRepository } from "./mediaRepository.js";
import type { MediaItem } from "./mediaTypes.js";
import {
  buildEditPlan,
  EDIT_PLAN_DEFAULT_ASPECT_RATIO,
  EDIT_PLAN_DEFAULT_RESOLUTION,
  EDIT_PLAN_DEFAULT_STYLE,
  EDIT_PLAN_STYLE_TARGETS,
  noopPlanRefiner,
  resolveAudioPolicy,
  type AiRefinePlanRefiner,
  type EditPlanAspectRatio,
  type EditPlanCandidate,
  type EditPlanResolution,
  type EditPlanStyle,
  type EditPlanWarning,
  type VideoEditPlan,
} from "./videoEditPlan.js";
import { generateEditPlanBodySchema } from "./videoEditPlanSchemas.js";

/** Service-construction deps. */
export interface VideoEditPlanServiceDeps {
  readonly tripService: TripService;
  readonly mediaRepo: MediaRepository;
  readonly audioLibraryRepo: AudioLibraryRepository;
  /** P11.T5 — persists generated plans so the render endpoint
   * can find them by id later. The service ALWAYS persists,
   * regardless of `aiEnabled`; render-without-persist is not a
   * supported flow in V1 (the renderer needs a stable plan
   * source). */
  readonly editPlansRepo: EditPlansRepository;
  /** Default fade / loudnorm values flowed from `config.video.audio.*`. */
  readonly audioDefaults: {
    readonly loudnormEnabled: boolean;
    readonly fadeInSeconds: number;
    readonly fadeOutSeconds: number;
  };
  /** `config.video.editPlan.aiEnabled`. When true, the future
   * `refiner` injected on the constructor (or via per-call options)
   * is consulted. V1 default is `false` → noop refiner. */
  readonly aiEnabled: boolean;
  /** Optional AI refiner. When omitted the service uses
   * `noopPlanRefiner` regardless of `aiEnabled` (defence-in-depth:
   * even an aiEnabled=true deployment without a real refiner stays
   * on the no-op path). */
  readonly refiner?: AiRefinePlanRefiner;
  /** Optional structured logger. */
  readonly logger?: Logger;
}

/** Per-call options for {@link VideoEditPlanService.generatePlan}. */
export interface GeneratePlanOptions {
  /** Clock override (smokes / tests). Default `() => new Date()`. */
  readonly now?: () => Date;
}

/** Bound on `MediaRepository.list` page size. Plans rarely use more
 * than a handful of clips; 200 covers the largest reasonable trip
 * while bounding the work. */
const TRIP_VIDEO_FETCH_LIMIT = 200;

export class VideoEditPlanService {
  constructor(private readonly deps: VideoEditPlanServiceDeps) {}

  /**
   * Generate an edit plan. NEVER renders, never writes any DB row
   * (read-only); returns the plan as a JSON-serialisable object.
   *
   * Throws:
   *   * `NotFoundError` — trip missing / soft-deleted (matches the
   *     `GET /api/trips/:id` contract for parity).
   *   * `ValidationError` — body fails the zod schema (.strict()
   *     rejects unknown keys; closed enums reject unknown values).
   */
  async generatePlan(
    tripIdInput: unknown,
    bodyInput: unknown,
    options: GeneratePlanOptions = {},
  ): Promise<VideoEditPlan> {
    // ---- Validate inputs ---------------------------------------------
    const tripId = parseOrThrow(entityIdSchema, tripIdInput, "tripId");
    const body = parseOrThrow(generateEditPlanBodySchema, bodyInput ?? {}, "request body");

    // 404 on missing / soft-deleted trip (delegated to TripService
    // so the error envelope matches `GET /api/trips/:id`).
    this.deps.tripService.getTripById(tripId);

    // ---- Resolve style + target duration ------------------------------
    const style: EditPlanStyle = body.style ?? EDIT_PLAN_DEFAULT_STYLE;
    const styleTarget = EDIT_PLAN_STYLE_TARGETS[style];
    const targetDurationSec = body.targetDurationSec ?? styleTarget;

    // ---- Resolve candidates -------------------------------------------
    const candidatesResult = body.mediaIds
      ? this.resolveCandidatesFromIds(body.mediaIds, tripId)
      : this.resolveCandidatesFromTrip(tripId);
    const candidates = candidatesResult.candidates;
    const candidateWarnings = candidatesResult.warnings;

    // ---- Resolve background audio (if requested) ----------------------
    const audioResult = this.resolveBackgroundAudio({
      ...(body.audioMode !== undefined ? { requestedMode: body.audioMode } : {}),
      ...(body.backgroundAudioId !== undefined
        ? { requestedBackgroundAudioId: body.backgroundAudioId }
        : {}),
    });

    // ---- Compose audio policy ----------------------------------------
    const audioPolicyResult = resolveAudioPolicy({
      ...(body.audioMode !== undefined ? { requestedMode: body.audioMode } : {}),
      ...(body.backgroundAudioId !== undefined
        ? { requestedBackgroundAudioId: body.backgroundAudioId }
        : {}),
      backgroundAudio: audioResult.audio,
      targetDurationSec,
      defaults: {
        loudnorm: this.deps.audioDefaults.loudnormEnabled,
        fadeInSeconds: this.deps.audioDefaults.fadeInSeconds,
        fadeOutSeconds: this.deps.audioDefaults.fadeOutSeconds,
      },
    });

    // ---- Build the plan ----------------------------------------------
    const aspectRatio: EditPlanAspectRatio = body.aspectRatio ?? EDIT_PLAN_DEFAULT_ASPECT_RATIO;
    const resolution: EditPlanResolution = body.resolution ?? EDIT_PLAN_DEFAULT_RESOLUTION;

    const priorWarnings: EditPlanWarning[] = [
      ...candidateWarnings,
      ...audioResult.warnings,
      ...audioPolicyResult.warnings,
    ];

    const baseInput = {
      tripId,
      style,
      targetDurationSec,
      aspectRatio,
      resolution,
      candidates,
      audioPolicy: audioPolicyResult.policy,
      priorWarnings,
    };
    const plan = buildEditPlan(
      options.now !== undefined ? { ...baseInput, now: options.now } : baseInput,
    );

    // ---- Optional AI refinement (V1: noop) ---------------------------
    // `aiEnabled=false` (V1 default) → noop refiner. Even when
    // aiEnabled=true the constructor MUST supply an explicit
    // refiner; otherwise we still stay on the noop path to
    // preserve "AI default-off" red line.
    const refiner =
      this.deps.aiEnabled && this.deps.refiner !== undefined ? this.deps.refiner : noopPlanRefiner;
    const refined = await refiner.refine({ plan });

    // P11.T5 — persist the plan so `POST /api/trips/:tripId/render`
    // can find it by id (or as "latest for this trip") later.
    // The persisted JSON contains the `id` field too so a future
    // read can round-trip back to the same shape. We do this AFTER
    // the AI refiner — refined plans deserve to be persisted just
    // like rule-engine plans.
    const planId = randomUUID();
    const planWithId: VideoEditPlan = { ...refined, id: planId };
    this.deps.editPlansRepo.insert({
      id: planId,
      tripId: planWithId.tripId,
      planJson: JSON.stringify(planWithId),
      targetDurationSec: planWithId.targetDurationSec,
      style: planWithId.style,
      now: planWithId.createdAt,
    });

    this.deps.logger?.info(
      {
        tripId,
        planId,
        style,
        targetDurationSec,
        clipCount: planWithId.clips.length,
        warningCount: planWithId.warnings.length,
        audioMode: planWithId.audioPolicy.mode,
        aiRefined: planWithId.aiRefined,
      },
      "video-edit-plan: generated + persisted",
    );

    return planWithId;
  }

  // -------------------------------------------------------------------------
  // private helpers
  // -------------------------------------------------------------------------

  /** Resolve `mediaIds` → candidate list. Per-id warnings for
   * missing / non-video / cross-trip / null-duration / null-path. */
  private resolveCandidatesFromIds(
    mediaIds: readonly string[],
    tripId: string,
  ): { candidates: readonly EditPlanCandidate[]; warnings: readonly EditPlanWarning[] } {
    const warnings: EditPlanWarning[] = [];
    const candidates: EditPlanCandidate[] = [];
    for (const id of mediaIds) {
      const media = this.deps.mediaRepo.findById(id);
      if (media === null) {
        warnings.push({
          code: "media_not_found",
          message: `Media not found or soft-deleted: ${id}`,
          mediaId: id,
        });
        continue;
      }
      if (media.tripId !== tripId) {
        // Treat cross-trip refs as "not found" for security:
        // refusing to enumerate other trips' media.
        warnings.push({
          code: "media_not_found",
          message: `Media ${id} does not belong to this trip; skipping`,
          mediaId: id,
        });
        continue;
      }
      const c = this.classifyCandidate(media);
      if (c !== null) candidates.push(c);
      else warnings.push(...this.classifyWarning(media));
    }
    return { candidates, warnings };
  }

  /** Resolve "every active video media in the trip" → candidate
   * list. Order matches `MediaRepository.list` (by `created_at DESC`),
   * mirroring the gallery view; if a future iteration wants
   * "chronological order by capture time" it can re-sort here. */
  private resolveCandidatesFromTrip(tripId: string): {
    candidates: readonly EditPlanCandidate[];
    warnings: readonly EditPlanWarning[];
  } {
    const warnings: EditPlanWarning[] = [];
    const allMedia = this.deps.mediaRepo.list(tripId, { limit: TRIP_VIDEO_FETCH_LIMIT });
    const candidates: EditPlanCandidate[] = [];
    for (const media of allMedia) {
      if (media.type !== "video") continue; // silent skip — gallery has images too
      const c = this.classifyCandidate(media);
      if (c !== null) candidates.push(c);
      else warnings.push(...this.classifyWarning(media));
    }
    return { candidates, warnings };
  }

  /** Project a `MediaItem` into an `EditPlanCandidate`, or null
   * when the row doesn't satisfy the basic preconditions. Caller
   * pairs this with `classifyWarning` to emit the appropriate
   * warning code on the null path. */
  private classifyCandidate(media: MediaItem): EditPlanCandidate | null {
    if (media.type !== "video") return null;
    if (media.originalPath === null || media.originalPath.length === 0) return null;
    if (media.duration === null || media.duration <= 0) return null;
    return { media, durationSec: media.duration };
  }

  /** Emit the warning code(s) explaining why a media row didn't
   * make it as a candidate. Caller already filtered out hidden
   * cases (`type !== 'video'` is silent in trip-mode but warns in
   * explicit-mediaIds mode); the warnings here cover the loud
   * preconditions. */
  private classifyWarning(media: MediaItem): readonly EditPlanWarning[] {
    if (media.type !== "video") {
      return [
        {
          code: "media_not_video",
          message: `Media ${media.id} is of type '${media.type}', not 'video'`,
          mediaId: media.id,
          details: { type: media.type },
        },
      ];
    }
    if (media.originalPath === null || media.originalPath.length === 0) {
      return [
        {
          code: "media_missing_path",
          message: `Media ${media.id} has no original_path on disk`,
          mediaId: media.id,
        },
      ];
    }
    if (media.duration === null || media.duration <= 0) {
      return [
        {
          code: "media_missing_duration",
          message: `Media ${media.id} has no duration metadata (video_metadata worker may not have run yet)`,
          mediaId: media.id,
        },
      ];
    }
    return [];
  }

  /** Look up the requested background audio. The two failure modes
   * (`background_audio_not_found` and `background_audio_inactive`)
   * are reported with distinct codes so the future UI can render
   * a precise error. */
  private resolveBackgroundAudio(args: {
    readonly requestedMode?: string;
    readonly requestedBackgroundAudioId?: string;
  }): { audio: AudioLibraryView | null; warnings: readonly EditPlanWarning[] } {
    const warnings: EditPlanWarning[] = [];
    const id = args.requestedBackgroundAudioId;
    if (id === undefined || id.length === 0) {
      // No background audio requested → no audio lookup needed.
      // The resolver will mark mode keep_original / mute as appropriate.
      return { audio: null, warnings };
    }
    const row = this.deps.audioLibraryRepo.findById(id);
    if (row === null) {
      warnings.push({
        code: "background_audio_not_found",
        message: `Background audio ${id} not found; falling back to keep_original.`,
        audioId: id,
      });
      return { audio: null, warnings };
    }
    if (!row.isActive) {
      warnings.push({
        code: "background_audio_inactive",
        message: `Background audio ${id} ('${row.displayName}') is inactive; falling back to keep_original.`,
        audioId: id,
      });
      return { audio: null, warnings };
    }
    return { audio: row, warnings };
  }
}
