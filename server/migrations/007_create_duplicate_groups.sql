-- 007_create_duplicate_groups.sql
--
-- Duplicate-detection tables (P5.T1, requirements §8.4 / §8.5 +
-- design.md §4.2 R-row). Two tables in one migration because they
-- are tightly coupled: every `duplicate_group_items` row needs a
-- `duplicate_groups` row to exist first. Single file keeps the
-- creation order deterministic without relying on cross-file
-- migration ordering tricks.
--
-- Scope of P5.T1 (per docs/tasks.md): SCHEMA ONLY. Hash workers,
-- the exact / similar `Dedup_Engine`, the recommendation pipeline,
-- the public Duplicate Group API, the frontend, and the user-
-- confirmation workflow are all explicitly deferred to P5.T2 …
-- P5.T7. Until those land both tables sit empty.
--
-- Tables:
--   * duplicate_groups       — one row per cluster of exact /
--                              similar / candidate duplicate images.
--                              Aggregates trip scope + recommendation
--                              + user-confirmation flag.
--   * duplicate_group_items  — one row per (group, media) membership.
--                              Carries the per-media similarity /
--                              quality score, the auto-recommendation
--                              the engine chose, the reason string
--                              (CLAUDE.md §3.8 "推荐结果必须可解释"),
--                              and the user's manual decision (which
--                              wins on conflict per CLAUDE.md §3.9).
--
-- FK strategy (design.md §4.2):
--   * duplicate_groups.trip_id       → trips(id) ON DELETE RESTRICT
--     Hard-deleting a trip while it still owns duplicate groups must
--     fail at the FK level, mirroring `media_items.trip_fk`. Soft
--     deletes do not cascade.
--   * duplicate_groups.recommended_media_id → media_items(id) ON DELETE SET NULL
--     Per design.md §4.2 R-row. Business layer is expected to reset
--     this column before issuing a permanent delete (CLAUDE.md §2.6);
--     SET NULL is the schema-level safety net so a forgotten reset
--     does not crash the delete itself.
--   * duplicate_group_items.group_id → duplicate_groups(id) ON DELETE CASCADE
--     Per design.md §4.2 R-row. Deleting a group takes its membership
--     rows with it.
--   * duplicate_group_items.media_id → media_items(id) ON DELETE CASCADE
--     Mirrors `processing_jobs` / `media_versions` — a hard delete of
--     media_items cascades through all its dependents (design §4.3
--     permanent-delete path).
--
-- Enum decisions:
--   * group_type ∈ {'exact', 'similar', 'candidate'} matches the
--     vocabulary in requirements §8.4 and design.md §6.3.
--     - exact     : `media_items.file_hash` strict equality (P5.T3)
--     - similar   : pHash / dHash Hamming distance ≤ threshold (P5.T4)
--     - candidate : reserved for future heuristics (e.g. burst /
--                   bracketed series); not yet emitted but stays in
--                   the closed set so a later writer needs no
--                   migration.
--   * recommendation / user_decision ∈ {'keep', 'remove', 'undecided'}
--     mirrors `media_items.user_decision_enum` and design.md §6.4.
--     Default 'undecided' covers fresh rows where nothing has run
--     or the user has not chosen yet.
--   * user_confirmed is an INTEGER 0/1 (SQLite STRICT has no BOOLEAN;
--     project convention is to store flags as INTEGER with a
--     CHECK constraint).
--
-- Numeric ranges:
--   * confidence       — 0..1, NULLABLE while the engine has not yet
--                        computed it.
--   * similarity_score — 0..1, NULLABLE for the same reason; lives on
--                        both the group (cluster aggregate) and each
--                        item (per-media against the representative).
--   * quality_score    — 0..1, written by P6 `Quality_Selector`; null
--                        until then.
--
-- Indexes (design.md §4.2):
--   * duplicate_groups:
--       - trip_id              : "list groups for a trip"
--       - group_type           : "all exact-duplicates across DB"
--       - recommended_media_id : reverse lookup for soft-delete reset
--       - user_confirmed       : "find unconfirmed groups to re-rank"
--   * duplicate_group_items:
--       - UNIQUE (group_id, media_id) : design §4.2 explicit. Left-
--                                       prefix on group_id also covers
--                                       "list items in this group".
--       - media_id             : "what groups is this media in"
--                                (P7 soft-delete & restore flows scan
--                                this).
--
-- Note: this migration intentionally does NOT touch existing tables.
-- Soft-delete business logic in `media_items` / `trips` is unchanged;
-- P7 will wire the cleanup that resets `recommended_media_id` and
-- toggles `user_decision` on item rows.

