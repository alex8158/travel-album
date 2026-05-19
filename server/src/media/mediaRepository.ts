// MediaRepository — data-access layer for media_items.
//
// Scope:
//   * P2.T4 added `insert` for Upload_Manager.
//   * P2.T5 added `findById` + `list(tripId, options)` to back the
//     read endpoints (`GET /api/media/:id`, `GET /api/trips/:tripId/media`).
//   * P3.T4 adds `updateImageDerivedPaths` so the thumbnail worker can
//     cache the derived image's display dimensions + preview / thumb
//     paths on the media_items row (so the Gallery can read them
//     without joining media_versions).
//   * P5.T2 adds `updateImageHashes` so the `image_hash` worker can
//     cache SHA256 + perceptual hash (pHash + dHash concatenation) on
//     the media row. Columns already exist in 002; no schema change.
//   * P5.T3 adds `findActiveImageHashesByTripId` — read-only projection
//     used by `Dedup_Engine.exact` to enumerate the (mediaId, fileHash)
//     pairs for one trip without pulling whole MediaItem rows.
//   * P5.T4 adds `findActiveImagePerceptualHashesByTripId` — same
//     shape but for `perceptual_hash`, consumed by
//     `Dedup_Engine.similar` (pHash Hamming distance grouping).
//   * P5.T6 adds `findByIds` — batch lookup returning a Map; used
//     by `DedupService` to hydrate per-item media projections in
//     one round-trip when rendering duplicate group lists / detail.
//   * No state-machine helpers (e.g. markProcessing / markFailed),
//     soft-delete writes, or restore ops — those belong to P4 / P7.
//
// All read paths default to `WHERE deleted_at IS NULL` to match the
// project-wide soft-delete convention (design.md §4.4). An optional
// `includeDeleted` toggle exists for future restore / admin callers
// but is NOT exposed at the route layer.
//
// All statements are prepared once at construction time, mirroring
// TripRepository's pattern. The repository never throws AppError —
// missing rows surface as `null` / empty arrays so the Service decides
// how to translate them.

import type { SqliteDatabase } from "../db/connection.js";
import type {
  ListMediaOptions,
  MediaAnalysisProjection,
  MediaItem,
  MediaStatus,
  MediaUserDecision,
} from "./mediaTypes.js";
import type { MediaInsertData, MediaType } from "./mediaTypes.js";

const DEFAULT_STATUS = "uploaded";
const DEFAULT_USER_DECISION = "undecided";

const DEFAULT_LIMIT = 50;

/**
 * Internal row shape returned by `SELECT ... FROM media_items LEFT JOIN
 * media_analysis ...`. Snake_case columns map to camelCase on the way
 * out via `rowToItem`. `analysis_*` columns come from the LEFT JOIN
 * and stay NULL when the per-media analysis row hasn't been written
 * yet (i.e. P6.T2–P6.T5 workers haven't run on this media).
 */
interface MediaRow {
  id: string;
  trip_id: string;
  type: MediaType;
  original_path: string | null;
  preview_path: string | null;
  thumbnail_path: string | null;
  file_size: number | null;
  mime_type: string | null;
  extension: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  status: MediaStatus;
  user_decision: MediaUserDecision;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  // P6.T6 LEFT JOIN media_analysis projection. Every column nullable
  // because (a) the JOIN is LEFT, and (b) the per-dimension workers
  // fill columns progressively.
  analysis_id: string | null;
  analysis_quality_score: number | null;
  analysis_sharpness_score: number | null;
  analysis_exposure_score: number | null;
  analysis_color_score: number | null;
  analysis_is_blurry: number | null;
  analysis_is_recommended: number | null;
  analysis_labels: string | null;
  analysis_reason: string | null;
}

/**
 * Read projection. file_hash / perceptual_hash are NOT included — they
 * are dedup internals (P5) and not useful to the frontend.
 *
 * P6.T6 extends the projection with a LEFT JOIN on `media_analysis`
 * so the gallery / detail UI can render quality / blur / recommendation
 * signals without a second round-trip. The JOIN is left because the
 * per-dimension workers populate `media_analysis` progressively — an
 * uploaded-but-not-yet-analysed image has no row in `media_analysis`
 * and its `analysis_*` columns come back NULL.
 *
 * Columns are aliased with the `m.` / `ma.` prefix because the
 * upcoming JOIN requires explicit table qualification (both tables
 * have `id`, `created_at`, `updated_at`).
 */
