// Manual smoke test for migration 008 (P6.T1).
//
// Usage: npm run smoke:migration-008
//
// Verifies the schema-level acceptance points for the migration:
//   * Fresh DB: 000..008 apply cleanly in one boot.
//   * Existing DB stopped at 007: upgrading to 008 adds the
//     `media_analysis` table without disturbing P5 tables or seeded
//     data.
//   * After upgrade, `media_analysis` exists with the documented
//     columns, CHECK constraints, FK, and UNIQUE index.
//   * Re-running migrate is a no-op (008 already applied).
//   * Rows can be inserted; CHECK / UNIQUE constraints reject bad
//     values; `is_*` flags accept NULL / 0 / 1 but reject anything
//     else; `quality_score` is bounded to [0, 1] while raw component
//     scores stay unconstrained (matches the worker normalisation
//     plan baked into the migration comments).
//   * FK strategy behaves as designed:
//       - media_id → media_items CASCADE on media delete.
//   * Existing P5 tables (duplicate_groups / duplicate_group_items)
//     remain untouched, and inserting into them still works after
//     008 lands.
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

function seedTripAndMedia(
  db: SqliteDatabase,
  tripTitle = "P6.T1 Smoke Trip",
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
     VALUES (?, ?, 'image', ?, 'image/jpeg', 'jpg', 1024,
             'uploaded', 'undecided', ?, ?)`,
  ).run(mediaId, tripId, `trips/${tripId}/originals/${mediaId}.jpg`, now, now);
  return { tripId, mediaId };
}

interface InsertAnalysisArgs {
  readonly mediaId: string;
  readonly blurScore?: number | null;
  readonly sharpnessScore?: number | null;
  readonly exposureScore?: number | null;
  readonly brightnessScore?: number | null;
  readonly colorScore?: number | null;
  readonly aestheticScore?: number | null;
  readonly qualityScore?: number | null;
  readonly isBlurry?: 0 | 1 | null;
  readonly isDuplicate?: 0 | 1 | null;
  readonly isRecommended?: 0 | 1 | null;
  readonly labels?: string | null;
  readonly reason?: string | null;
  readonly rawResult?: string | null;
}

function insertAnalysis(db: SqliteDatabase, args: InsertAnalysisArgs): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO media_analysis
       (id, media_id,
        blur_score, sharpness_score, exposure_score, brightness_score,
        color_score, aesthetic_score, quality_score,
        is_blurry, is_duplicate, is_recommended,
        labels, reason, raw_result)
     VALUES (?, ?,
             ?, ?, ?, ?,
             ?, ?, ?,
             ?, ?, ?,
             ?, ?, ?)`,
  ).run(
    id,
    args.mediaId,
    args.blurScore ?? null,
    args.sharpnessScore ?? null,
    args.exposureScore ?? null,
    args.brightnessScore ?? null,
    args.colorScore ?? null,
    args.aestheticScore ?? null,
    args.qualityScore ?? null,
    args.isBlurry ?? null,
    args.isDuplicate ?? null,
    args.isRecommended ?? null,
    args.labels ?? null,
    args.reason ?? null,
    args.rawResult ?? null,
  );
  return id;
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // ===================================================================
  // CASE GROUP A: fresh DB applies 000..008 in one shot
  // ===================================================================
  {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-mig008-fresh-"));
    const dbPath = path.join(tmpRoot, "fresh.db");
    const dbHandle = openDatabase(dbPath);
    try {
      const result = runMigrations(dbHandle.db);
      record(
        "fresh: 008 included in appliedNow",
        result.appliedNow.includes("008_create_media_analysis.sql"),
        `appliedNow=${JSON.stringify(result.appliedNow)}`,
      );
      record(
        "fresh: totalFiles >= 9 (000..008)",
        result.totalFiles >= 9,
        `totalFiles=${result.totalFiles}`,
      );

      // ---------------- media_analysis: schema ----------------
      const cols = dbHandle.db.prepare(`PRAGMA table_info(media_analysis)`).all() as {
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
        "blur_score",
        "sharpness_score",
        "exposure_score",
        "brightness_score",
        "color_score",
        "aesthetic_score",
        "quality_score",
        "is_blurry",
        "is_duplicate",
        "is_recommended",
        "labels",
        "reason",
        "raw_result",
        "created_at",
        "updated_at",
      ];
      record(
        "fresh: media_analysis has 17 columns in spec order",
        JSON.stringify(colNames) === JSON.stringify(expectedCols),
        `columns=${JSON.stringify(colNames)}`,
      );

      // id + media_id NOT NULL; rest nullable.
      const idCol = cols.find((c) => c.name === "id");
      const mediaCol = cols.find((c) => c.name === "media_id");
      record(
        "fresh: id is PRIMARY KEY NOT NULL",
        idCol?.pk === 1 && idCol?.notnull === 1,
        `id=${JSON.stringify(idCol)}`,
      );
      record(
        "fresh: media_id is NOT NULL",
        mediaCol?.notnull === 1,
        `media_id=${JSON.stringify(mediaCol)}`,
      );
      const blurCol = cols.find((c) => c.name === "blur_score");
      const qualityCol = cols.find((c) => c.name === "quality_score");
      const rawCol = cols.find((c) => c.name === "raw_result");
      record(
        "fresh: nullable analysis columns stay nullable",
        blurCol?.notnull === 0 && qualityCol?.notnull === 0 && rawCol?.notnull === 0,
        `blur=${JSON.stringify(blurCol)} quality=${JSON.stringify(qualityCol)} raw=${JSON.stringify(rawCol)}`,
      );

      // ---------------- indexes on media_analysis ----------------
      const idx = dbHandle.db.prepare(`PRAGMA index_list(media_analysis)`).all() as {
        name: string;
        unique: number;
      }[];
      record(
        "fresh: media_analysis has UNIQUE (media_id)",
        idx.some((i) => i.name === "idx_media_analysis_media_id" && i.unique === 1),
        `indexes=${JSON.stringify(idx)}`,
      );

      // ---------------- FK info ----------------
      const fks = dbHandle.db.prepare(`PRAGMA foreign_key_list(media_analysis)`).all() as {
        table: string;
        from: string;
        to: string;
        on_delete: string;
      }[];
      record(
        "fresh: media_analysis.media_id → media_items ON DELETE CASCADE",
        fks.some(
          (fk) =>
            fk.from === "media_id" && fk.table === "media_items" && fk.on_delete === "CASCADE",
        ),
        `fks=${JSON.stringify(fks)}`,
      );

      // ---------------- inserts: happy paths ----------------
      const seeded = seedTripAndMedia(dbHandle.db);

      // Minimal insert: only mandatory fields (id + media_id).
      const aid1 = insertAnalysis(dbHandle.db, { mediaId: seeded.mediaId });
      record(
        "fresh: minimal media_analysis row (NULL scores / flags) accepted",
        typeof aid1 === "string" && aid1.length > 0,
        `id=${aid1}`,
      );

      // Read back, defaults populated.
      const readback = dbHandle.db
        .prepare(`SELECT created_at, updated_at FROM media_analysis WHERE id = ?`)
        .get(aid1) as { created_at: string; updated_at: string } | undefined;
      record(
        "fresh: created_at + updated_at defaults are written",
        typeof readback?.created_at === "string" &&
          typeof readback?.updated_at === "string" &&
          readback.created_at.length > 0 &&
          readback.updated_at.length > 0,
        `row=${JSON.stringify(readback)}`,
      );

      // Need a second media to test a fully-populated row (UNIQUE on
      // media_id forbids two rows for the same media).
      const seeded2 = seedTripAndMedia(dbHandle.db, "P6.T1 second media");
      const aid2 = insertAnalysis(dbHandle.db, {
        mediaId: seeded2.mediaId,
        blurScore: 12.5,
        sharpnessScore: 0.74,
        exposureScore: 0.4,
        brightnessScore: 0.55,
        colorScore: 0.6,
        aestheticScore: 0.71,
        qualityScore: 0.82,
        isBlurry: 0,
        isDuplicate: 0,
        isRecommended: 1,
        labels: JSON.stringify(["sharp", "well-exposed"]),
        reason: "highest quality_score in cohort",
        rawResult: JSON.stringify({ laplacianVariance: 12.5, exposureRatio: 0.4 }),
      });
      record(
        "fresh: fully-populated media_analysis row accepted",
        typeof aid2 === "string" && aid2.length > 0,
        `id=${aid2}`,
      );

      // ---------------- UNIQUE (media_id) — 1:1 enforced ----------------
      expectThrow(
        "fresh: second insert for same media_id is rejected (1:1)",
        () => insertAnalysis(dbHandle.db, { mediaId: seeded.mediaId }),
        /UNIQUE constraint failed: media_analysis\.media_id/,
      );

      // ---------------- CHECK constraints ----------------
      // quality_score range
      expectThrow(
        "fresh: quality_score CHECK rejects > 1",
        () => {
          const tmp = seedTripAndMedia(dbHandle.db, "qs > 1");
          insertAnalysis(dbHandle.db, { mediaId: tmp.mediaId, qualityScore: 1.5 });
        },
        /CHECK constraint failed: media_analysis_quality_score_range/,
      );
      expectThrow(
        "fresh: quality_score CHECK rejects < 0",
        () => {
          const tmp = seedTripAndMedia(dbHandle.db, "qs < 0");
          insertAnalysis(dbHandle.db, { mediaId: tmp.mediaId, qualityScore: -0.01 });
        },
        /CHECK constraint failed: media_analysis_quality_score_range/,
      );

      // is_* flags CHECKs
      expectThrow(
        "fresh: is_blurry CHECK rejects value other than 0/1/NULL",
        () => {
          const tmp = seedTripAndMedia(dbHandle.db, "ib bad");
          dbHandle.db
            .prepare(`INSERT INTO media_analysis (id, media_id, is_blurry) VALUES (?, ?, ?)`)
            .run(randomUUID(), tmp.mediaId, 2);
        },
        /CHECK constraint failed: media_analysis_is_blurry_bool/,
      );
      expectThrow(
        "fresh: is_duplicate CHECK rejects value other than 0/1/NULL",
        () => {
          const tmp = seedTripAndMedia(dbHandle.db, "id bad");
          dbHandle.db
            .prepare(`INSERT INTO media_analysis (id, media_id, is_duplicate) VALUES (?, ?, ?)`)
            .run(randomUUID(), tmp.mediaId, 7);
        },
        /CHECK constraint failed: media_analysis_is_duplicate_bool/,
      );
      expectThrow(
        "fresh: is_recommended CHECK rejects value other than 0/1/NULL",
        () => {
          const tmp = seedTripAndMedia(dbHandle.db, "ir bad");
          dbHandle.db
            .prepare(`INSERT INTO media_analysis (id, media_id, is_recommended) VALUES (?, ?, ?)`)
            .run(randomUUID(), tmp.mediaId, -1);
        },
        /CHECK constraint failed: media_analysis_is_recommended_bool/,
      );

      // Raw component scores are intentionally unconstrained — accept
      // out-of-[0,1] values for things like raw Laplacian variance.
      {
        const tmp = seedTripAndMedia(dbHandle.db, "raw component scores unconstrained");
        const aid = insertAnalysis(dbHandle.db, {
          mediaId: tmp.mediaId,
          blurScore: 12345.6, // raw Laplacian variance
          sharpnessScore: -3.2,
          exposureScore: 17,
          brightnessScore: 280,
          colorScore: -55,
          aestheticScore: 9.9,
        });
        record(
          "fresh: blur/sharpness/exposure/brightness/color/aesthetic scores are unconstrained",
          typeof aid === "string" && aid.length > 0,
          `id=${aid}`,
        );
      }

      // ---------------- FK CASCADE on media delete ----------------
      // Delete seeded2.mediaId — its analysis row (aid2) should vanish.
      dbHandle.db.prepare(`DELETE FROM media_items WHERE id = ?`).run(seeded2.mediaId);
      const afterDelete = dbHandle.db
        .prepare(`SELECT COUNT(*) AS n FROM media_analysis WHERE id = ?`)
        .get(aid2) as { n: number };
      record(
        "fresh: media delete cascades to media_analysis",
        afterDelete.n === 0,
        `count=${afterDelete.n}`,
      );

      // The first analysis row (aid1) and unrelated media_items rows
      // are unaffected.
      const survivor = dbHandle.db
        .prepare(`SELECT COUNT(*) AS n FROM media_analysis WHERE id = ?`)
        .get(aid1) as { n: number };
      record(
        "fresh: unrelated media_analysis rows survive the cascade",
        survivor.n === 1,
        `count=${survivor.n}`,
      );

      // ---------------- P5 tables untouched ----------------
      const dupTables = dbHandle.db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('duplicate_groups', 'duplicate_group_items')`,
        )
        .all() as { name: string }[];
      record(
        "fresh: P5 duplicate_groups + duplicate_group_items remain present",
        dupTables.length === 2,
        `tables=${JSON.stringify(dupTables.map((t) => t.name).sort())}`,
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
    } finally {
      closeDatabase(dbHandle);
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }

  // ===================================================================
  // CASE GROUP B: upgrade scenario — stop at 007, then apply 008.
  // Pre-existing trip / media / duplicate_groups rows must survive.
  // ===================================================================
  {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-mig008-upgrade-"));
    const dbPath = path.join(tmpRoot, "upgrade.db");
    console.log(`[smoke] upgradeDbPath=${dbPath}`);

    let knownTripId = "";
    let knownMediaId = "";
    let knownGroupId = "";

    // ---- Stage 1: simulate previous release stopping at 007 ----
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
      ];
      for (const name of oldFiles) {
        const sql = await readFile(path.join(migrationsDir, name), "utf8");
        stage1.db.exec(sql);
        stage1.db.prepare(`INSERT INTO _schema_migrations (name) VALUES (?)`).run(name);
      }
      const seeded = seedTripAndMedia(stage1.db, "Pre-008 fixture");
      knownTripId = seeded.tripId;
      knownMediaId = seeded.mediaId;

      // Seed a duplicate_groups row to prove P5 data survives 008.
      knownGroupId = randomUUID();
      stage1.db
        .prepare(
          `INSERT INTO duplicate_groups (id, trip_id, group_type, recommended_media_id, confidence)
           VALUES (?, ?, 'similar', ?, 0.9)`,
        )
        .run(knownGroupId, knownTripId, knownMediaId);

      // Sanity: media_analysis should NOT exist before 008.
      const beforeTables = stage1.db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='media_analysis'`)
        .all() as { name: string }[];
      record(
        "upgrade-before: media_analysis does not exist on 007 schema",
        beforeTables.length === 0,
        `tables=${JSON.stringify(beforeTables)}`,
      );
    } finally {
      closeDatabase(stage1);
    }

    // ---- Stage 2: re-open, run migrations → only 008 should apply ----
    const stage2 = openDatabase(dbPath);
    try {
      const result = runMigrations(stage2.db);
      record(
        "upgrade: appliedNow contains exactly [008]",
        result.appliedNow.length === 1 && result.appliedNow[0] === "008_create_media_analysis.sql",
        `appliedNow=${JSON.stringify(result.appliedNow)}`,
      );

      // Existing trip + media rows untouched.
      const tripRow = stage2.db
        .prepare(`SELECT id, title FROM trips WHERE id = ?`)
        .get(knownTripId) as { id: string; title: string } | undefined;
      record(
        "upgrade: pre-existing trip preserved",
        tripRow?.id === knownTripId && tripRow?.title === "Pre-008 fixture",
        `trip=${JSON.stringify(tripRow)}`,
      );
      const mediaRow = stage2.db
        .prepare(`SELECT id, status FROM media_items WHERE id = ?`)
        .get(knownMediaId) as { id: string; status: string } | undefined;
      record(
        "upgrade: pre-existing media preserved",
        mediaRow?.id === knownMediaId && mediaRow?.status === "uploaded",
        `media=${JSON.stringify(mediaRow)}`,
      );

      // Pre-existing duplicate_groups row preserved.
      const groupRow = stage2.db
        .prepare(
          `SELECT id, group_type, recommended_media_id, confidence FROM duplicate_groups WHERE id = ?`,
        )
        .get(knownGroupId) as
        | { id: string; group_type: string; recommended_media_id: string; confidence: number }
        | undefined;
      record(
        "upgrade: pre-existing duplicate_groups row preserved (P5 data intact)",
        groupRow?.id === knownGroupId &&
          groupRow?.group_type === "similar" &&
          groupRow?.recommended_media_id === knownMediaId &&
          Math.abs((groupRow?.confidence ?? 0) - 0.9) < 1e-9,
        `group=${JSON.stringify(groupRow)}`,
      );

      // New table exists and accepts inserts after upgrade.
      const aid = insertAnalysis(stage2.db, {
        mediaId: knownMediaId,
        qualityScore: 0.77,
        isBlurry: 0,
        isRecommended: 1,
        reason: "P6.T1 smoke",
      });
      record(
        "upgrade: post-008 insert into media_analysis works",
        typeof aid === "string" && aid.length > 0,
        `id=${aid}`,
      );

      // FK + integrity clean post-008.
      const fkRows = stage2.db.prepare(`PRAGMA foreign_key_check`).all();
      record(
        "upgrade: PRAGMA foreign_key_check clean post-008",
        fkRows.length === 0,
        `rows=${JSON.stringify(fkRows)}`,
      );
      const integrity = stage2.db.prepare(`PRAGMA integrity_check`).all() as {
        integrity_check: string;
      }[];
      record(
        "upgrade: PRAGMA integrity_check ok post-008",
        integrity.length === 1 && integrity[0]?.integrity_check === "ok",
        `result=${JSON.stringify(integrity)}`,
      );

      // Idempotency: running again is a no-op.
      const again = runMigrations(stage2.db);
      record(
        "upgrade: re-running migrate is a no-op (008 already applied)",
        again.appliedNow.length === 0,
        `appliedNow=${JSON.stringify(again.appliedNow)}`,
      );

      // Deleting the seeded media cascades into the analysis row we
      // just inserted but leaves the duplicate_groups row alone
      // (recommended_media_id resets to NULL per 007 SET NULL FK).
      stage2.db.prepare(`DELETE FROM media_items WHERE id = ?`).run(knownMediaId);
      const analysisCount = stage2.db
        .prepare(`SELECT COUNT(*) AS n FROM media_analysis WHERE id = ?`)
        .get(aid) as { n: number };
      record(
        "upgrade: media delete cascades to media_analysis",
        analysisCount.n === 0,
        `count=${analysisCount.n}`,
      );
      const groupAfter = stage2.db
        .prepare(`SELECT recommended_media_id FROM duplicate_groups WHERE id = ?`)
        .get(knownGroupId) as { recommended_media_id: string | null } | undefined;
      record(
        "upgrade: duplicate_groups recommended_media_id resets to NULL (P5 SET NULL FK still wired)",
        groupAfter?.recommended_media_id === null,
        `recommended_media_id=${String(groupAfter?.recommended_media_id)}`,
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
