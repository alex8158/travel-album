-- 024_extend_ai_invocations.sql
--
-- Migration scope (P12.T3):
--
-- Extend `ai_invocations` (created in 012, enum-extended in 018) with the
-- four columns the curated-album pipeline needs for cost-cache de-dup and
-- multi-target audit (design.md §4.2 ai_invocations row + §7.8.3):
--
--   * trip_id      TEXT NULL → trips(id) ON DELETE SET NULL. Trip-level AI
--                  calls (scene grouping / best-pick) carry their trip here.
--   * target_type  TEXT NOT NULL DEFAULT 'media', closed CHECK enum
--                  {media,trip,audio,composition,slideshow,scene_group}.
--   * target_id    TEXT NULL. Target table PK (scene_groups.id when
--                  target_type='scene_group', etc.).
--   * input_hash   TEXT NULL. SHA256 of input bytes + key params; the cost-
--                  cache key. NULL = "not cacheable / legacy".
--
-- New PARTIAL UNIQUE index
--   `(trip_id, request_type, target_type, target_id, input_hash) WHERE status='success'`
-- gives the "don't pay twice for the same photo + request_type in this trip"
-- guarantee (design.md §4.2). It is decoupled from the processing_jobs
-- dedupe_key (queue idempotency) on purpose — see design.md §9.1.
--
-- Why ALTER ADD COLUMN (no rebuild):
--   ai_invocations has NO child tables (nothing references it), and none of
--   the four new columns needs a parenthesised-expression default. trip_id
--   is a NULL-default FK (allowed by ALTER ADD COLUMN); target_type is a
--   NOT NULL column with a constant DEFAULT 'media' (allowed); target_id and
--   input_hash are nullable. CHECK on an added column is permitted. This is
--   strictly safer than a rebuild (no DROP, no FK side-effects).
--
-- Backfill of existing P0–P11 rows:
--   target_type = 'media' (column DEFAULT applies to existing rows),
--   target_id   = media_id (explicit UPDATE below; media_id may itself be
--                 NULL for rows orphaned by a prior media delete),
--   input_hash  = NULL (legacy rows do not participate in the cost cache).
--   request_type is NOT touched — existing rows already carry a valid value
--   from 012/018; overwriting it (as a literal reading of design.md §4.2's
--   backfill note might suggest) would destroy real audit data, so we keep
--   it. In practice every legacy row is already 'image_ai_refine' (the only
--   AI worker that has run through P11).
--
-- Non-goals (schema-only): no repository / worker / route change. The
-- aiInvocationsRepository INSERT keeps working — target_type falls back to
-- its DEFAULT, the other three columns default to NULL.

-- 1. Add the four columns.
ALTER TABLE ai_invocations
  ADD COLUMN trip_id TEXT REFERENCES trips (id) ON DELETE SET NULL;

ALTER TABLE ai_invocations
  ADD COLUMN target_type TEXT NOT NULL DEFAULT 'media'
  CHECK (target_type IN ('media', 'trip', 'audio', 'composition', 'slideshow', 'scene_group'));

ALTER TABLE ai_invocations
  ADD COLUMN target_id TEXT;

ALTER TABLE ai_invocations
  ADD COLUMN input_hash TEXT;

-- 2. Backfill target_id from the existing media_id for legacy rows.
UPDATE ai_invocations
  SET target_id = media_id
  WHERE target_id IS NULL;

-- 3. Cost-cache uniqueness (only successful calls are cached / deduped).
CREATE UNIQUE INDEX idx_ai_invocations_cost_cache
  ON ai_invocations (trip_id, request_type, target_type, target_id, input_hash)
  WHERE status = 'success';

-- 4. Trip-level audit / cost lookups.
CREATE INDEX idx_ai_invocations_trip_id ON ai_invocations (trip_id);
