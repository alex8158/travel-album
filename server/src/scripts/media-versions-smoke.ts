// Manual smoke test for the media_versions migration (P3.T3).
//
// Usage: npm run smoke:media-versions
//
// Verifies:
//   * Fresh DB: migration 005 lands in appliedNow.
//   * Existing DB: re-running is a no-op (idempotency).
//   * INSERT happy path: valid row lands.
//   * Each CHECK constraint rejects the obvious bad value.
//   * UNIQUE (media_id, version_type) rejects duplicates.
//   * FK to media_items(id) rejects orphan media_id.
//   * ON DELETE CASCADE: hard-deleting a media_items row removes its
//     versions automatically.
//   * `foreign_key_check` and `integrity_check` are clean after all
//     of the above.
//
// No Repository / Service is exercised — those land in later P3 / P8
// / P9 / P10 tasks. This smoke pokes the table through direct SQL so
// the migration itself is the only thing under test.

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

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

function seedTripAndMedia(db: SqliteDatabase): { tripId: string; mediaId: string } {
  const tripId = randomUUID();
  const mediaId = randomUUID();
  const now = new Date().toISOString();

  db.prepare(`INSERT INTO trips (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
    tripId,
    "Smoke Trip",
    now,
    now,
  );

  db.prepare(
    `INSERT INTO media_items
       (id, trip_id, type, original_path, mime_type, extension, file_size,
        status, user_decision, created_at, updated_at)
     VALUES (?, ?, 'image', ?, 'image/jpeg', 'jpg', 1024,
             'uploaded', 'undecided', ?, ?)`,
  ).run(mediaId, tripId, `trips/${tripId}/originals/${mediaId}.jpg`, now, now);

  return { tripId, mediaId };
}

interface InsertVersionArgs {
  readonly id?: string;
  readonly mediaId: string;
  readonly versionType: string;
  readonly filePath: string;
  readonly status?: string;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly fileSize?: number | null;
}

function insertVersion(db: SqliteDatabase, args: InsertVersionArgs): string {
  const id = args.id ?? randomUUID();
  db.prepare(
    `INSERT INTO media_versions
       (id, media_id, version_type, file_path, status, width, height, file_size)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    args.mediaId,
    args.versionType,
    args.filePath,
    args.status ?? "ready",
    args.width ?? null,
    args.height ?? null,
    args.fileSize ?? null,
  );
  return id;
}

