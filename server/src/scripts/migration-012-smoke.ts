// Manual smoke test for migration 012 (P10.T1).
//
// Usage: npm run smoke:migration-012
//
// Verifies the schema-level acceptance points for the migration:
//   * Fresh DB: 000..012 apply cleanly in one boot.
//   * Existing DB stopped at 011: upgrading to 012 adds the
//     `ai_invocations` table without disturbing any prior tables
//     or seeded data.
//   * After upgrade, `ai_invocations` exists with the documented
//     columns, defaults, CHECK constraints, FKs, and indexes.
//   * Re-running migrate is a no-op (012 already applied).
//   * Rows can be inserted; CHECK constraints reject bad enum
//     values; FK SET NULL fires when the parent media / job rows
//     are deleted (audit row survives — design.md §4.2).
//   * Pre-existing tables (media_items / processing_jobs / etc.)
//     are untouched by the migration.
//   * `foreign_key_check` + `integrity_check` clean post-upgrade.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

function seedTripAndImage(
  db: SqliteDatabase,
  tripTitle = "P10.T1 Smoke Trip",
): { tripId: string; mediaId: string } {
  const tripId = randomUUID();
  const mediaId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO trips (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
    tripId,
    tripTitle,
    now,
    now,
  );
  db.prepare(
    `INSERT INTO media_items
       (id, trip_id, type, original_path, mime_type, extension, file_size,
        status, user_decision, created_at, updated_at)
     VALUES (?, ?, 'image', ?, 'image/jpeg', 'jpg', 4096,
             'processed', 'undecided', ?, ?)`,
  ).run(mediaId, tripId, `trips/${tripId}/originals/${mediaId}.jpg`, now, now);
  return { tripId, mediaId };
}

