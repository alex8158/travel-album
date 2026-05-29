-- 020_create_scene_group_items.sql
--
-- Migration scope (P12.T2 — second of four new tables; see
-- design.md §4.2 / §7.8):
--
-- Creates `scene_group_items`, the table that records the FULL
-- membership of every scene group from migration 019. requirements
-- §16.7 explicitly requires "前端可以展开看到 AI 把哪些照片归到一起"
-- — this table is the data substrate for that UI: a row exists for
-- every photo the worker decided belongs to a given scene_group,
-- regardless of whether the photo eventually wins curation
-- (curated_selections.included=1) or not.
--
-- Column contract (must match design.md §4.2):
--   * id                — UUID PK
--   * scene_group_id    — FK → scene_groups.id (CASCADE; member dies
--                         with its group)
--   * media_id          — FK → media_items.id (CASCADE; member row
--                         dies if the photo is permanently removed —
--                         soft-delete leaves the row in place)
--   * selection_round   — INTEGER >= 0; redundant with parent group
--                         but lets round-scoped queries skip the
--                         join (heat-path for the curation
--                         orchestrator). Must equal
--                         scene_groups.selection_round for the
--                         parent group (enforced at write time by
--                         the repository, not by SQL CHECK because
--                         CHECK across rows isn't sanctioned).
--   * group_score       — REAL NULL; in-group representativeness
--                         score given by the algorithm. For the
--                         Code baseline, this can be quality_score.
--                         For AI embedding clustering, this is the
--                         distance-to-centroid or similar.
--   * similarity_score  — REAL NULL; pairwise similarity vs the
--                         group's representative (or vs centroid).
--                         Optional; used by the UI to render
--                         "AI thought this was 95% similar to
--                         representative".
--   * rank_in_group     — INTEGER NOT NULL; 0-based ordering inside
--                         the group (0 = most-representative); ties
--                         broken by stable order (by media id).
--   * reason            — TEXT NULL; per-member reason text
--                         (e.g. "code-time-gps fallback", "embedding
--                         distance=0.12").
--   * created_at        — TEXT NOT NULL DEFAULT now()
--
-- Constraints:
--   * UNIQUE(scene_group_id, media_id) — a photo can be in a group
--     at most once
--   * UNIQUE(scene_group_id, rank_in_group) — rank is unique within
--     a group (enforces stable 0..N-1 numbering by repository)
--   * selection_round >= 0
--   * rank_in_group >= 0
--
-- Indexes:
--   * UNIQUE (scene_group_id, media_id)        -- enum + lookup
--   * UNIQUE (scene_group_id, rank_in_group)   -- ordered listing
--   * (media_id)                               -- reverse lookup
--                                                "what groups is
--                                                this photo in"
--
-- Non-goals:
--   * No backfill; first writers are P12.T4 grouping worker.
--   * No video members; P12 curation pipeline is image-only
--     (see tasks.md P12.T4).

CREATE TABLE scene_group_items (
  id                TEXT    NOT NULL PRIMARY KEY,
  scene_group_id    TEXT    NOT NULL,
  media_id          TEXT    NOT NULL,
  selection_round   INTEGER NOT NULL,
  group_score       REAL,
  similarity_score  REAL,
  rank_in_group     INTEGER NOT NULL,
  reason            TEXT,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  CONSTRAINT scene_group_items_selection_round_nonneg
    CHECK (selection_round >= 0),

  CONSTRAINT scene_group_items_rank_nonneg
    CHECK (rank_in_group >= 0),

  CONSTRAINT scene_group_items_group_fk
    FOREIGN KEY (scene_group_id) REFERENCES scene_groups (id) ON DELETE CASCADE,

  CONSTRAINT scene_group_items_media_fk
    FOREIGN KEY (media_id) REFERENCES media_items (id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX idx_scene_group_items_group_media
  ON scene_group_items (scene_group_id, media_id);

CREATE UNIQUE INDEX idx_scene_group_items_group_rank
  ON scene_group_items (scene_group_id, rank_in_group);

CREATE INDEX idx_scene_group_items_media
  ON scene_group_items (media_id);
