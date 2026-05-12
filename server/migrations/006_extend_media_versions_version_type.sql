-- 006_extend_media_versions_version_type.sql
--
-- Migration scope (P3.T5):
--
-- Extend the `media_versions.version_type` CHECK enum with the new
-- value `'metadata'`. Everything else about the table — columns,
-- defaults, indexes, FK, other CHECK constraints — is preserved
-- BYTE-FOR-BYTE from 005_create_media_versions.sql.
--
-- Why a full table rebuild:
-- SQLite STRICT tables do NOT support modifying or dropping CHECK
-- constraints in place (no `ALTER TABLE ... DROP CONSTRAINT`, no
-- `ALTER TABLE ... ADD CHECK`). The only sanctioned path is the
-- 12-step table-rebuild ritual from
-- https://sqlite.org/lang_altertable.html#otheralter:
--
--   1. CREATE TABLE <new> with the desired schema.
--   2. INSERT INTO <new> SELECT * FROM <old>.
--   3. DROP TABLE <old>.
--   4. ALTER TABLE <new> RENAME TO <old>.
--   5. Recreate indexes / triggers / views.
--
-- We DO NOT toggle `PRAGMA foreign_keys` (R-29):
--   * media_versions has FK going OUT (to media_items). Nothing
--     references media_versions, so DROP doesn't cascade.
--   * INSERT INTO new SELECT * FROM old preserves media_id values
--     that already satisfy the FK target; foreign_keys=ON validates
--     each copy and they all pass.
--   * The migration runner wraps this file in `db.transaction(...)`;
--     `PRAGMA foreign_keys = OFF` inside a transaction is a no-op
--     in SQLite anyway. Avoiding the PRAGMA is the safer path.
--
-- Data preservation guarantee:
-- Every existing media_versions row is copied into the new table
-- with identical column values. Existing values (`'thumbnail'`,
-- `'preview'`, etc. written by P3.T4 etc.) pass the new CHECK
-- because the new enum is a superset of the old enum.
--
-- Non-goals of this migration (explicit per user spec):
--   * No new columns.
--   * No new indexes.
--   * No FK changes.
--   * No status / size / dimension constraint tweaks.
-- The diff from 005 is exactly one new value in one CHECK clause.

-- 1. Build the new table with the extended enum. Schema is otherwise
-- a verbatim copy of 005 — same columns, same defaults, same FK,
-- same other CHECK constraints.
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
      'metadata'           -- new in 006
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

-- 2. Copy every existing row. The column list is explicit so the
-- migration would fail loudly (rather than silently re-ordering)
-- if 005 ever drifts in a different branch.
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

-- 3. Drop the old table. Indexes attached to it disappear with it.
DROP TABLE media_versions;

-- 4. Rename the new table into the canonical name. The FK
-- declaration on the renamed table continues to reference
-- media_items(id) — SQLite preserves the constraint definition.
ALTER TABLE media_versions_new RENAME TO media_versions;

-- 5. Recreate the four indexes from 005, byte-for-byte. Naming and
-- column lists match 005 exactly so any code (or DBA query) that
-- references these names continues to work.
CREATE UNIQUE INDEX idx_media_versions_media_version
  ON media_versions (media_id, version_type);

CREATE INDEX idx_media_versions_version_type ON media_versions (version_type);
CREATE INDEX idx_media_versions_file_path    ON media_versions (file_path);
CREATE INDEX idx_media_versions_status       ON media_versions (status);
