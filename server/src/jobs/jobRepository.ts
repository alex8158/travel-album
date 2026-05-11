// JobRepository — write-only surface for P2.T4 Upload_Manager.
//
// Scope (per docs/tasks.md P2.T4 + this turn's user confirmation):
//   * Upload_Manager INSERTs an initial `pending` job per successful
//     known-type upload (image → image_thumbnail, video → video_metadata,
//     per docs/design.md §6.2). That's it.
//   * No reads, no retry / cancel / state-transition helpers — those
//     belong to P4 (Worker pool + Job API).
//
// `insert` is synchronous (better-sqlite3). UploadService composes it
// with MediaRepository.insert inside a single `db.transaction()` so a
// failure in either INSERT rolls both back.

import type { SqliteDatabase } from "../db/connection.js";
import type { JobInsertData } from "./jobTypes.js";

const DEFAULT_STATUS = "pending";

export class JobRepository {
  private readonly insertStmt;

  constructor(private readonly db: SqliteDatabase) {
    this.insertStmt = db.prepare(`
      INSERT INTO processing_jobs (
        id, media_id, job_type, status, payload,
        created_at, updated_at
      ) VALUES (
        @id, @mediaId, @jobType, @status, @payload,
        @createdAt, @updatedAt
      )
    `);
  }

  /**
   * Persist a brand-new processing_jobs row. Throws on PK collision,
   * FK violation (media_id missing), or CHECK failure
   * (status not in enum / job_type blank / etc.). UploadService treats
   * any throw as "this upload didn't make it past the DB" and triggers
   * the compensating remove of the original file.
   */
  insert(data: JobInsertData): void {
    this.insertStmt.run({
      id: data.id,
      mediaId: data.mediaId,
      jobType: data.jobType,
      status: data.status ?? DEFAULT_STATUS,
      payload: data.payload ?? null,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    });
  }
}
