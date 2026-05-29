-- 023_extend_processing_jobs_multi_target.sql
--
-- Migration scope (P12.T3):
--
-- Extend `processing_jobs` (created in 004) so the curated-album
-- pipeline can enqueue NON-media targets (trip / scene_group / etc.)
-- and so multi-round re-enqueue is idempotent. Adds four columns and
-- relaxes one constraint:
--
--   * trip_id      TEXT NULL  → trips(id) ON DELETE SET NULL.
--                  trip-level jobs (curation_run / scene_grouping) carry
--                  their trip here; media-level jobs leave it NULL.
--   * target_type  TEXT NOT NULL DEFAULT 'media', closed CHECK enum
--                  {media,trip,audio,composition,slideshow,scene_group}
--                  (design.md §9.1). `scene_group` is required by the
--                  P12.T6 scene_best_pick worker (target_id = scene_groups.id);
--                  without it P12.T6 enqueue would hit the CHECK.
--   * target_id    TEXT NULL. Points at the target table's PK
--                  (media_items / trips / audio_library / video_compositions
--                  / slideshow_renders / scene_groups). Design.md §9.1
--                  declares this as plain `TEXT` (no NOT NULL); we honour
--                  the design (NOT the tasks.md draft's "NOT NULL") so the
--                  existing jobRepository INSERT — which does not yet set
--                  target_id — keeps working untouched. P12.T4+ updates the
--                  repository to populate it for media jobs.
--   * dedupe_key   TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))).
--                  Enqueue-idempotency key (design.md §9.1). Forced NOT
--                  NULL — SQLite treats multiple NULLs as distinct, which
--                  would silently bypass the UNIQUE guard. The random-blob
--                  DEFAULT means any INSERT that omits dedupe_key (e.g. the
--                  current jobRepository, which we deliberately do NOT
--                  touch in this schema-only task) gets a unique one-off
--                  key — exactly the "UUID = no-dedup" semantics design.md
--                  §9.1 sanctions for legacy / manual-retry jobs.
--   * media_id     RELAXED from NOT NULL to NULL. Trip / scene_group /
--                  composition / slideshow jobs have no single media; the
--                  FK CASCADE is preserved (NULL = no constraint). Existing
--                  media jobs always set it, so no behaviour changes.
--
-- New UNIQUE index `(job_type, target_type, target_id, dedupe_key)` backs
-- the "same logical task not enqueued twice" guard (design.md §9.1). A
-- companion `(target_type, target_id)` index backs the "all jobs for this
-- target" scan; a `trip_id` index backs trip-level queries.
--
-- Why a full table rebuild rather than ALTER ADD COLUMN:
--   1. dedupe_key needs a DEFAULT *expression* (randomblob); SQLite forbids
--      parenthesised-expression defaults on ALTER TABLE ADD COLUMN but
--      allows them in CREATE TABLE.
--   2. Relaxing media_id NOT NULL → NULL is not expressible via ALTER.
--   3. The new UNIQUE index over partially-backfilled columns is cleanest
--      to build once on the finished table.
-- This follows the same 12-step STRICT rebuild ritual as 003 / 006 / 013 /
-- 016 / 018.
--
-- FK side-effect handled explicitly:
--   `ai_invocations.job_id → processing_jobs(id) ON DELETE SET NULL`.
--   DROP TABLE processing_jobs performs an implicit per-row DELETE which
--   (with foreign_keys=ON, as the migration runner keeps it) fires SET NULL
--   on every ai_invocations.job_id pointing at a dropped row — wiping the
--   audit linkage. The migration runner wraps each file in a transaction,
--   inside which `PRAGMA foreign_keys=OFF` is a no-op, so we cannot disable
--   FKs. Instead we SNAPSHOT the linkage into a TEMP table before the DROP
--   and RESTORE it after the RENAME (the rebuilt table preserves every id,
--   so the FK re-validates cleanly). On a fresh DB both tables are empty and
--   the snapshot/restore is a no-op.
--
-- Backfill of existing P0–P11 rows:
--   target_type = 'media', target_id = media_id, dedupe_key = id
--   (the row's own PK — guaranteed unique, so the new UNIQUE never collides
--   even when two legacy jobs share the same media + job_type). trip_id NULL.
--
-- Non-goals (schema-only):
--   * No repository / service / worker / route / frontend change. The
--     jobRepository INSERT is deliberately left as-is; its omitted columns
--     fall back to the DEFAULTs above.
--   * No status enum change.

