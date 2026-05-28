-- 018_extend_ai_invocations_request_types.sql
--
-- Migration scope (P12.T1):
--
-- Extend the `ai_invocations.request_type` CHECK enum with four
-- new values needed by the curated-album pipeline (design.md §7.8):
--
--   * 'scene_embedding'     — L2 embedding for scene grouping
--                             (P12.T4 worker).
--   * 'ai_blur_check'       — L3 AI second-pass blur classification
--                             (P12.T5 worker).
--   * 'scene_best_pick'     — L4 best-in-scene-group selection
--                             (P12.T6 worker).
--   * 'refinement_suggest'  — L5 JSON refinement params suggestion
--                             (P12.T7 worker).
--
-- After this migration the enum has 10 values total; the original
-- 6 from migration 012 are preserved.
--
-- Why a full table rebuild:
-- SQLite STRICT tables do NOT support modifying CHECK constraints
-- in place. The only sanctioned path is the 12-step table-rebuild
-- ritual; this file mirrors 012's structure step for step.
--
-- Data preservation guarantee:
-- Every existing ai_invocations row is copied into the new table
-- with identical column values. The new enum is a strict superset
-- of the old enum, so the data passes the new CHECK on copy.
--
-- Non-goals (explicit per P12.T1 scope):
--   * No new columns. (P12.T3 / migration 024 adds the trip_id /
--     target_type / target_id / input_hash columns; THIS migration
--     touches only the request_type CHECK.)
--   * No new indexes.
--   * No FK changes.
--   * No status / provider / model_name / duration constraint
--     tweaks.
-- The diff from 012 is exactly four new values in one CHECK clause.

-- 1. Build the new table with the extended enum. Column list and
-- every other constraint mirrors 012 byte-for-byte; the only diff
-- is the four-value extension in `ai_invocations_request_type_enum`.
CREATE TABLE ai_invocations_new (
  id                TEXT    NOT NULL PRIMARY KEY,
  media_id          TEXT,
  job_id            TEXT,
  provider          TEXT    NOT NULL,
  model_name        TEXT    NOT NULL,
  request_type      TEXT    NOT NULL,
  request_params    TEXT,
  status            TEXT    NOT NULL DEFAULT 'pending',
  response_summary  TEXT,
  cost_estimate     REAL,
  duration_ms       INTEGER,
  error_message     TEXT,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  CONSTRAINT ai_invocations_request_type_enum
    CHECK (request_type IN (
      'image_ai_refine',
      'ai_caption',
      'ai_classify',
      'aesthetic_score',
      'video_plan',
      'ranking',
      'scene_embedding',     -- new in 018 (P12.T1)
      'ai_blur_check',       -- new in 018 (P12.T1)
      'scene_best_pick',     -- new in 018 (P12.T1)
      'refinement_suggest'   -- new in 018 (P12.T1)
    )),

  CONSTRAINT ai_invocations_status_enum
    CHECK (status IN ('pending', 'success', 'failed')),

  CONSTRAINT ai_invocations_provider_not_blank
    CHECK (length(provider) > 0),

  CONSTRAINT ai_invocations_model_name_not_blank
    CHECK (length(model_name) > 0),

  CONSTRAINT ai_invocations_duration_ms_nonneg
    CHECK (duration_ms IS NULL OR duration_ms >= 0),

  CONSTRAINT ai_invocations_media_fk
    FOREIGN KEY (media_id) REFERENCES media_items (id) ON DELETE SET NULL,

  CONSTRAINT ai_invocations_job_fk
    FOREIGN KEY (job_id) REFERENCES processing_jobs (id) ON DELETE SET NULL
) STRICT;

-- 2. Copy every existing row. Column list is explicit so a future
-- drift in 012 fails loudly rather than silently mis-aligning.
INSERT INTO ai_invocations_new (
  id, media_id, job_id, provider, model_name,
  request_type, request_params, status, response_summary,
  cost_estimate, duration_ms, error_message,
  created_at, updated_at
)
SELECT
  id, media_id, job_id, provider, model_name,
  request_type, request_params, status, response_summary,
  cost_estimate, duration_ms, error_message,
  created_at, updated_at
FROM ai_invocations;

-- 3. Drop the old table. Indexes go with it.
DROP TABLE ai_invocations;

-- 4. Rename. FK preserved by SQLite when ALTER TABLE RENAME runs.
ALTER TABLE ai_invocations_new RENAME TO ai_invocations;

-- 5. Recreate the four indexes byte-for-byte (same names as 012).
CREATE INDEX idx_ai_invocations_created_at ON ai_invocations (created_at);
CREATE INDEX idx_ai_invocations_media_id   ON ai_invocations (media_id);
CREATE INDEX idx_ai_invocations_job_id     ON ai_invocations (job_id);
CREATE INDEX idx_ai_invocations_provider_model
  ON ai_invocations (provider, model_name);
