// Manual smoke test for migration 024 (P12.T3).
//
// Usage: npm run smoke:migration-024
//
// Verifies the four ALTER ADD COLUMNs on ai_invocations + the new partial
// UNIQUE cost-cache index + the trip_id index, on both a fresh DB and an
// upgrade from the 023-baseline:
//   * Fresh DB: 000..024 apply cleanly.
//   * Columns trip_id / target_type / target_id / input_hash exist with the
//     right NOT NULL flags and target_type CHECK enum.
//   * Omitted target_type defaults to 'media'.
//   * Partial UNIQUE (trip_id, request_type, target_type, target_id,
//     input_hash) WHERE status='success' rejects the second success row but
//     allows a parallel non-success row (e.g. failed) on the same tuple.
//   * Upgrade path (apply 000..023, seed legacy ai_invocations rows, apply
//     024): existing rows backfill to target_type='media' (column DEFAULT)
//     and target_id=media_id (explicit UPDATE in the migration).
//   * ON DELETE SET NULL on trip_id still fires (we wired the FK fresh).
//   * foreign_key_check + integrity_check clean.

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";

const TARGET = "024_extend_ai_invocations.sql";

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

function seedTrip(db: SqliteDatabase, title: string): string {
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

/** Insert an ai_invocations row in the PRE-024 shape (no new columns). */
function seedLegacyAi(db: SqliteDatabase, mediaId: string, requestType: string, status: string): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO ai_invocations (id, media_id, provider, model_name, request_type, status)
     VALUES (?, ?, 'local-mock', 'm', ?, ?)`,
  ).run(id, mediaId, requestType, status);
  return id;
}

async function main(): Promise<void> {
  // ===================================================================
  // CASE A: fresh DB
  // ===================================================================
  {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-mig024-fresh-"));
    const dbHandle = openDatabase(path.join(tmpRoot, "fresh.db"));
    try {
      const res = runMigrations(dbHandle.db);
      record(
        "fresh: 024 in appliedNow",
        res.appliedNow.includes(TARGET),
        `last=${res.appliedNow.at(-1)}`,
      );

      const cols = dbHandle.db.prepare(`PRAGMA table_info(ai_invocations)`).all() as {
        name: string;
        notnull: number;
        dflt_value: string | null;
      }[];
      const byName = new Map(cols.map((c) => [c.name, c]));
      record(
        "fresh: 4 new columns present (trip_id/target_type/target_id/input_hash)",
        ["trip_id", "target_type", "target_id", "input_hash"].every((c) => byName.has(c)),
        `cols=${cols.map((c) => c.name).join(",")}`,
      );
      record(
        "fresh: target_type is NOT NULL with DEFAULT 'media'",
        byName.get("target_type")?.notnull === 1 &&
          (byName.get("target_type")?.dflt_value ?? "").includes("media"),
        `nn=${byName.get("target_type")?.notnull} dflt=${byName.get("target_type")?.dflt_value}`,
      );
      record(
        "fresh: trip_id / target_id / input_hash are nullable",
        byName.get("trip_id")?.notnull === 0 &&
          byName.get("target_id")?.notnull === 0 &&
          byName.get("input_hash")?.notnull === 0,
        `nn trip_id=${byName.get("trip_id")?.notnull} target_id=${byName.get("target_id")?.notnull} input_hash=${byName.get("input_hash")?.notnull}`,
      );

      const idxNames = (dbHandle.db.prepare(`PRAGMA index_list('ai_invocations')`).all() as {
        name: string;
      }[])
        .map((r) => r.name)
        .filter((n) => !n.startsWith("sqlite_autoindex_"))
        .sort();
      record(
        "fresh: idx_ai_invocations_cost_cache + idx_ai_invocations_trip_id present",
        idxNames.includes("idx_ai_invocations_cost_cache") &&
          idxNames.includes("idx_ai_invocations_trip_id"),
        `idx=${JSON.stringify(idxNames)}`,
      );

      const tripId = seedTrip(dbHandle.db, "Fresh A");
      const mediaId = seedMedia(dbHandle.db, tripId);

      // INSERT omitting target_type — defaults to 'media'.
      const a1 = randomUUID();
      dbHandle.db
        .prepare(
          `INSERT INTO ai_invocations (id, media_id, provider, model_name, request_type, status)
           VALUES (?, ?, 'local-mock', 'm', 'image_ai_refine', 'success')`,
        )
        .run(a1, mediaId);
      const tt = (dbHandle.db.prepare(`SELECT target_type FROM ai_invocations WHERE id=?`).get(a1) as {
        target_type: string;
      }).target_type;
      record("fresh: omitted target_type defaults to 'media'", tt === "media", `target_type=${tt}`);

      // target_type CHECK rejects bogus.
      expectThrow(
        "fresh: target_type CHECK rejects 'bogus'",
        () =>
          dbHandle.db
            .prepare(
              `INSERT INTO ai_invocations (id, target_type, provider, model_name, request_type, status)
               VALUES (?, 'bogus', 'p', 'm', 'image_ai_refine', 'success')`,
            )
            .run(randomUUID()),
        /CHECK constraint failed/i,
      );

      // Partial unique cost-cache: same tuple + success → collision.
      const hash = "h" + "0".repeat(63);
      dbHandle.db
        .prepare(
          `INSERT INTO ai_invocations (id, trip_id, target_type, target_id, input_hash, provider, model_name, request_type, status)
           VALUES (?, ?, 'media', ?, ?, 'p', 'm', 'image_ai_refine', 'success')`,
        )
        .run(randomUUID(), tripId, mediaId, hash);
      expectThrow(
        "fresh: cost-cache UNIQUE rejects 2nd success on same (trip,req,target,hash)",
        () =>
          dbHandle.db
            .prepare(
              `INSERT INTO ai_invocations (id, trip_id, target_type, target_id, input_hash, provider, model_name, request_type, status)
               VALUES (?, ?, 'media', ?, ?, 'p', 'm', 'image_ai_refine', 'success')`,
            )
            .run(randomUUID(), tripId, mediaId, hash),
        /UNIQUE constraint failed/i,
      );

      // Partial: a 'failed' row on the same tuple is allowed (WHERE status='success').
      let failedInsertOk = true;
      try {
        dbHandle.db
          .prepare(
            `INSERT INTO ai_invocations (id, trip_id, target_type, target_id, input_hash, provider, model_name, request_type, status)
             VALUES (?, ?, 'media', ?, ?, 'p', 'm', 'image_ai_refine', 'failed')`,
          )
          .run(randomUUID(), tripId, mediaId, hash);
      } catch (err) {
        failedInsertOk = false;
        record("fresh: failed-status row allowed on cached tuple", false, describeError(err));
      }
      if (failedInsertOk) {
        record("fresh: failed-status row allowed on cached tuple", true, "no unique violation");
      }

      // Trip FK SET NULL on delete.
      const tripDel = seedTrip(dbHandle.db, "Doomed");
      const aDel = randomUUID();
      dbHandle.db
        .prepare(
          `INSERT INTO ai_invocations (id, trip_id, provider, model_name, request_type, status)
           VALUES (?, ?, 'p', 'm', 'image_ai_refine', 'success')`,
        )
        .run(aDel, tripDel);
      dbHandle.db.prepare(`DELETE FROM trips WHERE id=?`).run(tripDel);
      const after = dbHandle.db.prepare(`SELECT trip_id FROM ai_invocations WHERE id=?`).get(aDel) as {
        trip_id: string | null;
      };
      record(
        "fresh: ON DELETE SET NULL on trip_id fires",
        after.trip_id === null,
        `trip_id=${String(after.trip_id)}`,
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
  // CASE B: upgrade — apply 000..023, seed legacy ai rows, then 024.
  // ===================================================================
  {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-mig024-upgrade-"));
    const dbHandle = openDatabase(path.join(tmpRoot, "upgrade.db"));
    try {
      const all = listMigrationFiles();
      const idx = all.indexOf(TARGET);
      record("upgrade: 024 present in migrations dir", idx >= 0, `idx=${idx}`);
      ensureTracking(dbHandle.db);
      for (const name of all.slice(0, idx)) {
        await execTracked(dbHandle.db, name);
      }

      const tripId = seedTrip(dbHandle.db, "Upgrade B");
      const mediaId = seedMedia(dbHandle.db, tripId);
      const legacySuccess = seedLegacyAi(dbHandle.db, mediaId, "image_ai_refine", "success");
      const legacyFailed = seedLegacyAi(dbHandle.db, mediaId, "image_ai_refine", "failed");

      await execTracked(dbHandle.db, TARGET);

      const r1 = dbHandle.db
        .prepare(`SELECT target_type, target_id, input_hash, trip_id FROM ai_invocations WHERE id=?`)
        .get(legacySuccess) as {
          target_type: string;
          target_id: string | null;
          input_hash: string | null;
          trip_id: string | null;
        };
      record(
        "upgrade: legacy row backfilled target_type='media' + target_id=media_id",
        r1.target_type === "media" && r1.target_id === mediaId,
        `target_type=${r1.target_type} target_id==media=${r1.target_id === mediaId}`,
      );
      record(
        "upgrade: legacy row trip_id/input_hash remain NULL",
        r1.trip_id === null && r1.input_hash === null,
        `trip_id=${String(r1.trip_id)} input_hash=${String(r1.input_hash)}`,
      );
      const r2 = dbHandle.db
        .prepare(`SELECT target_type, target_id FROM ai_invocations WHERE id=?`)
        .get(legacyFailed) as { target_type: string; target_id: string | null };
      record(
        "upgrade: 2nd legacy row also backfilled (target_type='media', target_id=media_id)",
        r2.target_type === "media" && r2.target_id === mediaId,
        `target_type=${r2.target_type} target_id==media=${r2.target_id === mediaId}`,
      );

      // Important: backfilled legacy success row has input_hash=NULL.
      // Partial UNIQUE on cost-cache treats NULLs as distinct, so a new
      // success row with input_hash=NULL must still be allowed (NULL ≠ NULL).
      let nullHashOk = true;
      try {
        dbHandle.db
          .prepare(
            `INSERT INTO ai_invocations (id, media_id, provider, model_name, request_type, status)
             VALUES (?, ?, 'p', 'm', 'image_ai_refine', 'success')`,
          )
          .run(randomUUID(), mediaId);
      } catch (err) {
        nullHashOk = false;
        record("upgrade: NULL input_hash doesn't trigger UNIQUE", false, describeError(err));
      }
      if (nullHashOk) {
        record("upgrade: NULL input_hash doesn't trigger UNIQUE", true, "no violation");
      }

      const count = (dbHandle.db.prepare(`SELECT COUNT(*) n FROM ai_invocations`).get() as { n: number }).n;
      record("upgrade: ai_invocations row count preserved (2 legacy + 1 new)", count === 3, `count=${count}`);

      const fk = dbHandle.db.prepare(`PRAGMA foreign_key_check`).all() as unknown[];
      record("upgrade: foreign_key_check clean", fk.length === 0, `len=${fk.length}`);
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