function seedJob(db: SqliteDatabase, mediaId: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO processing_jobs (id, media_id, job_type, status, created_at, updated_at)
     VALUES (?, ?, 'image_ai_refine', 'pending', ?, ?)`,
  ).run(id, mediaId, now, now);
  return id;
}

interface InsertInvocationArgs {
  readonly mediaId?: string | null;
  readonly jobId?: string | null;
  readonly provider?: string;
  readonly modelName?: string;
  readonly requestType?: string;
  readonly status?: string;
  readonly costEstimate?: number | null;
  readonly durationMs?: number | null;
  readonly errorMessage?: string | null;
  readonly requestParams?: string | null;
  readonly responseSummary?: string | null;
}

function insertInvocation(db: SqliteDatabase, args: InsertInvocationArgs = {}): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO ai_invocations
       (id, media_id, job_id, provider, model_name, request_type,
        request_params, status, response_summary, cost_estimate,
        duration_ms, error_message)
     VALUES (?, ?, ?, ?, ?, ?,
             ?, ?, ?, ?,
             ?, ?)`,
  ).run(
    id,
    args.mediaId ?? null,
    args.jobId ?? null,
    args.provider ?? "noop",
    args.modelName ?? "noop-v1",
    args.requestType ?? "image_ai_refine",
    args.requestParams ?? null,
    args.status ?? "pending",
    args.responseSummary ?? null,
    args.costEstimate ?? null,
    args.durationMs ?? null,
    args.errorMessage ?? null,
  );
  return id;
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // ===================================================================
  // CASE GROUP A: fresh DB applies 000..012 in one shot
  // ===================================================================
  {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-mig012-fresh-"));
    const dbPath = path.join(tmpRoot, "fresh.db");
    const dbHandle = openDatabase(dbPath);
    try {
      const result = runMigrations(dbHandle.db);
      record(
        "fresh: 012 included in appliedNow",
        result.appliedNow.includes("012_create_ai_invocations.sql"),
        `appliedNow=${JSON.stringify(result.appliedNow.slice(-3))}`,
      );
      record(
        "fresh: totalFiles >= 13 (000..012)",
        result.totalFiles >= 13,
        `totalFiles=${result.totalFiles}`,
      );

      // ---------------- ai_invocations: schema ----------------
      const cols = dbHandle.db.prepare(`PRAGMA table_info(ai_invocations)`).all() as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }[];
      const colNames = cols.map((c) => c.name);
      const expectedCols = [
        "id",
        "media_id",
        "job_id",
        "provider",
        "model_name",
        "request_type",
        "request_params",
        "status",
        "response_summary",
        "cost_estimate",
        "duration_ms",
        "error_message",
        "created_at",
        "updated_at",
      ];
      record(
        "fresh: ai_invocations has 14 columns in spec order",
        JSON.stringify(colNames) === JSON.stringify(expectedCols),
        `columns=${JSON.stringify(colNames)}`,
      );

      const idCol = cols.find((c) => c.name === "id");
      const mediaCol = cols.find((c) => c.name === "media_id");
      const jobCol = cols.find((c) => c.name === "job_id");
      const providerCol = cols.find((c) => c.name === "provider");
      const modelCol = cols.find((c) => c.name === "model_name");
      const reqTypeCol = cols.find((c) => c.name === "request_type");
      const statusCol = cols.find((c) => c.name === "status");
      const createdCol = cols.find((c) => c.name === "created_at");
      const updatedCol = cols.find((c) => c.name === "updated_at");
      record(
        "fresh: id is PRIMARY KEY NOT NULL",
        idCol?.pk === 1 && idCol?.notnull === 1,
        `id=${JSON.stringify(idCol)}`,
      );
      record(
        "fresh: media_id + job_id are NULLABLE (audit FK SET NULL)",
        mediaCol?.notnull === 0 && jobCol?.notnull === 0,
        `media.notnull=${mediaCol?.notnull} job.notnull=${jobCol?.notnull}`,
      );
      record(
        "fresh: provider + model_name + request_type are NOT NULL",
        providerCol?.notnull === 1 && modelCol?.notnull === 1 && reqTypeCol?.notnull === 1,
        `p=${providerCol?.notnull} m=${modelCol?.notnull} r=${reqTypeCol?.notnull}`,
      );
      record(
        "fresh: status NOT NULL DEFAULT='pending'",
        statusCol?.notnull === 1 && statusCol?.dflt_value === "'pending'",
        `status.dflt=${String(statusCol?.dflt_value)}`,
      );
      record(
        "fresh: created_at + updated_at NOT NULL with DEFAULTs",
        createdCol?.notnull === 1 &&
          createdCol?.dflt_value !== null &&
          updatedCol?.notnull === 1 &&
          updatedCol?.dflt_value !== null,
        `created.dflt=${String(createdCol?.dflt_value)?.slice(0, 20)}…`,
      );

      // ---------------- indexes ----------------
      const idxs = dbHandle.db
        .prepare(`PRAGMA index_list(ai_invocations)`)
        .all() as { name: string; unique: number }[];
      const idxNames = idxs.map((i) => i.name).sort();
      record(
        "fresh: 4 named indexes present (created_at / media_id / job_id / provider_model)",
        ["idx_ai_invocations_created_at", "idx_ai_invocations_job_id", "idx_ai_invocations_media_id", "idx_ai_invocations_provider_model"].every(
          (n) => idxNames.includes(n),
        ),
        `indexes=${JSON.stringify(idxNames)}`,
      );

      // ---------------- foreign_key_check / integrity_check ----------------
      const fkCheck = dbHandle.db.prepare(`PRAGMA foreign_key_check`).all();
      record(
        "fresh: PRAGMA foreign_key_check is clean (no FK violations)",
        Array.isArray(fkCheck) && fkCheck.length === 0,
        `rows=${JSON.stringify(fkCheck)}`,
      );
      const integ = dbHandle.db.prepare(`PRAGMA integrity_check`).all() as {
        integrity_check: string;
      }[];
      record(
        "fresh: PRAGMA integrity_check returns 'ok'",
        integ.length === 1 && integ[0]?.integrity_check === "ok",
        `result=${JSON.stringify(integ)}`,
      );

      // ---------------- INSERT happy paths ----------------
      const seeded = seedTripAndImage(dbHandle.db);
      const jobId = seedJob(dbHandle.db, seeded.mediaId);

      const happyId = insertInvocation(dbHandle.db, {
        mediaId: seeded.mediaId,
        jobId,
        provider: "noop",
        modelName: "noop-v1",
        requestType: "image_ai_refine",
        status: "pending",
      });
      record(
        "fresh: INSERT with valid enums + FKs succeeds",
        typeof happyId === "string" && happyId.length === 36,
        `id=${happyId}`,
      );

      // All 6 request_type values + 3 status values accepted.
      const allRequestTypes = [
        "image_ai_refine",
        "ai_caption",
        "ai_classify",
        "aesthetic_score",
        "video_plan",
        "ranking",
      ] as const;
      for (const reqType of allRequestTypes) {
        insertInvocation(dbHandle.db, { requestType: reqType, mediaId: seeded.mediaId });
      }
      const allStatuses = ["pending", "success", "failed"] as const;
      for (const status of allStatuses) {
        insertInvocation(dbHandle.db, { status, mediaId: seeded.mediaId });
      }
      const allRowCount = (
        dbHandle.db
          .prepare(`SELECT COUNT(*) AS n FROM ai_invocations WHERE media_id = ?`)
          .get(seeded.mediaId) as { n: number }
      ).n;
      record(
        "fresh: all 6 request_type + 3 status enum values accepted (10 rows total incl. happy)",
        allRowCount === 10,
        `rows=${allRowCount}`,
      );

      // INSERT with NULL media_id / NULL job_id (pre-attached audit row).
      insertInvocation(dbHandle.db, { mediaId: null, jobId: null });
      record(
        "fresh: INSERT with NULL media_id + NULL job_id succeeds (audit-only)",
        true,
        "ok",
      );

      // ---------------- CHECK constraint violations ----------------
      expectThrow(
        "fresh: unknown request_type rejected",
        () => insertInvocation(dbHandle.db, { requestType: "totally-bogus" }),
        /CHECK constraint failed: ai_invocations_request_type_enum/,
      );
      expectThrow(
        "fresh: unknown status rejected",
        () => insertInvocation(dbHandle.db, { status: "running" }),
        /CHECK constraint failed: ai_invocations_status_enum/,
      );
      expectThrow(
        "fresh: blank provider rejected",
        () => insertInvocation(dbHandle.db, { provider: "" }),
        /CHECK constraint failed: ai_invocations_provider_not_blank/,
      );
      expectThrow(
        "fresh: blank model_name rejected",
        () => insertInvocation(dbHandle.db, { modelName: "" }),
        /CHECK constraint failed: ai_invocations_model_name_not_blank/,
      );
      expectThrow(
        "fresh: negative duration_ms rejected",
        () => insertInvocation(dbHandle.db, { durationMs: -1 }),
        /CHECK constraint failed: ai_invocations_duration_ms_nonneg/,
      );

      // ---------------- FK SET NULL behaviour ----------------
      const fkInvocId = insertInvocation(dbHandle.db, {
        mediaId: seeded.mediaId,
        jobId,
        provider: "noop",
        modelName: "noop-v1",
        requestType: "image_ai_refine",
      });
      // Sanity: row really points at the media + job we seeded.
      const before = dbHandle.db
        .prepare(`SELECT media_id, job_id FROM ai_invocations WHERE id = ?`)
        .get(fkInvocId) as { media_id: string | null; job_id: string | null };
      record(
        "FK setup: row references the seeded media + job",
        before.media_id === seeded.mediaId && before.job_id === jobId,
        JSON.stringify(before),
      );

      // Hard-delete the parent JOB → ai_invocations.job_id flips to NULL,
      // row survives.
      dbHandle.db.prepare(`DELETE FROM processing_jobs WHERE id = ?`).run(jobId);
      const afterJobDelete = dbHandle.db
        .prepare(`SELECT media_id, job_id FROM ai_invocations WHERE id = ?`)
        .get(fkInvocId) as { media_id: string | null; job_id: string | null };
      record(
        "FK: hard-delete processing_jobs row → ai_invocations.job_id becomes NULL (row survives)",
        afterJobDelete !== undefined &&
          afterJobDelete.job_id === null &&
          afterJobDelete.media_id === seeded.mediaId,
        JSON.stringify(afterJobDelete),
      );

      // Hard-delete the parent MEDIA → ai_invocations.media_id flips to
      // NULL across every row referencing it; rows survive.
      dbHandle.db.prepare(`DELETE FROM media_items WHERE id = ?`).run(seeded.mediaId);
      const afterMediaDelete = dbHandle.db
        .prepare(`SELECT COUNT(*) AS n FROM ai_invocations WHERE media_id = ?`)
        .get(seeded.mediaId) as { n: number };
      record(
        "FK: hard-delete media_items row → no ai_invocations.media_id still points at it",
        afterMediaDelete.n === 0,
        `survivors-with-old-media=${afterMediaDelete.n}`,
      );
      const survivors = (
        dbHandle.db
          .prepare(`SELECT COUNT(*) AS n FROM ai_invocations WHERE media_id IS NULL`)
          .get() as { n: number }
      ).n;
      record(
        "FK: rows with media_id=NULL survive after parent hard-delete (audit trail preserved)",
        survivors >= 11,
        `survivors=${survivors}`,
      );

      // Re-run migrate → no-op.
      const second = runMigrations(dbHandle.db);
      record(
        "fresh: re-running migrate is a no-op (012 already applied)",
        second.appliedNow.length === 0,
        `appliedNow=${JSON.stringify(second.appliedNow)}`,
      );
    } finally {
      closeDatabase(dbHandle);
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }

  // ===================================================================
  // CASE GROUP B: upgrade from 011 → 012 preserves prior tables / data
  // ===================================================================
  {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-mig012-upgrade-"));
    const dbPath = path.join(tmpRoot, "upgrade.db");
    console.log(`[smoke] upgradeDbPath=${dbPath}`);
    const dbHandle = openDatabase(dbPath);
    try {
      // Stop after 011 by hand-removing 012 from the directory we
      // pass in. Simpler: just apply ALL files first, drop the
      // marker for 012 + drop the table, then re-apply. That keeps
      // the harness path-free.
      runMigrations(dbHandle.db);
      // Verify 012 actually applied first time.
      const applied = dbHandle.db
        .prepare(`SELECT name FROM _schema_migrations ORDER BY name`)
        .all() as { name: string }[];
      record(
        "upgrade-prep: 012 row present in _schema_migrations after initial run",
        applied.some((r) => r.name === "012_create_ai_invocations.sql"),
        `count=${applied.length}`,
      );
      // Tear down to simulate "DB stopped at 011": drop the row +
      // drop the table.
      dbHandle.db
        .prepare(`DELETE FROM _schema_migrations WHERE name = ?`)
        .run("012_create_ai_invocations.sql");
      dbHandle.db.exec(`DROP TABLE ai_invocations`);

      // Pre-existing 011-era fixture: a trip + media + segment row.
      const seeded = seedTripAndImage(dbHandle.db, "Pre-012 fixture");
      const preMediaRow = dbHandle.db
        .prepare(`SELECT id, status FROM media_items WHERE id = ?`)
        .get(seeded.mediaId) as { id: string; status: string };

      // Apply migrations again → only 012 should run.
      const upgrade = runMigrations(dbHandle.db);
      record(
        "upgrade: appliedNow == ['012_create_ai_invocations.sql']",
        upgrade.appliedNow.length === 1 &&
          upgrade.appliedNow[0] === "012_create_ai_invocations.sql",
        `appliedNow=${JSON.stringify(upgrade.appliedNow)}`,
      );

      // Pre-existing data intact.
      const postMediaRow = dbHandle.db
        .prepare(`SELECT id, status FROM media_items WHERE id = ?`)
        .get(seeded.mediaId) as { id: string; status: string };
      record(
        "upgrade: pre-existing media row preserved across migration",
        postMediaRow !== undefined &&
          postMediaRow.id === preMediaRow.id &&
          postMediaRow.status === preMediaRow.status,
        JSON.stringify(postMediaRow),
      );

      // Post-012: table is present + INSERTable.
      const invocId = insertInvocation(dbHandle.db, {
        mediaId: seeded.mediaId,
        provider: "noop",
        modelName: "noop-v1",
        requestType: "image_ai_refine",
        status: "pending",
      });
      record(
        "upgrade: post-012 INSERT into ai_invocations works",
        typeof invocId === "string",
        `id=${invocId}`,
      );

      // PRAGMA foreign_key_check / integrity_check still clean.
      const fkCheck = dbHandle.db.prepare(`PRAGMA foreign_key_check`).all();
      record(
        "upgrade: PRAGMA foreign_key_check clean post-012",
        Array.isArray(fkCheck) && fkCheck.length === 0,
        `rows=${JSON.stringify(fkCheck)}`,
      );
      const integ = dbHandle.db.prepare(`PRAGMA integrity_check`).all() as {
        integrity_check: string;
      }[];
      record(
        "upgrade: PRAGMA integrity_check ok post-012",
        integ.length === 1 && integ[0]?.integrity_check === "ok",
        `result=${JSON.stringify(integ)}`,
      );

      // Re-running migrate is a no-op.
      const third = runMigrations(dbHandle.db);
      record(
        "upgrade: re-running migrate is a no-op (012 already applied)",
        third.appliedNow.length === 0,
        `appliedNow=${JSON.stringify(third.appliedNow)}`,
      );
    } finally {
      closeDatabase(dbHandle);
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }

  // ===================================================================
  // SUMMARY
  // ===================================================================
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n[smoke] summary: ${passed}/${results.length} passed`);
  if (failed > 0) {
    console.log(
      `[smoke] failures: ${results.filter((r) => !r.ok).map((r) => r.name).join(", ")}`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[smoke] uncaught error: ${describeError(err)}`);
  process.exit(1);
});
