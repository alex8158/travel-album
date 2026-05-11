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
import type { ListMediaOptions, MediaItem, MediaStatus, MediaUserDecision } from "./mediaTypes.js";
import type { MediaInsertData, MediaType } from "./mediaTypes.js";

const DEFAULT_STATUS = "uploaded";
const DEFAULT_USER_DECISION = "undecided";

const DEFAULT_LIMIT = 50;

/**
 * Internal row shape returned by `SELECT ... FROM media_items`.
 * Snake_case columns map to camelCase on the way out via `rowToItem`.
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
}

/**
 * Read projection. file_hash / perceptual_hash are NOT included — they
 * are dedup internals (P5) and not useful to the frontend.
 */
const SELECT_COLUMNS = `
  id,
  trip_id,
  type,
  original_path,
  preview_path,
  thumbnail_path,
  file_size,
  mime_type,
  extension,
  width,
  height,
  duration,
  status,
  user_decision,
  created_at,
  updated_at,
  deleted_at
`;

export class MediaRepository {
  private readonly insertStmt;
  private readonly findByIdActiveStmt;
  private readonly findByIdAnyStmt;
  private readonly listByTripActiveStmt;
  private readonly listByTripAllStmt;
  private readonly updateImageDerivedPathsStmt;

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
      SELECT ${SELECT_COLUMNS}
      FROM media_items
      WHERE id = ? AND deleted_at IS NULL
    `);

    this.findByIdAnyStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM media_items
      WHERE id = ?
    `);

    // Newest-first ordering mirrors TripRepository: the Gallery (P2.T7)
    // wants most recent uploads at the top. Tie-break on id keeps the
    // page boundaries deterministic across paginated requests.
    this.listByTripActiveStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM media_items
      WHERE trip_id = ? AND deleted_at IS NULL
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `);

    this.listByTripAllStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM media_items
      WHERE trip_id = ?
      ORDER BY created_at DESC, id DESC
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
  };
}
