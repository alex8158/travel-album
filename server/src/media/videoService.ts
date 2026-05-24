// VideoService — business surface for the Video API (P9.T8).
//
// Owns the read + write paths backing:
//
//   GET   /api/media/:mediaId/video-segments
//   GET   /api/media/:mediaId/video-segments/:segmentId
//   PATCH /api/video-segments/:segmentId/user-decision
//   POST  /api/media/:mediaId/process-video-segments
//
// The Service follows the same conventions as `MediaService`:
//   * Every public method takes `unknown` so route handlers (and
//     future CLI / smoke callers) cannot bypass the zod pass.
//   * Successful returns are stable, JSON-friendly shapes the route
//     layer can `res.json()` directly.
//   * Misses raise AppError subclasses (NotFoundError /
//     BadRequestError) so the global error middleware renders the
//     unified envelope without per-route try/catch.
//   * P7 contract: every method reads parent `media_items` with
//     `findById` (active-only), so soft-deleted media surface as
//     404 here too. Segment rows survive a soft-delete on disk but
//     are NOT enumerable through this API until the parent is
//     restored.
//
// R-107 (closed by P9.T7) is fully respected here:
//   * `updateUserDecision` writes ONLY the `user_decision` column
//     via `videoSegmentsRepo.updateUserDecision()`; the scores +
//     waste classification remain untouched.
//   * `processVideoSegments` enqueues the `video_segments` worker
//     with the user-supplied `force` flag carried in the
//     `processing_jobs.payload` — `force: true` ⇒ user_decision is
//     wiped on the next re-slice; default ⇒ user_decision is
//     preserved via time-overlap mapping. The keyframes + quality
//     jobs do NOT carry the flag (they never write user_decision).

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { BadRequestError, NotFoundError } from "../errors/AppError.js";
import type { JobRepository } from "../jobs/jobRepository.js";
import type { KeyframeManifest } from "../jobs/videoKeyframesWorker.js";

// Job-type strings inlined here as VERBATIM copies of the workers'
// canonical `VIDEO_*_JOB_TYPE` constants. They are NOT imported
// because the workers value-import `videoSegmentMp4Path` from
// `../media/index.js`, while `media/index.js` re-exports this very
// file — a runtime circular initialization that puts the worker
// constants in TDZ when this module's top-level code runs.
//
// The strings are part of the closed `processing_jobs.job_type`
// vocabulary; a drift between these literals and the workers'
// exported constants would be caught by the existing
// smoke:video-* tests because they exercise the workers via the
// canonical exports and the JobQueue claims by exact string match.
const VIDEO_SEGMENTS_JOB_TYPE = "video_segments";
const VIDEO_KEYFRAMES_JOB_TYPE = "video_keyframes";
const VIDEO_SEGMENT_QUALITY_JOB_TYPE = "video_segment_quality";
import { entityIdSchema } from "../trips/index.js";
import { parseOrThrow } from "../util/zodParse.js";
import type { LocalStorageProvider } from "../storage/index.js";

import { MediaRepository } from "./mediaRepository.js";
import type { MediaItem } from "./mediaTypes.js";
import {
  processVideoSegmentsBodySchema,
  updateUserDecisionBodySchema,
} from "./videoSchemas.js";
import {
  VideoSegmentsRepository,
  videoSegmentMp4Path,
} from "./videoSegmentsRepository.js";
import type { VideoSegment, VideoSegmentUserDecision } from "./videoSegmentTypes.js";

// ---------------------------------------------------------------------------
// public response types
// ---------------------------------------------------------------------------

/**
 * Per-segment projection enriched with the canonical on-disk path
 * (`trips/{tripId}/derived/{mediaId}/segments/{id}.mp4`). The
 * `video_segments` schema deliberately omits a `file_path` column
 * (path is reconstructable; see P9.T1 design notes), so the API
 * layer materialises it here so the frontend doesn't need to
 * re-derive the convention on its side.
 */
