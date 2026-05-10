-- 003_add_trips_cover_media_id_fk.sql
--
-- Attach the deferred FK from trips.cover_media_id → media_items(id)
-- (P2.T1, design §4.2). 001_create_trips.sql declared the column
-- without a constraint because media_items did not yet exist; now
-- that 002_create_media_items.sql has provided the parent table we
-- can rebuild trips with the FK in place.
--
-- ON DELETE SET NULL: a media_items row going away (only possible
-- via P7's hard-delete path; soft-delete keeps the row) leaves the
-- trip alive with cover_media_id reset to NULL. The trip should not
-- vanish just because its cover did.
--
-- SQLite does not support `ALTER TABLE … ADD CONSTRAINT`. We follow
-- the official table-rebuild pattern (sqlite.org/lang_altertable.html
-- §"Making Other Kinds Of Table Schema Changes"):
--
--   1. CREATE the new shape under a temporary name.
--   2. Copy every row over.
--   3. DROP the old table.
--   4. RENAME the new table into place.
--   5. Recreate the indexes.
--
-- The migration runner already wraps this entire script in a single
-- transaction, so any step failing rolls everything back. PRAGMA
-- foreign_keys stays ON throughout — better-sqlite3 wraps each
-- migration in db.transaction(...) and SQLite turns PRAGMA
-- foreign_keys into a no-op inside an open transaction
-- (https://sqlite.org/pragma.html#pragma_foreign_keys), so we cannot
-- toggle it from within this script. The rebuild stays safe because:
--
--   - The `UPDATE trips SET cover_media_id = NULL` below clears every
--     pre-existing value before the data copy. P1.T3's
--     POST /api/trips and POST /api/trips/:id/cover allow callers to
--     write any well-formed entity id into the column without
--     verifying the referenced media exists, so the only safe state
--     to assume is "all values are orphan" — media_items was created
--     by 002 just one migration ago, and at that moment held zero
--     rows, so by definition no pre-existing cover_media_id can
--     point to a real media. The user can re-set the cover via
--     POST /api/trips/:id/cover once real media exists in P2+.
--   - DROP TABLE does not fire FK checks in SQLite, and the FK from
--     media_items.trip_id is rebound automatically when trips_new
--     takes over the name "trips" (legacy_alter_table is OFF in
--     modern SQLite, which keeps cross-table references coherent).
--   - At the moment 003 runs, media_items contains zero rows, so the
--     ON DELETE RESTRICT constraint on media_items.trip_id is
--     vacuously satisfied during the implicit DELETE that DROP TABLE
--     performs against the parent.
--
-- Future migrations that rebuild trips again under different data
-- conditions cannot reuse this exact pattern unsafely; see R-29 in
-- docs/progress.md for the broader limitation.
--
-- Every column / DEFAULT / CHECK below mirrors 001_create_trips.sql
-- byte-for-byte except for the new FOREIGN KEY clause on
-- cover_media_id.

CREATE TABLE trips_new (
  id              TEXT    PRIMARY KEY NOT NULL,
  title           TEXT    NOT NULL,
  description     TEXT,
  destination     TEXT,
  start_date      TEXT,
  end_date        TEXT,
  cover_media_id  TEXT,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at      TEXT,

  CONSTRAINT trips_title_not_blank
    CHECK (length(trim(title)) > 0),

  CONSTRAINT trips_date_order
    CHECK (
      start_date IS NULL OR
      end_date   IS NULL OR
      end_date  >= start_date
    ),

  CONSTRAINT trips_cover_media_fk
    FOREIGN KEY (cover_media_id) REFERENCES media_items (id) ON DELETE SET NULL
) STRICT;

-- Reset any pre-existing cover_media_id values to NULL before the
-- copy. Anything non-NULL here is necessarily orphan (media_items did
-- not exist as a parent table until 002, which created it empty), and
-- leaving it would trigger FOREIGN KEY constraint failed on the
-- INSERT below — boot would then fail and roll back, blocking the
-- upgrade. Users can re-set the cover via POST /api/trips/:id/cover
-- after uploading real media in P2+.
UPDATE trips SET cover_media_id = NULL WHERE cover_media_id IS NOT NULL;

INSERT INTO trips_new (
  id, title, description, destination,
  start_date, end_date, cover_media_id,
  created_at, updated_at, deleted_at
)
SELECT
  id, title, description, destination,
  start_date, end_date, cover_media_id,
  created_at, updated_at, deleted_at
FROM trips;

DROP TABLE trips;

ALTER TABLE trips_new RENAME TO trips;

-- Recreate the indexes from 001_create_trips.sql; they were dropped
-- alongside the old trips table.
CREATE INDEX idx_trips_created_at  ON trips (created_at);
CREATE INDEX idx_trips_deleted_at  ON trips (deleted_at);
CREATE INDEX idx_trips_destination ON trips (destination);
