-- 025_extend_media_versions_v2.sql
--
-- Migration scope (P12.T3 — ADDITIVE ONLY):
--
-- Prepare `media_versions` (created in 005, enum-extended in 006/013/016)
-- for the curated-album pipeline by adding three columns and three new
-- version_type values. Per the P12.T3 decision this migration is
-- **deliberately additive and non-breaking**:
--
--   ADDED columns:
--     * params_hash TEXT NULL  — SHA256 of the normalised `params` JSON;
--                    the future de-dup key for multi-history version rows.
--                    Left NULL on every existing row (multi-history is not
--                    enabled yet).
--     * is_active   INTEGER NOT NULL DEFAULT 1, CHECK IN (0,1) — marks the
--                    currently-active version row. Backfilled to 1.
--     * deleted_at  TEXT NULL — soft-delete marker (mirrors media_items /
--                    trips). Backfilled to NULL.
--
--   ADDED version_type values (design.md §4.2.1 canonical names):
--     * ai_refined_param   — sharp-applied JSON refinement output (§7.6).
--     * final_composition  — multi-video composition output (P11/P12).
--     * slideshow          — image→video slideshow output (§7.22).
--
-- EXPLICITLY NOT done here (deferred to P12.T8, which is the first writer
-- of multi-history rows and owns the matching MediaVersionsRepository
-- change):
--     * The global UNIQUE index `idx_media_versions_media_version`
--       (media_id, version_type) is PRESERVED byte-for-byte. It is NOT
--       dropped. `MediaVersionsRepository.upsert` relies on
--       `ON CONFLICT(media_id, version_type)` (prepared in its constructor);
--       dropping the global unique would break that prepare and take down
--       every version-writing worker (p9/p10/p11). So we keep it.
--     * No partial-unique indexes (Single-instance / Multi-history split).
--     * No multi-history semantics, no repository upsert change.
--   This keeps P12.T3 strictly schema-only while landing the columns +
--   enum so later tasks can build on them.
--
-- Why a full table rebuild (rather than ALTER ADD COLUMN):
--   Extending the `version_type` CHECK enum on a STRICT table requires the
--   12-step rebuild ritual (SQLite cannot modify CHECK in place). Since we
--   rebuild anyway, the three new columns are added in the new table
--   definition. Same pattern as 006/013/016.
--
-- FK side-effect handled explicitly:
--   `slideshow_renders.output_media_version_id → media_versions(id)
--   ON DELETE SET NULL` (declared in 022). DROP TABLE media_versions fires
--   an implicit per-row DELETE which, with foreign_keys=ON, SET-NULLs that
--   column on matching slideshow_renders rows. We cannot disable FKs inside
--   the runner's per-file transaction, so we SNAPSHOT the linkage into a
--   TEMP table before the DROP and RESTORE it after the RENAME (the rebuilt
--   table preserves every id). In practice slideshow_renders is empty
--   (no render worker has run yet), so this is a no-op — but it keeps the
--   migration correct regardless of data.
--
-- Backfill of existing rows:
--   is_active = 1, params_hash = NULL, deleted_at = NULL. (The old global
--   unique guaranteed at most one row per (media_id, version_type), so
--   is_active=1 on every row is unambiguous.)

-- 1. Snapshot the slideshow_renders → media_versions linkage.
CREATE TEMP TABLE _mv_ssr_link AS
  SELECT id AS ssr_id, output_media_version_id
  FROM slideshow_renders
  WHERE output_media_version_id IS NOT NULL;

-- 2. Build the new table: 005/016 shape + three P12 columns + extended enum.
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
  params_hash     TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1,
  deleted_at      TEXT,
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
      'edited',
      'ai_refined_param',   -- new in 025 (P12.T3)
      'final_composition',  -- new in 025 (P12.T3)
      'slideshow'           -- new in 025 (P12.T3)
    )),

  CONSTRAINT media_versions_status_enum
    CHECK (status IN ('ready', 'failed')),

  CONSTRAINT media_versions_is_active_bool
    CHECK (is_active IN (0, 1)),

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

-- 3. Copy every row, backfilling the three new columns.
INSERT INTO media_versions_new (
  id, media_id, version_type, file_path,
  mime_type, width, height, file_size,
  model_name, params, status,
  params_hash, is_active, deleted_at,
  created_at, updated_at
)
SELECT
  id, media_id, version_type, file_path,
  mime_type, width, height, file_size,
  model_name, params, status,
  NULL, 1, NULL,
  created_at, updated_at
FROM media_versions;

-- 4. Drop the old table.
DROP TABLE media_versions;

-- 5. Rename.
ALTER TABLE media_versions_new RENAME TO media_versions;

-- 6. Recreate the FOUR indexes from 005/016 byte-for-byte. The global
--    UNIQUE (media_id, version_type) is PRESERVED (NOT dropped) so the
--    existing ON CONFLICT(media_id, version_type) upsert keeps matching.
CREATE UNIQUE INDEX idx_media_versions_media_version
  ON media_versions (media_id, version_type);

CREATE INDEX idx_media_versions_version_type ON media_versions (version_type);
CREATE INDEX idx_media_versions_file_path    ON media_versions (file_path);
CREATE INDEX idx_media_versions_status       ON media_versions (status);

-- 7. Restore the slideshow_renders → media_versions linkage wiped by step 4.
UPDATE slideshow_renders
  SET output_media_version_id = (
    SELECT output_media_version_id FROM _mv_ssr_link
    WHERE _mv_ssr_link.ssr_id = slideshow_renders.id
  )
  WHERE id IN (SELECT ssr_id FROM _mv_ssr_link);

DROP TABLE _mv_ssr_link;