export interface VideoSegmentView extends VideoSegment {
  /** Logical storage path for the segment MP4. */
  readonly filePath: string;
}

/**
 * Compact summary of the P9.T5 keyframes manifest. Carries the
 * fields a video player UI needs (frame timestamps + file paths)
 * without inlining the whole manifest. `null` when the keyframes
 * worker has not run yet for this media.
 */
export interface KeyframesSummary {
  readonly workerVersion: string;
  readonly intervalSec: number;
  readonly frameCount: number;
  readonly sourceDurationSec: number | null;
  readonly generatedAt: string;
  readonly frames: readonly {
    readonly index: number;
    readonly timestampSec: number;
    readonly filePath: string;
    readonly width: number;
    readonly height: number;
    readonly fileSize: number;
  }[];
}

export interface ListVideoSegmentsResult {
  readonly mediaId: string;
  /** Convenience copy of `media_items.duration` for the player UI. */
  readonly mediaDurationSec: number | null;
  readonly segments: readonly VideoSegmentView[];
  /** P9.T5 manifest summary, or `null` when keyframes haven't been
   * generated yet. The API never RECOMPUTES — only reads. */
  readonly keyframes: KeyframesSummary | null;
}

export interface VideoSegmentDetailResult {
  readonly mediaId: string;
  readonly segment: VideoSegmentView;
}

export interface UpdateUserDecisionResult {
  readonly segmentId: string;
  readonly mediaId: string;
  readonly previousUserDecision: VideoSegmentUserDecision;
  readonly userDecision: VideoSegmentUserDecision;
  /** True when the new value matches the previous one (no DB write). */
  readonly alreadyApplied: boolean;
  readonly updatedAt: string;
}

/** Outcome semantics mirror `MediaService.reprocess` slot results. */
export type ProcessSlotOutcome = "created" | "reset" | "skipped";
export interface ProcessSlotResult {
  readonly jobType: string;
  readonly outcome: ProcessSlotOutcome;
  readonly jobId: string;
  /** Set when outcome === 'skipped'; explains why. */
  readonly reason?: string;
}
export interface ProcessVideoSegmentsResult {
  readonly mediaId: string;
  /** Echoed back so the client can confirm the force flag was honoured. */
  readonly force: boolean;
  readonly results: readonly ProcessSlotResult[];
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

/** The three job types the process endpoint cycles. Order matches
 * the design.md §8.1 pipeline dependency: segments → keyframes →
 * segment_quality. */
const VIDEO_PROCESS_JOB_TYPES: readonly string[] = [
  VIDEO_SEGMENTS_JOB_TYPE,
  VIDEO_KEYFRAMES_JOB_TYPE,
  VIDEO_SEGMENT_QUALITY_JOB_TYPE,
] as const;

export class VideoService {
  constructor(
    private readonly mediaRepo: MediaRepository,
    private readonly videoSegmentsRepo: VideoSegmentsRepository,
    private readonly jobRepo: JobRepository,
    private readonly storage: LocalStorageProvider,
  ) {}

  /**
   * List every segment of one media + (when available) the
   * P9.T5 keyframes manifest. The media must exist, be active
   * (deleted_at IS NULL), and `type='video'`. An empty
   * `segments[]` is a valid response — it means P9.T6 has not
   * yet run for this media.
   */
  async listSegments(mediaIdInput: unknown): Promise<ListVideoSegmentsResult> {
    const media = this.requireActiveVideoMedia(mediaIdInput);
    const segments = this.videoSegmentsRepo.listByMediaId(media.id);
    const keyframes = await this.readKeyframesManifest(media);
    return {
      mediaId: media.id,
      mediaDurationSec: media.duration,
      segments: segments.map((s) => this.attachFilePath(s, media.tripId)),
      keyframes,
    };
  }

