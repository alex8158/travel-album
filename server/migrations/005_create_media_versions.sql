-- 005_create_media_versions.sql
--
-- Media versions table (P3.T3, requirements §8.6 + design.md §4.2 / §5.2).
-- One row per derived artefact attached to a media_items row:
--
--   thumbnail   — P3.T4 sharp output `derived/{mediaId}/thumb.webp`
--   preview     — P3.T4 sharp output `derived/{mediaId}/preview.webp`
--   enhanced    — P8 image-enhance output `derived/{mediaId}/enhanced.jpg`
--   ai_refined  — P10 AI-refine output `derived/{mediaId}/ai_refined_*.jpg`
--   video_cover — P9 ffmpeg output     `derived/{mediaId}/video_cover.jpg`
--   video_proxy — P9 ffmpeg output     `derived/{mediaId}/video_proxy.mp4`
--   original    — reserved per requirements §8.6; the upload path
--                 itself does NOT write to media_versions (the canonical
--                 original is tracked by `media_items.original_path`).
--                 The enum value exists so a future "promote existing
--                 file to a version" feature would not need a migration.
--
-- Scope of P3.T3 (per docs/tasks.md): SCHEMA ONLY. Repository / Service /
-- workers / API are deferred:
--   * `image_thumbnail` / `image_metadata` workers are P3.T4 / P3.T5.
--   * `media_versions` reads / API are P3.T6 onwards.
--   * Image-enhance writes are P8; AI-refine writes are P10; video
--     derived writes are P9. All of those will INSERT into this table
--     when they land.
--
-- Field decisions:
--   * `file_path` (NOT NULL) is the logical storage path consumable
--     via the P3.T1 `/storage/<file_path>` route. Same convention as
--     `media_items.original_path` etc.
--   * `mime_type` / `width` / `height` / `file_size` are nullable
--     since they are derivable from the file itself and not strictly
--     required at INSERT time. They cache the values for fast Gallery
--     rendering without extra ffprobe / sharp calls.
--   * `model_name` is nullable; only AI versions set it (design §7.6).
--   * `params` is nullable JSON, stored as TEXT (STRICT tables do not
--     have a JSON type; SQLite's `json` is just typed TEXT). Workers
--     serialise their parameters here for auditability.
--   * `status` keeps the surface tiny — `ready` (the only state we
--     ever INSERT today) and `failed` (reserved for the case where
--     a worker wrote a row but later detected the underlying file is
--     gone). We do NOT include a `generating` value because that
--     transient state lives in `processing_jobs`, not here — rows
--     only appear after a successful generation.
--   * `created_at` + `updated_at` mirror every other table in the
--     project. Defaults use the same `strftime` expression as 001/002/004.
--
-- Constraints:
--   * version_type CHECK — strict enum per design.md §4.2.
--   * status       CHECK — strict enum.
--   * file_path    CHECK — non-blank (mirrors `trips_title_not_blank`).
--   * file_size    CHECK — non-negative when present (mirrors media_items).
--   * width/height CHECK — positive when present (mirrors media_items).
--   * FK media_id  → media_items(id) ON DELETE CASCADE per design §4.3
--                    permanent-delete path: a hard delete of media_items
--                    must take its derived rows with it.
--
-- Indexes:
--   * UNIQUE (media_id, version_type) — design §4.2 explicit. Doubles
--     as the per-media lookup index (left-prefix scan).
--   * version_type — answers "all thumbnails / all AI refines".
--   * file_path    — supports orphan-file detection / "what version
--                    owns this file" reverse lookup at storage-cleanup time.
--   * status       — supports "find failed versions" admin queries.

CREATE TABLE media_versions (
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
      'video_proxy'
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

-- Unique-and-lookup composite. Left-prefix on `media_id` covers the
-- "all versions of this media" query without needing a separate index.
CREATE UNIQUE INDEX idx_media_versions_media_version
  ON media_versions (media_id, version_type);

-- Standalone indexes for the less-common access patterns.
CREATE INDEX idx_media_versions_version_type ON media_versions (version_type);
CREATE INDEX idx_media_versions_file_path    ON media_versions (file_path);
CREATE INDEX idx_media_versions_status       ON media_versions (status);
