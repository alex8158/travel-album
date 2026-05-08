-- 000_init.sql
--
-- Baseline migration for Travel Album Site V2.
--
-- IMPORTANT: This migration intentionally does NOT create any business
-- tables. Tables for trips / media_items / media_analysis / duplicate_groups
-- / media_versions / video_segments / processing_jobs / ai_invocations land
-- in their own dedicated migrations during later phases (see docs/tasks.md
-- starting at P1.T1). Keeping the baseline empty makes it easy to track
-- exactly which migration introduced each schema change.
--
-- Per-connection PRAGMAs are NOT set here: SQLite requires them on every
-- new connection, so they live in server/src/db/connection.ts:
--   PRAGMA foreign_keys = ON;
--   PRAGMA journal_mode = WAL;
--
-- The PRAGMAs below are persistent at the database-file level, so it is
-- safe (and meaningful) to set them inside this migration's transaction.

-- application_id 1953853804 is "tral" (= 0x7472616C) interpreted as a
-- 32-bit big-endian ASCII tag. It marks this DB file as belonging to
-- the Travel Album project and lets future tooling do quick sanity checks.
PRAGMA application_id = 1953853804;

-- Schema version exposed on the SQLite file. Bump this in future migrations
-- as needed; combined with the _schema_migrations tracking table it gives
-- two independent ways to detect drift.
PRAGMA user_version = 1;
