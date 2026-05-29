// Manual smoke test for migration 026 (P12.T3).
//
// Usage: npm run smoke:migration-026
//
// Verifies the two ALTER ADD COLUMNs on media_analysis:
//   * Fresh DB: 000..026 apply cleanly.
//   * ai_blur_class column present, DEFAULT 'unknown', CHECK ∈
//     {sharp, maybe_blurry, blurry, unknown, NULL}.
//   * ai_blur_reason column present, nullable, no CHECK.
//   * Omitted ai_blur_class on INSERT defaults to 'unknown'.
//   * Upgrade path (apply 000..025, seed legacy media_analysis row,
//     apply 026): existing row keeps its data, ai_blur_class lands on
//     DEFAULT 'unknown' (column DEFAULT applies to existing rows because
//     SQLite ADD COLUMN with non-NULL DEFAULT virtualises the default
//     for absent rows), ai_blur_reason is NULL.
//   * Existing repository upsert pattern (`ON CONFLICT(media_id) DO
//     UPDATE`) still works — proves we did not touch the unique on
//     media_id.
//   * foreign_key_check + integrity_check clean.

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";

const TARGET = "026_extend_media_analysis_ai_blur.sql";

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

/** Insert a media_analysis row in the PRE-026 shape (no new columns). */
function seedLegacyAnalysis(
  db: SqliteDatabase,
  mediaId: string,
  reason: string,
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO media_analysis (id, media_id, blur_score, is_blurry, reason)
     VALUES (?, ?, 0.5, 0, ?)`,
  ).run(id, mediaId, reason);
  return id;
}

async function main(): Promise<void> {
  // ===================================================================
  // CASE A: fresh DB
  // ===================================================================
  {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-mig026-fresh-"));
    const dbHandle = openDatabase(path.join(tmpRoot, "fresh.db"));
    try {
      const res = runMigrations(dbHandle.db);
      record(
        "fresh: 026 in appliedNow",
        res.appliedNow.includes(TARGET),
        `last=${res.appliedNow.at(-1)}`,
      );

      const cols = dbHandle.db.prepare(`PRAGMA table_info(media_analysis)`).all() as {
        name: string;
        notnull: number;
        dflt_value: string | null;
      }[];
      const byName = new Map(cols.map((c) => [c.name, c]));
      record(
        "fresh: ai_blur_class column present, DEFAULT 'unknown'",
        byName.has("ai_blur_class") &&
          (byName.get("ai_blur_class")?.dflt_value ?? "").includes("unknown"),
        `dflt=${byName.get("ai_blur_class")?.dflt_value}`,
      );
      record(
        "fresh: ai_blur_reason column present, nullable",
        byName.has("ai_blur_reason") && byName.get("ai_blur_reason")?.notnull === 0,
        `nn=${byName.get("ai_blur_reason")?.notnull}`,
      );
      // ai_blur_class is NULLable in the column definition; the CHECK
      // admits NULL.
      record(
        "fresh: ai_blur_class is nullable (CHECK admits NULL)",
        byName.get("ai_blur_class")?.notnull === 0,
        `nn=${byName.get("ai_blur_class")?.notnull}`,
      );

      const tripId = seedTrip(dbHandle.db, "Fresh A");
      const mediaId = seedMedia(dbHandle.db, tripId);

      // INSERT omitting ai_blur_class — defaults to 'unknown'.
      const anaId = randomUUID();
      dbHandle.db
        .prepare(
          `INSERT INTO media_analysis (id, media_id, blur_score, is_blurry, reason)
           VALUES (?, ?, 0.5, 0, 'fresh insert')`,
        )
        .run(anaId, mediaId);
      const row = dbHandle.db
        .prepare(`SELECT ai_blur_class, ai_blur_reason FROM media_analysis WHERE id=?`)
        .get(anaId) as { ai_blur_class: string; ai_blur_reason: string | null };
      record(
        "fresh: omitted ai_blur_class defaults to 'unknown'",
        row.ai_blur_class === "unknown",
        `ai_blur_class=${row.ai_blur_class}`,
      );
      record(
        "fresh: ai_blur_reason starts as NULL when omitted",
        row.ai_blur_reason === null,
        `ai_blur_reason=${String(row.ai_blur_reason)}`,
      );

      // CHECK rejects bogus.
      const mediaForBogus = seedMedia(dbHandle.db, tripId);
      expectThrow(
        "fresh: ai_blur_class CHECK rejects 'bogus'",
        () =>
          dbHandle.db
            .prepare(
              `INSERT INTO media_analysis (id, media_id, blur_score, is_blurry, reason, ai_blur_class)
               VALUES (?, ?, 0.5, 0, 'r', 'bogus')`,
            )
            .run(randomUUID(), mediaForBogus),
        /CHECK constraint failed/i,
      );

      // CHECK accepts all 4 enum values.
      let accepted = 0;
      for (const cls of ["sharp", "maybe_blurry", "blurry", "unknown"]) {
        const m = seedMedia(dbHandle.db, tripId);
        try {
          dbHandle.db
            .prepare(
              `INSERT INTO media_analysis (id, media_id, blur_score, is_blurry, reason, ai_blur_class, ai_blur_reason)
               VALUES (?, ?, 0.5, 0, 'r', ?, 'some justification')`,
            )
            .run(randomUUID(), m, cls);
          accepted += 1;
        } catch (err) {
          record(`fresh: accept ai_blur_class='${cls}'`, false, describeError(err));
        }
      }
      record("fresh: all 4 ai_blur_class enum values accepted", accepted === 4, `accepted=${accepted}/4`);

      // CHECK admits NULL (explicit).
      const mNull = seedMedia(dbHandle.db, tripId);
      let nullOk = true;
      try {
        dbHandle.db
          .prepare(
            `INSERT INTO media_analysis (id, media_id, blur_score, is_blurry, reason, ai_blur_class)
             VALUES (?, ?, 0.5, 0, 'r', NULL)`,
          )
          .run(randomUUID(), mNull);
      } catch (err) {
        nullOk = false;
        record("fresh: ai_blur_class CHECK admits explicit NULL", false, describeError(err));
      }
      if (nullOk) {
        record("fresh: ai_blur_class CHECK admits explicit NULL", true, "ok");
      }

      // Existing ON CONFLICT(media_id) upsert (MediaAnalysisRepository
      // pattern) still works — proves the unique on media_id was not
      // disturbed by ADD COLUMN.
      let upsertOk = true;
      try {
        dbHandle.db
          .prepare(
            `INSERT INTO media_analysis (id, media_id, blur_score, is_blurry, reason)
             VALUES (?, ?, 0.8, 1, 'upsert refresh')
             ON CONFLICT(media_id) DO UPDATE SET blur_score=excluded.blur_score`,
          )
          .run(randomUUID(), mediaId);
      } catch (err) {
        upsertOk = false;
        record("fresh: ON CONFLICT(media_id) DO UPDATE still works", false, describeError(err));
      }
      if (upsertOk) {
        record("fresh: ON CONFLICT(media_id) DO UPDATE still works", true, "no error");
      }

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
  // CASE B: upgrade — apply 000..025, seed legacy analysis, apply 026.
  // ===================================================================
  {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-mig026-upgrade-"));
    const dbHandle = openDatabase(path.join(tmpRoot, "upgrade.db"));
    try {
      const all = listMigrationFiles();
      const idx = all.indexOf(TARGET);
      record("upgrade: 026 present in migrations dir", idx >= 0, `idx=${idx}`);
      ensureTracking(dbHandle.db);
      for (const name of all.slice(0, idx)) {
        await execTracked(dbHandle.db, name);
      }

      const tripId = seedTrip(dbHandle.db, "Upgrade B");
      const mediaId = seedMedia(dbHandle.db, tripId);
      const anaId = seedLegacyAnalysis(dbHandle.db, mediaId, "legacy reason");

      await execTracked(dbHandle.db, TARGET);

      const after = dbHandle.db
        .prepare(`SELECT reason, ai_blur_class, ai_blur_reason FROM media_analysis WHERE id=?`)
        .get(anaId) as { reason: string; ai_blur_class: string; ai_blur_reason: string | null };
      record(
        "upgrade: legacy reason preserved (no data loss)",
        after.reason === "legacy reason",
        `reason=${after.reason}`,
      );
      record(
        "upgrade: legacy row sees DEFAULT ai_blur_class='unknown'",
        after.ai_blur_class === "unknown",
        `ai_blur_class=${after.ai_blur_class}`,
      );
      record(
        "upgrade: legacy ai_blur_reason is NULL",
        after.ai_blur_reason === null,
        `ai_blur_reason=${String(after.ai_blur_reason)}`,
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
