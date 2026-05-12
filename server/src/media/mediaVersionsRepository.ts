// MediaVersionsRepository — data-access layer for media_versions.
//
// Scope:
//   * P3.T4 added `upsert` — INSERT a (media_id, version_type) row,
//     or UPDATE the existing one. The UNIQUE constraint from 005 is
//     the conflict target. Used by image-thumbnail / image-metadata
//     workers today, by P8 enhance / P10 ai_refine when they land.
//   * P3.T6 adds `listByMediaId` — return all versions for one media,
//     ordered by `version_type` for stable rendering on the detail
//     page (`GET /api/media/:id`).
//   * No deletes / state-machine helpers — soft-delete cascades come
//     for free via the FK in 005; explicit per-version delete is a
//     P8.T4 / P10.T5 concern.

import { randomUUID } from "node:crypto";

import type { SqliteDatabase } from "../db/connection.js";
import type { MediaVersion } from "./mediaTypes.js";

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

interface MediaVersionRow {
  id: string;
  media_id: string;
  version_type: string;
  file_path: string;
  mime_type: string | null;
  width: number | null;
  height: number | null;
  file_size: number | null;
  model_name: string | null;
  params: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

const SELECT_COLUMNS = `
  id,
  media_id,
  version_type,
  file_path,
  mime_type,
  width,
  height,
  file_size,
  model_name,
  params,
  status,
  created_at,
  updated_at
`;

export class MediaVersionsRepository {
  private readonly upsertStmt;
  private readonly listByMediaIdStmt;

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

    // List all versions for one media, ordered by version_type for
    // a stable, deterministic detail-page render (the UNIQUE index
    // on (media_id, version_type) makes this lookup cheap).
    this.listByMediaIdStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM media_versions
      WHERE media_id = ?
      ORDER BY version_type ASC
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

  /**
   * Return every version row for one media, ordered by version_type.
   * Empty array when no versions exist (e.g. uploaded but not yet
   * processed). Used by the `GET /api/media/:id` detail endpoint
   * (P3.T6) to bundle thumbnail / preview / metadata together.
   */
  listByMediaId(mediaId: string): MediaVersion[] {
    const rows = this.listByMediaIdStmt.all(mediaId) as MediaVersionRow[];
    return rows.map(rowToVersion);
  }
}

function rowToVersion(row: MediaVersionRow): MediaVersion {
  return {
    id: row.id,
    mediaId: row.media_id,
    versionType: row.version_type,
    filePath: row.file_path,
    mimeType: row.mime_type,
    width: row.width,
    height: row.height,
    fileSize: row.file_size,
    modelName: row.model_name,
    params: row.params,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
