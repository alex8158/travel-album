-- 027_extend_trips_curation.sql
--
-- Migration scope (P12.T3):
--
-- Add the three curation-control columns to `trips` (created in 001,
-- rebuilt in 003, extended in 009) that the curated-album idle scanner and
-- per-trip auto-curation switch need (design.md §4.2 trips row + §7.8.2):
--
--   * last_upload_at        TEXT NULL. Set by the Upload API (NOT by any
--                           processing worker) in the same transaction that
--                           writes media_items, so "idle" means "user's last
--                           upload", not "system's last processing finished"
--                           (design.md §4.2 red-line note). NULL = no upload
--                           yet — the natural "never happened" sentinel, so
--                           no backfill is required.
--   * last_curation_at      TEXT NULL. Set by the service layer when a
--                           curation_run enters running, to debounce the
--                           scanner. NULL = never curated.
--   * curation_auto_enabled INTEGER NOT NULL DEFAULT 1, CHECK IN (0,1). Per-
--                           trip switch; ANDed with the global
--                           CURATION_AUTO_TRIGGER_ENABLED env. Default 1
--                           (auto-curation on) for new and existing trips.
--
-- Why ALTER ADD COLUMN (no rebuild): trips is the PARENT of several FKs
-- (media_items.trip_id RESTRICT, scene_groups, curated_selections,
-- slideshow_renders, and — after 023/024 — processing_jobs.trip_id /
-- ai_invocations.trip_id), but ALTER ADD COLUMN does not drop the table, so
-- none of those references are disturbed. A CHECK on an added column is
-- permitted; curation_auto_enabled's constant DEFAULT 1 backfills every
-- existing row.
--
-- Non-goals (schema-only): no Upload API / scanner / service change. The
-- Upload API write of last_upload_at and the scanner that reads all three
-- columns are later P12 tasks.

ALTER TABLE trips
  ADD COLUMN last_upload_at TEXT;

ALTER TABLE trips
  ADD COLUMN last_curation_at TEXT;

ALTER TABLE trips
  ADD COLUMN curation_auto_enabled INTEGER NOT NULL DEFAULT 1
  CHECK (curation_auto_enabled IN (0, 1));
