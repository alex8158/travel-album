-- 015_create_edit_plans.sql
--
-- Migration scope (P11.T5):
--
-- Persist the P11.T4 `VideoEditPlan` JSON so the render endpoint
-- (`POST /api/trips/:tripId/render`) can find a previously-generated
-- plan by id, OR fall back to "the most recent plan for this trip"
-- when no planId is supplied.
--
-- Why a dedicated table (not just an in-memory cache):
--   * Plans must outlive the HTTP request that built them — the
--     user clicks "Generate" then later clicks "Render", possibly
--     after a server restart.
--   * Plans must be addressable by id so a future P11.T7 UI can
--     show "Plan history" or let the user revise a plan and render
--     a specific version.
--   * Plans are JSON-serialisable by design (P11.T4) — storing them
--     as a TEXT column is the natural fit; no row-per-clip
--     normalisation needed.
--
-- Column decisions:
--   * `id`              — UUID issued by the service.
--   * `trip_id`         — FK to trips. ON DELETE CASCADE so plans
--                          die with their parent trip; soft-deleted
--                          trips still expose plans (the join
--                          decides visibility).
--   * `plan_json`       — full VideoEditPlan as JSON (TEXT in STRICT
--                          tables; SQLite has no native JSON type).
--                          The application layer re-parses on read.
--   * `target_duration_sec` — denormalised for cheap "latest /
--                              filter" listing without parsing JSON.
--   * `style`           — denormalised style enum (short / standard /
--                          long). Mirrors the JSON field; lets
--                          future P11.T7 list views filter without
--                          deserialising every row.
--   * `created_at`      — used by `findLatestByTripId` ORDER BY
--                          DESC + UUID tie-break.
--
-- Indexes:
--   * (trip_id, created_at DESC) — the "latest plan for this trip"
--     read path. The leading trip_id column also serves as the
--     bulk "all plans for this trip" listing index.
--
-- Scope: schema only. The repository / service wiring lives in
-- application code; this file is just the table.

CREATE TABLE edit_plans (
  id                   TEXT    NOT NULL PRIMARY KEY,
  trip_id              TEXT    NOT NULL,
  plan_json            TEXT    NOT NULL,
  target_duration_sec  REAL    NOT NULL,
  style                TEXT    NOT NULL,
  created_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  CONSTRAINT edit_plans_target_duration_positive
    CHECK (target_duration_sec > 0),

  CONSTRAINT edit_plans_style_enum
    CHECK (style IN ('short', 'standard', 'long')),

  CONSTRAINT edit_plans_plan_json_not_blank
    CHECK (length(plan_json) > 0),

  CONSTRAINT edit_plans_trip_fk
    FOREIGN KEY (trip_id) REFERENCES trips (id) ON DELETE CASCADE
) STRICT;

-- "Latest plan for this trip" — the render endpoint's fallback path
-- when no planId is supplied. SQLite uses this composite as a
-- single-index DESC scan.
CREATE INDEX idx_edit_plans_trip_created
  ON edit_plans (trip_id, created_at DESC);
