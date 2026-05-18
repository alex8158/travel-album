-- 008_create_media_analysis.sql
--
-- `media_analysis` table (P6.T1, requirements §8.3 + design.md §4.2
-- M-row). Centralises per-media quality / blur / exposure / colour /
-- aesthetic scoring + explanation so that follow-up P6 tasks can
-- write into one row instead of bolting more columns onto
-- `media_items`.
--
-- Scope of P6.T1 (per docs/tasks.md): SCHEMA ONLY. No repository,
-- no service, no API, no worker, no frontend, no backfill. Until
-- P6.T2 .. P6.T5 land the table sits empty; existing reads of
-- `media_items` / `duplicate_groups` / `duplicate_group_items`
-- are deliberately untouched.
--
-- Cardinality (design.md §4.2 M-row):
--   * 1:1 with `media_items` — exactly one analysis row per media.
--     Enforced by UNIQUE (media_id). P6.T5 `Quality_Selector` will
--     upsert into the same row rather than appending versions.
--
-- FK strategy (design.md §4.2 M-row + §4.3 permanent-delete path):
--   * media_id → media_items(id) ON DELETE CASCADE.
--     Hard-deleting a media row (P7 permanent-delete) sweeps its
--     analysis with it; mirrors `duplicate_group_items.media_id`,
--     `media_versions.media_id`, and `processing_jobs.media_id` so
--     the cascade tree stays consistent (design.md §4.3 step 3).
--
-- Numeric ranges:
--   * quality_score   — 0..1 composite (Quality_Selector P6.T5).
--                       Constrained here to mirror
--                       `duplicate_group_items.quality_score`
--                       (007_create_duplicate_groups.sql:142–143).
--   * blur_score / sharpness_score / exposure_score /
--     brightness_score / color_score / aesthetic_score —
--                       intentionally UNCONSTRAINED nullable REALs.
--                       Their normalisation strategy is still being
--                       tuned in P6.T2 / P6.T3 / P6.T4 (e.g. raw
--                       Laplacian variance vs. clipped 0..1), and
--                       baking a range CHECK now would force a
--                       re-migration the moment the worker decides
--                       to switch units. The worker layer is
--                       responsible for keeping these in their
--                       intended domain.
--
-- Boolean-as-INTEGER flags (project convention — see
-- 007_create_duplicate_groups.sql:60–62):
--   * is_blurry / is_duplicate / is_recommended — INTEGER nullable
--                                                 with CHECK IN (0, 1).
--     NULL means "not yet evaluated" — distinct from "evaluated and
--     false" which is 0. P6 workers will flip from NULL → 0/1.
--
-- Free-form text columns:
--   * labels      — nullable TEXT carrying a JSON array of issue
--                   tags (e.g. `["blurry","over-exposed"]`). Stored
--                   as TEXT because SQLite STRICT has no JSON column
--                   type; reads use `json_extract`. Empty array vs
--                   NULL: workers SHOULD prefer `[]` over NULL once
--                   evaluation has run, so downstream code can tell
--                   "no issues" from "not yet checked".
--   * reason      — nullable TEXT, human-readable explanation
--                   surfaced by §10.5 detail page and §10.6
--                   recommendation badges. Per CLAUDE.md §3.8
--                   "推荐结果必须可解释" — workers MUST write a
--                   non-empty reason whenever they assert a
--                   recommendation, but the schema keeps it nullable
--                   so a row created before recommendation runs is
--                   not blocked.
--   * raw_result  — nullable TEXT JSON blob holding the engine's
--                   raw output (histograms, per-tile blur scores,
--                   model logits, etc.). Audit-trail / debug only;
--                   business logic should read the typed columns
--                   above, not this blob.
--
-- Indexes (design.md §4.2 M-row):
--   * UNIQUE (media_id) — enforces the 1:1 cardinality AND serves
--                         as the primary lookup index ("fetch the
--                         analysis row for media X"). No additional
--                         indexes added in P6.T1; future query
--                         workloads (e.g. "find all blurry photos in
--                         a trip") can layer indexes in a later
--                         migration once the access patterns settle.
--
-- Compatibility:
--   * Does NOT touch `media_items`, `duplicate_groups`,
--     `duplicate_group_items`, `media_versions`, `processing_jobs`,
--     or any other existing table.
--   * No data backfill — P6.T1 is a pure additive migration. P6.T2
--     onwards will populate rows lazily through the worker pipeline.

CREATE TABLE media_analysis (
  id                TEXT    NOT NULL PRIMARY KEY,
  media_id          TEXT    NOT NULL,
  blur_score        REAL,
  sharpness_score   REAL,
  exposure_score    REAL,
  brightness_score  REAL,
  color_score       REAL,
  aesthetic_score   REAL,
  quality_score     REAL,
  is_blurry         INTEGER,
  is_duplicate      INTEGER,
  is_recommended    INTEGER,
  labels            TEXT,
  reason            TEXT,
  raw_result        TEXT,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  CONSTRAINT media_analysis_quality_score_range
    CHECK (quality_score IS NULL OR (quality_score >= 0 AND quality_score <= 1)),

  CONSTRAINT media_analysis_is_blurry_bool
    CHECK (is_blurry IS NULL OR is_blurry IN (0, 1)),

  CONSTRAINT media_analysis_is_duplicate_bool
    CHECK (is_duplicate IS NULL OR is_duplicate IN (0, 1)),

  CONSTRAINT media_analysis_is_recommended_bool
    CHECK (is_recommended IS NULL OR is_recommended IN (0, 1)),

  CONSTRAINT media_analysis_media_fk
    FOREIGN KEY (media_id) REFERENCES media_items (id) ON DELETE CASCADE
) STRICT;

-- design.md §4.2 M-row: `media_id` is unique. The UNIQUE index also
-- doubles as the FK lookup index, so a separate non-unique index on
-- media_id would be redundant.
CREATE UNIQUE INDEX idx_media_analysis_media_id ON media_analysis (media_id);
