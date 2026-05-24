// VideoSegmentsRepository — data-access layer for `video_segments`
// (migration 011, P9.T1; producer worker P9.T6; quality scorer P9.T7).
//
// Scope:
//   * P9.T6: INSERT one row per segment; `listByMediaId` for the
//     per-media UI / cleanup paths; `replaceAllForMedia` for the
//     transactional "wipe + reinsert" idempotency pattern the
//     producer worker uses on re-run. P9.T7 widens the function
//     with a `preserveUserDecision` policy so a normal re-slice
//     does **not** lose the user's manual `keep`/`remove`
//     selections — only an explicit `{ force: true }` payload from
//     the operator wipes user state. (R-107.)
//   * P9.T7: `updateQuality` UPDATEs per-segment score / waste /
//     reason / is_recommended in one prepared statement. The
//     quality worker iterates and calls this per row; no batch
//     transaction is needed because the worker computes all
//     scores in memory before touching SQLite.
//   * `updateUserDecision` is the targeted write the future
//     "user marks a segment keep/remove" API path will use; it
//     also backs the time-overlap mapping inside the
//     `preserveUserDecision` branch of `replaceAllForMedia`.
//
// `video_segments.media_id` has ON DELETE CASCADE to media_items
// (migration 011 FK), so hard-deleting a video naturally cascades
// segments away. Soft delete leaves the rows in place (matches the
// P7 contract — recycle bin can list a soft-deleted video's
// segments without surfacing them in the active gallery).
//
// All statements are prepared once at construction time, mirroring
// the other repos' pattern. The repo never throws AppError —
// missing rows surface as null / empty arrays so the caller decides
// how to translate them.

import type { SqliteDatabase } from "../db/connection.js";
import {
  type VideoSegment,
  type VideoSegmentInsertData,
  type VideoSegmentUserDecision,
  type VideoSegmentWasteType,
} from "./videoSegmentTypes.js";

interface SegmentRow {
  id: string;
  media_id: string;
  start_time: number;
  end_time: number;
  duration: number;
  thumbnail_path: string | null;
  preview_path: string | null;
  blur_score: number | null;
  stability_score: number | null;
  quality_score: number | null;
  waste_type: VideoSegmentWasteType;
  is_recommended: number;
  user_decision: VideoSegmentUserDecision;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_COLUMNS = `
  id,
  media_id,
  start_time,
  end_time,
  duration,
  thumbnail_path,
  preview_path,
  blur_score,
  stability_score,
  quality_score,
  waste_type,
  is_recommended,
  user_decision,
  reason,
  created_at,
  updated_at
`;

/**
 * Compose the canonical segment-file logical path. The video_segments
 * schema deliberately has no `file_path` column — the file lives at
 * `trips/{tripId}/derived/{mediaId}/segments/{id}.mp4` per design.md
 * §6.2. Downstream callers use this helper rather than re-deriving
 * the convention by hand.
 */
export function videoSegmentMp4Path(args: {
  readonly tripId: string;
  readonly mediaId: string;
  readonly segmentId: string;
}): string {
  return `trips/${args.tripId}/derived/${args.mediaId}/segments/${args.segmentId}.mp4`;
}

/** Threshold for the time-overlap mapping used by
 * `replaceAllForMedia(..., { force: false })` (R-107). A previous
 * user_decision is carried over to a new segment when the overlap of
 * the new segment with the previous segment, measured against the
 * NEW segment's duration, is at least this fraction.
 *
 * 0.5 is the "majority overlap" inflection point: a single user
 * decision survives a re-slice that changes the segment boundaries
 * slightly (e.g. a 10s→8s slice; the new and old segments overlap
 * by ≥ 50% of the new duration). It does not survive a *re*-slice
 * with a different durationSec that produces dramatically different
 * boundaries — the operator should treat that as a fresh analysis
 * and set `{ force: true }` to be explicit. */
export const PRESERVE_USER_DECISION_OVERLAP_RATIO = 0.5;

/** Options for `replaceAllForMedia` (R-107 fix). */
export interface ReplaceAllForMediaOptions {
  /** When true, the wipe-and-reinsert does NOT attempt to carry
   * forward any prior `user_decision` rows. Use only when the
   * operator explicitly requests a clean reanalysis. Defaults to
   * `false` — i.e. the default re-run preserves user decisions. */
  readonly force?: boolean;
}

/** Per-row quality writer payload, matching the columns the P9.T7
 * worker updates after computing per-segment blur + blackdetect. */
export interface VideoSegmentQualityUpdate {
  readonly id: string;
  /** [0, 1] OR NULL — column is CHECK-constrained. */
  readonly blurScore: number | null;
  readonly stabilityScore: number | null;
  readonly qualityScore: number | null;
  readonly wasteType: VideoSegmentWasteType;
  readonly isRecommended: boolean;
  readonly reason: string | null;
  readonly now: string;
}

export class VideoSegmentsRepository {
  private readonly insertStmt;
  private readonly listByMediaIdStmt;
  private readonly findByIdStmt;
  private readonly deleteByMediaIdStmt;
  private readonly updateUserDecisionStmt;
  private readonly updateQualityStmt;

