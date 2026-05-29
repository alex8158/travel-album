// Manual smoke test for migration 025 (P12.T3 — ADDITIVE ONLY).
//
// Usage: npm run smoke:migration-025
//
// Verifies the additive-only rebuild of media_versions:
//   * Fresh DB: 000..025 apply cleanly.
//   * Three new columns exist (params_hash NULLable, is_active NOT NULL
//     DEFAULT 1, deleted_at NULLable) and is_active CHECK in (0,1).
//   * version_type CHECK accepts ALL 13 values, including the three new
//     P12.T3 values: ai_refined_param / final_composition / slideshow.
//   * The pre-existing global UNIQUE (media_id, version_type) is PRESERVED
//     byte-for-byte under its old name idx_media_versions_media_version
//     (so MediaVersionsRepository.upsert's ON CONFLICT(media_id,
//     version_type) keeps prepare()-ing). All 4 indexes from 005/016
//     present, no partial-unique indexes introduced.
//   * Upgrade path (apply 000..024, seed legacy media_versions rows + a
//     slideshow_renders link, apply 025): backfill is_active=1 /
//     params_hash=NULL / deleted_at=NULL on every existing row, row count
//     preserved, slideshow_renders.output_media_version_id linkage
//     PRESERVED across the rebuild.
//   * foreign_key_check + integrity_check clean.

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";

const TARGET = "025_extend_media_versions_v2.sql";

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

