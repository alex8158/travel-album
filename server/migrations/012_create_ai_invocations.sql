-- 012_create_ai_invocations.sql
--
-- Migration scope (P10.T1):
--
-- Land the `ai_invocations` audit table — one row per externally-
-- billed AI request. Per requirements §8.9 and design.md §4.2
-- "ai_invocations" row, this table is **审计用，不参与业务流**
-- (audit only; never read on the hot path). Future P10 tasks will
-- write to it from the AI worker(s):
--   * P10.T3 — POST /api/media/:id/ai-refine enqueue
--   * P10.T5 — image_ai_refine worker writes provider/model/status/
--              cost/duration before producing media_versions
--              (version_type='ai_refined')
--
-- P10.T1 is **schema only** — no repository, no service, no API,
-- no worker, no frontend. Until P10.T2..T7 land the table sits
-- empty.
--
-- Cardinality:
--   * 1:N with `media_items` — one media may accumulate many AI
--     calls over its lifetime (refine + future caption + classify
--     + aesthetic-score). NOT 1:1 (that's `media_analysis`).
--   * Loosely-linked to `processing_jobs` via `job_id` — the
--     audit row outlives the queue row (P4 lifecycle: a job can
--     transition to terminal + eventually get cleaned, but the AI
--     spend is an immutable historical fact).
--
-- FK strategy (design.md §4.2 ai_invocations row: "media_id /
-- job_id (SET NULL)"):
--   * media_id → media_items(id) ON DELETE SET NULL.
--     Hard-deleting the parent media should NOT erase the audit
--     trail — the operator may still want to bill / debug a past
--     call after permanent delete (P7.T7+). The column becomes
--     NULL once the parent is gone; the audit row stays.
--   * job_id → processing_jobs(id) ON DELETE SET NULL.
--     Same logic: the job row may be GC'd long before the audit
--     trail is.
--   * NB: media_id is therefore NULLABLE in this table (unlike
--     `media_versions` / `media_analysis` / `video_segments` etc.
--     where it cascades and is NOT NULL). Audit semantics require
--     this distinction.
--
-- request_type enum (closed CHECK) covers the request types known
-- at P10.T1; future request types will require a follow-up
-- migration to extend the enum (same pattern as
-- 006_extend_media_versions_version_type.sql):
--   * 'image_ai_refine'   — sharp / diffusion-based per-image refinement
--                           (P10.T3 / P10.T5). Output written to
--                           media_versions(version_type='ai_refined').
--   * 'ai_caption'        — image captioning (future; not in P10.T5
--                           scope but reserved here).
--   * 'ai_classify'       — image classification / tagging (future).
--   * 'aesthetic_score'   — model-based aesthetic scoring (future;
--                           may write back to media_analysis.aesthetic_score).
--   * 'video_plan'        — AI-assisted video edit plan (future; pre-
--                           visualised in design.md §8.3).
--   * 'ranking'           — group-level recommendation re-ranking
--                           (future; would feed Quality_Selector).
--
-- status enum (closed CHECK):
--   * 'pending'  — the audit row was written before the call started
--                  (for budget reservation / quota counting).
--   * 'success'  — the provider returned a usable response. Worker
--                  has written the output artefact (e.g.
--                  media_versions row of type 'ai_refined') and
--                  audit row carries cost + duration.
--   * 'failed'   — the provider rejected / errored / timed out.
--                  Audit row carries `error_message`. The downstream
--                  worker row in `processing_jobs` carries its own
--                  retry budget; the audit row never retries (each
--                  retry creates a fresh audit row so per-call cost
--                  is auditable).
--
-- Numeric ranges:
--   * cost_estimate — REAL nullable, intentionally UNCONSTRAINED at
--                     the schema level. Different providers price in
--                     wildly different units (USD micros, credits,
--                     tokens) and forcing a unit at the schema level
--                     would force migrations every time a new
--                     provider lands. The AIProvider implementation
--                     is responsible for normalising to USD (or
--                     leaving NULL if the provider doesn't surface
--                     cost). UI may render "—" for NULL.
--   * duration_ms  — INTEGER nullable. Server-measured wall-clock
--                    for the provider round-trip (not the worker's
--                    total handler duration; that's separate in
--                    processing_jobs).
--
-- Cross-task red lines (CLAUDE.md §2.4 + §3.9):
--   * AI results NEVER overwrite media_items.user_decision,
--     video_segments.user_decision, or duplicate_group_items.user_decision.
--   * AI outputs land as new media_versions rows (P10.T5) — original
--     bytes never mutated.
--   * `ai_invocations` is write-only from the worker's POV (the
--     worker INSERTs at start, UPDATEs status / duration / cost /
--     error_message at finish). Readers (P10.T4 quota counter, P10.T7
--     acceptance) only SELECT.
--
-- Indexes per design.md §4.2 ai_invocations row + the typical
-- P10.T4 quota query ("how many AI calls have we made today?"):
--   * (created_at)            — daily / per-Trip quota counting,
--                               admin time-range queries.
--   * (media_id)              — "what AI calls happened on this
--                               media" — backs the future audit
--                               view + the P10.T5 worker's pre-flight
--                               idempotency check.
--   * (job_id)                — trace back from a `processing_jobs`
--                               row to its audit row.
--   * (provider, model_name)  — analytics: "how much have we spent
--                               on each model".
--
-- Non-goals of this migration:
--   * No data writes — every column starts NULL or at its DEFAULT.
--   * No backfill — there is no V1 data using a previous shape.
--   * No repository / worker / route / frontend code — those are
--     P10.T2..T6.
--   * No `media_versions.version_type='ai_refined'` extension — that
--     value already lives in the enum from migration 006.

CREATE TABLE ai_invocations (
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
      'ranking'
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

CREATE INDEX idx_ai_invocations_created_at ON ai_invocations (created_at);
CREATE INDEX idx_ai_invocations_media_id   ON ai_invocations (media_id);
CREATE INDEX idx_ai_invocations_job_id     ON ai_invocations (job_id);
CREATE INDEX idx_ai_invocations_provider_model
  ON ai_invocations (provider, model_name);