  constructor(private readonly db: SqliteDatabase) {
    this.insertStmt = db.prepare(`
      INSERT INTO video_segments
        (id, media_id, start_time, end_time, duration,
         created_at, updated_at)
      VALUES
        (@id, @mediaId, @startTime, @endTime, @duration,
         @now, @now)
    `);

    // ORDER BY start_time keeps the per-media segment list in
    // play order (the same order ffmpeg emitted them); tie-break
    // on id stays deterministic if two segments share start_time
    // (shouldn't happen for fixed-duration slicing, but defensive).
    this.listByMediaIdStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM video_segments
      WHERE media_id = ?
      ORDER BY start_time ASC, id ASC
    `);

    // P9.T8 single-row lookup powering `GET /api/video-segments/:id`
    // and the user_decision PATCH. Returns the raw row; the Service
    // layer cross-checks the parent media's `deleted_at` to honour
    // the P7 contract (recycle-bin members must NOT surface).
    this.findByIdStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM video_segments
      WHERE id = ?
    `);

    this.deleteByMediaIdStmt = db.prepare(`
      DELETE FROM video_segments
      WHERE media_id = ?
    `);

    // Single-row UPDATE for the user_decision write path. CLAUDE.md
    // §3.9 says user manual selection takes precedence over system
    // recommendation; this writer is the one place callers set it.
    this.updateUserDecisionStmt = db.prepare(`
      UPDATE video_segments
      SET user_decision = @userDecision, updated_at = @now
      WHERE id = @id
    `);

    // Quality writer for P9.T7 — scores + waste classification +
    // is_recommended + reason in one UPDATE. We deliberately do
    // NOT touch user_decision here (the user's manual selection
    // outranks system rescoring).
    this.updateQualityStmt = db.prepare(`
      UPDATE video_segments
      SET blur_score      = @blurScore,
          stability_score = @stabilityScore,
          quality_score   = @qualityScore,
          waste_type      = @wasteType,
          is_recommended  = @isRecommended,
          reason          = @reason,
          updated_at      = @now
      WHERE id = @id
    `);
  }

  /**
   * Insert one segment row. Throws on PK collision, FK violation
   * (media_id missing), or any CHECK failure (negative start_time,
   * inverted end_time, non-positive duration, etc.). The P9.T6
   * worker calls this inside a `replaceAllForMedia` transaction so
   * any failure rolls back the whole reinsert.
   */
  insert(data: VideoSegmentInsertData): void {
    this.insertStmt.run({
      id: data.id,
      mediaId: data.mediaId,
      startTime: data.startTime,
      endTime: data.endTime,
      duration: data.duration,
      now: data.now,
    });
  }

  /**
   * Return every segment row for one media, ordered by start_time.
   * Returns an empty array when no segments exist (e.g. P9.T6 has
   * not run yet, or the worker is mid-re-run between DELETE and
   * INSERT).
   */
  listByMediaId(mediaId: string): VideoSegment[] {
    const rows = this.listByMediaIdStmt.all(mediaId) as SegmentRow[];
    return rows.map(rowToSegment);
  }

  /**
   * Lookup one segment by primary key. Returns `null` when the row
   * does not exist. The repository does NOT cross-check the parent
   * `media_items` row's `deleted_at` — that's a Service-layer
   * concern (`VideoService` cross-checks via `MediaRepository`).
   */
  findById(id: string): VideoSegment | null {
    const row = this.findByIdStmt.get(id) as SegmentRow | undefined;
    return row === undefined ? null : rowToSegment(row);
  }

  /**
   * Best-effort delete of every segment row for one media. Returns
   * the number of rows removed. Used by the P9.T6 worker's
   * "wipe + reinsert" idempotency pattern.
   *
   * NB: does NOT touch the segment files on disk — that's the
   * worker's responsibility (the repository has no storage handle
   * by design).
   */
  deleteByMediaId(mediaId: string): number {
    const info = this.deleteByMediaIdStmt.run(mediaId);
    return info.changes;
  }