  /**
   * Fetch one segment by id with the parent media's identity
   * cross-checked. Throws when the segment is missing OR the
   * parent media is soft-deleted (P7 contract).
   */
  getSegmentDetail(segmentIdInput: unknown): VideoSegmentDetailResult {
    const safeSegmentId = parseOrThrow(entityIdSchema, segmentIdInput, "segmentId");
    const segment = this.videoSegmentsRepo.findById(safeSegmentId);
    if (segment === null) {
      throw new NotFoundError(`Video segment not found: ${safeSegmentId}`, {
        segmentId: safeSegmentId,
      });
    }
    // Cross-check parent media is alive (active-only read).
    const media = this.mediaRepo.findById(segment.mediaId);
    if (media === null) {
      throw new NotFoundError(
        `Video segment not found: ${safeSegmentId} (parent media missing or soft-deleted)`,
        { segmentId: safeSegmentId, mediaId: segment.mediaId },
      );
    }
    if (media.type !== "video") {
      // Defensive: a non-video media row should never own
      // video_segments rows, but if it does we refuse to surface
      // them to keep the API's type semantics clean.
      throw new NotFoundError(
        `Video segment not found: ${safeSegmentId} (parent media is not a video)`,
        { segmentId: safeSegmentId, mediaId: segment.mediaId, type: media.type },
      );
    }
    return {
      mediaId: media.id,
      segment: this.attachFilePath(segment, media.tripId),
    };
  }

  /**
   * PATCH `user_decision` on one segment. CLAUDE.md §3.9 fixes the
   * precedence: the user's choice outranks system recommendation,
   * and rescoring never overwrites it (see R-107 in progress.md).
   * Idempotent — re-sending the current value is a no-op
   * (`alreadyApplied: true`, no DB write).
   *
   * Throws:
   *   * `NotFoundError` — segment missing or parent media missing /
   *     soft-deleted / non-video.
   *   * `ValidationError` — body fails zod (missing / wrong enum
   *     value / unknown body key under `.strict()`).
   */
  updateUserDecision(
    segmentIdInput: unknown,
    body: unknown,
  ): UpdateUserDecisionResult {
    const safeSegmentId = parseOrThrow(entityIdSchema, segmentIdInput, "segmentId");
    const parsed = parseOrThrow(
      updateUserDecisionBodySchema,
      body,
      "request body",
    );
    const segment = this.videoSegmentsRepo.findById(safeSegmentId);
    if (segment === null) {
      throw new NotFoundError(`Video segment not found: ${safeSegmentId}`, {
        segmentId: safeSegmentId,
      });
    }
    const media = this.mediaRepo.findById(segment.mediaId);
    if (media === null) {
      throw new NotFoundError(
        `Video segment not found: ${safeSegmentId} (parent media missing or soft-deleted)`,
        { segmentId: safeSegmentId, mediaId: segment.mediaId },
      );
    }
    if (media.type !== "video") {
      throw new NotFoundError(
        `Video segment not found: ${safeSegmentId} (parent media is not a video)`,
        { segmentId: safeSegmentId, mediaId: segment.mediaId, type: media.type },
      );
    }

    const previous = segment.userDecision;
    if (previous === parsed.userDecision) {
      // No-op: skip the UPDATE so updated_at is preserved exactly.
      return {
        segmentId: safeSegmentId,
        mediaId: media.id,
        previousUserDecision: previous,
        userDecision: parsed.userDecision,
        alreadyApplied: true,
        updatedAt: segment.updatedAt,
      };
    }

    const now = new Date().toISOString();
    const changes = this.videoSegmentsRepo.updateUserDecision({
      id: safeSegmentId,
      userDecision: parsed.userDecision,
      now,
    });
    if (changes === 0) {
      // Shouldn't happen: we already verified the row above, and a
      // hard-delete via FK CASCADE would have raced the read. Treat
      // as a 404 with explanation so the caller can retry.
      throw new NotFoundError(
        `Video segment vanished between read and update: ${safeSegmentId}`,
        { segmentId: safeSegmentId, mediaId: media.id },
      );
    }
    return {
      segmentId: safeSegmentId,
      mediaId: media.id,
      previousUserDecision: previous,
      userDecision: parsed.userDecision,
      alreadyApplied: false,
      updatedAt: now,
    };
  }

