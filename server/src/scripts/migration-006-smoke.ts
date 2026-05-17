// Manual smoke test for migration 006 (P3.T5).
//
// Usage: npm run smoke:migration-006
//
// Verifies the user-spec acceptance points for the migration:
//   * Fresh DB: 001..006 apply cleanly in one boot.
//   * Existing DB stopped at 005: upgrading to 006 keeps pre-existing
//     `'thumbnail'` / `'preview'` rows intact (no data loss).
//   * After upgrade, `version_type='metadata'` rows can be inserted.
//   * After upgrade, the original enum values still insert (i.e. the
//     enum is a superset, not a replacement).
//   * After upgrade, an unknown `version_type` is still rejected by
//     the CHECK constraint.
//   * Indexes from 005 are recreated on the rebuilt table.
//   * `foreign_key_check` + `integrity_check` clean after the rebuild.
//
// Migration 006 itself does a 12-step table rebuild (see SQL header);
// these smokes prove the rebuild does not silently drop anything.

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

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

function seedTripAndMedia(db: SqliteDatabase): { tripId: string; mediaId: string } {
  const tripId = randomUUID();
  const mediaId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO trips (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
    tripId,
    "006 Smoke Trip",
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

function insertVersion(
  db: SqliteDatabase,
  args: { mediaId: string; versionType: string; filePath: string },
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO media_versions (id, media_id, version_type, file_path)
     VALUES (?, ?, ?, ?)`,
  ).run(id, args.mediaId, args.versionType, args.filePath);
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
  // ===================================================================
  // CASE GROUP A: fresh DB applies 001..006 in one shot
  // ===================================================================
  {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-mig006-fresh-"));
    const dbPath = path.join(tmpRoot, "fresh.db");
    const dbHandle = openDatabase(dbPath);
    try {
      const result = runMigrations(dbHandle.db);
      // We check 006 is included rather than a hard-coded length so
      // the assertion stays correct as later migrations land on top
      // of 006 (e.g. P5.T1 added 007).
      record(
        "fresh: 001..006 all in appliedNow (includes 006)",
        result.appliedNow.includes("006_extend_media_versions_version_type.sql"),
        `appliedNow=${JSON.stringify(result.appliedNow)}`,
      );

      const { mediaId } = seedTripAndMedia(dbHandle.db);
      // After 006, ALL eight enum values must accept.
      const allValues = [
        "original",
        "thumbnail",
        "preview",
        "enhanced",
        "ai_refined",
        "video_cover",
        "video_proxy",
        "metadata",
      ];
      const acceptedCount = allValues.filter((vt) => {
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
        "fresh: all 8 enum values accepted (incl. 'metadata')",
        acceptedCount === 8,
        `accepted=${acceptedCount}/8`,
      );

      // Unknown value still rejected.
      expectThrow(
        "fresh: unknown version_type still rejected by CHECK",
        () =>
          insertVersion(dbHandle.db, {
            mediaId,
            versionType: "definitely_not_real",
            filePath: "trips/x/derived/whatever.bin",
          }),
        /CHECK constraint failed: media_versions_version_type_enum/,
      );
    } finally {
      closeDatabase(dbHandle);
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }

  // ===================================================================
  // CASE GROUP B: upgrade scenario — stop at 005, then apply 006.
  // Pre-existing thumbnail / preview rows must survive untouched.
  // ===================================================================
  {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-mig006-upgrade-"));
    const dbPath = path.join(tmpRoot, "upgrade.db");
    console.log(`[smoke] upgradeDbPath=${dbPath}`);

    // ---- Stage 1: simulate "previous release" stopping at 005 ----
    const stage1 = openDatabase(dbPath);
    let knownThumbId = "";
    let knownPreviewId = "";
    let knownMediaId = "";
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
      ];
      for (const name of oldFiles) {
        const sql = await readFile(path.join(migrationsDir, name), "utf8");
        stage1.db.exec(sql);
        stage1.db.prepare(`INSERT INTO _schema_migrations (name) VALUES (?)`).run(name);
      }

      const seeded = seedTripAndMedia(stage1.db);
      knownMediaId = seeded.mediaId;
      knownThumbId = insertVersion(stage1.db, {
        mediaId: seeded.mediaId,
        versionType: "thumbnail",
        filePath: `trips/x/derived/${seeded.mediaId}/thumb.webp`,
      });
      knownPreviewId = insertVersion(stage1.db, {
        mediaId: seeded.mediaId,
        versionType: "preview",
        filePath: `trips/x/derived/${seeded.mediaId}/preview.webp`,
      });
      // Cache some recognisable columns on those rows so the rebuild
      // can be verified to preserve them byte-for-byte.
      stage1.db
        .prepare(
          `UPDATE media_versions
           SET mime_type='image/webp', width=320, height=240, file_size=4096,
               params='{"sharpVersion":"test","quality":80}'
           WHERE id = ?`,
        )
        .run(knownThumbId);

      // 005 must reject `'metadata'` BEFORE upgrade.
      expectThrow(
        "upgrade-before: 'metadata' rejected on the 005 schema",
        () =>
          insertVersion(stage1.db, {
            mediaId: seeded.mediaId,
            versionType: "metadata",
            filePath: "trips/x/derived/metadata.json",
          }),
        /CHECK constraint failed: media_versions_version_type_enum/,
      );
    } finally {
      closeDatabase(stage1);
    }

    // ---- Stage 2: re-open, run migrations → 006 (and anything
    // newer than 006) should apply. We check 006 is FIRST in
    // appliedNow rather than the sole entry so the smoke stays
    // correct as later migrations land on top of 006 (e.g. P5.T1
    // added 007).
    const stage2 = openDatabase(dbPath);
    try {
      const result = runMigrations(stage2.db);
      record(
        "upgrade: appliedNow starts with 006 (006 is the first pending migration)",
        result.appliedNow[0] === "006_extend_media_versions_version_type.sql",
        `appliedNow=${JSON.stringify(result.appliedNow)}`,
      );

      // Existing rows preserved
      const thumbRow = stage2.db
        .prepare(`SELECT * FROM media_versions WHERE id = ?`)
        .get(knownThumbId) as Record<string, unknown> | undefined;
      record(
        "upgrade: thumbnail row preserved with same id",
        thumbRow?.id === knownThumbId &&
          thumbRow?.version_type === "thumbnail" &&
          thumbRow?.media_id === knownMediaId,
        `id=${String(thumbRow?.id)} type=${String(thumbRow?.version_type)}`,
      );
      record(
        "upgrade: thumbnail row column values byte-for-byte preserved",
        thumbRow?.mime_type === "image/webp" &&
          thumbRow?.width === 320 &&
          thumbRow?.height === 240 &&
          thumbRow?.file_size === 4096 &&
          thumbRow?.params === '{"sharpVersion":"test","quality":80}' &&
          thumbRow?.status === "ready",
        `width=${String(thumbRow?.width)} mime=${String(thumbRow?.mime_type)} params=${String(thumbRow?.params)}`,
      );
      const previewRow = stage2.db
        .prepare(`SELECT * FROM media_versions WHERE id = ?`)
        .get(knownPreviewId) as Record<string, unknown> | undefined;
      record(
        "upgrade: preview row preserved",
        previewRow?.id === knownPreviewId && previewRow?.version_type === "preview",
        `id=${String(previewRow?.id)} type=${String(previewRow?.version_type)}`,
      );
      const allRows = stage2.db.prepare(`SELECT COUNT(*) AS n FROM media_versions`).get() as {
        n: number;
      };
      record("upgrade: row count unchanged across rebuild", allRows.n === 2, `count=${allRows.n}`);

      // After upgrade, 'metadata' must accept.
      const metaId = insertVersion(stage2.db, {
        mediaId: knownMediaId,
        versionType: "metadata",
        filePath: `trips/x/originals/${knownMediaId}.jpg`,
      });
      record(
        "upgrade: 'metadata' now accepted post-006",
        typeof metaId === "string" && metaId.length > 0,
        `id=${metaId}`,
      );

      // Other enum values still accepted.
      const seedB = seedTripAndMedia(stage2.db);
      let acceptedAfter = 0;
      for (const vt of [
        "original",
        "thumbnail",
        "preview",
        "enhanced",
        "ai_refined",
        "video_cover",
        "video_proxy",
      ]) {
        try {
          const fresh = seedTripAndMedia(stage2.db);
          insertVersion(stage2.db, {
            mediaId: fresh.mediaId,
            versionType: vt,
            filePath: `trips/x/derived/${fresh.mediaId}/${vt}.bin`,
          });
          acceptedAfter += 1;
        } catch {
          /* unexpected — accepted stays under 7 */
        }
      }
      record(
        "upgrade: pre-existing 7 enum values still accepted",
        acceptedAfter === 7,
        `accepted=${acceptedAfter}/7`,
      );

      // Unknown still rejected.
      expectThrow(
        "upgrade: unknown version_type still rejected post-006",
        () =>
          insertVersion(stage2.db, {
            mediaId: seedB.mediaId,
            versionType: "still_not_real",
            filePath: "trips/x/derived/x.bin",
          }),
        /CHECK constraint failed: media_versions_version_type_enum/,
      );

      // Indexes preserved by name + uniqueness flag.
      const idx = stage2.db.prepare(`PRAGMA index_list(media_versions)`).all() as {
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
        "upgrade: all 4 indexes recreated on rebuilt table",
        expected.every((e) => names.includes(e)),
        `indexes=${JSON.stringify(names)}`,
      );
      const composite = idx.find((i) => i.name === "idx_media_versions_media_version");
      record(
        "upgrade: composite index still UNIQUE",
        composite !== undefined && composite.unique === 1,
        `unique=${String(composite?.unique)}`,
      );

      // FK + integrity clean.
      const fkRows = stage2.db.prepare(`PRAGMA foreign_key_check`).all();
      record(
        "upgrade: PRAGMA foreign_key_check clean",
        fkRows.length === 0,
        `rows=${JSON.stringify(fkRows)}`,
      );
      const integrity = stage2.db.prepare(`PRAGMA integrity_check`).all() as {
        integrity_check: string;
      }[];
      record(
        "upgrade: PRAGMA integrity_check ok",
        integrity.length === 1 && integrity[0]?.integrity_check === "ok",
        `result=${JSON.stringify(integrity)}`,
      );

      // CASCADE still works on the rebuilt table.
      stage2.db.prepare(`DELETE FROM media_items WHERE id = ?`).run(knownMediaId);
      const remaining = stage2.db
        .prepare(`SELECT COUNT(*) AS n FROM media_versions WHERE media_id = ?`)
        .get(knownMediaId) as { n: number };
      record(
        "upgrade: ON DELETE CASCADE still wires through after rebuild",
        remaining.n === 0,
        `remaining=${remaining.n}`,
      );

      // Idempotency: running again is a no-op.
      const again = runMigrations(stage2.db);
      record(
        "upgrade: re-running migrate is a no-op (006 already applied)",
        again.appliedNow.length === 0,
        `appliedNow=${JSON.stringify(again.appliedNow)}`,
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
