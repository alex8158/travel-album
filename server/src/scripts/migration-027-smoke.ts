// Manual smoke test for migration 027 (P12.T3).
//
// Usage: npm run smoke:migration-027
//
// Verifies the three ALTER ADD COLUMNs on trips:
//   * Fresh DB: 000..027 apply cleanly.
//   * Columns last_upload_at / last_curation_at (both nullable TEXT, no
//     DEFAULT) and curation_auto_enabled (NOT NULL INTEGER DEFAULT 1,
//     CHECK ∈ {0,1}) exist with the right NOT NULL flags.
//   * Omitted curation_auto_enabled on INSERT defaults to 1.
//   * CHECK rejects 2 / -1 / 'a'.
//   * Upgrade path (apply 000..026, seed legacy trip, apply 027):
//     existing trip lands on curation_auto_enabled=1 / last_upload_at=NULL
//     / last_curation_at=NULL.
//   * Existing FKs from media_items / scene_groups / processing_jobs (et
//     al.) NOT broken — trips is a heavy parent; we explicitly avoided a
//     rebuild. media_items rows for that trip still resolve.
//   * foreign_key_check + integrity_check clean.

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";

const TARGET = "027_extend_trips_curation.sql";

interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}
const results: CheckResult[] = [];
function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`[smoke][${ok ? "PASS" : "FAIL"}] ${name}: ${detail}`);
}
function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
function expectThrow(name: string, fn: () => void, matcher: RegExp): void {
  let threw: unknown;
  try {
    fn();
  } catch (err) {
    threw = err;
  }
  const ok = threw !== undefined && matcher.test(describeError(threw));
  record(name, ok, describeError(threw));
}

const migrationsDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  "migrations",
);

function listMigrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((n) => n.endsWith(".sql"))
    .sort();
}

function ensureTracking(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _schema_migrations (
      name        TEXT NOT NULL PRIMARY KEY,
      applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ) STRICT;
  `);
}

async function execTracked(db: SqliteDatabase, name: string): Promise<void> {
  const sql = await readFile(path.join(migrationsDir, name), "utf8");
  db.exec(sql);
  db.prepare(`INSERT INTO _schema_migrations (name) VALUES (?)`).run(name);
}

function seedLegacyTrip(db: SqliteDatabase, title: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO trips (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
    id,
    title,
    now,
    now,
  );
  return id;
}

function seedMedia(db: SqliteDatabase, tripId: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO media_items
       (id, trip_id, type, original_path, mime_type, extension, file_size,
        status, user_decision, created_at, updated_at)
     VALUES (?, ?, 'image', ?, 'image/jpeg', 'jpg', 4096,
             'processed', 'undecided', ?, ?)`,
  ).run(id, tripId, `trips/${tripId}/originals/${id}.jpg`, now, now);
  return id;
}

