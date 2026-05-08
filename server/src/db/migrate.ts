// Migration runner (P0.T5).
//
// Strategy:
//   1. Maintain a tracking table `_schema_migrations(name, applied_at)`.
//   2. Read every `*.sql` file from `server/migrations/` in lexicographic order.
//   3. Skip any file whose name is already in the tracking table.
//   4. Apply remaining files in transactions, recording each in the tracking table.
//
// This intentionally remains tiny — no checksums, no down-migrations, no CLI.
// Those can be added later once business tables exist (see docs/tasks.md X.T1
// and onwards).

import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SqliteDatabase } from "./connection.js";

const here = dirname(fileURLToPath(import.meta.url));
// dev:   <repo>/server/src/db
// built: <repo>/server/dist/db
// Both resolve to <repo>/server via "..", "..".
const serverDir = resolve(here, "..", "..");
const defaultMigrationsDir = resolve(serverDir, "migrations");

const TRACKING_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS _schema_migrations (
  name        TEXT NOT NULL PRIMARY KEY,
  applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
`;

export interface MigrationResult {
  /** Files actually applied during this run (in apply order). */
  readonly appliedNow: readonly string[];
  /** Files skipped because they were already applied. */
  readonly alreadyApplied: readonly string[];
  /** All `.sql` files discovered in the migrations directory. */
  readonly totalFiles: number;
  /** Absolute path of the migrations directory used for this run. */
  readonly migrationsDir: string;
}

export interface RunMigrationsOptions {
  /** Override the default migrations directory (mostly for tests). */
  readonly migrationsDir?: string;
}

/**
 * Apply pending SQL migrations. Idempotent: a second invocation with no
 * new files becomes a no-op.
 */
export function runMigrations(
  db: SqliteDatabase,
  options: RunMigrationsOptions = {},
): MigrationResult {
  const migrationsDir = options.migrationsDir ?? defaultMigrationsDir;

  db.exec(TRACKING_TABLE_DDL);

  const files = listMigrationFiles(migrationsDir);

  const checkStmt = db.prepare("SELECT name FROM _schema_migrations WHERE name = ?");
  const insertStmt = db.prepare("INSERT INTO _schema_migrations (name) VALUES (?)");

  const appliedNow: string[] = [];
  const alreadyApplied: string[] = [];

  for (const name of files) {
    if (checkStmt.get(name) !== undefined) {
      alreadyApplied.push(name);
      continue;
    }
    const sqlPath = resolve(migrationsDir, name);
    const sql = readFileSync(sqlPath, "utf8");
    const apply = db.transaction(() => {
      db.exec(sql);
      insertStmt.run(name);
    });
    apply();
    appliedNow.push(name);
  }

  return { appliedNow, alreadyApplied, totalFiles: files.length, migrationsDir };
}

function listMigrationFiles(migrationsDir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(migrationsDir, { withFileTypes: true, encoding: "utf8" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  return entries
    .filter((d) => d.isFile() && d.name.endsWith(".sql"))
    .map((d) => d.name)
    .sort();
}
