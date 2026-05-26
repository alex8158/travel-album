-- 016_extend_media_versions_edited.sql
--
-- Migration scope (P11.T5):
--
-- Extend the `media_versions.version_type` CHECK enum with one new
-- value: `'edited'`. Everything else about the table — columns,
-- defaults, indexes, FK, other CHECK constraints — is preserved
-- BYTE-FOR-BYTE from 013_extend_media_versions_video_optimized.sql.
--
-- The new value represents the P11.T5 output of the video render
-- worker (`video_render` job_type): an edited video produced by
-- concatenating clips from an `edit_plans` row, applying the plan's
-- `audioPolicy`, and re-muxing into a single MP4. The artefact
-- lands at `derived/{firstClipMediaId}/edited.mp4` (V1 — see
-- progress.md R-147 for the multi-edit-per-trip future direction).
--
-- Distinction from existing version_type values:
--   * `original`        — the raw upload (canonical source bytes)
--   * `thumbnail`       — gallery-list cache
--   * `preview`         — detail-page cache
--   * `enhanced`        — P8 sharp-based image refinement
--   * `ai_refined`      — P10 AI-assisted image refinement
--   * `video_cover`     — P9.T3 single JPEG cover frame
--   * `video_proxy`     — P9.T4 INTERNAL low-res analysis source
--   * `metadata`        — P9.T2 metadata-only record (no derived file)
--   * `video_optimized` — P11.T1 user-facing 1080p re-encode
--   * `edited`          — P11.T5 multi-clip edited video (NEW)
--
-- Why a full table rebuild:
-- SQLite STRICT tables do NOT support modifying CHECK constraints
-- in place. The only sanctioned path is the 12-step table-rebuild
-- ritual; this file mirrors 013's structure step for step.
--
-- Data preservation guarantee:
-- Every existing media_versions row is copied into the new table
-- with identical column values. The new enum is a strict superset
-- of the old enum, so the data passes the new CHECK on copy.
--
-- Non-goals (explicit per scope):
--   * No new columns.
--   * No new indexes.
--   * No FK changes.
--   * No status / size / dimension constraint tweaks.
-- The diff from 013 is exactly one new value in one CHECK clause.

-- 1. Build the new table with the extended enum.
CREATE TABLE media_versions_new (
  id              TEXT    NOT NULL PRIMARY KEY,
  media_id        TEXT    NOT NULL,
  version_type    TEXT    NOT NULL,
  file_path       TEXT    NOT NULL,
  mime_type       TEXT,
  width           INTEGER,
  height          INTEGER,
  file_size       INTEGER,
  model_name      TEXT,
  params          TEXT,
  status          TEXT    NOT NULL DEFAULT 'ready',
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  CONSTRAINT media_versions_version_type_enum
    CHECK (version_type IN (
      'original',
      'thumbnail',
      'preview',
      'enhanced',
      'ai_refined',
      'video_cover',
      'video_proxy',
      'metadata',
      'video_optimized',
      'edited'              -- new in 016 (P11.T5)
    )),

  CONSTRAINT media_versions_status_enum
    CHECK (status IN ('ready', 'failed')),

  CONSTRAINT media_versions_file_path_not_blank
    CHECK (length(file_path) > 0),

  CONSTRAINT media_versions_file_size_nonneg
    CHECK (file_size IS NULL OR file_size >= 0),

  CONSTRAINT media_versions_dimensions_positive
    CHECK (
      (width  IS NULL OR width  > 0) AND
      (height IS NULL OR height > 0)
    ),

  CONSTRAINT media_versions_media_fk
    FOREIGN KEY (media_id) REFERENCES media_items (id) ON DELETE CASCADE
) STRICT;

-- 2. Copy every existing row. Column list explicit so a future
-- drift in 013 fails loudly rather than silently mis-aligning.
INSERT INTO media_versions_new (
  id, media_id, version_type, file_path,
  mime_type, width, height, file_size,
  model_name, params, status,
  created_at, updated_at
)
SELECT
  id, media_id, version_type, file_path,
  mime_type, width, height, file_size,
  model_name, params, status,
  created_at, updated_at
FROM media_versions;

-- 3. Drop the old table. Indexes go with it.
DROP TABLE media_versions;

-- 4. Rename. FK preserved.
ALTER TABLE media_versions_new RENAME TO media_versions;

-- 5. Recreate the four indexes byte-for-byte (same names as 013).
CREATE UNIQUE INDEX idx_media_versions_media_version
  ON media_versions (media_id, version_type);

CREATE INDEX idx_media_versions_version_type ON media_versions (version_type);
CREATE INDEX idx_media_versions_file_path    ON media_versions (file_path);
CREATE INDEX idx_media_versions_status       ON media_versions (status);
