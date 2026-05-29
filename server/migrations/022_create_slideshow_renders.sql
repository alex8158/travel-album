-- 022_create_slideshow_renders.sql
--
-- Migration scope (P12.T2 — fourth and last new table; see
-- design.md §4.2 / §8.7 / requirements §7.22 / §15.6):
--
-- Creates `slideshow_renders`, the table that records EVERY
-- slideshow video generation request. requirements §7.22 + §15.6
-- explicitly require "用户可以查看历史生成的幻灯片视频，下载或重新
-- 生成"; design.md §8.7.5 chose "Plan A" — preserve every history
-- entry by INSERT-not-UPSERT — so this table needs to carry the
-- full per-request parameter snapshot plus a status machine.
--
-- One row = one render request. Lifecycle:
--   pending → running → success
--           ↘ running → failed
--           ↘ cancelled (by user / orchestrator on shutdown)
--
-- Column contract (must match design.md §4.2 row):
--   * id                       — UUID PK; used as the basename of
--                                the output file
--                                (trips/{tripId}/outputs/slideshows/
--                                {renderId}.mp4) and as
--                                processing_jobs.target_id when
--                                slideshow_render jobs run
--   * trip_id                  — FK → trips.id (CASCADE)
--   * status                   — TEXT NOT NULL CHECK ∈
--                                {pending, running, success,
--                                 failed, cancelled}
--   * input_media_ids          — TEXT (JSON array of media_ids,
--                                order-sensitive); the photo list
--                                the user requested (default = the
--                                curated set; can be overridden via
--                                body.mediaIds)
--   * per_image_duration_sec   — REAL NOT NULL, 1.0..5.0
--   * transition_type          — TEXT NOT NULL CHECK ∈ {xfade, none}
--   * transition_duration_sec  — REAL NOT NULL, 0.0..1.0
--   * output_resolution        — TEXT NOT NULL (e.g. "1920x1080");
--                                CHECK requires a non-blank value
--   * output_fps               — INTEGER NOT NULL, 1..120
--   * audio_policy             — TEXT NOT NULL CHECK ∈
--                                {replace_with_library, mute}
--                                (keep_original is meaningless for
--                                photos and explicitly disallowed —
--                                see design.md §8.7.2)
--   * background_audio_id      — TEXT NULL FK → audio_library.id
--                                (SET NULL); required when
--                                audio_policy = replace_with_library
--                                (enforced at service / repo layer)
--   * output_media_version_id  — TEXT NULL FK → media_versions.id
--                                (SET NULL); populated only after
--                                successful render (UPDATE step in
--                                P12.T12 worker)
--   * error_message            — TEXT NULL; populated on failure
--   * created_at               — TEXT NOT NULL DEFAULT now()
--   * updated_at               — TEXT NOT NULL DEFAULT now()
--   * deleted_at               — TEXT NULL; soft delete (CLAUDE.md
--                                §2.4 — no auto permanent delete;
--                                future user-initiated history
--                                cleanup writes this column rather
--                                than DELETE)
--
-- Indexes:
--   * (trip_id, created_at DESC)  -- "list this trip's history,
--                                    newest first" — backs
--                                    GET /api/trips/:id/slideshows
--   * (status)                    -- worker pickup / monitoring
--   * (output_media_version_id)   -- reverse lookup: "what render
--                                    produced this media_versions
--                                    row"
--
-- Non-goals:
--   * No worker / route / service / frontend code (P12.T11+).
--   * No backfill.
--   * deleted_at IS NULL filtering is the repository's job, not a
--     trigger / view. Mirrors §4.4 (soft-delete query convention).

CREATE TABLE slideshow_renders (
  id                        TEXT    NOT NULL PRIMARY KEY,
  trip_id                   TEXT    NOT NULL,
  status                    TEXT    NOT NULL DEFAULT 'pending',
  input_media_ids           TEXT    NOT NULL,
  per_image_duration_sec    REAL    NOT NULL,
  transition_type           TEXT    NOT NULL,
  transition_duration_sec   REAL    NOT NULL,
  output_resolution         TEXT    NOT NULL,
  output_fps                INTEGER NOT NULL,
  audio_policy              TEXT    NOT NULL,
  background_audio_id       TEXT,
  output_media_version_id   TEXT,
  error_message             TEXT,
  created_at                TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at                TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at                TEXT,

  CONSTRAINT slideshow_renders_status_enum
    CHECK (status IN ('pending', 'running', 'success', 'failed', 'cancelled')),

  CONSTRAINT slideshow_renders_per_image_duration_range
    CHECK (per_image_duration_sec >= 1.0 AND per_image_duration_sec <= 5.0),

  CONSTRAINT slideshow_renders_transition_type_enum
    CHECK (transition_type IN ('xfade', 'none')),

  CONSTRAINT slideshow_renders_transition_duration_range
    CHECK (transition_duration_sec >= 0.0 AND transition_duration_sec <= 1.0),

  CONSTRAINT slideshow_renders_output_resolution_not_blank
    CHECK (length(output_resolution) > 0),

  CONSTRAINT slideshow_renders_output_fps_range
    CHECK (output_fps >= 1 AND output_fps <= 120),

  -- requirements §7.22.4 lists three audio policies but explicitly
  -- bans keep_original for photo input (no source audio); design.md
  -- §8.7.2 codifies the closed enum to two values.
  CONSTRAINT slideshow_renders_audio_policy_enum
    CHECK (audio_policy IN ('replace_with_library', 'mute')),

  CONSTRAINT slideshow_renders_input_media_ids_not_blank
    CHECK (length(input_media_ids) > 0),

  CONSTRAINT slideshow_renders_trip_fk
    FOREIGN KEY (trip_id) REFERENCES trips (id) ON DELETE CASCADE,

  CONSTRAINT slideshow_renders_background_audio_fk
    FOREIGN KEY (background_audio_id) REFERENCES audio_library (id) ON DELETE SET NULL,

  CONSTRAINT slideshow_renders_output_media_version_fk
    FOREIGN KEY (output_media_version_id) REFERENCES media_versions (id) ON DELETE SET NULL
) STRICT;

CREATE INDEX idx_slideshow_renders_trip_created
  ON slideshow_renders (trip_id, created_at DESC);

CREATE INDEX idx_slideshow_renders_status
  ON slideshow_renders (status);

CREATE INDEX idx_slideshow_renders_output_media_version
  ON slideshow_renders (output_media_version_id);