CREATE TABLE duplicate_groups (
  id                    TEXT    NOT NULL PRIMARY KEY,
  trip_id               TEXT    NOT NULL,
  group_type            TEXT    NOT NULL,
  recommended_media_id  TEXT,
  confidence            REAL,
  similarity_score      REAL,
  user_confirmed        INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  CONSTRAINT duplicate_groups_group_type_enum
    CHECK (group_type IN ('exact', 'similar', 'candidate')),

  CONSTRAINT duplicate_groups_confidence_range
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),

  CONSTRAINT duplicate_groups_similarity_score_range
    CHECK (similarity_score IS NULL OR (similarity_score >= 0 AND similarity_score <= 1)),

  CONSTRAINT duplicate_groups_user_confirmed_bool
    CHECK (user_confirmed IN (0, 1)),

  CONSTRAINT duplicate_groups_trip_fk
    FOREIGN KEY (trip_id) REFERENCES trips (id) ON DELETE RESTRICT,

  CONSTRAINT duplicate_groups_recommended_media_fk
    FOREIGN KEY (recommended_media_id) REFERENCES media_items (id) ON DELETE SET NULL
) STRICT;

CREATE INDEX idx_duplicate_groups_trip_id              ON duplicate_groups (trip_id);
CREATE INDEX idx_duplicate_groups_group_type           ON duplicate_groups (group_type);
CREATE INDEX idx_duplicate_groups_recommended_media_id ON duplicate_groups (recommended_media_id);
CREATE INDEX idx_duplicate_groups_user_confirmed       ON duplicate_groups (user_confirmed);

CREATE TABLE duplicate_group_items (
  id                TEXT    NOT NULL PRIMARY KEY,
  group_id          TEXT    NOT NULL,
  media_id          TEXT    NOT NULL,
  similarity_score  REAL,
  quality_score     REAL,
  recommendation    TEXT    NOT NULL DEFAULT 'undecided',
  reason            TEXT,
  user_decision     TEXT    NOT NULL DEFAULT 'undecided',
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  CONSTRAINT duplicate_group_items_similarity_score_range
    CHECK (similarity_score IS NULL OR (similarity_score >= 0 AND similarity_score <= 1)),

  CONSTRAINT duplicate_group_items_quality_score_range
    CHECK (quality_score IS NULL OR (quality_score >= 0 AND quality_score <= 1)),

  CONSTRAINT duplicate_group_items_recommendation_enum
    CHECK (recommendation IN ('keep', 'remove', 'undecided')),

  CONSTRAINT duplicate_group_items_user_decision_enum
    CHECK (user_decision IN ('keep', 'remove', 'undecided')),

  CONSTRAINT duplicate_group_items_group_fk
    FOREIGN KEY (group_id) REFERENCES duplicate_groups (id) ON DELETE CASCADE,

  CONSTRAINT duplicate_group_items_media_fk
    FOREIGN KEY (media_id) REFERENCES media_items (id) ON DELETE CASCADE
) STRICT;

-- design.md §4.2 explicit UNIQUE. The left-prefix on `group_id` also
-- doubles as the "all items in this group" lookup index, so a
-- separate `group_id`-only index would be redundant.
CREATE UNIQUE INDEX idx_duplicate_group_items_group_media
  ON duplicate_group_items (group_id, media_id);

-- Reverse lookup: "what groups is this media currently a member of?".
-- P7 soft-delete will use this to find rows whose user_decision needs
-- to be flipped to 'remove' on a media delete (CLAUDE.md §2.6).
CREATE INDEX idx_duplicate_group_items_media_id ON duplicate_group_items (media_id);
