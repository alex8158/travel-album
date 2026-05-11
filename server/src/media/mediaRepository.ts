// MediaRepository — write-only surface for P2.T4 Upload_Manager.
//
// Scope (per docs/tasks.md P2.T4 + this turn's user confirmation):
//   * The Upload_Manager INSERTs media_items rows. That's it.
//   * Read operations (findById / list with pagination / filters) and
//     the corresponding HTTP layer land in P2.T5. Until then this
//     repository deliberately exposes a single `insert` method to
//     keep the surface honest about the current capability.
//   * No state-machine helpers (e.g. markProcessing / markFailed) —
//     those belong to P4 once the Worker pool lands.
//
// The class follows TripRepository's prepared-statement pattern so the
// later P2.T5 additions can layer on without restructuring.
//
// `insert` is synchronous (better-sqlite3 API). It does not wrap itself
// in a transaction — callers that need atomic media + job insertion
// (UploadService) compose `db.transaction(() => { ... })` around both
// repositories.

import type { SqliteDatabase } from "../db/connection.js";
import type { MediaInsertData } from "./mediaTypes.js";

const DEFAULT_STATUS = "uploaded";
const DEFAULT_USER_DECISION = "undecided";

export class MediaRepository {
  private readonly insertStmt;

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
}