const MEDIA_TABLE_COLUMNS = `
  m.id              AS id,
  m.trip_id         AS trip_id,
  m.type            AS type,
  m.original_path   AS original_path,
  m.preview_path    AS preview_path,
  m.thumbnail_path  AS thumbnail_path,
  m.file_size       AS file_size,
  m.mime_type       AS mime_type,
  m.extension       AS extension,
  m.width           AS width,
  m.height          AS height,
  m.duration        AS duration,
  m.status          AS status,
  m.user_decision   AS user_decision,
  m.created_at      AS created_at,
  m.updated_at      AS updated_at,
  m.deleted_at      AS deleted_at
`;

const ANALYSIS_JOIN_COLUMNS = `
  ma.id              AS analysis_id,
  ma.quality_score   AS analysis_quality_score,
  ma.sharpness_score AS analysis_sharpness_score,
  ma.exposure_score  AS analysis_exposure_score,
  ma.color_score     AS analysis_color_score,
  ma.is_blurry       AS analysis_is_blurry,
  ma.is_recommended  AS analysis_is_recommended,
  ma.labels          AS analysis_labels,
  ma.reason          AS analysis_reason
`;

const SELECT_FROM_MEDIA = `
  SELECT
    ${MEDIA_TABLE_COLUMNS},
    ${ANALYSIS_JOIN_COLUMNS}
  FROM media_items m
  LEFT JOIN media_analysis ma ON ma.media_id = m.id
`;

export class MediaRepository {
  private readonly insertStmt;
  private readonly findByIdActiveStmt;
  private readonly findByIdAnyStmt;
  private readonly listByTripActiveStmt;
  private readonly listByTripAllStmt;
  private readonly updateImageDerivedPathsStmt;
  private readonly updateImageHashesStmt;
  private readonly findFirstThumbnailPathStmt;
  private readonly findActiveImageHashesByTripIdStmt;
  private readonly findActiveImagePerceptualHashesByTripIdStmt;