/** Insert a media_versions row in the PRE-025 shape (no new columns). */
function seedLegacyVersion(
  db: SqliteDatabase,
  mediaId: string,
  versionType: string,
  filePath: string,
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO media_versions (id, media_id, version_type, file_path, status)
     VALUES (?, ?, ?, ?, 'ready')`,
  ).run(id, mediaId, versionType, filePath);
  return id;
}

async function main(): Promise<void> {
  // ===================================================================
  // CASE A: fresh DB
  // ===================================================================
  {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-mig025-fresh-"));
    const dbHandle = openDatabase(path.join(tmpRoot, "fresh.db"));
    try {
      const res = runMigrations(dbHandle.db);
      record(
        "fresh: 025 in appliedNow",
        res.appliedNow.includes(TARGET),
        `last=${res.appliedNow.at(-1)}`,
      );

      const cols = dbHandle.db.prepare(`PRAGMA table_info(media_versions)`).all() as {
        name: string;
        notnull: number;
        dflt_value: string | null;
      }[];
      const byName = new Map(cols.map((c) => [c.name, c]));
      record(
        "fresh: 3 new columns present (params_hash/is_active/deleted_at)",
        ["params_hash", "is_active", "deleted_at"].every((c) => byName.has(c)),
        `cols=${cols.map((c) => c.name).join(",")}`,
      );
      record(
        "fresh: is_active NOT NULL DEFAULT 1",
        byName.get("is_active")?.notnull === 1 && byName.get("is_active")?.dflt_value === "1",
        `nn=${byName.get("is_active")?.notnull} dflt=${byName.get("is_active")?.dflt_value}`,
      );
      record(
        "fresh: params_hash / deleted_at are nullable",
        byName.get("params_hash")?.notnull === 0 && byName.get("deleted_at")?.notnull === 0,
        `nn params_hash=${byName.get("params_hash")?.notnull} deleted_at=${byName.get("deleted_at")?.notnull}`,
      );

      // ALL 4 indexes from 005/016 PRESERVED, plus the global unique kept
      // under its original name. No partial-unique indexes introduced.
      const idxRows = dbHandle.db.prepare(`PRAGMA index_list('media_versions')`).all() as {
        name: string;
        unique: number;
        partial: number;
      }[];
      const idxByName = new Map(idxRows.map((r) => [r.name, r]));
      const namedIdx = idxRows
        .map((r) => r.name)
        .filter((n) => !n.startsWith("sqlite_autoindex_"))
        .sort();
      const expectedIdx = [
        "idx_media_versions_file_path",
        "idx_media_versions_media_version",
        "idx_media_versions_status",
        "idx_media_versions_version_type",
      ].sort();
      record(
        "fresh: all 4 named indexes present (global unique preserved by name)",
        JSON.stringify(namedIdx) === JSON.stringify(expectedIdx),
        `idx=${JSON.stringify(namedIdx)}`,
      );
      const globUnique = idxByName.get("idx_media_versions_media_version");
      record(
        "fresh: idx_media_versions_media_version is UNIQUE and NON-partial (full unique)",
        globUnique?.unique === 1 && globUnique?.partial === 0,
        `unique=${globUnique?.unique} partial=${globUnique?.partial}`,
      );
      record(
        "fresh: no partial-unique indexes were introduced",
        idxRows.every((r) => r.partial === 0),
        `partials=${idxRows.filter((r) => r.partial !== 0).map((r) => r.name).join(",") || "none"}`,
      );

      const tripId = seedTrip(dbHandle.db, "Fresh A");

      // Accept ALL 13 enum values (each on its own media to dodge global unique).
      const enumValues = [
        "original",
        "thumbnail",
        "preview",
        "enhanced",
        "ai_refined",
        "video_cover",
        "video_proxy",
        "metadata",
        "video_optimized",
        "edited",
        "ai_refined_param",
        "final_composition",
        "slideshow",
      ];
      let accepted = 0;
      for (const vt of enumValues) {
        const m = seedMedia(dbHandle.db, tripId);
        try {
          dbHandle.db
            .prepare(
              `INSERT INTO media_versions (id, media_id, version_type, file_path, status)
               VALUES (?, ?, ?, ?, 'ready')`,
            )
            .run(randomUUID(), m, vt, `p/${vt}.bin`);
          accepted += 1;
        } catch (err) {
          record(`fresh: accept version_type='${vt}'`, false, describeError(err));
        }
      }
      record("fresh: all 13 version_type enum values accepted", accepted === 13, `accepted=${accepted}/13`);

      // CHECK rejects bogus.
      expectThrow(
        "fresh: version_type CHECK rejects 'bogus'",
        () => {
          const m = seedMedia(dbHandle.db, tripId);
          dbHandle.db
            .prepare(
              `INSERT INTO media_versions (id, media_id, version_type, file_path, status)
               VALUES (?, ?, 'bogus', 'p/x.bin', 'ready')`,
            )
            .run(randomUUID(), m);
        },
        /CHECK constraint failed/i,
      );

      // is_active CHECK rejects 2.
      expectThrow(
        "fresh: is_active CHECK rejects 2",
        () => {
          const m = seedMedia(dbHandle.db, tripId);
          dbHandle.db
            .prepare(
              `INSERT INTO media_versions (id, media_id, version_type, file_path, status, is_active)
               VALUES (?, ?, 'original', 'p/x.bin', 'ready', 2)`,
            )
            .run(randomUUID(), m);
        },
        /CHECK constraint failed/i,
      );

      // Global UNIQUE still rejects duplicate (media_id, version_type).
      const conflictMedia = seedMedia(dbHandle.db, tripId);
      dbHandle.db
        .prepare(
          `INSERT INTO media_versions (id, media_id, version_type, file_path, status)
           VALUES (?, ?, 'original', 'p/a.bin', 'ready')`,
        )
        .run(randomUUID(), conflictMedia);
      expectThrow(
        "fresh: global UNIQUE(media_id, version_type) still rejects duplicate",
        () =>
          dbHandle.db
            .prepare(
              `INSERT INTO media_versions (id, media_id, version_type, file_path, status)
               VALUES (?, ?, 'original', 'p/b.bin', 'ready')`,
            )
            .run(randomUUID(), conflictMedia),
        /UNIQUE constraint failed/i,
      );

      // ON CONFLICT(media_id, version_type) DO UPDATE — proves the old
      // MediaVersionsRepository upsert prepare()-able shape still works.
      let upsertOk = true;
      try {
        dbHandle.db
          .prepare(
            `INSERT INTO media_versions (id, media_id, version_type, file_path, status)
             VALUES (?, ?, 'original', 'p/c.bin', 'ready')
             ON CONFLICT(media_id, version_type) DO UPDATE SET file_path = excluded.file_path`,
          )
          .run(randomUUID(), conflictMedia);
      } catch (err) {
        upsertOk = false;
        record("fresh: ON CONFLICT(media_id, version_type) upsert still prepares + runs", false, describeError(err));
      }
      if (upsertOk) {
        const fp = (dbHandle.db
          .prepare(`SELECT file_path FROM media_versions WHERE media_id=? AND version_type='original'`)
          .get(conflictMedia) as { file_path: string }).file_path;
        record(
          "fresh: ON CONFLICT(media_id, version_type) upsert still prepares + runs",
          fp === "p/c.bin",
          `file_path=${fp}`,
        );
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
  // CASE B: upgrade — apply 000..024, seed legacy versions + ssr link,
  //         apply 025. Verify backfill + linkage preservation.
  // ===================================================================
  {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-mig025-upgrade-"));
    const dbHandle = openDatabase(path.join(tmpRoot, "upgrade.db"));
    try {
      const all = listMigrationFiles();
      const idx = all.indexOf(TARGET);
      record("upgrade: 025 present in migrations dir", idx >= 0, `idx=${idx}`);
      ensureTracking(dbHandle.db);
      for (const name of all.slice(0, idx)) {
        await execTracked(dbHandle.db, name);
      }

      const tripId = seedTrip(dbHandle.db, "Upgrade B");
      const mediaId = seedMedia(dbHandle.db, tripId);
      const v1 = seedLegacyVersion(dbHandle.db, mediaId, "original", "p/o.jpg");
      const v2 = seedLegacyVersion(dbHandle.db, mediaId, "thumbnail", "p/t.jpg");

      // Wire one slideshow_renders → media_versions linkage so we can
      // verify the rebuild's snapshot/restore preserved it. We must
      // supply every NOT-NULL-without-default column (input_media_ids,
      // per_image_duration_sec, transition_type, transition_duration_sec,
      // output_resolution, output_fps, audio_policy).
      const ssrId = randomUUID();
      dbHandle.db
        .prepare(
          `INSERT INTO slideshow_renders (
             id, trip_id, status,
             input_media_ids, per_image_duration_sec, transition_type,
             transition_duration_sec, output_resolution, output_fps,
             audio_policy, output_media_version_id
           ) VALUES (?, ?, 'success', ?, 3.0, 'xfade', 0.5, '1920x1080', 30, 'mute', ?)`,
        )
        .run(ssrId, tripId, JSON.stringify([mediaId]), v1);

      await execTracked(dbHandle.db, TARGET);

      const r1 = dbHandle.db
        .prepare(`SELECT params_hash, is_active, deleted_at FROM media_versions WHERE id=?`)
        .get(v1) as { params_hash: string | null; is_active: number; deleted_at: string | null };
      const r2 = dbHandle.db
        .prepare(`SELECT params_hash, is_active, deleted_at FROM media_versions WHERE id=?`)
        .get(v2) as { params_hash: string | null; is_active: number; deleted_at: string | null };
      record(
        "upgrade: legacy v1 backfilled (is_active=1, params_hash=NULL, deleted_at=NULL)",
        r1.is_active === 1 && r1.params_hash === null && r1.deleted_at === null,
        `is_active=${r1.is_active} params_hash=${String(r1.params_hash)} deleted_at=${String(r1.deleted_at)}`,
      );
      record(
        "upgrade: legacy v2 backfilled (is_active=1, params_hash=NULL, deleted_at=NULL)",
        r2.is_active === 1 && r2.params_hash === null && r2.deleted_at === null,
        `is_active=${r2.is_active} params_hash=${String(r2.params_hash)} deleted_at=${String(r2.deleted_at)}`,
      );

      const count = (dbHandle.db.prepare(`SELECT COUNT(*) n FROM media_versions`).get() as { n: number }).n;
      record("upgrade: media_versions row count preserved (2)", count === 2, `count=${count}`);

      // No row should have is_active=NULL (NOT NULL backfill).
      const nullActiveCount = (dbHandle.db
        .prepare(`SELECT COUNT(*) n FROM media_versions WHERE is_active IS NULL`)
        .get() as { n: number }).n;
      record(
        "upgrade: NO row has NULL is_active (NOT NULL satisfied)",
        nullActiveCount === 0,
        `null_is_active_count=${nullActiveCount}`,
      );

      // Critical: slideshow_renders.output_media_version_id link PRESERVED.
      const ssrAfter = dbHandle.db
        .prepare(`SELECT output_media_version_id FROM slideshow_renders WHERE id=?`)
        .get(ssrId) as { output_media_version_id: string | null };
      record(
        "upgrade: slideshow_renders.output_media_version_id linkage PRESERVED across rebuild",
        ssrAfter.output_media_version_id === v1,
        `output_media_version_id=${String(ssrAfter.output_media_version_id)} (expected ${v1})`,
      );

      // SET NULL still fires after rebuild.
      dbHandle.db.prepare(`DELETE FROM media_versions WHERE id=?`).run(v1);
      const ssrAfterDel = dbHandle.db
        .prepare(`SELECT output_media_version_id FROM slideshow_renders WHERE id=?`)
        .get(ssrId) as { output_media_version_id: string | null };
      record(
        "upgrade: ON DELETE SET NULL on output_media_version_id still works post-rebuild",
        ssrAfterDel.output_media_version_id === null,
        `output_media_version_id=${String(ssrAfterDel.output_media_version_id)}`,
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
