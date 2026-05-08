-- 001_create_trips.sql
--
-- Phase 1, Task 1: create the trips table (docs/tasks.md P1.T1).
--
-- The field set follows docs/requirements.md §8.1, with `destination`
-- chosen over the requirements' `location` per the P1.T1 spec to match
-- the wording the front-end forms will use.
--
-- Soft delete is the only delete path during the first version
-- (CLAUDE.md §2.4 and design.md §4.3). The repository layer (P1.T2)
-- adds `WHERE deleted_at IS NULL` to default queries; permanent delete
-- is held until P7 (design.md §4.3, env flag PERMANENT_DELETE_ENABLED).
--
-- Foreign keys deliberately NOT added here:
--   - cover_media_id → media_items(id) lands in a later migration once
--     media_items exists (P2.T1). SQLite cannot ALTER TABLE ADD
--     CONSTRAINT, so attaching the FK will require a table-rebuild
--     migration (CREATE new table, INSERT … SELECT, DROP, RENAME).
--
-- Date-order CHECK is a coarse safety net: SQLite compares TEXT
-- lexicographically, which is correct for ISO-8601 dates but not for
-- arbitrary strings. The repository / service layer is responsible for
-- canonicalising the format on write (validated against zod or similar
-- in P1.T2 / P1.T3).

CREATE TABLE trips (
  id              TEXT NOT NULL PRIMARY KEY,
  title           TEXT NOT NULL,
  description     TEXT,
  destination     TEXT,
  start_date      TEXT,
  end_date        TEXT,
  cover_media_id  TEXT,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at      TEXT,

  CONSTRAINT trips_title_not_blank
    CHECK (length(trim(title)) > 0),

  CONSTRAINT trips_date_order
    CHECK (
      start_date IS NULL
      OR end_date IS NULL
      OR end_date >= start_date
    )
) STRICT;

CREATE INDEX idx_trips_created_at  ON trips (created_at);
CREATE INDEX idx_trips_deleted_at  ON trips (deleted_at);
CREATE INDEX idx_trips_destination ON trips (destination);