  /**
   * Enqueue the three video-pipeline jobs for one media:
   *   * `video_segments`  (P9.T6 — fixed-duration slicing)
   *   * `video_keyframes` (P9.T5 — fixed-interval frame extraction)
   *   * `video_segment_quality` (P9.T7 — per-segment scoring)
   *
   * Idempotency mirrors `MediaService.reprocess`:
   *   * "created"  — no prior job existed; one was inserted as pending
   *   * "reset"    — prior failed / success / retrying / cancelled
   *                  row was flipped back to retrying
   *   * "skipped"  — prior pending / running row left alone
   *
   * Ordering: the JobQueue claim SQL is
   * `ORDER BY created_at ASC, id ASC`. Since this method may insert
   * three rows in the same millisecond, the queue's tie-break by
   * (random UUID) `id` would otherwise pick them in arbitrary
   * order. We stamp each slot with a monotonically increasing
   * `createdAt` (millisecond offset) so the queue claims segments
   * → keyframes → quality in dependency order. A late-arriving
   * quality job that runs before segments / keyframes succeed
   * would simply fail "no segments to score" / "manifest missing"
   * and retry via the retry budget — but with this ordering it
   * normally won't have to.
   *
   * The `force` flag (default false) is JSON-encoded into the
   * `video_segments` slot's `payload` column only. The segments
   * worker reads it and threads it through to
   * `replaceAllForMedia({ force })`, controlling whether the
   * R-107 user_decision time-overlap mapping fires (force=false,
   * default) or whether user_decision is wiped along with the
   * old rows (force=true, "operator explicitly asks for a clean
   * reanalysis"). The keyframes + quality slots NEVER carry the
   * flag — they don't write user_decision.
   *
   * Throws:
   *   * `NotFoundError` — media missing / soft-deleted.
   *   * `BadRequestError` — `media.type !== 'video'`.
   *   * `ValidationError` — body fails zod under `.strict()`.
   */
  processVideoSegments(
    mediaIdInput: unknown,
    body: unknown = {},
  ): ProcessVideoSegmentsResult {
    const media = this.requireActiveVideoMedia(mediaIdInput, {
      onNonVideoCode: "bad-request",
    });
    const parsed = parseOrThrow(
      processVideoSegmentsBodySchema,
      body,
      "request body",
    );
    const force = parsed.force ?? false;

    const baseMs = Date.now();
    const results: ProcessSlotResult[] = [];
    for (let i = 0; i < VIDEO_PROCESS_JOB_TYPES.length; i += 1) {
      const jobType = VIDEO_PROCESS_JOB_TYPES[i]!;
      const now = new Date(baseMs + i).toISOString();
      // Only the segments slot carries the force payload; keyframes
      // and quality do not touch user_decision so the flag is
      // semantically meaningless to them.
      const payload =
        force && jobType === VIDEO_SEGMENTS_JOB_TYPE
          ? JSON.stringify({ force: true })
          : null;
      results.push(this.enqueueOneJobType(media.id, jobType, now, payload));
    }
    return { mediaId: media.id, force, results };
  }

  // -------------------------------------------------------------------------
  // private helpers
  // -------------------------------------------------------------------------

  private requireActiveVideoMedia(
    mediaIdInput: unknown,
    options: { readonly onNonVideoCode?: "not-found" | "bad-request" } = {},
  ): MediaItem {
    const safeId = parseOrThrow(entityIdSchema, mediaIdInput, "mediaId");
    const media = this.mediaRepo.findById(safeId);
    if (media === null) {
      throw new NotFoundError(`Media not found: ${safeId}`, { id: safeId });
    }
    if (media.type !== "video") {
      const onNonVideoCode = options.onNonVideoCode ?? "not-found";
      // For LIST/GET we 404 — the URL path implies "this is a video";
      // we don't want to surface non-video rows on this endpoint.
      // For the process endpoint we 400 so the operator gets a
      // clearer "wrong tool" signal (matches `enhanceMedia`'s 400
      // for non-image media).
      if (onNonVideoCode === "bad-request") {
        throw new BadRequestError(
          `process-video-segments is only supported for video media; this row is '${media.type}'`,
          { mediaId: safeId, type: media.type },
        );
      }
      throw new NotFoundError(
        `Video media not found: ${safeId} (this row is '${media.type}')`,
        { id: safeId, type: media.type },
      );
    }
    return media;
  }