-- 1. Snapshot the ai_invocations → processing_jobs linkage before the DROP
--    nullifies it.
CREATE TEMP TABLE _pj_aijob_link AS
  SELECT id AS ai_id, job_id
  FROM ai_invocations
  WHERE job_id IS NOT NULL;

-- 2. Build the new table. Column list mirrors 004 plus the four P12
--    columns; media_id relaxed to NULL.
CREATE TABLE processing_jobs_new (
  id              TEXT    NOT NULL PRIMARY KEY,
  media_id        TEXT,
  trip_id         TEXT,
  target_type     TEXT    NOT NULL DEFAULT 'media',
  target_id       TEXT,
  dedupe_key      TEXT    NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  job_type        TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'pending',
  progress        INTEGER NOT NULL DEFAULT 0,
  error_message   TEXT,
  retry_count     INTEGER NOT NULL DEFAULT 0,
  payload         TEXT,
  next_run_at     TEXT,
  started_at      TEXT,
  finished_at     TEXT,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  CONSTRAINT processing_jobs_status_enum
    CHECK (status IN ('pending', 'running', 'success', 'failed', 'retrying', 'cancelled')),

  CONSTRAINT processing_jobs_progress_range
    CHECK (progress >= 0 AND progress <= 100),

  CONSTRAINT processing_jobs_retry_count_nonneg
    CHECK (retry_count >= 0),

  CONSTRAINT processing_jobs_job_type_not_blank
    CHECK (length(job_type) > 0),

  CONSTRAINT processing_jobs_target_type_enum
    CHECK (target_type IN ('media', 'trip', 'audio', 'composition', 'slideshow', 'scene_group')),

  CONSTRAINT processing_jobs_dedupe_key_not_blank
    CHECK (length(dedupe_key) > 0),

  CONSTRAINT processing_jobs_media_fk
    FOREIGN KEY (media_id) REFERENCES media_items (id) ON DELETE CASCADE,

  CONSTRAINT processing_jobs_trip_fk
    FOREIGN KEY (trip_id) REFERENCES trips (id) ON DELETE SET NULL
) STRICT;

-- 3. Copy every existing row, backfilling the four new columns. Column
--    list explicit so a future drift in 004 fails loudly.
INSERT INTO processing_jobs_new (
  id, media_id, trip_id, target_type, target_id, dedupe_key,
  job_type, status, progress, error_message, retry_count,
  payload, next_run_at, started_at, finished_at, created_at, updated_at
)
SELECT
  id, media_id, NULL, 'media', media_id, id,
  job_type, status, progress, error_message, retry_count,
  payload, next_run_at, started_at, finished_at, created_at, updated_at
FROM processing_jobs;

-- 4. Drop the old table (implicit DELETE fires SET NULL on
--    ai_invocations.job_id — restored in step 7).
DROP TABLE processing_jobs;

-- 5. Rename. FKs that reference "processing_jobs" by name rebind to the
--    new table.
ALTER TABLE processing_jobs_new RENAME TO processing_jobs;

-- 6. Recreate the four original indexes (same names as 004) + three new.
CREATE INDEX idx_processing_jobs_status     ON processing_jobs (status);
CREATE INDEX idx_processing_jobs_job_type   ON processing_jobs (job_type);
CREATE INDEX idx_processing_jobs_media_id   ON processing_jobs (media_id);
CREATE INDEX idx_processing_jobs_started_at ON processing_jobs (started_at);
CREATE INDEX idx_processing_jobs_trip_id    ON processing_jobs (trip_id);
CREATE INDEX idx_processing_jobs_target     ON processing_jobs (target_type, target_id);
CREATE UNIQUE INDEX idx_processing_jobs_dedupe
  ON processing_jobs (job_type, target_type, target_id, dedupe_key);

-- 7. Restore the ai_invocations → processing_jobs linkage wiped by step 4.
UPDATE ai_invocations
  SET job_id = (
    SELECT job_id FROM _pj_aijob_link WHERE _pj_aijob_link.ai_id = ai_invocations.id
  )
  WHERE id IN (SELECT ai_id FROM _pj_aijob_link);

DROP TABLE _pj_aijob_link;
