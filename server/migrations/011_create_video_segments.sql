-- 011_create_video_segments.sql
--
-- Migration scope (P9.T1):
--
-- Land the `video_segments` table — one row per fixed-duration slice
-- (or, later, scene-detected slice) of a video. P9.T1 is **schema
-- only**; the producer (P9.T6 固定时长切片 + P9.T7 片段质量) and
-- the consumer (P9.T8 Video API + P9.T9 frontend video segments page)
-- arrive in later P9 tasks.
--
-- Columns per requirements §8.7 + design.md §4.2 (row "video_segments"):
--   * id              — PK uuid (matches the project-wide entity-id shape).
--   * media_id        — FK → media_items(id) ON DELETE CASCADE. One
--                       segment belongs to exactly one video. Hard
--                       delete of the parent video propagates here.
--   * start_time      — REAL seconds from the start of the source
--                       video. Inclusive lower bound.
--   * end_time        — REAL seconds. Exclusive upper bound; > start_time.
--   * duration        — REAL seconds. Stored (not derived) for
--                       cheap range / aggregate queries and to
--                       tolerate FFmpeg precision quirks where
--                       `end - start` may drift by sub-frame amounts.
--   * thumbnail_path  — TEXT, nullable. Logical path inside the
--                       storage root pointing at a small webp poster
--                       for grid views (P9.T9). NULL until the
--                       segment-thumb worker writes it.
--   * preview_path    — TEXT, nullable. Logical path to a short
--                       low-res preview clip used by the segments
--                       page on hover-play. NULL until the
--                       segment-preview worker writes it.
--   * blur_score      — REAL [0, 1], nullable. From `blackdetect` /
--                       Laplacian-on-keyframes analysis (P9.T7).
--   * stability_score — REAL [0, 1], nullable. Motion / shake
--                       analysis on keyframes. NULL until P9.T7.
--   * quality_score   — REAL [0, 1], nullable. Composite of the
--                       per-axis scores (mirrors media_analysis.
--                       quality_score's role for image media).
--   * waste_type      — TEXT, enum 'black' / 'blurry' / 'unstable' /
--                       'silence' / 'none' (design.md §426). Default
--                       'none' so a freshly-inserted segment is
--                       NOT pre-classified as waste.
--   * is_recommended  — INTEGER 0/1 default 0. Set by the per-segment
--                       quality finalizer; users can override via
--                       user_decision.
--   * user_decision   — TEXT enum 'keep' / 'remove' / 'undecided'
--                       default 'undecided'. Mirrors
--                       media_items.user_decision shape so CLAUDE.md
--                       §3.9 user-precedence stays consistent across
--                       image + video.
--   * reason          — TEXT, nullable. Human-readable note from the
--                       quality finalizer (e.g. "黑场 ≥ 0.5s").
--   * created_at      — TEXT iso8601, NOT NULL DEFAULT now().
--   * updated_at      — TEXT iso8601, NOT NULL DEFAULT now().
--
-- CHECK constraints:
--   * start_time >= 0 — videos start at t=0.
--   * end_time > start_time — empty / inverted ranges are bugs.
--   * duration > 0 — same.
--   * NB: we deliberately do NOT enforce `start_time + duration ==
--     end_time` because FFmpeg's reported boundaries can drift by
--     fractional milliseconds vs the integer-frame slicing. The
--     producer is expected to keep them coherent; treating that as
--     a schema-level invariant would force the producer to round-
--     trip floats through SQLite, which adds rounding error.
--   * blur_score / stability_score / quality_score ∈ [0, 1] OR NULL.
--     Raw upstream values (e.g. Laplacian variance) get normalised
--     by the worker before insert — same convention as
--     media_analysis.quality_score (008).
--   * waste_type IN ('black','blurry','unstable','silence','none').
--   * is_recommended IN (0, 1).
--   * user_decision IN ('keep','remove','undecided').
--
-- FK strategy:
--   * media_id → media_items(id) ON DELETE CASCADE. Same family as
--     media_versions / media_analysis / processing_jobs / duplicate_
--     group_items: hard-deleting a video propagates the row away,
--     soft-delete (P7) leaves the segment row in place (because the
--     media_items row also stays in place; only `deleted_at` flips).
--   * No reciprocal FK from media_items back here — segments are
--     children, not pointers.
--
-- Indexes per design.md §210:
--   * (media_id)       — "list segments for one video" is the
--                        dominant query (P9.T8, P9.T9). LEFT-most
--                        non-PK index.
--   * (is_recommended) — "list recommended segments" / "count
--                        keepers" queries during recommendation
--                        + export. Cheap because is_recommended
--                        cardinality is at most 2.
--
-- Non-goals of this migration:
--   * No data writes — every column starts NULL or at its DEFAULT.
--   * No backfill — there is no V1 data using a previous shape.
--   * No worker / repository / service / route / frontend code —
--     those are P9.T2-T9.
--   * No mention of `video_segment_analysis` or `video_keyframes` —
--     those are separate (future) tables, not collapsed into this
--     one.

CREATE TABLE video_segments (
  id               TEXT    NOT NULL PRIMARY KEY,
  media_id         TEXT    NOT NULL,
  start_time       REAL    NOT NULL,
  end_time         REAL    NOT NULL,
  duration         REAL    NOT NULL,
  thumbnail_path   TEXT,
  preview_path     TEXT,
  blur_score       REAL,
  stability_score  REAL,
  quality_score    REAL,
  waste_type       TEXT    NOT NULL DEFAULT 'none',
  is_recommended   INTEGER NOT NULL DEFAULT 0,
  user_decision    TEXT    NOT NULL DEFAULT 'undecided',
  reason           TEXT,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  CONSTRAINT video_segments_start_nonneg
    CHECK (start_time >= 0),

  CONSTRAINT video_segments_end_after_start
    CHECK (end_time > start_time),

  CONSTRAINT video_segments_duration_positive
    CHECK (duration > 0),

  CONSTRAINT video_segments_blur_score_range
    CHECK (blur_score IS NULL OR (blur_score >= 0 AND blur_score <= 1)),

  CONSTRAINT video_segments_stability_score_range
    CHECK (stability_score IS NULL OR (stability_score >= 0 AND stability_score <= 1)),

  CONSTRAINT video_segments_quality_score_range
    CHECK (quality_score IS NULL OR (quality_score >= 0 AND quality_score <= 1)),

  CONSTRAINT video_segments_waste_type_enum
    CHECK (waste_type IN ('black', 'blurry', 'unstable', 'silence', 'none')),

  CONSTRAINT video_segments_is_recommended_bool
    CHECK (is_recommended IN (0, 1)),

  CONSTRAINT video_segments_user_decision_enum
    CHECK (user_decision IN ('keep', 'remove', 'undecided')),

  CONSTRAINT video_segments_media_fk
    FOREIGN KEY (media_id) REFERENCES media_items (id) ON DELETE CASCADE
) STRICT;

-- Indexes per design.md §4.2 row "video_segments":
--   media_id       — segments-for-video lookups (P9.T8 / T9).
--   is_recommended — "list recommended keepers" filter during
--                    recommendation aggregation + export.
CREATE INDEX idx_video_segments_media_id       ON video_segments (media_id);
CREATE INDEX idx_video_segments_is_recommended ON video_segments (is_recommended);
