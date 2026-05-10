-- 004_create_processing_jobs.sql
--
-- Processing jobs table (P2.T2). One row per asynchronous processing
-- step that the runner needs to perform on a media item — for example
-- image_thumbnail, image_metadata, image_hash, image_dedup,
-- image_quality, video_metadata, video_cover, video_proxy,
-- video_keyframes, video_segments, image_ai_refine. The actual job
-- type vocabulary will grow as workers land starting in P3 / P5 / P9;
-- this table is the single source of truth for queue state, in line
-- with docs/design.md §1.2 / §9.1.
--
-- Scope of P2.T2 (per docs/tasks.md): SCHEMA ONLY. State-transition
-- rules, scheduling, retry back-off, zombie recovery, the in-process
-- worker pool, and the Job API are all explicitly deferred to phase
-- 4 (P4.T1 .. P4.T6). Upload_Manager (P2.T4) will be the first writer
-- when it lands; until then the table sits empty.
--
-- Field decisions (R-32 follow-up):
--   * Fields from requirements §8.2 §8.8 are all here.
--   * `payload` (TEXT, nullable) and `next_run_at` (TEXT, nullable)
--     are added to match docs/design.md §9.1 (payload JSON for the
--     runner) and §9.2 (next_run_at for retry back-off scheduling).
--     Both are nullable so the table is usable today by callers that
--     do not yet care about them. Adding them now avoids a later
--     ALTER-type migration once P4 lands.
--
-- FK on media_id (R-33 follow-up):
--   ON DELETE CASCADE — a hard delete of media_items takes its jobs
--   with it (docs/design.md §4.3). Soft delete on media_items does
--   not fire FK actions; cancelling running jobs on soft delete is a
--   business-layer concern handled by P7 when it lands. A schema
--   level CASCADE is the safety net for permanent deletes.
--
-- The status enum is fixed by CLAUDE.md §4.2:
--   pending  → running, cancelled
--   running  → success, failed, cancelled
--   failed   → retrying, cancelled
--   retrying → running
-- The schema only checks the value is one of the six tokens; the
-- transition graph is enforced at the Repository / Service layer
-- once P4 lands. Direct UPDATEs that bypass the runner are not
-- prevented at the schema level by design.
--
-- job_type is intentionally a free-form TEXT (NOT NULL, length>0)
-- rather than a CHECK enum. The vocabulary keeps growing across P3
-- / P5 / P9 / P10; locking it in schema today would force a table
-- rebuild on every new worker. Application-layer validation owns
-- the closed set when it stabilises.

CREATE TABLE processing_jobs (
  id              TEXT    NOT NULL PRIMARY KEY,
  media_id        TEXT    NOT NULL,
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

  CONSTRAINT processing_jobs_media_fk
    FOREIGN KEY (media_id) REFERENCES media_items (id) ON DELETE CASCADE
) STRICT;

-- Indexes per docs/design.md §4.2 / §9.2:
--   status     — runner pulls "WHERE status='pending'" / "WHERE status='retrying'"
--   job_type   — channel routing (image / video / AI workers each pull their own slice)
--   media_id   — "what's the queue state for this media?" / cancel-on-soft-delete in P7
--   started_at — zombie detection scans long-running rows on worker boot
CREATE INDEX idx_processing_jobs_status     ON processing_jobs (status);
CREATE INDEX idx_processing_jobs_job_type   ON processing_jobs (job_type);
CREATE INDEX idx_processing_jobs_media_id   ON processing_jobs (media_id);
CREATE INDEX idx_processing_jobs_started_at ON processing_jobs (started_at);
