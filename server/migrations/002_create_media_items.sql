-- 002_create_media_items.sql
--
-- Media items table (P2.T1, requirements §8.2). One row per uploaded
-- media file (image / video / unknown). Original files and derived
-- artefacts are tracked here as paths into storage; the file content
-- itself never enters SQLite (CLAUDE.md §3.2 / design.md §5).
--
-- Lifecycle states (CLAUDE.md §4.1):
--   uploaded  → file is on disk, no processing started
--   processing → at least one job is running for this media
--   processed  → all critical jobs succeeded
--   failed     → any critical job failed without recovery
--   archived   → user opt-in (future)
--   deleted    → set together with deleted_at on soft delete
--
-- user_decision tracks human intent during dedup / cleanup workflows
-- (P5 / P6 / P7); defaults to 'undecided' until the user picks.
--
-- FK trip_id → trips(id) ON DELETE RESTRICT — a trip cannot be hard
-- deleted while it still owns media (CLAUDE.md §2.6 + design §4.3).
-- Soft deletes do not cascade; both sides maintain their own
-- deleted_at independently.
--
-- Hash / dimension / duration / mime / extension columns stay
-- nullable because they are filled lazily by later tasks
-- (P3.T2 metadata, P5.T2 file/perceptual hash, P9.T2 video metadata).
--
-- The reciprocal FK trips.cover_media_id → media_items(id) is added
-- by 003_add_trips_cover_media_id_fk.sql via table rebuild.

CREATE TABLE media_items (
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

  CONSTRAINT media_items_trip_fk
    FOREIGN KEY (trip_id) REFERENCES trips (id) ON DELETE RESTRICT
) STRICT;

-- Indexes per design.md §4.2: trip_id (per-trip lookups dominate),
-- file_hash (SHA256 exact-duplicate match in P5.T2), status (worker
-- scheduling and global counts), deleted_at (default soft-delete
-- filtering).
CREATE INDEX idx_media_items_trip_id    ON media_items (trip_id);
CREATE INDEX idx_media_items_file_hash  ON media_items (file_hash);
CREATE INDEX idx_media_items_status     ON media_items (status);
CREATE INDEX idx_media_items_deleted_at ON media_items (deleted_at);
