// AudioLibraryRepository — data-access layer for the `audio_library`
// table introduced in migration 014 (P11.T3).
//
// Scope:
//   * P11.T3 lands the schema + seed runner + basic CRUD. No HTTP
//     surface, no edit-plan integration — those are P11.T6 and
//     P11.T4/T5 respectively.
//   * All SQL stays in this file; the Service / smoke layers
//     compose around the typed read/write surface (mirrors the
//     videoSegmentsRepository / mediaVersionsRepository pattern).
//
// Conventions:
//   * Every prepared statement is constructed once in the
//     constructor and cached.
//   * Row → domain mapping happens in one place (`rowToView`) so
//     consumers always see camelCase typed shapes.
//   * `upsertBySourceTypeAndChecksum` is the seed runner's entry
//     point — it preserves user-edited surface (`display_name`,
//     `tags`, `metadata_json`, `is_active`) on re-seed while
//     refreshing the bytes-of-truth columns (`file_path`,
//     `relative_path`, `size_bytes`, `duration_seconds`,
//     `mime_type`, `updated_at`).

import type { SqliteDatabase } from "../db/connection.js";

/** Closed enum mirroring the `source_type` CHECK in migration 014. */
export type AudioLibrarySourceType = "system" | "user";

/**
 * Domain-shape audio library row. Field-level docs explain the
 * non-obvious semantics; SQL-level constraints are in migration 014.
 */
export interface AudioLibraryView {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly sourceType: AudioLibrarySourceType;
  readonly filePath: string;
  readonly relativePath: string | null;
  readonly mimeType: string | null;
  readonly durationSeconds: number | null;
  readonly sizeBytes: number;
  readonly checksum: string;
  readonly isActive: boolean;
  readonly tags: string | null;
  readonly metadataJson: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * INSERT-time payload. The seed runner constructs one of these per
 * discovered audio file; tests / future P11.T6 upload code use the
 * same shape.
 */
export interface AudioLibraryInsertData {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly sourceType: AudioLibrarySourceType;
  readonly filePath: string;
  readonly relativePath: string | null;
  readonly mimeType: string | null;
  readonly durationSeconds: number | null;
  readonly sizeBytes: number;
  readonly checksum: string;
  readonly isActive?: boolean;
  readonly tags?: string | null;
  readonly metadataJson?: string | null;
  /** Single timestamp used for both created_at and updated_at on new rows. */
  readonly now: string;
}

/** UPSERT-on-conflict payload. Same shape as insert but the runner
 * treats `id` / `displayName` / `tags` / `metadataJson` / `isActive`
 * as "first-write wins" — the UPDATE branch in
 * `upsertBySourceTypeAndChecksum` only refreshes the
 * bytes-of-truth columns. */
export type AudioLibraryUpsertData = AudioLibraryInsertData;

/** Outcome enum for {@link AudioLibraryRepository.upsertBySourceTypeAndChecksum}. */
export type AudioLibraryUpsertOutcome = "inserted" | "updated" | "unchanged";

export interface AudioLibraryUpsertResult {
  readonly id: string;
  readonly outcome: AudioLibraryUpsertOutcome;
}

interface AudioLibraryRow {
  id: string;
  name: string;
  display_name: string;
  source_type: string;
  file_path: string;
  relative_path: string | null;
  mime_type: string | null;
  duration_seconds: number | null;
  size_bytes: number;
  checksum: string;
  is_active: number;
  tags: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_COLUMNS = `
  id, name, display_name, source_type,
  file_path, relative_path, mime_type,
  duration_seconds, size_bytes, checksum,
  is_active, tags, metadata_json,
  created_at, updated_at
`;

export class AudioLibraryRepository {
  private readonly insertStmt;
  private readonly findByIdStmt;
  private readonly findBySourceAndChecksumStmt;
  private readonly listActiveBySourceTypeStmt;
  private readonly listAllBySourceTypeStmt;
  private readonly updateBytesOfTruthStmt;
  private readonly setActiveStmt;

  constructor(private readonly db: SqliteDatabase) {
    this.insertStmt = db.prepare(`
      INSERT INTO audio_library (
        id, name, display_name, source_type,
        file_path, relative_path, mime_type,
        duration_seconds, size_bytes, checksum,
        is_active, tags, metadata_json,
        created_at, updated_at
      ) VALUES (
        @id, @name, @displayName, @sourceType,
        @filePath, @relativePath, @mimeType,
        @durationSeconds, @sizeBytes, @checksum,
        @isActive, @tags, @metadataJson,
        @now, @now
      )
    `);

    this.findByIdStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM audio_library
      WHERE id = ?
    `);

    this.findBySourceAndChecksumStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM audio_library
      WHERE source_type = ? AND checksum = ?
    `);

    // Ordered by display_name for deterministic UI / smoke output.
    // `is_active=1` filter matches the typical read path (BGM picker
    // never wants disabled audio).
    this.listActiveBySourceTypeStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM audio_library
      WHERE source_type = ? AND is_active = 1
      ORDER BY display_name ASC, id ASC
    `);

    // Admin / smoke variant — includes disabled rows. Same ordering.
    this.listAllBySourceTypeStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM audio_library
      WHERE source_type = ?
      ORDER BY display_name ASC, id ASC
    `);