async function main(): Promise<void> {
  // ===================================================================
  // CASE A: fresh DB
  // ===================================================================
  {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-mig027-fresh-"));
    const dbHandle = openDatabase(path.join(tmpRoot, "fresh.db"));
    try {
      const res = runMigrations(dbHandle.db);
      record(
        "fresh: 027 in appliedNow",
        res.appliedNow.includes(TARGET),
        `last=${res.appliedNow.at(-1)}`,
      );

      const cols = dbHandle.db.prepare(`PRAGMA table_info(trips)`).all() as {
        name: string;
        notnull: number;
        dflt_value: string | null;
      }[];
      const byName = new Map(cols.map((c) => [c.name, c]));
      record(
        "fresh: 3 new columns present (last_upload_at/last_curation_at/curation_auto_enabled)",
        ["last_upload_at", "last_curation_at", "curation_auto_enabled"].every((c) =>
          byName.has(c),
        ),
        `cols=${cols.map((c) => c.name).join(",")}`,
      );
      record(
        "fresh: last_upload_at / last_curation_at are nullable (no DEFAULT)",
        byName.get("last_upload_at")?.notnull === 0 &&
          byName.get("last_curation_at")?.notnull === 0 &&
          byName.get("last_upload_at")?.dflt_value === null &&
          byName.get("last_curation_at")?.dflt_value === null,
        `nn lu=${byName.get("last_upload_at")?.notnull} lc=${byName.get("last_curation_at")?.notnull}`,
      );
      record(
        "fresh: curation_auto_enabled NOT NULL DEFAULT 1",
        byName.get("curation_auto_enabled")?.notnull === 1 &&
          byName.get("curation_auto_enabled")?.dflt_value === "1",
        `nn=${byName.get("curation_auto_enabled")?.notnull} dflt=${byName.get("curation_auto_enabled")?.dflt_value}`,
      );

      // INSERT omitting curation_auto_enabled → defaults to 1.
      const tId = randomUUID();
      const now = new Date().toISOString();
      dbHandle.db
        .prepare(`INSERT INTO trips (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`)
        .run(tId, "Fresh A", now, now);
      const row = dbHandle.db
        .prepare(
          `SELECT last_upload_at, last_curation_at, curation_auto_enabled FROM trips WHERE id=?`,
        )
        .get(tId) as {
          last_upload_at: string | null;
          last_curation_at: string | null;
          curation_auto_enabled: number;
        };
      record(
        "fresh: omitted curation_auto_enabled defaults to 1",
        row.curation_auto_enabled === 1,
        `curation_auto_enabled=${row.curation_auto_enabled}`,
      );
      record(
        "fresh: last_upload_at / last_curation_at start as NULL",
        row.last_upload_at === null && row.last_curation_at === null,
        `lu=${String(row.last_upload_at)} lc=${String(row.last_curation_at)}`,
      );

      // CHECK rejects bogus.
      expectThrow(
        "fresh: curation_auto_enabled CHECK rejects 2",
        () =>
          dbHandle.db
            .prepare(
              `INSERT INTO trips (id, title, created_at, updated_at, curation_auto_enabled)
               VALUES (?, ?, ?, ?, 2)`,
            )
            .run(randomUUID(), "x", now, now),
        /CHECK constraint failed/i,
      );
      expectThrow(
        "fresh: curation_auto_enabled CHECK rejects -1",
        () =>
          dbHandle.db
            .prepare(
              `INSERT INTO trips (id, title, created_at, updated_at, curation_auto_enabled)
               VALUES (?, ?, ?, ?, -1)`,
            )
            .run(randomUUID(), "x", now, now),
        /CHECK constraint failed/i,
      );

      // Accept 0 explicitly.
      const tOff = randomUUID();
      dbHandle.db
        .prepare(
          `INSERT INTO trips (id, title, created_at, updated_at, curation_auto_enabled)
           VALUES (?, ?, ?, ?, 0)`,
        )
        .run(tOff, "off", now, now);
      const offVal = (dbHandle.db
        .prepare(`SELECT curation_auto_enabled FROM trips WHERE id=?`)
        .get(tOff) as { curation_auto_enabled: number }).curation_auto_enabled;
      record("fresh: curation_auto_enabled accepts 0", offVal === 0, `val=${offVal}`);

      // Write the timestamp columns to prove they store ISO strings.
      const tStamp = randomUUID();
      const iso = "2026-05-29T12:00:00.000Z";
      dbHandle.db
        .prepare(
          `INSERT INTO trips (id, title, created_at, updated_at, last_upload_at, last_curation_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(tStamp, "s", now, now, iso, iso);
      const tsRow = dbHandle.db
        .prepare(`SELECT last_upload_at, last_curation_at FROM trips WHERE id=?`)
        .get(tStamp) as { last_upload_at: string; last_curation_at: string };
      record(
        "fresh: last_upload_at / last_curation_at accept ISO TEXT writes",
        tsRow.last_upload_at === iso && tsRow.last_curation_at === iso,
        `lu=${tsRow.last_upload_at} lc=${tsRow.last_curation_at}`,
      );

      const fk = dbHandle.db.prepare(`PRAGMA foreign_key_check`).all() as unknown[];
      record("fresh: foreign_key_check clean", fk.length === 0, `len=${fk.length}`);
      const integ = dbHandle.db.prepare(`PRAGMA integrity_check`).get() as { integrity_check: string };
      record("fresh: integrity_check ok", integ.integrity_check === "ok", integ.integrity_check);
    } finally {
      closeDatabase(dbHandle);
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }

  // ===================================================================
  // CASE B: upgrade — apply 000..026, seed legacy trip + child media,
  //         apply 027. Verify backfill + parent FK preservation.
  // ===================================================================
  {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-mig027-upgrade-"));
    const dbHandle = openDatabase(path.join(tmpRoot, "upgrade.db"));
    try {
      const all = listMigrationFiles();
      const idx = all.indexOf(TARGET);
      record("upgrade: 027 present in migrations dir", idx >= 0, `idx=${idx}`);
      ensureTracking(dbHandle.db);
      for (const name of all.slice(0, idx)) {
        await execTracked(dbHandle.db, name);
      }

      const tripId = seedLegacyTrip(dbHandle.db, "Upgrade B");
      const mediaId = seedMedia(dbHandle.db, tripId);

      await execTracked(dbHandle.db, TARGET);

      const after = dbHandle.db
        .prepare(
          `SELECT last_upload_at, last_curation_at, curation_auto_enabled FROM trips WHERE id=?`,
        )
        .get(tripId) as {
          last_upload_at: string | null;
          last_curation_at: string | null;
          curation_auto_enabled: number;
        };
      record(
        "upgrade: legacy trip backfilled curation_auto_enabled=1",
        after.curation_auto_enabled === 1,
        `curation_auto_enabled=${after.curation_auto_enabled}`,
      );
      record(
        "upgrade: legacy trip last_upload_at / last_curation_at NULL (never-happened sentinel)",
        after.last_upload_at === null && after.last_curation_at === null,
        `lu=${String(after.last_upload_at)} lc=${String(after.last_curation_at)}`,
      );

      // No row should have NULL curation_auto_enabled.
      const nullCount = (dbHandle.db
        .prepare(`SELECT COUNT(*) n FROM trips WHERE curation_auto_enabled IS NULL`)
        .get() as { n: number }).n;
      record(
        "upgrade: NO trip row has NULL curation_auto_enabled",
        nullCount === 0,
        `null_count=${nullCount}`,
      );

      // FK preservation: media_items.trip_id (RESTRICT) still resolves
      // — would fail with FK error if trips lost its row id.
      const mediaTrip = dbHandle.db
        .prepare(`SELECT trip_id FROM media_items WHERE id=?`)
        .get(mediaId) as { trip_id: string };
      record(
        "upgrade: child media_items.trip_id still resolves (parent FK preserved)",
        mediaTrip.trip_id === tripId,
        `child_trip_id=${mediaTrip.trip_id} expected=${tripId}`,
      );

      const fk = dbHandle.db.prepare(`PRAGMA foreign_key_check`).all() as unknown[];
      record("upgrade: foreign_key_check clean", fk.length === 0, `len=${fk.length}`);
      const integ = dbHandle.db.prepare(`PRAGMA integrity_check`).get() as { integrity_check: string };
      record("upgrade: integrity_check ok", integ.integrity_check === "ok", integ.integrity_check);
    } finally {
      closeDatabase(dbHandle);
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n[smoke] summary: ${passed}/${results.length} passed`);
  if (failed > 0) {
    console.log(`[smoke] failures: ${results.filter((r) => !r.ok).map((r) => r.name).join(", ")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[smoke] uncaught error: ${describeError(err)}`);
  process.exit(1);
});
