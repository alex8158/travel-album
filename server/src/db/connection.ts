// SQLite connection layer (P0.T5).
//
// Responsibilities:
//   1. Resolve a (possibly relative) database path to an absolute path
//      anchored at the repo root, so the location does not depend on the
//      shell's current working directory.
//   2. Auto-create the parent directory (`data/` by default) if missing.
//   3. Open a better-sqlite3 connection.
//   4. Enforce per-connection PRAGMAs:
//        - foreign_keys = ON   (per-connection only, must be re-set on each open)
//        - journal_mode = WAL  (persistent at the DB level, but cheap to reapply)
//
// Business tables are NOT defined here — those land in dedicated migrations
// during later phases (see docs/tasks.md). Persistent DB-level metadata is
// handled by migrations/000_init.sql.

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// In dev (tsx): here = <repo>/server/src/db
// After build:  here = <repo>/server/dist/db
// Both resolve to <repo>/ via "..", "..", "..".
const repoRoot = resolve(here, "..", "..", "..");

/**
 * Re-export the better-sqlite3 instance type so callers can type their
 * handles without importing better-sqlite3 directly.
 */
export type SqliteDatabase = InstanceType<typeof Database>;

/**
 * Resolve a (possibly relative) database path to an absolute path anchored
 * at the repo root. Absolute paths pass through unchanged.
 */
export function resolveDatabasePath(rawPath: string): string {
  return isAbsolute(rawPath) ? rawPath : resolve(repoRoot, rawPath);
}

export interface DbHandle {
  /** Live better-sqlite3 connection. */
  readonly db: SqliteDatabase;
  /** Absolute path of the database file. */
  readonly resolvedPath: string;
  /** Effective `foreign_keys` PRAGMA value (1 = on). */
  readonly foreignKeysPragma: number;
  /** Effective `journal_mode` PRAGMA value (e.g. "wal"). */
  readonly journalModePragma: string;
}

/**
 * Open the SQLite database, creating the parent directory if needed and
 * applying mandatory PRAGMAs. Throws if the file cannot be opened.
 */
export function openDatabase(rawPath: string): DbHandle {
  const resolvedPath = resolveDatabasePath(rawPath);
  const parentDir = dirname(resolvedPath);
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  const db = new Database(resolvedPath);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");

  const foreignKeysPragma = db.pragma("foreign_keys", { simple: true }) as number;
  const journalModePragma = db.pragma("journal_mode", { simple: true }) as string;

  return { db, resolvedPath, foreignKeysPragma, journalModePragma };
}

/**
 * Close the database connection if it is still open. Safe to call multiple
 * times. WAL is checkpointed automatically by better-sqlite3 on close.
 */
export function closeDatabase(handle: DbHandle): void {
  if (handle.db.open) {
    handle.db.close();
  }
}