  constructor(private readonly db: SqliteDatabase) {
    this.insertStmt = db.prepare(`
      INSERT INTO media_items (
        id, trip_id, type, original_path,
        file_size, mime_type, extension,
        status, user_decision,
        created_at, updated_at
      ) VALUES (
        @id, @tripId, @type, @originalPath,
        @fileSize, @mimeType, @extension,
        @status, @userDecision,
        @createdAt, @updatedAt
      )
    `);

    this.findByIdActiveStmt = db.prepare(`
      ${SELECT_FROM_MEDIA}
      WHERE m.id = ? AND m.deleted_at IS NULL
    `);

    this.findByIdAnyStmt = db.prepare(`
      ${SELECT_FROM_MEDIA}
      WHERE m.id = ?
    `);

    // Newest-first ordering mirrors TripRepository: the Gallery (P2.T7)
    // wants most recent uploads at the top. Tie-break on id keeps the
    // page boundaries deterministic across paginated requests.
    this.listByTripActiveStmt = db.prepare(`
      ${SELECT_FROM_MEDIA}
      WHERE m.trip_id = ? AND m.deleted_at IS NULL
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ? OFFSET ?
    `);

    this.listByTripAllStmt = db.prepare(`
      ${SELECT_FROM_MEDIA}
      WHERE m.trip_id = ?
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ? OFFSET ?
    `);

    // Cache the display dimensions + derived paths on the media row
    // itself (P3.T4 ImageWorker.thumbnail). Limited to active rows
    // (`deleted_at IS NULL`) — a soft-deleted media should not absorb
    // further write traffic. The handler logs a warning if changes=0
    // so the soft-delete-race case is observable.
    this.updateImageDerivedPathsStmt = db.prepare(`
      UPDATE media_items
      SET width = @width,
          height = @height,
          preview_path = @previewPath,
          thumbnail_path = @thumbnailPath,
          updated_at = @updatedAt
      WHERE id = @mediaId AND deleted_at IS NULL
    `);

    // P5.T2 image_hash worker: cache the file-level SHA256 and the
    // perceptual hash signature on the media row. Active rows only —
    // a soft-deleted media should not absorb further writes. The
    // handler logs a warning when changes=0 so the soft-delete race
    // case is observable. Both columns already exist in 002 (with an
    // index on file_hash), so no schema change is required.
    this.updateImageHashesStmt = db.prepare(`
      UPDATE media_items
      SET file_hash = @fileHash,
          perceptual_hash = @perceptualHash,
          updated_at = @updatedAt
      WHERE id = @mediaId AND deleted_at IS NULL
    `);

    // P3.T8 derived cover: pick the oldest active image in this trip
    // that already has a thumbnail_path. Returns just the path so we
    // don't pull a whole MediaItem when the caller only needs the URL
    // suffix. ORDER BY created_at ASC, id ASC mirrors the
    // tie-break the design (§7.7) prescribes ("按 created_at 升序的
    // 第一张已生成缩略图的图片").
    this.findFirstThumbnailPathStmt = db.prepare(`
      SELECT thumbnail_path
      FROM media_items
      WHERE trip_id = ?
        AND type = 'image'
        AND thumbnail_path IS NOT NULL
        AND deleted_at IS NULL
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `);

    // P5.T3 Dedup_Engine.exact: enumerate every active image in a
    // trip that has a `file_hash` set. We deliberately return only
    // (id, file_hash) instead of a full MediaItem — the dedup engine
    // groups by hash in JS and never needs the larger projection.
    //   * Active rows only (`deleted_at IS NULL`).
    //   * type='image' — videos do not participate in image dedup
    //     (P9 has its own video-side dedup if/when it lands).
    //   * file_hash IS NOT NULL — rows whose `image_hash` worker has
    //     not run yet are out of scope; the engine simply ignores
    //     them rather than failing.
    // ORDER BY created_at ASC, id ASC keeps the per-hash member list
    // deterministic across runs (logs and group items are stable).
    this.findActiveImageHashesByTripIdStmt = db.prepare(`
      SELECT id, file_hash AS file_hash
      FROM media_items
      WHERE trip_id = ?
        AND type = 'image'
        AND deleted_at IS NULL
        AND file_hash IS NOT NULL
      ORDER BY created_at ASC, id ASC
    `);

    // P5.T4 Dedup_Engine.similar: same projection but for
    // `perceptual_hash`. The engine slices the first 16 chars as
    // pHash. Filter / ordering identical to the file_hash variant.
    this.findActiveImagePerceptualHashesByTripIdStmt = db.prepare(`
      SELECT id, perceptual_hash AS perceptual_hash
      FROM media_items
      WHERE trip_id = ?
        AND type = 'image'
        AND deleted_at IS NULL
        AND perceptual_hash IS NOT NULL
      ORDER BY created_at ASC, id ASC
    `);
  }

  /**
   * Persist a brand-new media_items row. Throws on PK collision, FK
   * violation (trip_id missing), or any CHECK constraint failure —
   * UploadService translates those into a per-file failure response.
   *
   * Hash, dimension, preview, and thumbnail columns are intentionally
   * omitted: they remain NULL after this insert and are populated by
   * downstream workers (P3.T2 / P5.T2 / P9.T2).
   */
  insert(data: MediaInsertData): void {
    this.insertStmt.run({
      id: data.id,
      tripId: data.tripId,
      type: data.type,
      originalPath: data.originalPath,
      fileSize: data.fileSize,
      mimeType: data.mimeType,
      extension: data.extension,
      status: data.status ?? DEFAULT_STATUS,
      userDecision: data.userDecision ?? DEFAULT_USER_DECISION,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    });
  }

  /**
   * Fetch a single media row by id. Active rows only (deleted_at IS
   * NULL); pass `includeDeleted: true` to also surface soft-deleted
   * rows (reserved for P7 restore).
   */
  findById(id: string, options: { includeDeleted?: boolean } = {}): MediaItem | null {
    const stmt = options.includeDeleted ? this.findByIdAnyStmt : this.findByIdActiveStmt;
    const row = stmt.get(id) as MediaRow | undefined;
    return row ? rowToItem(row) : null;
  }

