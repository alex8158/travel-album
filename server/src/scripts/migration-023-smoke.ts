// Manual smoke test for migration 023 (P12.T3).
//
// Usage: npm run smoke:migration-023
//
// Verifies the schema-level acceptance points for the processing_jobs
// multi-target rebuild:
//   * Fresh DB: 000..023 apply cleanly in one boot.
//   * The four new columns exist (trip_id / target_type / target_id /
//     dedupe_key); media_id is RELAXED to nullable.
//   * target_type CHECK accepts the 6 enum values and rejects others;
//     DEFAULT 'media' applies when omitted.
//   * dedupe_key is NOT NULL with a random DEFAULT: an INSERT that omits
//     it (as the untouched jobRepository does) still succeeds and gets a
//     unique value — two such inserts do NOT collide.
//   * The UNIQUE (job_type, target_type, target_id, dedupe_key) index
//     rejects an explicit duplicate.
//   * The original 4 indexes + 3 new indexes all exist.
//   * Upgrade path (apply 000..022, seed legacy rows + ai_invocations
//     linkage, then apply 023): backfill is correct
//     (target_type='media', target_id=media_id, dedupe_key=id), two legacy
//     jobs on the same media+type do NOT collide, and the
//     ai_invocations.job_id → processing_jobs linkage is PRESERVED across
//     the rebuild (snapshot/restore).
//   * foreign_key_check + integrity_check clean.

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";

const TARGET = "023_extend_processing_jobs_multi_target.sql";

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

/** Insert a processing_jobs row in the PRE-023 shape (no target columns). */
function seedLegacyJob(db: SqliteDatabase, mediaId: string, jobType: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO processing_jobs (id, media_id, job_type, status, payload, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', NULL, ?, ?)`,
  ).run(id, mediaId, jobType, now, now);
  return id;
}

