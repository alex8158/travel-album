// MediaVersionsRepository — write surface for media_versions (P3.T4).
//
// Scope (per docs/tasks.md P3.T4):
//   * `upsert` — INSERT a (media_id, version_type) row, or UPDATE the
//     existing one. The UNIQUE constraint added in 005 migration is
//     the conflict target. Used by the image-thumbnail worker today
//     and by P3.T5 metadata / P8 enhance / P10 ai_refine when they
//     land.
//   * No reads — Gallery (P2.T7) consumes the `media_items.preview_path`
//     / `thumbnail_path` columns directly. A read API on media_versions
//     comes when version switching lands (P8.T4 / P10.T5).
//
// Idempotency: re-running the same job (e.g. a retry, or manual
// re-thumbnail) repeats the upsert and overwrites the cached metrics
// without growing the table. The handler also calls
// `storage.putDerived(..., overwrite: true)` so the on-disk artefact
// is regenerated to match.

import { randomUUID } from "node:crypto";

import type { SqliteDatabase } from "../db/connection.js";

export interface MediaVersionUpsertData {
  readonly mediaId: string;
  readonly versionType: string;
  readonly filePath: string;
  readonly mimeType?: string | null;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly fileSize?: number | null;
  readonly modelName?: string | null;
  /** JSON-serialised processing params (sharp options, AI prompt, …). */
  readonly params?: string | null;
  /** Single timestamp value used for both `created_at` (new row) and `updated_at`. */
  readonly now: string;
}

export class MediaVersionsRepository {
  private readonly upsertStmt;

  constructor(private readonly db: SqliteDatabase) {
    // SQLite UPSERT (3.24+). Conflict target is the UNIQUE index
    // `idx_media_versions_media_version` on (media_id, version_type)
    // declared in 005_create_media_versions.sql. On conflict we keep
    // the existing `id` and `created_at` and refresh the rest —
    // `updated_at` always bumps. The status flips back to 'ready' on
    // re-success (in case a prior run had been marked 'failed').
    this.upsertStmt = db.prepare(`
      INSERT INTO media_versions (
        id, media_id, version_type, file_path,
        mime_type, width, height, file_size,
        model_name, params, status,
        created_at, updated_at
      ) VALUES (
        @id, @mediaId, @versionType, @filePath,
        @mimeType, @width, @height, @fileSize,
        @modelName, @params, 'ready',
        @now, @now
      )
      ON CONFLICT(media_id, version_type) DO UPDATE SET
        file_path  = excluded.file_path,
        mime_type  = excluded.mime_type,
        width      = excluded.width,
        height     = excluded.height,
        file_size  = excluded.file_size,
        model_name = excluded.model_name,
        params     = excluded.params,
        status     = 'ready',
        updated_at = excluded.updated_at
    `);
  }

  upsert(data: MediaVersionUpsertData): void {
    this.upsertStmt.run({
      id: randomUUID(),
      mediaId: data.mediaId,
      versionType: data.versionType,
      filePath: data.filePath,
      mimeType: data.mimeType ?? null,
      width: data.width ?? null,
      height: data.height ?? null,
      fileSize: data.fileSize ?? null,
      modelName: data.modelName ?? null,
      params: data.params ?? null,
      now: data.now,
    });
  }
}