  private attachFilePath(segment: VideoSegment, tripId: string): VideoSegmentView {
    return {
      ...segment,
      filePath: videoSegmentMp4Path({
        tripId,
        mediaId: segment.mediaId,
        segmentId: segment.id,
      }),
    };
  }

  private async readKeyframesManifest(
    media: MediaItem,
  ): Promise<KeyframesSummary | null> {
    const manifestRel = `trips/${media.tripId}/derived/${media.id}/frames/manifest.json`;
    const manifestAbs = path.join(this.storage.root, manifestRel);
    let raw: string;
    try {
      raw = await readFile(manifestAbs, "utf8");
    } catch (err) {
      if (isENOENT(err)) return null;
      // Any other IO error is genuinely unexpected — surface as a
      // 500 via the global error handler.
      throw err;
    }
    let parsed: KeyframeManifest;
    try {
      parsed = JSON.parse(raw) as KeyframeManifest;
    } catch (err) {
      // Corrupt manifest on disk — treat as "no manifest" rather
      // than failing the whole list endpoint, so the gallery can
      // still render the segments list while the operator fixes
      // the manifest.
      void err;
      return null;
    }
    if (!Array.isArray(parsed.frames)) return null;
    return {
      workerVersion: parsed.workerVersion,
      intervalSec: parsed.intervalSec,
      frameCount: parsed.frameCount,
      sourceDurationSec: parsed.sourceDurationSec,
      generatedAt: parsed.generatedAt,
      frames: parsed.frames.map((f) => ({
        index: f.index,
        timestampSec: f.timestampSec,
        filePath: f.filePath,
        width: f.width,
        height: f.height,
        fileSize: f.fileSize,
      })),
    };
  }

  private enqueueOneJobType(
    mediaId: string,
    jobType: string,
    now: string,
    payload: string | null,
  ): ProcessSlotResult {
    const latest = this.jobRepo.findLatestByMediaIdAndType(mediaId, jobType);
    if (latest === null) {
      const jobId = randomUUID();
      this.jobRepo.insert({
        id: jobId,
        mediaId,
        jobType,
        payload,
        createdAt: now,
        updatedAt: now,
      });
      return { jobType, outcome: "created", jobId };
    }
    if (latest.status === "pending" || latest.status === "running") {
      // Active — don't double-queue. The executor will drain.
      return {
        jobType,
        outcome: "skipped",
        jobId: latest.id,
        reason: `already ${latest.status}`,
      };
    }
    // Terminal-ish (failed / success / retrying / cancelled).
    //
    // Plain `resetToRetrying` does NOT update the payload — so a
    // prior force=false row stays force=false on retry. To honour
    // the new `force` flag we insert a fresh row (mirrors what
    // `force: true` semantics require: a clean re-slice). The old
    // row stays untouched, ordered before the new one by
    // (created_at, id); the JobQueue picks the new pending one
    // first, the stale terminal row is ignored.
    if (payload !== null) {
      const jobId = randomUUID();
      this.jobRepo.insert({
        id: jobId,
        mediaId,
        jobType,
        payload,
        createdAt: now,
        updatedAt: now,
      });
      return { jobType, outcome: "created", jobId };
    }
    const changes = this.jobRepo.resetToRetrying(latest.id, now);
    if (changes === 0) {
      return {
        jobType,
        outcome: "skipped",
        jobId: latest.id,
        reason: "row no longer eligible for reset (raced with executor)",
      };
    }
    return { jobType, outcome: "reset", jobId: latest.id };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isENOENT(err: unknown): boolean {
  return (
    err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}
