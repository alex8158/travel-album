// Video segment domain types (P9.T6 scope).
//
// Mirrors the columns of server/migrations/011_create_video_segments.sql.
// Per-segment audit columns (blur_score / stability_score /
// quality_score / waste_type / is_recommended / user_decision /
// reason) all stay nullable / default-valued at P9.T6 time — they
// get populated by P9.T7 (segment quality finalizer).
//
// File path is intentionally NOT a column on `video_segments` — the
// segment MP4 lives at the canonical
// `trips/{tripId}/derived/{mediaId}/segments/{id}.mp4` (design.md
// §6.2). Downstream code reconstructs the path from
// (mediaId, segmentId) rather than carrying a redundant column.
// Helper `videoSegmentMp4Path()` in videoSegmentsRepository.ts
// formalises that convention.

export type VideoSegmentWasteType = "black" | "blurry" | "unstable" | "silence" | "none";

export type VideoSegmentUserDecision = "keep" | "remove" | "undecided";

/** Read projection — every column from migration 011. */
export interface VideoSegment {
  readonly id: string;
  readonly mediaId: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly duration: number;
  readonly thumbnailPath: string | null;
  readonly previewPath: string | null;
  readonly blurScore: number | null;
  readonly stabilityScore: number | null;
  readonly qualityScore: number | null;
  readonly wasteType: VideoSegmentWasteType;
  /** SQLite stores 0/1; we expose the boolean projection. */
  readonly isRecommended: boolean;
  readonly userDecision: VideoSegmentUserDecision;
  readonly reason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Minimum writer surface for `VideoSegmentsRepository.insert`. The
 * P9.T6 worker only knows the timing fields + the per-row uuid;
 * P9.T7 fills the quality fields later via UPDATE, so they don't
 * need to be on the insert path.
 */
export interface VideoSegmentInsertData {
  readonly id: string;
  readonly mediaId: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly duration: number;
  /** ISO-8601 timestamp; insert + update at the same moment. */
  readonly now: string;
}
