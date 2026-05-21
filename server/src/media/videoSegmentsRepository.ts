// VideoSegmentsRepository — data-access layer for `video_segments`
// (migration 011, P9.T1; producer worker P9.T6).
//
// Scope:
//   * P9.T6: INSERT one row per segment; `listByMediaId` for the
//     per-media UI / cleanup paths; `replaceAllForMedia` for the
//     transactional "wipe + reinsert" idempotency pattern the
//     worker uses on re-run.
//   * No state-machine helpers, no per-axis writers — those are
//     P9.T7 territory (segment quality finalize: blur_score /
//     stability_score / quality_score / waste_type via UPDATE).
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

export class VideoSegmentsRepository {
  private readonly insertStmt;
  private readonly listByMediaIdStmt;
  private readonly deleteByMediaIdStmt;

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

    this.deleteByMediaIdStmt = db.prepare(`
      DELETE FROM video_segments
      WHERE media_id = ?
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
   * R-107 (recorded in progress.md): wipe destroys any P9.T7+
   * scores the user / analyser left on the prior segments. P9.T6
   * is the only writer pre-T7, so the risk is dormant at the
   * P9.T6 commit; revisit when P9.T7 lands.
   */
  replaceAllForMedia(mediaId: string, segments: readonly VideoSegmentInsertData[]): void {
    const tx = this.db.transaction(() => {
      this.deleteByMediaId(mediaId);
      for (const seg of segments) {
        this.insert(seg);
      }
    });
    tx();
  }
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