    // Seed-runner UPDATE branch. Touches ONLY the bytes-of-truth
    // columns + `updated_at`. Preserves:
    //   * `id` — stable handle, future renders may already reference it
    //   * `name` — derived once at first seed; renaming the on-disk
    //              file changes display_name semantics (a different
    //              human label) but `name` is the machine handle
    //   * `display_name` — operator may have customised it via the
    //                       (future P11.T6) admin path
    //   * `tags` / `metadata_json` — operator-edited surface
    //   * `is_active` — operator may have disabled this audio; a
    //                    re-seed must not un-disable it
    //   * `created_at` — original timestamp preserved
    this.updateBytesOfTruthStmt = db.prepare(`
      UPDATE audio_library
      SET file_path        = @filePath,
          relative_path    = @relativePath,
          mime_type        = @mimeType,
          duration_seconds = @durationSeconds,
          size_bytes       = @sizeBytes,
          updated_at       = @now
      WHERE source_type = @sourceType AND checksum = @checksum
    `);

    // Toggle active flag. Used by smokes / future operator paths.
    this.setActiveStmt = db.prepare(`
      UPDATE audio_library
      SET is_active = @isActive,
          updated_at = @now
      WHERE id = @id
    `);
  }

  findById(id: string): AudioLibraryView | null {
    const row = this.findByIdStmt.get(id) as AudioLibraryRow | undefined;
    return row === undefined ? null : rowToView(row);
  }

  findBySourceTypeAndChecksum(
    sourceType: AudioLibrarySourceType,
    checksum: string,
  ): AudioLibraryView | null {
    const row = this.findBySourceAndChecksumStmt.get(sourceType, checksum) as
      | AudioLibraryRow
      | undefined;
    return row === undefined ? null : rowToView(row);
  }

  listActiveBySourceType(sourceType: AudioLibrarySourceType): readonly AudioLibraryView[] {
    const rows = this.listActiveBySourceTypeStmt.all(sourceType) as AudioLibraryRow[];
    return rows.map(rowToView);
  }

  listAllBySourceType(sourceType: AudioLibrarySourceType): readonly AudioLibraryView[] {
    const rows = this.listAllBySourceTypeStmt.all(sourceType) as AudioLibraryRow[];
    return rows.map(rowToView);
  }

  /**
   * Idempotent UPSERT keyed on (source_type, checksum).
   *
   * Outcomes:
   *   * `inserted` — no prior row; one is inserted with all
   *     supplied fields including operator-surface columns.
   *   * `updated`  — prior row exists; only the bytes-of-truth
   *     columns + `updated_at` are refreshed (see SQL above).
   *   * `unchanged` — defensive value reserved for "row exists
   *     but `updateBytesOfTruthStmt.run()` reported `changes=0`".
   *     In practice changes is always 1 when the row exists, but
   *     callers should still handle this for paranoia.
   *
   * The seed runner uses the outcome to populate its summary
   * counters; smokes assert on it directly.
   */
  upsertBySourceTypeAndChecksum(data: AudioLibraryUpsertData): AudioLibraryUpsertResult {
    const existing = this.findBySourceAndChecksumStmt.get(data.sourceType, data.checksum) as
      | AudioLibraryRow
      | undefined;
    if (existing === undefined) {
      this.insertStmt.run({
        id: data.id,
        name: data.name,
        displayName: data.displayName,
        sourceType: data.sourceType,
        filePath: data.filePath,
        relativePath: data.relativePath,
        mimeType: data.mimeType,
        durationSeconds: data.durationSeconds,
        sizeBytes: data.sizeBytes,
        checksum: data.checksum,
        isActive: data.isActive === false ? 0 : 1,
        tags: data.tags ?? null,
        metadataJson: data.metadataJson ?? null,
        now: data.now,
      });
      return { id: data.id, outcome: "inserted" };
    }
    const result = this.updateBytesOfTruthStmt.run({
      filePath: data.filePath,
      relativePath: data.relativePath,
      mimeType: data.mimeType,
      durationSeconds: data.durationSeconds,
      sizeBytes: data.sizeBytes,
      sourceType: data.sourceType,
      checksum: data.checksum,
      now: data.now,
    });
    return {
      id: existing.id,
      outcome: result.changes === 0 ? "unchanged" : "updated",
    };
  }

  /**
   * Set an existing row's `is_active` flag. Returns the number of
   * rows actually modified (0 when the id is unknown OR the flag
   * already matched the requested value — SQLite UPDATE doesn't
   * distinguish those without a SELECT, and callers don't usually
   * need to).
   */
  setActive(id: string, isActive: boolean, now: string): number {
    const result = this.setActiveStmt.run({
      id,
      isActive: isActive ? 1 : 0,
      now,
    });
    return result.changes as number;
  }
}

function rowToView(row: AudioLibraryRow): AudioLibraryView {
  // Defensive: the CHECK enum constrains source_type at the DB
  // layer, but the runtime cast is still needed to satisfy the
  // domain-type narrowing.
  const sourceType: AudioLibrarySourceType = row.source_type === "user" ? "user" : "system";
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    sourceType,
    filePath: row.file_path,
    relativePath: row.relative_path,
    mimeType: row.mime_type,
    durationSeconds: row.duration_seconds,
    sizeBytes: row.size_bytes,
    checksum: row.checksum,
    isActive: row.is_active === 1,
    tags: row.tags,
    metadataJson: row.metadata_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
