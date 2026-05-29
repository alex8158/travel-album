-- 019_create_scene_groups.sql
--
-- Migration scope (P12.T2 — one of four new tables for the curated-
-- album pipeline; see design.md §4.2 / §7.8):
--
-- Creates `scene_groups`, the table that records "AI / Code-grouped
-- a set of trip photos that look like the same scene". One row per
-- group per curation round. Group MEMBERS are stored separately in
-- `scene_group_items` (migration 020); this table holds only the
-- group's metadata (time range, GPS center, representative photo,
-- member count, algorithm version).
--
-- Column contract (must match design.md §4.2 byte-for-byte):
--   * id                      — UUID PK
--   * trip_id                 — FK to trips.id (CASCADE; group dies
--                               with its trip)
--   * selection_round         — INTEGER >= 0; 0 reserved for user
--                               override layer, AI rounds start at 1
--   * group_index             — INTEGER >= 0; group's position
--                               within the round (stable identifier
--                               for UI links). Together with
--                               (trip_id, selection_round) forms the
--                               human-stable "group N of round M".
--   * captured_at_start       — TEXT NULL; earliest member's
--                               captured_at (or fallback to
--                               created_at when no EXIF date)
--   * captured_at_end         — TEXT NULL; latest member's
--                               captured_at
--   * gps_center_lat          — REAL NULL; mean lat over members
--                               with GPS (or NULL if no member had
--                               GPS)
--   * gps_center_lon          — REAL NULL; mean lon over members
--                               with GPS (or NULL if no member had
--                               GPS)
--   * representative_media_id — TEXT NULL FK → media_items.id
--                               (SET NULL; cover thumbnail for the
--                               group in the UI; nullable when the
--                               chosen rep is later soft-deleted)
--   * member_count            — INTEGER NOT NULL DEFAULT 0; mirror
--                               of COUNT(scene_group_items) for the
--                               group, updated by the worker writing
--                               the group
--   * algorithm_version       — TEXT NOT NULL; identifies the
--                               grouping algorithm + version used
--                               to produce this group (e.g.
--                               "code-time-gps-1.0" or
--                               "code-time-gps+local-mock-embedding-1.0").
--                               Lets re-curate runs detect drift.
--   * created_at              — TEXT NOT NULL DEFAULT now()
--
-- Constraints:
--   * UNIQUE(trip_id, selection_round, group_index) — a group is
--     uniquely identified within a (trip, round) by its index.
--   * member_count >= 0
--   * selection_round >= 0
--   * group_index >= 0
--   * algorithm_version not blank
--
-- Indexes:
--   * UNIQUE (trip_id, selection_round, group_index)  -- enum index
--   * (representative_media_id)                       -- "what group
--     does this media represent" lookups (rare; backstop)
--
-- Non-goals of this migration:
--   * No worker / service / route code (P12.T4+).
--   * No member rows (P12.T2 migration 020 creates that table).
--   * No backfill — there is no prior data for this table.
--   * No write paths from existing P0-P11 code; only the curation
--     orchestrator (P12.T9) and grouping worker (P12.T4) will write.

CREATE TABLE scene_groups (
  id                      TEXT    NOT NULL PRIMARY KEY,
  trip_id                 TEXT    NOT NULL,
  selection_round         INTEGER NOT NULL,
  group_index             INTEGER NOT NULL,
  captured_at_start       TEXT,
  captured_at_end         TEXT,
  gps_center_lat          REAL,
  gps_center_lon          REAL,
  representative_media_id TEXT,
  member_count            INTEGER NOT NULL DEFAULT 0,
  algorithm_version       TEXT    NOT NULL,
  created_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  CONSTRAINT scene_groups_selection_round_nonneg
    CHECK (selection_round >= 0),

  CONSTRAINT scene_groups_group_index_nonneg
    CHECK (group_index >= 0),

  CONSTRAINT scene_groups_member_count_nonneg
    CHECK (member_count >= 0),

  CONSTRAINT scene_groups_algorithm_version_not_blank
    CHECK (length(algorithm_version) > 0),

  CONSTRAINT scene_groups_trip_fk
    FOREIGN KEY (trip_id) REFERENCES trips (id) ON DELETE CASCADE,

  CONSTRAINT scene_groups_representative_media_fk
    FOREIGN KEY (representative_media_id) REFERENCES media_items (id) ON DELETE SET NULL
) STRICT;

CREATE UNIQUE INDEX idx_scene_groups_trip_round_index
  ON scene_groups (trip_id, selection_round, group_index);

CREATE INDEX idx_scene_groups_representative_media
  ON scene_groups (representative_media_id);
