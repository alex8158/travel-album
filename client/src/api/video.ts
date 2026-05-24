// Video API client (P9.T9 — consumes the P9.T8 server endpoints).
//
// Mirrors the server's `VideoService` response shapes
// (server/src/media/videoService.ts) for the four endpoints:
//
//   GET   /api/media/:mediaId/video-segments
//   GET   /api/media/:mediaId/video-segments/:segmentId
//   PATCH /api/video-segments/:segmentId/user-decision
//   POST  /api/media/:mediaId/process-video-segments
//
// Kept in sync by hand; an auto-generated client (R-14) is a later
// concern. Type drift between this file and the server projection is
// caught by `npm run smoke:video-api` plus `tsc -b` failing if the
// fields drift away from the server's runtime shape.

import type { MediaUserDecision } from "./media";

// ---------------------------------------------------------------------------
// shared error helper
// ---------------------------------------------------------------------------

interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId?: string;
    details?: unknown;
  };
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const envelope = (await res.json()) as ApiErrorEnvelope | null;
    if (envelope?.error?.message) return envelope.error.message;
  } catch {
    // Non-JSON error body; fall through.
  }
  return `HTTP ${res.status}`;
}

// ---------------------------------------------------------------------------
// closed-set tokens (mirror migration 011 + server's VideoSegmentTypes)
// ---------------------------------------------------------------------------

/** `video_segments.waste_type` enum. */
export type VideoSegmentWasteType = "black" | "blurry" | "unstable" | "silence" | "none";

/**
 * `video_segments.user_decision` enum. Same shape as
 * `MediaUserDecision` from `./media`; aliased here so importers don't
 * need to know that the two domains share the same vocabulary.
 */
export type VideoSegmentUserDecision = MediaUserDecision;

// ---------------------------------------------------------------------------
// read projections (P9.T8 wire shape)
// ---------------------------------------------------------------------------

/**
 * One segment row enriched with the canonical
 * `trips/{tripId}/derived/{mediaId}/segments/{id}.mp4` path that the
 * `video_segments` schema deliberately omits — the server's
 * `VideoSegmentView` re-derives it via `videoSegmentMp4Path()` so the
 * UI doesn't have to.
 */
export interface VideoSegment {
  readonly id: string;
  readonly mediaId: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly duration: number;
  readonly thumbnailPath: string | null;
  readonly previewPath: string | null;
  /** Normalised [0, 1] sharpness (higher = sharper). NULL when no
   * keyframes fell inside the segment interval. */
  readonly blurScore: number | null;
  /** V1: always NULL (P9.T7 R-110 — vidstabdetect deferred). The
   * field is preserved here so a future stability worker can land
   * without breaking the wire shape. */
  readonly stabilityScore: number | null;
  /** Composite quality_score = blur_score × (1 - blackRatio),
   * clamped to [0, 1]. NULL when blur_score is NULL. */
  readonly qualityScore: number | null;
  readonly wasteType: VideoSegmentWasteType;
  readonly isRecommended: boolean;
  readonly userDecision: VideoSegmentUserDecision;
  readonly reason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Canonical on-disk path (logical, under the storage root).
   * Open via `/storage/${filePath}`. */
  readonly filePath: string;
}

/**
 * Compact P9.T5 keyframes manifest summary, inlined into the list
 * response so a video segments page can render a keyframe strip in
 * a single round-trip.
 */
export interface KeyframesSummary {
  readonly workerVersion: string;
  readonly intervalSec: number;
  readonly frameCount: number;
  readonly sourceDurationSec: number | null;
  readonly generatedAt: string;
  readonly frames: readonly KeyframeEntry[];
}

export interface KeyframeEntry {
  readonly index: number;
  readonly timestampSec: number;
  readonly filePath: string;
  readonly width: number;
  readonly height: number;
  readonly fileSize: number;
}

export interface ListVideoSegmentsResponse {
  readonly mediaId: string;
  readonly mediaDurationSec: number | null;
  readonly segments: readonly VideoSegment[];
  readonly keyframes: KeyframesSummary | null;
}

export interface VideoSegmentDetailResponse {
  readonly mediaId: string;
  readonly segment: VideoSegment;
}

// ---------------------------------------------------------------------------
// write projections (PATCH / POST)
// ---------------------------------------------------------------------------

