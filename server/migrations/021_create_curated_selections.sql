-- 021_create_curated_selections.sql
--
-- Migration scope (P12.T2 — third of four new tables; see
-- design.md §4.2 / §7.8 / §3.3):
--
-- Creates `curated_selections`, the table that records "which
-- photos are in this trip's curated album, across multiple
-- selection rounds + user-override rows". This is the single
-- source of truth the frontend Curated tab + slideshow worker
-- both read via Repository.getCurrentCuratedMediaIds (§7.8.4
-- merge formula).
--
-- Two row classes (see design.md §7.8.4):
--
--   * AI rounds (selection_round >= 1)
--     Written by P12.T6 (scene_best_pick worker, draft is_current=0)
--     and finalized by P12.T9 (curation_finalize worker which flips
--     drafts to is_current=1). Each AI round writes one row per
--     photo per group (best_media_id → included=1; non-best → 0).
--
--   * User overrides (selection_round = 0)
--     Written ONLY by the curated-overrides API (P12.T9) when the
--     user clicks [Pin] or [Exclude] in the UI. Always is_current=0
--     (the merge formula gives them their own layer on top of AI).
--     One row per (trip_id, media_id) — UPSERT, not INSERT.
--
-- "Current curated set" merge formula (§7.8.4):
--   (aiCurrent ∪ userPins) − userUnpins
--
-- Column contract (must match design.md §4.2):
--   * id                  — UUID PK
--   * trip_id             — FK → trips.id (CASCADE)
--   * media_id            — FK → media_items.id (CASCADE)
--   * scene_group_id      — FK → scene_groups.id (SET NULL); NULL
--                           for round=0 user-pin rows and for
--                           ungrouped fallback rows
--   * selection_round     — INTEGER >= 0; 0 = user override layer,
--                           1+ = AI rounds
--   * included            — INTEGER ∈ {0, 1}; 1 = this media is IN
--                           the curated set
--   * is_current          — INTEGER ∈ {0, 1}; AI rounds: 1 on the
--                           latest round, 0 on older rounds. Round
--                           0 user rows: always 0 (they live in a
--                           separate layer; see merge formula).
--   * reason              — TEXT NULL; human-readable explanation
--                           ("best-in-scene-by-quality_score",
--                           "user pinned", "AI:sharpest subject")
--   * ai_confidence       — REAL NULL ∈ [0, 1]; provider's
--                           confidence number (NULL for non-AI
--                           rows / Code fallback)
--   * refinement_params   — TEXT (JSON) NULL; P12.T7's AI-suggested
--                           refinement JSON (or NULL when L5 was
--                           skipped / failed)
--   * user_decision       — TEXT NULL ∈ {'kept', 'excluded', NULL};
--                           non-null only on round=0 rows
--   * created_at          — TEXT NOT NULL DEFAULT now()
--   * updated_at          — TEXT NOT NULL DEFAULT now()
--
-- Constraints:
--   * UNIQUE(trip_id, selection_round, media_id) — a photo gets
--     one row per (trip, round). Round 0 effectively gives one
--     row per (trip, media) for user overrides.
--   * included ∈ {0, 1}
--   * is_current ∈ {0, 1}
--   * selection_round >= 0
--   * ai_confidence IS NULL OR (0 <= ai_confidence <= 1)
--   * user_decision IS NULL OR user_decision IN ('kept','excluded')
--   * round=0 rows must have user_decision NOT NULL
--     (enforced at the SQL level for defence; repository also
--     guards via writeOverride API).
--   * round>=1 rows must have user_decision IS NULL
--     (same reasoning).
--
-- Indexes:
--   * UNIQUE (trip_id, selection_round, media_id)  -- write/lookup
--   * (trip_id, is_current, included)              -- current AI
--     curated set retrieval (Repository.getCurrentCuratedMediaIds
--     aiCurrent branch)
--   * (trip_id, selection_round)                   -- list-by-round
--   * (scene_group_id)                             -- reverse:
--                                                     "what curated
--                                                     rows live in
--                                                     this group"
--
-- Non-goals:
--   * No backfill (no prior data).
--   * No partial unique on is_current (the round-based UNIQUE +
--     repository's UPDATE-flip semantics are sufficient).

CREATE TABLE curated_selections (
  id                  TEXT    NOT NULL PRIMARY KEY,
  trip_id             TEXT    NOT NULL,
  media_id            TEXT    NOT NULL,
  scene_group_id      TEXT,
  selection_round     INTEGER NOT NULL,
  included            INTEGER NOT NULL,
  is_current          INTEGER NOT NULL DEFAULT 0,
  reason              TEXT,
  ai_confidence       REAL,
  refinement_params   TEXT,
  user_decision       TEXT,
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  CONSTRAINT curated_selections_round_nonneg
    CHECK (selection_round >= 0),

  CONSTRAINT curated_selections_included_bool
    CHECK (included IN (0, 1)),

  CONSTRAINT curated_selections_is_current_bool
    CHECK (is_current IN (0, 1)),

  CONSTRAINT curated_selections_ai_confidence_range
    CHECK (ai_confidence IS NULL OR (ai_confidence >= 0 AND ai_confidence <= 1)),

  CONSTRAINT curated_selections_user_decision_enum
    CHECK (user_decision IS NULL OR user_decision IN ('kept', 'excluded')),

  -- Layer-discipline guards:
  --   * round=0 rows are the user-override layer; they MUST carry
  --     a non-null user_decision (otherwise the row has no meaning).
  --   * round>=1 rows are the AI layer; they MUST have
  --     user_decision IS NULL (user_decision lives only in the
  --     round=0 layer per §7.8.4).
  CONSTRAINT curated_selections_round0_requires_decision
    CHECK (
      (selection_round  = 0 AND user_decision IS NOT NULL) OR
      (selection_round  > 0 AND user_decision IS NULL)
    ),

  CONSTRAINT curated_selections_trip_fk
    FOREIGN KEY (trip_id) REFERENCES trips (id) ON DELETE CASCADE,

  CONSTRAINT curated_selections_media_fk
    FOREIGN KEY (media_id) REFERENCES media_items (id) ON DELETE CASCADE,

  CONSTRAINT curated_selections_scene_group_fk
    FOREIGN KEY (scene_group_id) REFERENCES scene_groups (id) ON DELETE SET NULL
) STRICT;

CREATE UNIQUE INDEX idx_curated_selections_trip_round_media
  ON curated_selections (trip_id, selection_round, media_id);

CREATE INDEX idx_curated_selections_current_set
  ON curated_selections (trip_id, is_current, included);

CREATE INDEX idx_curated_selections_trip_round
  ON curated_selections (trip_id, selection_round);

CREATE INDEX idx_curated_selections_scene_group
  ON curated_selections (scene_group_id);
