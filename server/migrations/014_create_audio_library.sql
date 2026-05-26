-- 014_create_audio_library.sql
--
-- Migration scope (P11.T3):
--
-- Land the `audio_library` table — one row per audio asset known to
-- the system. Two source types are supported in V1:
--
--   * 'system' — bundled / operator-curated audio under the
--                `DEFAULT_AUDIO_LIBRARY_DIR` directory (P11.T2
--                convention, default `server/assets/audio/default/`).
--                Seeded by `AudioLibraryService.seedDefaultDirectory()`.
--
--   * 'user'   — user-uploaded audio. NOT written by P11.T3 — the
--                upload + URL-import API surface lands in P11.T6
--                (`POST /api/audio-library/upload`,
--                `POST /api/audio-library/import-url`). The enum
--                value exists here so future migrations don't have
--                to extend the CHECK.
--
-- The table is intentionally decoupled from media_items / trips:
-- audio assets are reusable across many trips and many renders.
-- Per design.md §8.5.1 it has no FK to media_items / trips.
--
-- Schema-only migration. No data is written. The corresponding
-- repository, service, and seed runner land in the same task
-- (P11.T3) as application code; this file is just the table +
-- indexes. No worker / no route surface in P11.T3 — those are
-- P11.T6 territory.
--
-- Why STRICT:
-- Same rationale as every other table in this project — strict
-- typing catches mis-typed INSERTs immediately rather than
-- silently coercing values.
--
-- Why `(source_type, checksum)` UNIQUE (not just `checksum`):
-- A `system` audio file and a `user` upload could *theoretically*
-- have identical bytes (the same royalty-free MP3 imported by the
-- operator AND by a user). The composite UNIQUE keeps both rows
-- discoverable without one masking the other. Within a single
-- source_type, identical bytes resolve to the same row — the seed
-- runner relies on this for its UPSERT idempotency contract.

CREATE TABLE audio_library (
  id                   TEXT    NOT NULL PRIMARY KEY,
  -- Stable machine-friendly name (lowercased, alphanumeric,
  -- hyphen-separated). Used as a stable handle / log identifier.
  -- Derived from the filename minus extension during seed.
  name                 TEXT    NOT NULL,
  -- Human-friendly title. May contain spaces, capitalisation,
  -- non-ASCII. Default = the original filename's basename
  -- (without extension); can be edited later via P11.T6 API.
  display_name         TEXT    NOT NULL,
  -- Where this row originated. CHECK enum keeps the closed set
  -- enforced at the DB layer.
  source_type          TEXT    NOT NULL,
  -- Absolute on-disk path. Stored so the future render worker
  -- can pass it straight to ffmpeg's `-i` (which needs an
  -- absolute path). On a deployment migration the operator may
  -- need to re-seed or update these paths.
  file_path            TEXT    NOT NULL,
  -- Logical path relative to the storage / asset root used by
  -- LocalStorageProvider. May be NULL when an asset lives
  -- outside the project's storage root (e.g. an absolute /opt/
  -- path on a non-standard install). UI / API surfaces should
  -- prefer this when present.
  relative_path        TEXT,
  -- MIME type, e.g. `audio/mpeg`, `audio/mp4`, `audio/wav`.
  -- Derived from the file extension; NULL is allowed only when
  -- the seed runner could not determine the type (defensive —
  -- the discovery pass filters by audio extensions so this
  -- should always be populated in practice).
  mime_type            TEXT,
  -- Duration as reported by ffprobe. NULL when ffprobe is
  -- unavailable / failed for this file — V1 gracefully degrades
  -- so a single failed probe doesn't kill the whole seed run
  -- (recorded as R-146 in progress.md).
  duration_seconds     REAL,
  -- File size in bytes (from `fs.stat`). Non-negative.
  size_bytes           INTEGER NOT NULL,
  -- SHA256 hex digest of the file's bytes. Used as the
  -- deduplication key (combined with source_type) and the
  -- "did this file change on disk" detector for future re-seeds.
  checksum             TEXT    NOT NULL,
  -- Soft enable / disable flag. 1 = surfaced in API responses,
  -- 0 = hidden but row preserved (so historical renders that
  -- reference this audio_library_id still have a row to read).
  -- The seed runner inserts rows with is_active=1 and never
  -- toggles existing rows off (TODO: "deactivate missing audio"
  -- is a P11.T3+ polish — see service header for the rationale).
  is_active            INTEGER NOT NULL DEFAULT 1,
  -- Free-form comma-separated tag list (e.g. `cinematic,upbeat,
  -- travel`). UI can split / filter by these in future phases.
  -- Empty string OK; NULL also allowed for "untagged".
  tags                 TEXT,
  -- JSON blob of free-form metadata. The P11.T2 design notes
  -- and requirements §7.19 list "版权 / 来源 metadata" — V1
  -- writes this as a JSON object so future fields (license,
  -- author, source_url for imports, ISRC, etc.) can land here
  -- without schema migrations. NULL when no metadata is known.
  metadata_json        TEXT,
  created_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  CONSTRAINT audio_library_source_type_enum
    CHECK (source_type IN ('system', 'user')),

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

-- Idempotency / dedup key. The seed runner uses this composite to
-- decide INSERT vs UPDATE (same source_type + same checksum =
-- same row). The unique constraint also guards against accidental
-- duplicate inserts from a buggy future call site.
CREATE UNIQUE INDEX idx_audio_library_source_checksum
  ON audio_library (source_type, checksum);

-- "List all active audio of a given source type" — the most
-- common read path (UI shows system audio for the BGM picker;
-- a future admin view may list user uploads). Filtering by
-- source_type first, is_active second matches the typical query.
CREATE INDEX idx_audio_library_source_active
  ON audio_library (source_type, is_active);

-- Standalone checksum index for "have we seen these bytes
-- anywhere" lookups (cross-source-type dedup advisories etc.).
CREATE INDEX idx_audio_library_checksum
  ON audio_library (checksum);