  /**
   * Page through the media items of a single trip. Always orders
   * newest-first. Active rows only by default.
   *
   * Note: this method does NOT verify the tripId exists — it returns
   * an empty array for missing / soft-deleted trips. The Service layer
   * is responsible for translating "trip missing" into a 404 before
   * calling here.
   */
  list(tripId: string, options: ListMediaOptions = {}): MediaItem[] {
    const limit = options.limit ?? DEFAULT_LIMIT;
    const offset = options.offset ?? 0;
    const stmt = options.includeDeleted ? this.listByTripAllStmt : this.listByTripActiveStmt;
    const rows = stmt.all(tripId, limit, offset) as MediaRow[];
    return rows.map(rowToItem);
  }

  /**
   * Cache the rotated/displayed image dimensions and the derived
   * thumbnail / preview paths on the media row. Called by
   * ImageWorker.thumbnail (P3.T4) after sharp finishes.
   *
   * Returns the number of rows touched. 0 means the row was missing
   * or already soft-deleted between the worker's `findById` and this
   * UPDATE — the caller logs that case and proceeds (the
   * media_versions write still landed if it ran earlier).
   */
  updateImageDerivedPaths(args: {
    readonly mediaId: string;
    readonly width: number;
    readonly height: number;
    readonly previewPath: string;
    readonly thumbnailPath: string;
    readonly updatedAt: string;
  }): number {
    const info = this.updateImageDerivedPathsStmt.run({
      mediaId: args.mediaId,
      width: args.width,
      height: args.height,
      previewPath: args.previewPath,
      thumbnailPath: args.thumbnailPath,
      updatedAt: args.updatedAt,
    });
    return info.changes;
  }

  /**
   * Cache the file-level SHA256 and perceptual hash signature on the
   * media row. Called by `image_hash` worker (P5.T2) after sharp +
   * crypto finish.
   *
   * Returns the number of rows touched. 0 means the row was missing
   * or already soft-deleted between the worker's `findById` and this
   * UPDATE — the caller logs that case and proceeds.
   *
   * The handler computes hashes deterministically over the same byte
   * stream, so re-running this method on the same media writes the
   * same values; idempotency is built in.
   */
  updateImageHashes(args: {
    readonly mediaId: string;
    /** SHA256 hex string of the original file bytes (64 chars). */
    readonly fileHash: string;
    /**
     * Perceptual hash signature, currently the concatenation of
     * `pHashHex(16) + dHashHex(16)` = 32 hex chars. Documented in
     * `imageHashWorker.ts`; the dedup engine slices the two halves
     * apart at compare time.
     */
    readonly perceptualHash: string;
    readonly updatedAt: string;
  }): number {
    const info = this.updateImageHashesStmt.run({
      mediaId: args.mediaId,
      fileHash: args.fileHash,
      perceptualHash: args.perceptualHash,
      updatedAt: args.updatedAt,
    });
    return info.changes;
  }

  /**
   * Return the `thumbnail_path` of the oldest active image in the
   * trip whose thumbnail has already been generated, or `null` when
   * no such row exists yet (trip is empty, or thumbnail worker has
   * not run for any image).
   *
   * Used by the response-layer cover_url derivation (P3.T8). Pure
   * read; the value is NOT persisted on `trips.cover_media_id`.
   */
  findFirstThumbnailPath(tripId: string): string | null {
    const row = this.findFirstThumbnailPathStmt.get(tripId) as
      | { thumbnail_path: string | null }
      | undefined;
    return row?.thumbnail_path ?? null;
  }

  /**
   * P5.T3 Dedup_Engine.exact: enumerate every active image of one
   * trip whose `file_hash` has been computed. Returns just the
   * (mediaId, fileHash) pairs ordered by `created_at ASC, id ASC`
   * for deterministic grouping. Empty array when the trip has no
   * hash-bearing images yet.
   *
   * The caller groups by `fileHash` in memory; we deliberately do
   * NOT push the GROUP BY into SQL so the dedup engine can apply
   * its own per-cohort policy (idempotency check, user-confirmed
   * protection) before any write.
   */
  findActiveImageHashesByTripId(tripId: string): { id: string; fileHash: string }[] {
    const rows = this.findActiveImageHashesByTripIdStmt.all(tripId) as {
      id: string;
      file_hash: string;
    }[];
    return rows.map((r) => ({ id: r.id, fileHash: r.file_hash }));
  }

