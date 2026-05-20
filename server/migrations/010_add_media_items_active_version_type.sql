-- 010_add_media_items_active_version_type.sql
--
-- Migration scope (P8.T4):
--
-- Add `media_items.active_version_type` to record which version the
-- user has selected for display. The column is the persistence layer
-- behind `POST /api/media/:id/select-version` + `GET /api/media/:id/versions`
-- (requirements §7.9 #4-5 — "用户可以查看增强前后对比 / 用户可以选择采用原图或增强图").
--
-- Why this column instead of reusing an existing one:
--   * `preview_path` / `thumbnail_path` already have a fixed
--     semantics (medium-res webp / small-res webp, produced by P3.T4).
--     Overloading them with "currently selected user version" would
--     mix two unrelated concerns and break the thumbnail worker (P3.T4
--     overwrites preview_path on every re-run).
--   * `enhanced.jpg` and future variants live in `media_versions`,
--     which has UNIQUE(media_id, version_type) — so a single
--     enum-typed column on media_items uniquely identifies the
--     user's pick without an extra FK or join.
--
-- Closed enum:
--   * 'original'   — default; the originally-uploaded file referenced
--                    by `media_items.original_path`. Has no row in
--                    `media_versions` (it's the implicit base).
--   * 'enhanced'   — P8.T3 wrote a `media_versions(version_type='enhanced')`
--                    row + an `enhanced.jpg` file under `derived/`.
--   * 'ai_refined' — P10 will write `media_versions(version_type='ai_refined')`.
--
-- 'thumbnail' / 'preview' / 'video_cover' / 'video_proxy' /
-- 'metadata' are deliberately NOT valid `active_version_type` values:
-- they are operational artefacts (thumbnails for grid, metadata for
-- EXIF panel, etc.), not user-facing version choices.
--
-- Default: every existing media_items row gains
-- `active_version_type = 'original'` automatically (NOT NULL DEFAULT).
-- This is the correct value for every row at migration time — nothing
-- has been "selected" yet, so the original is the implicit active view.
--
-- Why a full table rebuild:
-- SQLite STRICT tables do not support `ALTER TABLE ... ADD CHECK`
-- (or modifying existing CHECKs in place); the only sanctioned path
-- is the 12-step rebuild ritual from
-- https://sqlite.org/lang_altertable.html#otheralter. We mirror what
-- migrations 003 / 006 did: rebuild the table, copy data verbatim,
-- recreate indexes byte-for-byte.
--
-- FK considerations (R-29 / migration 003 / 006 pattern):
--   * media_items is referenced BY: trips.cover_media_id,
--     duplicate_groups.recommended_media_id,
--     duplicate_group_items.media_id, media_analysis.media_id,
--     media_versions.media_id, processing_jobs.media_id.
--   * The DROP + RENAME below keeps the same id values, so all
--     incoming FKs remain valid. We DO NOT toggle PRAGMA foreign_keys
--     because:
--       - The migration runner wraps this file in a transaction;
--         `PRAGMA foreign_keys = OFF` is a no-op inside a transaction.
--       - The INSERT INTO new SELECT * FROM old preserves id values
--         that already satisfy every incoming FK (those FKs check
--         that referenced rows exist — which they do throughout the
--         rebuild because the new table inherits the same ids).
--   * trips.cover_media_id has ON DELETE SET NULL — but we never
--     DELETE here, only DROP the table. Foreign keys reference the
--     parent BY NAME, so after the RENAME they re-bind to the new
--     table automatically. This is the same trick 003 used to add
--     the reciprocal cover_media_id FK without breaking the world.
--
-- Data preservation guarantee:
-- Every existing media_items row is copied with identical column
-- values; the new `active_version_type` column inherits the DEFAULT
-- 'original'. The 12-step ritual is the only path that's allowed to
-- skip a per-row UPDATE because the DEFAULT IS the desired value.
--
-- Non-goals of this migration (explicit per P8.T4 prompt):
--   * No changes to other columns / indexes / constraints.
--   * No file moves on disk.
--   * No backfill UPDATEs (DEFAULT covers it).
--   * No data migration — every existing row stays at 'original',
--     which is correct: nothing has been "selected" yet.

-- 1. Build the new table with the additional column. Schema is
-- otherwise a verbatim copy of 002 — same columns, defaults, FK,
-- other CHECK constraints. The new CHECK on the new column lives at
-- the bottom of the constraint list so the diff is easy to read.
CREATE TABLE media_items_new (
  id              TEXT    PRIMARY KEY NOT NULL,
  trip_id         TEXT    NOT NULL,
  type            TEXT    NOT NULL,
  original_path   TEXT,
  preview_path    TEXT,
  thumbnail_path  TEXT,
  file_hash       TEXT,
  perceptual_hash TEXT,
  file_size       INTEGER,
  mime_type       TEXT,
  extension       TEXT,
  width           INTEGER,
  height          INTEGER,
  duration        REAL,
  status          TEXT    NOT NULL DEFAULT 'uploaded',
  user_decision   TEXT    NOT NULL DEFAULT 'undecided',
  active_version_type TEXT NOT NULL DEFAULT 'original',          -- new in 010
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at      TEXT,

  CONSTRAINT media_items_type_enum
    CHECK (type IN ('image', 'video', 'unknown')),

  CONSTRAINT media_items_status_enum
    CHECK (status IN ('uploaded', 'processing', 'processed', 'failed', 'archived', 'deleted')),

  CONSTRAINT media_items_user_decision_enum
    CHECK (user_decision IN ('keep', 'remove', 'undecided')),

  CONSTRAINT media_items_file_size_nonneg
    CHECK (file_size IS NULL OR file_size >= 0),

  CONSTRAINT media_items_dimensions_positive
    CHECK (
      (width  IS NULL OR width  > 0) AND
      (height IS NULL OR height > 0)
    ),

  CONSTRAINT media_items_duration_nonneg
    CHECK (duration IS NULL OR duration >= 0),

  CONSTRAINT media_items_active_version_type_enum                  -- new in 010
    CHECK (active_version_type IN ('original', 'enhanced', 'ai_refined')),

  CONSTRAINT media_items_trip_fk
    FOREIGN KEY (trip_id) REFERENCES trips (id) ON DELETE RESTRICT
) STRICT;

-- 2. Copy every existing row. Explicit column list — adds
-- 'original' as the active_version_type for every existing row.
INSERT INTO media_items_new (
  id, trip_id, type,
  original_path, preview_path, thumbnail_path,
  file_hash, perceptual_hash, file_size,
  mime_type, extension, width, height, duration,
  status, user_decision,
  active_version_type,
  created_at, updated_at, deleted_at
)
SELECT
  id, trip_id, type,
  original_path, preview_path, thumbnail_path,
  file_hash, perceptual_hash, file_size,
  mime_type, extension, width, height, duration,
  status, user_decision,
  'original',                                                     -- explicit
  created_at, updated_at, deleted_at
FROM media_items;

-- 3. Drop the old table. Indexes attached to it disappear with it.
-- All referencing FKs (trips.cover_media_id, duplicate_groups.*,
-- media_versions.*, processing_jobs.*, media_analysis.*,
-- duplicate_group_items.*) will rebind to the new table after the
-- RENAME because SQLite resolves FK targets by name.
DROP TABLE media_items;

-- 4. Rename the new table into the canonical name. From SQLite's
-- perspective, every FK that previously referenced `media_items`
-- now references the new table — same name, same ids.
ALTER TABLE media_items_new RENAME TO media_items;

-- 5. Recreate the four indexes from 002 + 009 (009 didn't add new
-- indexes; the latest index set is exactly what 002 declared).
-- Keep names + column lists byte-for-byte identical so existing code
-- and DBA queries continue to work.
CREATE INDEX idx_media_items_trip_id    ON media_items (trip_id);
CREATE INDEX idx_media_items_file_hash  ON media_items (file_hash);
CREATE INDEX idx_media_items_status     ON media_items (status);
CREATE INDEX idx_media_items_deleted_at ON media_items (deleted_at);