  /**
   * Transactional wipe + reinsert. Used by P9.T6 worker on every
   * (re-)run so the table reflects exactly the current ffmpeg
   * output. Any failure inside the callback rolls back the whole
   * thing: the old rows survive AND no new rows land. This avoids
   * the "half-old, half-new" intermediate state that a naive
   * sequence would leave on a crash.
   *
   * R-107 (closed by P9.T7): by default, the function now snapshots
   * the old rows BEFORE the wipe and re-applies any non-`undecided`
   * `user_decision` to whichever new segment overlaps the prior
   * one by ≥ `PRESERVE_USER_DECISION_OVERLAP_RATIO`. This respects
   * CLAUDE.md §3.9 (system rescoring may not silently overwrite a
   * user choice). Passing `{ force: true }` opts out — the wipe is
   * unconditional, including the user's `user_decision` — for the
   * "operator explicitly asks for a clean reanalysis" case.
   *
   * Score columns (blur_score / stability_score / quality_score /
   * waste_type / is_recommended / reason) are NEVER preserved
   * across a re-slice: the new segments have different time
   * boundaries (or new content from a re-encoded proxy), so the
   * prior numerical scores are stale by definition. P9.T7 will
   * recompute them in a follow-up job.
   */
  replaceAllForMedia(
    mediaId: string,
    segments: readonly VideoSegmentInsertData[],
    options?: ReplaceAllForMediaOptions,
  ): void {
    const force = options?.force === true;
    const tx = this.db.transaction(() => {
      // Snapshot BEFORE deleting so we can replay user decisions
      // back onto whichever new segments overlap the prior ones.
      const oldRows = force ? [] : this.listByMediaId(mediaId);
      const decisionPlan = force ? [] : mapUserDecisionsByOverlap(oldRows, segments);
      this.deleteByMediaId(mediaId);
      for (const seg of segments) {
        this.insert(seg);
      }
      for (const plan of decisionPlan) {
        this.updateUserDecisionStmt.run({
          id: plan.newSegmentId,
          userDecision: plan.userDecision,
          now: plan.now,
        });
      }
    });
    tx();
  }

  /**
   * Write the quality columns for one segment. P9.T7 calls this
   * once per scored segment. Returns 1 when the row exists, 0
   * otherwise (the worker should treat 0 as a no-op race — e.g.
   * the parent media was hard-deleted between SELECT and UPDATE).
   */
  updateQuality(data: VideoSegmentQualityUpdate): number {
    const info = this.updateQualityStmt.run({
      id: data.id,
      blurScore: data.blurScore,
      stabilityScore: data.stabilityScore,
      qualityScore: data.qualityScore,
      wasteType: data.wasteType,
      isRecommended: data.isRecommended ? 1 : 0,
      reason: data.reason,
      now: data.now,
    });
    return info.changes;
  }

  /**
   * Update a single segment's `user_decision`. Used by the future
   * "user marks a segment keep/remove" API path. P9.T7 worker
   * itself does NOT call this — the quality scorer never touches
   * user_decision (per CLAUDE.md §3.9).
   */
  updateUserDecision(args: {
    readonly id: string;
    readonly userDecision: VideoSegmentUserDecision;
    readonly now: string;
  }): number {
    const info = this.updateUserDecisionStmt.run({
      id: args.id,
      userDecision: args.userDecision,
      now: args.now,
    });
    return info.changes;
  }
}

/**
 * Plan one row per "new segment that inherits an old user_decision".
 * The mapping uses time-interval overlap: for each new segment, find
 * the old segment that maximally overlaps it; if the overlap
 * fraction (against the new segment's duration) is ≥
 * `PRESERVE_USER_DECISION_OVERLAP_RATIO` AND the old segment's
 * user_decision is not 'undecided', emit a plan entry.
 *
 * Exported separately from the class so the unit smoke can drive
 * the mapping with synthetic data (no SQLite spin-up).
 */
export function mapUserDecisionsByOverlap(
  oldRows: readonly VideoSegment[],
  newSegments: readonly VideoSegmentInsertData[],
): readonly { newSegmentId: string; userDecision: VideoSegmentUserDecision; now: string }[] {
  const plan: { newSegmentId: string; userDecision: VideoSegmentUserDecision; now: string }[] = [];
  for (const newSeg of newSegments) {
    if (newSeg.duration <= 0) continue;
    let bestOverlap = 0;
    let bestOld: VideoSegment | null = null;
    for (const old of oldRows) {
      if (old.userDecision === "undecided") continue;
      const overlapStart = Math.max(newSeg.startTime, old.startTime);
      const overlapEnd = Math.min(newSeg.endTime, old.endTime);
      const overlap = overlapEnd - overlapStart;
      if (overlap <= 0) continue;
      const ratio = overlap / newSeg.duration;
      if (ratio > bestOverlap) {
        bestOverlap = ratio;
        bestOld = old;
      }
    }
    if (bestOld !== null && bestOverlap >= PRESERVE_USER_DECISION_OVERLAP_RATIO) {
      plan.push({
        newSegmentId: newSeg.id,
        userDecision: bestOld.userDecision,
        now: newSeg.now,
      });
    }
  }
  return plan;
}

function rowToSegment(row: SegmentRow): VideoSegment {
  return {
    id: row.id,
    mediaId: row.media_id,
    startTime: row.start_time,
    endTime: row.end_time,
    duration: row.duration,
    thumbnailPath: row.thumbnail_path,
    previewPath: row.preview_path,
    blurScore: row.blur_score,
    stabilityScore: row.stability_score,
    qualityScore: row.quality_score,
    wasteType: row.waste_type,
    isRecommended: row.is_recommended === 1,
    userDecision: row.user_decision,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