function expectThrow(name: string, fn: () => void, expectedMatcher: RegExp): void {
  let threw: unknown;
  try {
    fn();
  } catch (err) {
    threw = err;
  }
  const ok = threw !== undefined && expectedMatcher.test(describeError(threw));
  record(name, ok, describeError(threw));
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-media-versions-smoke-"));
  const dbPath = path.join(tmpRoot, "smoke.db");
  console.log(`[smoke] dbPath=${dbPath}`);

  const dbHandle = openDatabase(dbPath);
  try {
    // -------------------------------------------------------------------
    // CASE 1: migration applied on fresh DB
    // -------------------------------------------------------------------
    {
      const result = runMigrations(dbHandle.db);
      record(
        "fresh DB: 005_create_media_versions.sql in appliedNow",
        result.appliedNow.includes("005_create_media_versions.sql"),
        `appliedNow=${JSON.stringify(result.appliedNow)}`,
      );
      // Check the migration chain 000..005 is present, but use an
      // "includes" subset check rather than an exact-length match so
      // later phases (P3.T5 added 006, future phases will add more)
      // do not retroactively break this assertion.
      const required = [
        "000_init.sql",
        "001_create_trips.sql",
        "002_create_media_items.sql",
        "003_add_trips_cover_media_id_fk.sql",
        "004_create_processing_jobs.sql",
        "005_create_media_versions.sql",
      ];
      record(
        "fresh DB: migrations 000..005 chain present in appliedNow",
        required.every((m) => result.appliedNow.includes(m)),
        `count=${result.appliedNow.length} missing=${JSON.stringify(
          required.filter((m) => !result.appliedNow.includes(m)),
        )}`,
      );
    }

    // -------------------------------------------------------------------
    // CASE 2: media_versions table exists with the expected columns
    // -------------------------------------------------------------------
    {
      const columns = dbHandle.db.prepare(`PRAGMA table_info(media_versions)`).all() as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: unknown;
      }[];
      const names = columns.map((c) => c.name);
      const expected = [
        "id",
        "media_id",
        "version_type",
        "file_path",
        "mime_type",
        "width",
        "height",
        "file_size",
        "model_name",
        "params",
        "status",
        "created_at",
        "updated_at",
      ];
      record(
        "table_info: all 13 expected columns present",
        expected.every((c) => names.includes(c)) && names.length === expected.length,
        `columns=${JSON.stringify(names)}`,
      );
    }

    // -------------------------------------------------------------------
    // CASE 3: expected indexes exist
    // -------------------------------------------------------------------
    {
      const idx = dbHandle.db.prepare(`PRAGMA index_list(media_versions)`).all() as {
        name: string;
        unique: number;
      }[];
      const names = idx.map((i) => i.name);
      const expected = [
        "idx_media_versions_media_version",
        "idx_media_versions_version_type",
        "idx_media_versions_file_path",
        "idx_media_versions_status",
      ];
      record(
        "index_list: all 4 expected indexes present",
        expected.every((e) => names.includes(e)),
        `indexes=${JSON.stringify(names)}`,
      );
      const composite = idx.find((i) => i.name === "idx_media_versions_media_version");
      record(
        "idx_media_versions_media_version is UNIQUE",
        composite !== undefined && composite.unique === 1,
        `unique=${String(composite?.unique)}`,
      );
    }

    // -------------------------------------------------------------------
    // CASE 4: idempotency — second runMigrations call is a no-op
    // -------------------------------------------------------------------
    {
      const result = runMigrations(dbHandle.db);
      record(
        "idempotency: appliedNow=[] on second run",
        result.appliedNow.length === 0,
        `appliedNow=${JSON.stringify(result.appliedNow)}`,
      );
      record(
        "idempotency: alreadyApplied includes 005",
        result.alreadyApplied.includes("005_create_media_versions.sql"),
        `alreadyApplied=${JSON.stringify(result.alreadyApplied)}`,
      );
    }

    // -------------------------------------------------------------------
    // Seed a trip + media_items row so the FK has a target.
    // -------------------------------------------------------------------
    const { mediaId } = seedTripAndMedia(dbHandle.db);

    // -------------------------------------------------------------------
    // CASE 5: happy-path INSERT
    // -------------------------------------------------------------------
    {
      const id = insertVersion(dbHandle.db, {
        mediaId,
        versionType: "thumbnail",
        filePath: `trips/x/derived/${mediaId}/thumb.webp`,
        width: 320,
        height: 240,
        fileSize: 4096,
      });
      const row = dbHandle.db.prepare(`SELECT * FROM media_versions WHERE id = ?`).get(id) as
        | Record<string, unknown>
        | undefined;
      record(
        "happy path: row inserted with defaults",
        row?.version_type === "thumbnail" &&
          row?.status === "ready" &&
          typeof row?.created_at === "string" &&
          typeof row?.updated_at === "string",
        `status=${String(row?.status)} ct=${typeof row?.created_at}`,
      );
    }

    // -------------------------------------------------------------------
    // CASE 6..N: each constraint rejects the right bad value
    // -------------------------------------------------------------------
    expectThrow(
      "CHECK version_type_enum rejects unknown value",
      () =>
        insertVersion(dbHandle.db, {
          mediaId,
          versionType: "not_a_real_type",
          filePath: "trips/x/derived/whatever.jpg",
        }),
      /CHECK constraint failed: media_versions_version_type_enum/,
    );

    expectThrow(
      "CHECK status_enum rejects unknown value",
      () =>
        insertVersion(dbHandle.db, {
          mediaId,
          versionType: "enhanced",
          filePath: "trips/x/derived/enhanced.jpg",
          status: "running", // valid for processing_jobs, NOT for media_versions
        }),
      /CHECK constraint failed: media_versions_status_enum/,
    );

    expectThrow(
      "CHECK file_path_not_blank rejects empty string",
      () =>
        insertVersion(dbHandle.db, {
          mediaId,
          versionType: "preview",
          filePath: "",
        }),
      /CHECK constraint failed: media_versions_file_path_not_blank/,
    );

    expectThrow(
      "CHECK file_size_nonneg rejects -1",
      () =>
        insertVersion(dbHandle.db, {
          mediaId,
          versionType: "preview",
          filePath: "trips/x/derived/preview.webp",
          fileSize: -1,
        }),
      /CHECK constraint failed: media_versions_file_size_nonneg/,
    );

    expectThrow(
      "CHECK dimensions_positive rejects width=0",
      () =>
        insertVersion(dbHandle.db, {
          mediaId,
          versionType: "preview",
          filePath: "trips/x/derived/preview.webp",
          width: 0,
          height: 100,
        }),
      /CHECK constraint failed: media_versions_dimensions_positive/,
    );

    expectThrow(
      "CHECK dimensions_positive rejects height=-5",
      () =>
        insertVersion(dbHandle.db, {
          mediaId,
          versionType: "preview",
          filePath: "trips/x/derived/preview.webp",
          width: 320,
          height: -5,
        }),
      /CHECK constraint failed: media_versions_dimensions_positive/,
    );

    // UNIQUE (media_id, version_type)
    expectThrow(
      "UNIQUE (media_id, version_type) rejects duplicate thumbnail",
      () =>
        insertVersion(dbHandle.db, {
          mediaId,
          versionType: "thumbnail", // already inserted in CASE 5
          filePath: "trips/x/derived/thumb2.webp",
        }),
      /UNIQUE constraint failed: media_versions\.media_id, media_versions\.version_type/,
    );

    // Different version_type for same media is fine.
    {
      const id = insertVersion(dbHandle.db, {
        mediaId,
        versionType: "preview",
        filePath: `trips/x/derived/${mediaId}/preview.webp`,
      });
      record(
        "UNIQUE allows different version_type for same media",
        typeof id === "string" && id.length > 0,
        `inserted id=${id}`,
      );
    }

    // FK violation on orphan media_id
    expectThrow(
      "FK media_id rejects non-existent media",
      () =>
        insertVersion(dbHandle.db, {
          mediaId: "definitely-not-a-real-media-id",
          versionType: "thumbnail",
          filePath: "trips/x/derived/orphan.webp",
        }),
      /FOREIGN KEY constraint failed/,
    );

    // -------------------------------------------------------------------
    // CASE: each of the 7 enum values accepts (with distinct media_ids)
    // -------------------------------------------------------------------
    {
      const versionTypes = [
        "original",
        "thumbnail",
        "preview",
        "enhanced",
        "ai_refined",
        "video_cover",
        "video_proxy",
      ] as const;
      const acceptedCount = versionTypes.filter((vt) => {
        // Use a fresh media row per enum value to bypass the
        // (media_id, version_type) UNIQUE constraint already populated
        // for `thumbnail` / `preview` above.
        const fresh = seedTripAndMedia(dbHandle.db);
        try {
          insertVersion(dbHandle.db, {
            mediaId: fresh.mediaId,
            versionType: vt,
            filePath: `trips/x/derived/${fresh.mediaId}/${vt}.bin`,
          });
          return true;
        } catch {
          return false;
        }
      }).length;
      record(
        "all 7 enum values accepted by version_type CHECK",
        acceptedCount === 7,
        `accepted=${acceptedCount}/7`,
      );
    }

    // -------------------------------------------------------------------
    // CASE: ON DELETE CASCADE — hard delete media_items takes versions
    // -------------------------------------------------------------------
    {
      const fresh = seedTripAndMedia(dbHandle.db);
      insertVersion(dbHandle.db, {
        mediaId: fresh.mediaId,
        versionType: "thumbnail",
        filePath: `trips/x/derived/${fresh.mediaId}/thumb.webp`,
      });
      insertVersion(dbHandle.db, {
        mediaId: fresh.mediaId,
        versionType: "preview",
        filePath: `trips/x/derived/${fresh.mediaId}/preview.webp`,
      });

      const before = (
        dbHandle.db
          .prepare(`SELECT COUNT(*) AS n FROM media_versions WHERE media_id = ?`)
          .get(fresh.mediaId) as { n: number }
      ).n;
      dbHandle.db.prepare(`DELETE FROM media_items WHERE id = ?`).run(fresh.mediaId);
      const after = (
        dbHandle.db
          .prepare(`SELECT COUNT(*) AS n FROM media_versions WHERE media_id = ?`)
          .get(fresh.mediaId) as { n: number }
      ).n;
      record(
        "CASCADE: hard-deleting media row removes 2 version rows",
        before === 2 && after === 0,
        `before=${before} after=${after}`,
      );
    }

    // -------------------------------------------------------------------
    // CASE: post-run sanity — foreign_key_check + integrity_check clean
    // -------------------------------------------------------------------
    {
      const fkRows = dbHandle.db.prepare(`PRAGMA foreign_key_check`).all();
      record(
        "PRAGMA foreign_key_check: clean",
        fkRows.length === 0,
        `rows=${JSON.stringify(fkRows)}`,
      );
      const integrity = dbHandle.db.prepare(`PRAGMA integrity_check`).all() as {
        integrity_check: string;
      }[];
      record(
        "PRAGMA integrity_check: ok",
        integrity.length === 1 && integrity[0]?.integrity_check === "ok",
        `result=${JSON.stringify(integrity)}`,
      );
    }
  } finally {
    closeDatabase(dbHandle);
    await rm(tmpRoot, { recursive: true, force: true });
    console.log(`[smoke] cleaned up ${tmpRoot}`);
  }

  // -------------------------------------------------------------------
  // CASE: applying migration on an existing post-P2.T2 database is a
  //       pure additive op (no rebuild of older tables, no data loss).
  // -------------------------------------------------------------------
  {
    const upgradeRoot = await mkdtemp(path.join(tmpdir(), "tas-media-versions-upgrade-"));
    const upgradeDbPath = path.join(upgradeRoot, "upgrade.db");
    console.log(`[smoke] upgradeDbPath=${upgradeDbPath}`);

    // Stage 1: simulate "previous release" — only run migrations 000..004.
    // Easiest way: read each file and exec it manually, recording rows
    // in _schema_migrations so when the real runner picks up, it will
    // only apply 005.
    const stageOne = openDatabase(upgradeDbPath);
    try {
      stageOne.db.exec(`
        CREATE TABLE IF NOT EXISTS _schema_migrations (
          name        TEXT NOT NULL PRIMARY KEY,
          applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ) STRICT;
      `);
      const fs = await import("node:fs");
      const migrationsDir = path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        "..",
        "..",
        "migrations",
      );
      const oldFiles = [
        "000_init.sql",
        "001_create_trips.sql",
        "002_create_media_items.sql",
        "003_add_trips_cover_media_id_fk.sql",
        "004_create_processing_jobs.sql",
      ];
      for (const name of oldFiles) {
        const sql = fs.readFileSync(path.join(migrationsDir, name), "utf8");
        stageOne.db.exec(sql);
        stageOne.db.prepare(`INSERT INTO _schema_migrations (name) VALUES (?)`).run(name);
      }
      // Seed some live data so we can verify nothing was clobbered.
      const tripId = randomUUID();
      const mediaId = randomUUID();
      const now = new Date().toISOString();
      stageOne.db
        .prepare(`INSERT INTO trips (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`)
        .run(tripId, "Pre-upgrade trip", now, now);
      stageOne.db
        .prepare(
          `INSERT INTO media_items
             (id, trip_id, type, original_path, mime_type, extension, file_size,
              status, user_decision, created_at, updated_at)
           VALUES (?, ?, 'image', ?, 'image/jpeg', 'jpg', 1024,
                   'uploaded', 'undecided', ?, ?)`,
        )
        .run(mediaId, tripId, `trips/${tripId}/originals/${mediaId}.jpg`, now, now);
    } finally {
      closeDatabase(stageOne);
    }

    // Stage 2: re-open + runMigrations — 005 should land (and any
    // newer migrations the project has accumulated since). The point
    // of this smoke is "005 landed AND existing data survives"; the
    // "exactly one migration" assertion was retired in P3.T5 when
    // 006 joined the chain.
    const stageTwo = openDatabase(upgradeDbPath);
    try {
      const result = runMigrations(stageTwo.db);
      record(
        "upgrade scenario: 005_create_media_versions in appliedNow",
        result.appliedNow.includes("005_create_media_versions.sql"),
        `appliedNow=${JSON.stringify(result.appliedNow)}`,
      );
      const tripCount = (
        stageTwo.db.prepare(`SELECT COUNT(*) AS n FROM trips`).get() as { n: number }
      ).n;
      const mediaCount = (
        stageTwo.db.prepare(`SELECT COUNT(*) AS n FROM media_items`).get() as { n: number }
      ).n;
      record(
        "upgrade scenario: pre-existing trips / media_items preserved",
        tripCount === 1 && mediaCount === 1,
        `trips=${tripCount} media=${mediaCount}`,
      );
      // The new table should be empty and addressable.
      const versionCount = (
        stageTwo.db.prepare(`SELECT COUNT(*) AS n FROM media_versions`).get() as { n: number }
      ).n;
      record(
        "upgrade scenario: media_versions exists and is empty",
        versionCount === 0,
        `versions=${versionCount}`,
      );
    } finally {
      closeDatabase(stageTwo);
      await rm(upgradeRoot, { recursive: true, force: true });
      console.log(`[smoke] cleaned up ${upgradeRoot}`);
    }
  }

  // ---------------------------------------------------------------------
  // summary
  // ---------------------------------------------------------------------
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n[smoke] summary: ${passed}/${results.length} passed`);
  if (failed > 0) {
    console.log(
      `[smoke] failures: ${results
        .filter((r) => !r.ok)
        .map((r) => r.name)
        .join(", ")}`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[smoke] uncaught error: ${describeError(err)}`);
  process.exit(1);
});