async function main(): Promise<void> {
  // ===================================================================
  // CASE A: fresh DB — schema shape, constraints, defaults, indexes.
  // ===================================================================
  {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-mig023-fresh-"));
    const dbHandle = openDatabase(path.join(tmpRoot, "fresh.db"));
    try {
      const res = runMigrations(dbHandle.db);
      record("fresh: 023 in appliedNow", res.appliedNow.includes(TARGET), `last=${res.appliedNow.at(-1)}`);

      const cols = dbHandle.db.prepare(`PRAGMA table_info(processing_jobs)`).all() as {
        name: string;
        notnull: number;
      }[];
      const byName = new Map(cols.map((c) => [c.name, c]));
      record(
        "fresh: 4 new columns present (trip_id/target_type/target_id/dedupe_key)",
        ["trip_id", "target_type", "target_id", "dedupe_key"].every((c) => byName.has(c)),
        `cols=${cols.map((c) => c.name).join(",")}`,
      );
      record(
        "fresh: media_id relaxed to nullable",
        byName.get("media_id")?.notnull === 0,
        `media_id.notnull=${byName.get("media_id")?.notnull}`,
      );
      record(
        "fresh: target_type/dedupe_key are NOT NULL",
        byName.get("target_type")?.notnull === 1 && byName.get("dedupe_key")?.notnull === 1,
        `target_type.notnull=${byName.get("target_type")?.notnull} dedupe_key.notnull=${byName.get("dedupe_key")?.notnull}`,
      );
      record(
        "fresh: target_id is nullable (design §9.1)",
        byName.get("target_id")?.notnull === 0,
        `target_id.notnull=${byName.get("target_id")?.notnull}`,
      );

      const idxNames = (dbHandle.db.prepare(`PRAGMA index_list('processing_jobs')`).all() as {
        name: string;
      }[])
        .map((r) => r.name)
        .filter((n) => !n.startsWith("sqlite_autoindex_"))
        .sort();
      const expectedIdx = [
        "idx_processing_jobs_status",
        "idx_processing_jobs_job_type",
        "idx_processing_jobs_media_id",
        "idx_processing_jobs_started_at",
        "idx_processing_jobs_trip_id",
        "idx_processing_jobs_target",
        "idx_processing_jobs_dedupe",
      ].sort();
      record(
        "fresh: 7 named indexes present (4 original + 3 new)",
        JSON.stringify(idxNames) === JSON.stringify(expectedIdx),
        `idx=${JSON.stringify(idxNames)}`,
      );

      const tripId = seedTrip(dbHandle.db, "Fresh A");
      const mediaId = seedMedia(dbHandle.db, tripId);

      // INSERT omitting target_type + dedupe_key (simulates untouched
      // jobRepository) — must succeed with defaults.
      const j1 = randomUUID();
      const j2 = randomUUID();
      const now = new Date().toISOString();
      const insOmit = dbHandle.db.prepare(
        `INSERT INTO processing_jobs (id, media_id, job_type, status, created_at, updated_at)
         VALUES (?, ?, 'image_thumbnail', 'pending', ?, ?)`,
      );
      insOmit.run(j1, mediaId, now, now);
      insOmit.run(j2, mediaId, now, now);
      const row1 = dbHandle.db.prepare(`SELECT target_type, dedupe_key FROM processing_jobs WHERE id=?`).get(j1) as {
        target_type: string;
        dedupe_key: string;
      };
      const row2 = dbHandle.db.prepare(`SELECT dedupe_key FROM processing_jobs WHERE id=?`).get(j2) as {
        dedupe_key: string;
      };
      record(
        "fresh: omitted target_type defaults to 'media'",
        row1.target_type === "media",
        `target_type=${row1.target_type}`,
      );
      record(
        "fresh: omitted dedupe_key gets a unique random value (no collision for 2 same-media+type jobs)",
        row1.dedupe_key.length === 32 && row2.dedupe_key.length === 32 && row1.dedupe_key !== row2.dedupe_key,
        `dk1=${row1.dedupe_key.slice(0, 8)} dk2=${row2.dedupe_key.slice(0, 8)}`,
      );

      // target_type CHECK
      expectThrow(
        "fresh: target_type CHECK rejects 'bogus'",
        () =>
          dbHandle.db
            .prepare(
              `INSERT INTO processing_jobs (id, target_type, target_id, dedupe_key, job_type, status, created_at, updated_at)
               VALUES (?, 'bogus', 't', 'k', 'jt', 'pending', ?, ?)`,
            )
            .run(randomUUID(), now, now),
        /CHECK constraint failed/i,
      );

      // accept all 6 enum values (trip job has NULL media_id — allowed now)
      let accepted = 0;
      for (const tt of ["media", "trip", "audio", "composition", "slideshow", "scene_group"]) {
        try {
          dbHandle.db
            .prepare(
              `INSERT INTO processing_jobs (id, trip_id, target_type, target_id, dedupe_key, job_type, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 'jt', 'pending', ?, ?)`,
            )
            .run(randomUUID(), tt === "trip" ? tripId : null, tt, `tgt-${tt}`, `dk-${tt}`, now, now);
          accepted += 1;
        } catch (err) {
          record(`fresh: accept target_type='${tt}'`, false, describeError(err));
        }
      }
      record("fresh: all 6 target_type enum values accepted", accepted === 6, `accepted=${accepted}/6`);

      // UNIQUE (job_type, target_type, target_id, dedupe_key)
      dbHandle.db
        .prepare(
          `INSERT INTO processing_jobs (id, target_type, target_id, dedupe_key, job_type, status, created_at, updated_at)
           VALUES (?, 'trip', 'T1', 'r1', 'curation_run', 'pending', ?, ?)`,
        )
        .run(randomUUID(), now, now);
      expectThrow(
        "fresh: UNIQUE(job_type,target_type,target_id,dedupe_key) rejects duplicate",
        () =>
          dbHandle.db
            .prepare(
              `INSERT INTO processing_jobs (id, target_type, target_id, dedupe_key, job_type, status, created_at, updated_at)
               VALUES (?, 'trip', 'T1', 'r1', 'curation_run', 'pending', ?, ?)`,
            )
            .run(randomUUID(), now, now),
        /UNIQUE constraint failed/i,
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
  // CASE B: upgrade — apply 000..022, seed legacy rows + ai linkage,
  //         then apply 023. Verify backfill + linkage preservation.
  // ===================================================================
  {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-mig023-upgrade-"));
    const dbHandle = openDatabase(path.join(tmpRoot, "upgrade.db"));
    try {
      const all = listMigrationFiles();
      const idx = all.indexOf(TARGET);
      record("upgrade: 023 present in migrations dir", idx >= 0, `idx=${idx}`);
      ensureTracking(dbHandle.db);
      for (const name of all.slice(0, idx)) {
        await execTracked(dbHandle.db, name);
      }

      const tripId = seedTrip(dbHandle.db, "Upgrade B");
      const mediaId = seedMedia(dbHandle.db, tripId);
      // Two legacy jobs on the SAME media + SAME job_type — these would
      // collide if backfill used {mediaId}:{jobType}; using id avoids it.
      const jobA = seedLegacyJob(dbHandle.db, mediaId, "image_thumbnail");
      const jobB = seedLegacyJob(dbHandle.db, mediaId, "image_thumbnail");

      // ai_invocations row linked to jobA — its job_id must survive the rebuild.
      const aiId = randomUUID();
      dbHandle.db
        .prepare(
          `INSERT INTO ai_invocations (id, media_id, job_id, provider, model_name, request_type, status)
           VALUES (?, ?, ?, 'local-mock', 'm', 'image_ai_refine', 'success')`,
        )
        .run(aiId, mediaId, jobA);

      // Apply 023 only.
      await execTracked(dbHandle.db, TARGET);

      const rowA = dbHandle.db
        .prepare(`SELECT target_type, target_id, dedupe_key FROM processing_jobs WHERE id=?`)
        .get(jobA) as { target_type: string; target_id: string; dedupe_key: string };
      const rowB = dbHandle.db
        .prepare(`SELECT dedupe_key FROM processing_jobs WHERE id=?`)
        .get(jobB) as { dedupe_key: string };
      record(
        "upgrade: legacy row backfilled target_type='media' + target_id=media_id + dedupe_key=id",
        rowA.target_type === "media" && rowA.target_id === mediaId && rowA.dedupe_key === jobA,
        `target_type=${rowA.target_type} target_id==media=${rowA.target_id === mediaId} dedupe==id=${rowA.dedupe_key === jobA}`,
      );
      record(
        "upgrade: two same-media+type legacy jobs got distinct dedupe_keys (=their ids)",
        rowA.dedupe_key === jobA && rowB.dedupe_key === jobB && jobA !== jobB,
        `dkA==idA=${rowA.dedupe_key === jobA} dkB==idB=${rowB.dedupe_key === jobB}`,
      );

      const aiAfter = dbHandle.db.prepare(`SELECT job_id FROM ai_invocations WHERE id=?`).get(aiId) as {
        job_id: string | null;
      };
      record(
        "upgrade: ai_invocations.job_id linkage PRESERVED across processing_jobs rebuild",
        aiAfter.job_id === jobA,
        `job_id=${String(aiAfter.job_id)} (expected ${jobA})`,
      );

      const count = (dbHandle.db.prepare(`SELECT COUNT(*) n FROM processing_jobs`).get() as { n: number }).n;
      record("upgrade: processing_jobs row count preserved (2)", count === 2, `count=${count}`);

      const fk = dbHandle.db.prepare(`PRAGMA foreign_key_check`).all() as unknown[];
      record("upgrade: foreign_key_check clean", fk.length === 0, `len=${fk.length}`);

      // SET NULL still fires after rebuild: delete jobA → ai_invocations.job_id NULL.
      dbHandle.db.prepare(`DELETE FROM processing_jobs WHERE id=?`).run(jobA);
      const aiAfterDel = dbHandle.db.prepare(`SELECT job_id FROM ai_invocations WHERE id=?`).get(aiId) as {
        job_id: string | null;
      };
      record(
        "upgrade: ON DELETE SET NULL on job_id still works post-rebuild",
        aiAfterDel.job_id === null,
        `job_id=${String(aiAfterDel.job_id)}`,
      );
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