  /**
   * P5.T4 Dedup_Engine.similar: enumerate every active image of one
   * trip whose `perceptual_hash` has been computed. Returns just the
   * (mediaId, perceptualHash) pairs ordered by `created_at ASC, id ASC`
   * for deterministic cohort iteration. Empty array when no rows yet.
   *
   * The caller is expected to slice the first 16 hex chars off the
   * returned `perceptualHash` to get the pHash half (P5.T2 layout:
   * `pHashHex(16) + dHashHex(16) = 32 hex`).
   */
  findActiveImagePerceptualHashesByTripId(
    tripId: string,
  ): { id: string; perceptualHash: string }[] {
    const rows = this.findActiveImagePerceptualHashesByTripIdStmt.all(tripId) as {
      id: string;
      perceptual_hash: string;
    }[];
    return rows.map((r) => ({ id: r.id, perceptualHash: r.perceptual_hash }));
  }

  /**
   * P5.T6: batch lookup of active media rows by id. Returns a Map
   * keyed by id so callers can hydrate per-item projections (e.g.
   * duplicate group items → MediaItem) in a single round-trip.
   *
   * Missing / soft-deleted ids are silently absent from the map (no
   * throw) — the dedup-list view tolerates and explicitly renders
   * "missing media" placeholders. Empty input yields an empty map.
   *
   * SQLite has no `ANY (?)` placeholder for variable-length IN-lists,
   * so we build the `?, ?, …` placeholder string per call. The cost
   * is negligible compared to the SELECT itself at V1 scale (< 100
   * media per dedup view).
   */
  findByIds(ids: readonly string[]): Map<string, MediaItem> {
    const out = new Map<string, MediaItem>();
    if (ids.length === 0) return out;
    const placeholders = ids.map(() => "?").join(", ");
    const sql = `
      ${SELECT_FROM_MEDIA}
      WHERE m.id IN (${placeholders})
        AND m.deleted_at IS NULL
    `;
    const rows = this.db.prepare(sql).all(...ids) as MediaRow[];
    for (const row of rows) {
      out.set(row.id, rowToItem(row));
    }
    return out;
  }
}

function rowToItem(row: MediaRow): MediaItem {
  return {
    id: row.id,
    tripId: row.trip_id,
    type: row.type,
    originalPath: row.original_path,
    previewPath: row.preview_path,
    thumbnailPath: row.thumbnail_path,
    fileSize: row.file_size,
    mimeType: row.mime_type,
    extension: row.extension,
    width: row.width,
    height: row.height,
    duration: row.duration,
    status: row.status,
    userDecision: row.user_decision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    analysis: rowToAnalysisProjection(row),
  };
}

/**
 * Build the {@link MediaAnalysisProjection} from the LEFT-joined
 * columns. Returns `null` when there is no `media_analysis` row for
 * this media (LEFT JOIN sentinel: `analysis_id` is null).
 *
 * Note: `analysis_id` is the most reliable "row exists" signal — a
 * media that's been touched by ONLY the blur worker will have
 * `analysis_quality_score = NULL` even though the row exists.
 */
function rowToAnalysisProjection(row: MediaRow): MediaAnalysisProjection | null {
  if (row.analysis_id === null) return null;
  return {
    qualityScore: row.analysis_quality_score,
    sharpnessScore: row.analysis_sharpness_score,
    exposureScore: row.analysis_exposure_score,
    colorScore: row.analysis_color_score,
    isBlurry: normaliseBoolColumn(row.analysis_is_blurry),
    isRecommended: normaliseBoolColumn(row.analysis_is_recommended),
    labels: parseLabelsColumn(row.analysis_labels),
    reason: row.analysis_reason,
  };
}

function normaliseBoolColumn(value: number | null): 0 | 1 | null {
  if (value === null) return null;
  return value === 1 ? 1 : 0;
}

/**
 * Decode the `labels` column (TEXT JSON array) into a `string[]`. A
 * malformed value or anything that isn't a JSON array of strings
 * decodes to `null` — readers treat that the same as "no labels yet"
 * rather than crashing.
 */
function parseLabelsColumn(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
      return parsed as string[];
    }
  } catch {
    /* malformed JSON */
  }
  return null;
}
