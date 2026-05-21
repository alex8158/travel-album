// Manual smoke test for migration 011 (P9.T1).
//
// Usage: npm run smoke:migration-011
//
// Verifies the schema-level acceptance points for the migration:
//   * Fresh DB: 000..011 apply cleanly in one boot.
//   * Existing DB stopped at 010: upgrading to 011 adds the
//     `video_segments` table without disturbing any prior tables or
//     seeded data.
//   * After upgrade, `video_segments` exists with the documented
//     columns, defaults, CHECK constraints, FK, and indexes.
//   * Re-running migrate is a no-op (011 already applied).
//   * Rows can be inserted; CHECK constraints reject bad ranges /
//     enums; FK CASCADE fires when the parent media row is deleted.
//   * Pre-existing tables (media_items / media_versions / etc.) are
//     untouched.
//   * `foreign_key_check` + `integrity_check` clean.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
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
// fixture helpers
// ---------------------------------------------------------------------------

function seedTripAndVideo(
  db: SqliteDatabase,
  tripTitle = "P9.T1 Smoke Trip",
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
     VALUES (?, ?, 'video', ?, 'video/mp4', 'mp4', 4096,
             'processed', 'undecided', ?, ?)`,
  ).run(mediaId, tripId, `trips/${tripId}/originals/${mediaId}.mp4`, now, now);
  return { tripId, mediaId };
}

interface InsertSegmentArgs {
  readonly mediaId: string;
  readonly startTime?: number;
  readonly endTime?: number;
  readonly duration?: number;
  readonly thumbnailPath?: string | null;
  readonly previewPath?: string | null;
  readonly blurScore?: number | null;
  readonly stabilityScore?: number | null;
  readonly qualityScore?: number | null;
  readonly wasteType?: string;
  readonly isRecommended?: 0 | 1;
  readonly userDecision?: "keep" | "remove" | "undecided";
  readonly reason?: string | null;
}

function insertSegment(db: SqliteDatabase, args: InsertSegmentArgs): string {
  const id = randomUUID();
  const startTime = args.startTime ?? 0;
  const endTime = args.endTime ?? 10;
  const duration = args.duration ?? endTime - startTime;
  db.prepare(
    `INSERT INTO video_segments
       (id, media_id, start_time, end_time, duration,
        thumbnail_path, preview_path,
        blur_score, stability_score, quality_score,
        waste_type, is_recommended, user_decision, reason)
     VALUES (?, ?, ?, ?, ?,
             ?, ?,
             ?, ?, ?,
             ?, ?, ?, ?)`,
  ).run(
    id,
    args.mediaId,
    startTime,
    endTime,
    duration,
    args.thumbnailPath ?? null,
    args.previewPath ?? null,
    args.blurScore ?? null,
    args.stabilityScore ?? null,
    args.qualityScore ?? null,
    args.wasteType ?? "none",
    args.isRecommended ?? 0,
    args.userDecision ?? "undecided",
    args.reason ?? null,
  );
  return id;
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // ===================================================================
  // CASE GROUP A: fresh DB applies 000..011 in one shot
  // ===================================================================
  {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-mig011-fresh-"));
    const dbPath = path.join(tmpRoot, "fresh.db");
    const dbHandle = openDatabase(dbPath);
    try {
      const result = runMigrations(dbHandle.db);
      record(
        "fresh: 011 included in appliedNow",
        result.appliedNow.includes("011_create_video_segments.sql"),
        `appliedNow=${JSON.stringify(result.appliedNow)}`,
      );
      record(
        "fresh: totalFiles >= 12 (000..011)",
        result.totalFiles >= 12,
        `totalFiles=${result.totalFiles}`,
      );

      // ---------------- video_segments: schema ----------------
      const cols = dbHandle.db.prepare(`PRAGMA table_info(video_segments)`).all() as {
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
        "start_time",
        "end_time",
        "duration",
        "thumbnail_path",
        "preview_path",
        "blur_score",
        "stability_score",
        "quality_score",
        "waste_type",
        "is_recommended",
        "user_decision",
        "reason",
        "created_at",
        "updated_at",
      ];
      record(
        "fresh: video_segments has 16 columns in spec order",
        JSON.stringify(colNames) === JSON.stringify(expectedCols),
        `columns=${JSON.stringify(colNames)}`,
      );

      // id + media_id + 3 timing columns + 3 enum/flag columns NOT NULL.
      const idCol = cols.find((c) => c.name === "id");
      const mediaCol = cols.find((c) => c.name === "media_id");
      const startCol = cols.find((c) => c.name === "start_time");
      const endCol = cols.find((c) => c.name === "end_time");
      const durCol = cols.find((c) => c.name === "duration");
      const wasteCol = cols.find((c) => c.name === "waste_type");
      const recCol = cols.find((c) => c.name === "is_recommended");
      const udCol = cols.find((c) => c.name === "user_decision");
      record(
        "fresh: id is PRIMARY KEY NOT NULL",
        idCol?.pk === 1 && idCol?.notnull === 1,
        `id=${JSON.stringify(idCol)}`,
      );
      record(
        "fresh: media_id + start_time + end_time + duration are NOT NULL",
        mediaCol?.notnull === 1 &&
          startCol?.notnull === 1 &&
          endCol?.notnull === 1 &&
          durCol?.notnull === 1,
        `media=${mediaCol?.notnull} start=${startCol?.notnull} end=${endCol?.notnull} dur=${durCol?.notnull}`,
      );
      record(
        "fresh: waste_type + is_recommended + user_decision are NOT NULL with DEFAULTs",
        wasteCol?.notnull === 1 &&
          recCol?.notnull === 1 &&
          udCol?.notnull === 1 &&
          wasteCol?.dflt_value !== null &&
          recCol?.dflt_value !== null &&
          udCol?.dflt_value !== null,
        `waste.dflt=${String(wasteCol?.dflt_value)} rec.dflt=${String(recCol?.dflt_value)} ud.dflt=${String(udCol?.dflt_value)}`,
      );
      const thumbCol = cols.find((c) => c.name === "thumbnail_path");
      const blurCol = cols.find((c) => c.name === "blur_score");
      const reasonCol = cols.find((c) => c.name === "reason");
      record(
        "fresh: thumbnail_path / blur_score / reason are nullable",
        thumbCol?.notnull === 0 && blurCol?.notnull === 0 && reasonCol?.notnull === 0,
        `thumb=${thumbCol?.notnull} blur=${blurCol?.notnull} reason=${reasonCol?.notnull}`,
      );

      // ---------------- indexes on video_segments ----------------
      const idx = dbHandle.db.prepare(`PRAGMA index_list(video_segments)`).all() as {
        name: string;
        unique: number;
      }[];
      record(
        "fresh: idx_video_segments_media_id exists (non-unique)",
        idx.some((i) => i.name === "idx_video_segments_media_id" && i.unique === 0),
        `indexes=${JSON.stringify(idx)}`,
      );
      record(
        "fresh: idx_video_segments_is_recommended exists",
        idx.some((i) => i.name === "idx_video_segments_is_recommended"),
        `indexes=${JSON.stringify(idx)}`,
      );

      // ---------------- FK info ----------------
      const fks = dbHandle.db.prepare(`PRAGMA foreign_key_list(video_segments)`).all() as {
        table: string;
        from: string;
        to: string;
        on_delete: string;
      }[];
      record(
        "fresh: video_segments.media_id → media_items ON DELETE CASCADE",
        fks.some(
          (fk) =>
            fk.from === "media_id" && fk.table === "media_items" && fk.on_delete === "CASCADE",
        ),
        `fks=${JSON.stringify(fks)}`,
      );

      // ---------------- inserts: happy paths ----------------
      const seeded = seedTripAndVideo(dbHandle.db);

      // Minimal insert: only mandatory fields, NULL nullable columns.
      const sid1 = insertSegment(dbHandle.db, {
        mediaId: seeded.mediaId,
        startTime: 0,
        endTime: 10,
        duration: 10,
      });
      record(
        "fresh: minimal video_segments row accepted",
        typeof sid1 === "string" && sid1.length > 0,
        `id=${sid1}`,
      );

      // Read back, DEFAULTs populated.
      const readback = dbHandle.db
        .prepare(
          `SELECT waste_type, is_recommended, user_decision, created_at, updated_at
             FROM video_segments WHERE id = ?`,
        )
        .get(sid1) as
        | {
            waste_type: string;
            is_recommended: number;
            user_decision: string;
            created_at: string;
            updated_at: string;
          }
        | undefined;
      record(
        "fresh: DEFAULTs land: waste_type='none', is_recommended=0, user_decision='undecided'",
        readback?.waste_type === "none" &&
          readback?.is_recommended === 0 &&
          readback?.user_decision === "undecided",
        `row=${JSON.stringify(readback)}`,
      );
      record(
        "fresh: created_at + updated_at defaults are written",
        typeof readback?.created_at === "string" &&
          typeof readback?.updated_at === "string" &&
          (readback?.created_at as string).length > 0 &&
          (readback?.updated_at as string).length > 0,
        `created_at=${String(readback?.created_at)} updated_at=${String(readback?.updated_at)}`,
      );

      // Fully-populated row.
      const sid2 = insertSegment(dbHandle.db, {
        mediaId: seeded.mediaId,
        startTime: 10,
        endTime: 20,
        duration: 10,
        thumbnailPath: `trips/${seeded.tripId}/derived/${seeded.mediaId}/segments/seg-1/thumb.webp`,
        previewPath: `trips/${seeded.tripId}/derived/${seeded.mediaId}/segments/seg-1/preview.mp4`,
        blurScore: 0.85,
        stabilityScore: 0.7,
        qualityScore: 0.78,
        wasteType: "none",
        isRecommended: 1,
        userDecision: "keep",
        reason: "high sharpness, no shake",
      });
      record(
        "fresh: fully-populated video_segments row accepted",
        typeof sid2 === "string" && sid2.length > 0,
        `id=${sid2}`,
      );

      // ---------------- CHECK constraints ----------------
      // start_time < 0
      expectThrow(
        "fresh: start_time CHECK rejects negative",
        () => insertSegment(dbHandle.db, { mediaId: seeded.mediaId, startTime: -1, endTime: 5 }),
        /CHECK constraint failed: video_segments_start_nonneg/,
      );
      // end_time <= start_time (inverted range)
      expectThrow(
        "fresh: end_time CHECK rejects end <= start",
        () => insertSegment(dbHandle.db, { mediaId: seeded.mediaId, startTime: 5, endTime: 5 }),
        /CHECK constraint failed: video_segments_end_after_start/,
      );
      // duration <= 0
      expectThrow(
        "fresh: duration CHECK rejects 0",
        () =>
          insertSegment(dbHandle.db, {
            mediaId: seeded.mediaId,
            startTime: 0,
            endTime: 5,
            duration: 0,
          }),
        /CHECK constraint failed: video_segments_duration_positive/,
      );
      // score ranges — blur_score > 1
      expectThrow(
        "fresh: blur_score CHECK rejects > 1",
        () => insertSegment(dbHandle.db, { mediaId: seeded.mediaId, blurScore: 1.5 }),
        /CHECK constraint failed: video_segments_blur_score_range/,
      );
      // score ranges — quality_score < 0
      expectThrow(
        "fresh: quality_score CHECK rejects < 0",
        () => insertSegment(dbHandle.db, { mediaId: seeded.mediaId, qualityScore: -0.01 }),
        /CHECK constraint failed: video_segments_quality_score_range/,
      );
      // stability_score = NULL passes (nullable).
      {
        const tid = insertSegment(dbHandle.db, {
          mediaId: seeded.mediaId,
          startTime: 30,
          endTime: 35,
          stabilityScore: null,
        });
        record(
          "fresh: stability_score NULL passes (nullable score)",
          typeof tid === "string" && tid.length > 0,
          `id=${tid}`,
        );
      }
      // waste_type bad enum
      expectThrow(
        "fresh: waste_type CHECK rejects unknown enum",
        () => insertSegment(dbHandle.db, { mediaId: seeded.mediaId, wasteType: "bogus" }),
        /CHECK constraint failed: video_segments_waste_type_enum/,
      );
      // is_recommended bad value
      expectThrow(
        "fresh: is_recommended CHECK rejects value other than 0/1",
        () =>
          dbHandle.db
            .prepare(
              `INSERT INTO video_segments (id, media_id, start_time, end_time, duration, is_recommended)
               VALUES (?, ?, 0, 1, 1, 2)`,
            )
            .run(randomUUID(), seeded.mediaId),
        /CHECK constraint failed: video_segments_is_recommended_bool/,
      );
      // user_decision bad enum
      expectThrow(
        "fresh: user_decision CHECK rejects unknown enum",
        () =>
          insertSegment(dbHandle.db, {
            mediaId: seeded.mediaId,
            userDecision: "maybe" as unknown as "keep",
          }),
        /CHECK constraint failed: video_segments_user_decision_enum/,
      );

      // ---------------- FK CASCADE on media delete ----------------
      // Build a fresh trip + media so we can hard-delete the parent
      // without trampling earlier rows in this test run.
      const seeded2 = seedTripAndVideo(dbHandle.db, "cascade target");
      const cascadeSegId = insertSegment(dbHandle.db, {
        mediaId: seeded2.mediaId,
        startTime: 0,
        endTime: 5,
      });
      dbHandle.db.prepare(`DELETE FROM media_items WHERE id = ?`).run(seeded2.mediaId);
      const afterDelete = dbHandle.db
        .prepare(`SELECT COUNT(*) AS n FROM video_segments WHERE id = ?`)
        .get(cascadeSegId) as { n: number };
      record(
        "fresh: hard delete of parent media cascades to video_segments",
        afterDelete.n === 0,
        `count=${afterDelete.n}`,
      );

      // The unrelated parent media (seeded) still has its segments.
      const survivors = dbHandle.db
        .prepare(`SELECT COUNT(*) AS n FROM video_segments WHERE media_id = ?`)
        .get(seeded.mediaId) as { n: number };
      record(
        "fresh: unrelated video_segments rows survive the cascade",
        survivors.n > 0,
        `count=${survivors.n}`,
      );

      // ---------------- FK rejection: bogus media_id ----------------
      expectThrow(
        "fresh: FK rejects insert with non-existent media_id",
        () =>
          insertSegment(dbHandle.db, {
            mediaId: randomUUID(),
            startTime: 0,
            endTime: 1,
          }),
        /FOREIGN KEY constraint failed/,
      );

      // ---------------- Pre-existing tables untouched ----------------
      const otherTables = dbHandle.db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name IN
             ('trips', 'media_items', 'media_versions', 'media_analysis',
              'duplicate_groups', 'duplicate_group_items', 'processing_jobs')`,
        )
        .all() as { name: string }[];
      record(
        "fresh: every prior table still present (P1-P8 tables untouched)",
        otherTables.length === 7,
        `count=${otherTables.length} tables=${JSON.stringify(otherTables.map((t) => t.name).sort())}`,
      );

      // ---------------- FK + integrity clean ----------------
      const fkRows = dbHandle.db.prepare(`PRAGMA foreign_key_check`).all();
      record(
        "fresh: PRAGMA foreign_key_check clean",
        fkRows.length === 0,
        `rows=${JSON.stringify(fkRows)}`,
      );
      const integrity = dbHandle.db.prepare(`PRAGMA integrity_check`).all() as {
        integrity_check: string;
      }[];
      record(
        "fresh: PRAGMA integrity_check ok",
        integrity.length === 1 && integrity[0]?.integrity_check === "ok",
        `result=${JSON.stringify(integrity)}`,
      );

      // ---------------- Idempotency ----------------
      const again = runMigrations(dbHandle.db);
      record(
        "fresh: re-running migrate is a no-op (011 already applied)",
        again.appliedNow.length === 0,
        `appliedNow=${JSON.stringify(again.appliedNow)}`,
      );
    } finally {
      closeDatabase(dbHandle);
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }

  // ===================================================================
  // CASE GROUP B: upgrade scenario — stop at 010, then apply 011.
  // Pre-existing trip / media / media_versions / media_items.
  //   active_version_type rows must survive.
  // ===================================================================
  {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-mig011-upgrade-"));
    const dbPath = path.join(tmpRoot, "upgrade.db");
    console.log(`[smoke] upgradeDbPath=${dbPath}`);

    let knownTripId = "";
    let knownMediaId = "";

    // ---- Stage 1: simulate previous release stopping at 010 ----
    const stage1 = openDatabase(dbPath);
    try {
      stage1.db.exec(`
        CREATE TABLE IF NOT EXISTS _schema_migrations (
          name        TEXT NOT NULL PRIMARY KEY,
          applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ) STRICT;
      `);
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
        "005_create_media_versions.sql",
        "006_extend_media_versions_version_type.sql",
        "007_create_duplicate_groups.sql",
        "008_create_media_analysis.sql",
        "009_add_trips_cover_set_by_user.sql",
        "010_add_media_items_active_version_type.sql",
      ];
      for (const name of oldFiles) {
        const sql = await readFile(path.join(migrationsDir, name), "utf8");
        stage1.db.exec(sql);
        stage1.db.prepare(`INSERT INTO _schema_migrations (name) VALUES (?)`).run(name);
      }
      const seeded = seedTripAndVideo(stage1.db, "Pre-011 fixture");
      knownTripId = seeded.tripId;
      knownMediaId = seeded.mediaId;

      // Sanity: video_segments should NOT exist before 011.
      const beforeTables = stage1.db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='video_segments'`)
        .all() as { name: string }[];
      record(
        "upgrade-before: video_segments does not exist on 010 schema",
        beforeTables.length === 0,
        `tables=${JSON.stringify(beforeTables)}`,
      );
    } finally {
      closeDatabase(stage1);
    }

    // ---- Stage 2: re-open, run migrations → only 011 should apply ----
    const stage2 = openDatabase(dbPath);
    try {
      const result = runMigrations(stage2.db);
      record(
        "upgrade: appliedNow includes 011 as the first new migration",
        result.appliedNow[0] === "011_create_video_segments.sql" &&
          result.appliedNow.includes("011_create_video_segments.sql"),
        `appliedNow=${JSON.stringify(result.appliedNow)}`,
      );

      // Existing trip + video media row untouched.
      const tripRow = stage2.db
        .prepare(`SELECT id, title FROM trips WHERE id = ?`)
        .get(knownTripId) as { id: string; title: string } | undefined;
      record(
        "upgrade: pre-existing trip preserved",
        tripRow?.id === knownTripId && tripRow?.title === "Pre-011 fixture",
        `trip=${JSON.stringify(tripRow)}`,
      );
      const mediaRow = stage2.db
        .prepare(`SELECT id, type, active_version_type FROM media_items WHERE id = ?`)
        .get(knownMediaId) as { id: string; type: string; active_version_type: string } | undefined;
      record(
        "upgrade: pre-existing video media preserved (incl. P8.T4 active_version_type)",
        mediaRow?.id === knownMediaId &&
          mediaRow?.type === "video" &&
          mediaRow?.active_version_type === "original",
        `media=${JSON.stringify(mediaRow)}`,
      );

      // New table exists and accepts inserts after upgrade.
      const sid = insertSegment(stage2.db, {
        mediaId: knownMediaId,
        startTime: 0,
        endTime: 10,
        duration: 10,
        qualityScore: 0.5,
        wasteType: "none",
      });
      record(
        "upgrade: post-011 insert into video_segments works",
        typeof sid === "string" && sid.length > 0,
        `id=${sid}`,
      );

      // FK + integrity clean post-011.
      const fkRows = stage2.db.prepare(`PRAGMA foreign_key_check`).all();
      record(
        "upgrade: PRAGMA foreign_key_check clean post-011",
        fkRows.length === 0,
        `rows=${JSON.stringify(fkRows)}`,
      );
      const integrity = stage2.db.prepare(`PRAGMA integrity_check`).all() as {
        integrity_check: string;
      }[];
      record(
        "upgrade: PRAGMA integrity_check ok post-011",
        integrity.length === 1 && integrity[0]?.integrity_check === "ok",
        `result=${JSON.stringify(integrity)}`,
      );

      // Idempotency: running again is a no-op.
      const again = runMigrations(stage2.db);
      record(
        "upgrade: re-running migrate is a no-op (011 already applied)",
        again.appliedNow.length === 0,
        `appliedNow=${JSON.stringify(again.appliedNow)}`,
      );

      // Deleting the seeded video cascades into the segment we just inserted.
      stage2.db.prepare(`DELETE FROM media_items WHERE id = ?`).run(knownMediaId);
      const segCount = stage2.db
        .prepare(`SELECT COUNT(*) AS n FROM video_segments WHERE id = ?`)
        .get(sid) as { n: number };
      record(
        "upgrade: media delete cascades to video_segments",
        segCount.n === 0,
        `count=${segCount.n}`,
      );
    } finally {
      closeDatabase(stage2);
      await rm(tmpRoot, { recursive: true, force: true });
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
