-- 017_extend_audio_library_url_import.sql
--
-- Migration scope (P11.T6):
--
-- Extend the `audio_library.source_type` CHECK enum from
-- {'system','user'} (P11.T3 / migration 014) to
-- {'system','user','url_import'}. Everything else about the table —
-- columns, defaults, indexes, FK, other CHECK constraints — is
-- preserved BYTE-FOR-BYTE from 014_create_audio_library.sql.
--
-- The new value `'url_import'` represents the P11.T6 user path
-- `POST /api/audio-library/import-url`: an audio file the user
-- supplied a public URL for, which the server downloaded to
-- `audio_library/imported/{audioId}.{ext}` and registered as a
-- row. design.md §8.5.1 + requirements.md §7.19 / §8.10 both
-- list this third value; P11.T3 deliberately deferred it to the
-- task that actually consumes it (this one).
--
-- Why a full table rebuild:
-- SQLite STRICT tables do NOT support modifying CHECK constraints
-- in place. The only sanctioned path is the 12-step table-rebuild
-- ritual; this file mirrors 014's structure step for step.
--
-- Data preservation guarantee:
-- Every existing audio_library row is copied into the new table
-- with identical column values. The new enum is a strict superset
-- of the old enum, so the data passes the new CHECK on copy.
--
-- Indexes recreated byte-for-byte (same names as 014):
--   * idx_audio_library_source_checksum   UNIQUE (source_type, checksum)
--   * idx_audio_library_source_active     (source_type, is_active)
--   * idx_audio_library_checksum          (checksum)

-- 1. Build the new table with the extended enum.
CREATE TABLE audio_library_new (
  id                   TEXT    NOT NULL PRIMARY KEY,
  name                 TEXT    NOT NULL,
  display_name         TEXT    NOT NULL,
  source_type          TEXT    NOT NULL,
  file_path            TEXT    NOT NULL,
  relative_path        TEXT,
  mime_type            TEXT,
  duration_seconds     REAL,
  size_bytes           INTEGER NOT NULL,
  checksum             TEXT    NOT NULL,
  is_active            INTEGER NOT NULL DEFAULT 1,
  tags                 TEXT,
  metadata_json        TEXT,
  created_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  CONSTRAINT audio_library_source_type_enum
    CHECK (source_type IN ('system', 'user', 'url_import')),

  CONSTRAINT audio_library_is_active_bool
    CHECK (is_active IN (0, 1)),

  CONSTRAINT audio_library_name_not_blank
    CHECK (length(name) > 0),

  CONSTRAINT audio_library_display_name_not_blank
    CHECK (length(display_name) > 0),

  CONSTRAINT audio_library_file_path_not_blank
    CHECK (length(file_path) > 0),

  CONSTRAINT audio_library_checksum_not_blank
    CHECK (length(checksum) > 0),

  CONSTRAINT audio_library_size_nonneg
    CHECK (size_bytes >= 0),

  CONSTRAINT audio_library_duration_nonneg
    CHECK (duration_seconds IS NULL OR duration_seconds >= 0)
) STRICT;

-- 2. Copy every existing row; new enum is a superset so the
-- existing 'system' / 'user' values pass the new CHECK.
INSERT INTO audio_library_new (
  id, name, display_name, source_type,
  file_path, relative_path, mime_type,
  duration_seconds, size_bytes, checksum,
  is_active, tags, metadata_json,
  created_at, updated_at
)
SELECT
  id, name, display_name, source_type,
  file_path, relative_path, mime_type,
  duration_seconds, size_bytes, checksum,
  is_active, tags, metadata_json,
  created_at, updated_at
FROM audio_library;

-- 3. Drop the old table; indexes go with it.
DROP TABLE audio_library;

-- 4. Rename.
ALTER TABLE audio_library_new RENAME TO audio_library;

-- 5. Recreate the 3 indexes byte-for-byte (same names as 014).
CREATE UNIQUE INDEX idx_audio_library_source_checksum
  ON audio_library (source_type, checksum);

CREATE INDEX idx_audio_library_source_active
  ON audio_library (source_type, is_active);

CREATE INDEX idx_audio_library_checksum
  ON audio_library (checksum);