export interface UpdateUserDecisionResponse {
  readonly segmentId: string;
  readonly mediaId: string;
  readonly previousUserDecision: VideoSegmentUserDecision;
  readonly userDecision: VideoSegmentUserDecision;
  /** True when the new value matches the previous one (no DB write). */
  readonly alreadyApplied: boolean;
  readonly updatedAt: string;
}

export type ProcessSlotOutcome = "created" | "reset" | "skipped";

export interface ProcessSlotResult {
  readonly jobType: string;
  readonly outcome: ProcessSlotOutcome;
  readonly jobId: string;
  readonly reason?: string;
}

export interface ProcessVideoSegmentsResponse {
  readonly mediaId: string;
  /** Echoed back so the UI can confirm the force flag was honoured. */
  readonly force: boolean;
  readonly results: readonly ProcessSlotResult[];
}

// ---------------------------------------------------------------------------
// fetchers
// ---------------------------------------------------------------------------

/**
 * Fetch the per-media segments list + (when present) the keyframes
 * manifest summary.
 *
 * Throws on whole-request failures:
 *   * 400 — invalid mediaId
 *   * 404 — media missing, soft-deleted, or non-video
 */
export async function fetchVideoSegments(
  mediaId: string,
  signal?: AbortSignal,
): Promise<ListVideoSegmentsResponse> {
  const init: RequestInit = { headers: { Accept: "application/json" } };
  if (signal) init.signal = signal;
  const res = await fetch(
    `/api/media/${encodeURIComponent(mediaId)}/video-segments`,
    init,
  );
  if (!res.ok) throw new Error(await readErrorMessage(res));
  return (await res.json()) as ListVideoSegmentsResponse;
}

/**
 * Fetch one segment by id under its parent media. The :mediaId path
 * component must match `segment.media_id`; a forged cross-parent URL
 * returns 404 by design (server's "no enumeration across parents"
 * guard).
 *
 * Throws on whole-request failures:
 *   * 404 — segment missing, parent missing / soft-deleted / non-video,
 *           or :mediaId / :segmentId mismatch
 */
export async function fetchVideoSegmentDetail(
  mediaId: string,
  segmentId: string,
  signal?: AbortSignal,
): Promise<VideoSegmentDetailResponse> {
  const init: RequestInit = { headers: { Accept: "application/json" } };
  if (signal) init.signal = signal;
  const res = await fetch(
    `/api/media/${encodeURIComponent(mediaId)}/video-segments/${encodeURIComponent(segmentId)}`,
    init,
  );
  if (!res.ok) throw new Error(await readErrorMessage(res));
  return (await res.json()) as VideoSegmentDetailResponse;
}

/**
 * PATCH one segment's `user_decision`. The server reuses
 * `videoSegmentsRepo.updateUserDecision()` (P9.T7 public method) —
 * scoring columns are never touched. Idempotent: re-sending the
 * current value is a no-op with `alreadyApplied: true`.
 *
 * Throws on whole-request failures:
 *   * 400 — body fails zod (bad enum / unknown key / missing field)
 *   * 404 — segment missing OR parent media missing / soft-deleted /
 *           non-video
 */
export async function updateSegmentUserDecision(
  segmentId: string,
  userDecision: VideoSegmentUserDecision,
): Promise<UpdateUserDecisionResponse> {
  const res = await fetch(
    `/api/video-segments/${encodeURIComponent(segmentId)}/user-decision`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ userDecision }),
    },
  );
  if (!res.ok) throw new Error(await readErrorMessage(res));
  return (await res.json()) as UpdateUserDecisionResponse;
}

/**
 * Enqueue the three video-pipeline jobs (segments → keyframes →
 * segment_quality) for one media. `force=true` opts into the
 * "operator explicitly asks for a clean reanalysis" path, which
 * wipes `user_decision` along with the old rows; default (omitted /
 * `force=false`) preserves any non-`undecided` user_decision via the
 * P9.T7 time-overlap mapping (R-107). UIs MUST gate `force=true`
 * behind an explicit confirmation step.
 *
 * Throws on whole-request failures:
 *   * 400 — non-video media, body fails zod
 *   * 404 — media missing or soft-deleted
 */
export async function processVideoSegments(
  mediaId: string,
  force = false,
): Promise<ProcessVideoSegmentsResponse> {
  const res = await fetch(
    `/api/media/${encodeURIComponent(mediaId)}/process-video-segments`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ force }),
    },
  );
  if (!res.ok) throw new Error(await readErrorMessage(res));
  return (await res.json()) as ProcessVideoSegmentsResponse;
}
