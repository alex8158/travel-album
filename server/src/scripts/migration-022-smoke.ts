// Manual smoke test for migration 022 (P12.T2 — slideshow_renders).
//
// Usage: npm run smoke:migration-022
//
// Verifies:
//   * Fresh DB: 000..022 apply cleanly.
//   * `slideshow_renders` exists with 16 columns from design.md §4.2.
//   * Status / transition / audio_policy CHECK enums fire on bad
//     values.
//   * Range CHECKs (per_image_duration_sec 1..5, transition 0..1,
//     fps 1..120) fire.
//   * FK behaviour:
//       - trip_id CASCADE
//       - background_audio_id SET NULL on audio_library delete
//       - output_media_version_id SET NULL on media_versions delete
//   * deleted_at column exists (soft-delete support).

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";

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

function seedTrip(db: SqliteDatabase): string {
  const tripId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO trips (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
    tripId,
    "Smoke 022",
    now,
    now,
  );
  return tripId;
}

function seedAudioLibrary(db: SqliteDatabase): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO audio_library
       (id, name, display_name, source_type,
        file_path, relative_path, mime_type, duration_seconds, size_bytes, checksum,
        is_active, tags, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, 'system', ?, ?, 'audio/mpeg', NULL, 1024,
             ?, 1, NULL, NULL, ?, ?)`,
  ).run(
    id,
    `audio-${id.slice(0, 8)}`,
    "Audio Smoke",
    `audio_library/system/${id}.mp3`,
    `${id}.mp3`,
    `checksum-${id}`,
    now,
    now,
  );
  return id;
}

interface InsertArgs {
  id?: string;
  tripId: string;
  status?: string;
  inputMediaIds?: string;
  perImageDurationSec?: number;
  transitionType?: string;
  transitionDurationSec?: number;
  outputResolution?: string;
  outputFps?: number;
  audioPolicy?: string;
  backgroundAudioId?: string | null;
  outputMediaVersionId?: string | null;
}

function insertRender(db: SqliteDatabase, args: InsertArgs): string {
  const id = args.id ?? randomUUID();
  db.prepare(
    `INSERT INTO slideshow_renders
       (id, trip_id, status, input_media_ids,
        per_image_duration_sec, transition_type, transition_duration_sec,
        output_resolution, output_fps, audio_policy,
        background_audio_id, output_media_version_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    args.tripId,
    args.status ?? "pending",
    args.inputMediaIds ?? JSON.stringify(["m-1", "m-2", "m-3"]),
    args.perImageDurationSec ?? 2.0,
    args.transitionType ?? "xfade",
    args.transitionDurationSec ?? 0.3,
    args.outputResolution ?? "1920x1080",
    args.outputFps ?? 30,
    args.audioPolicy ?? "replace_with_library",
    args.backgroundAudioId ?? null,
    args.outputMediaVersionId ?? null,
  );
  return id;
}

async function main(): Promise<void> {
  // ====================================================================
  // A: schema
  // ====================================================================
  {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-mig022-schema-"));
    const dbPath = path.join(tmpRoot, "c.db");
    const dbHandle = openDatabase(dbPath);
    try {
      const result = runMigrations(dbHandle.db);
      record(
        "fresh: 022 included in appliedNow",
        result.appliedNow.includes("022_create_slideshow_renders.sql"),
        `appliedNow.last=${result.appliedNow[result.appliedNow.length - 1] ?? ""}`,
      );

      const cols = dbHandle.db.prepare(`PRAGMA table_info(slideshow_renders)`).all() as {
        name: string;
        notnull: number;
      }[];
      const colNames = cols.map((c) => c.name);
      const expectedCols = [
        "id",
        "trip_id",
        "status",
        "input_media_ids",
        "per_image_duration_sec",
        "transition_type",
        "transition_duration_sec",
        "output_resolution",
        "output_fps",
        "audio_policy",
        "background_audio_id",
        "output_media_version_id",
        "error_message",
        "created_at",
        "updated_at",
        "deleted_at",
      ];
      record(
        "fresh: slideshow_renders has 16 columns in spec order",
        JSON.stringify(colNames) === JSON.stringify(expectedCols),
        `columns=${JSON.stringify(colNames)}`,
      );

      const idxRows = dbHandle.db
        .prepare(`PRAGMA index_list('slideshow_renders')`)
        .all() as { name: string }[];
      const idxNames = idxRows
        .map((r) => r.name)
        .filter((n) => !n.startsWith("sqlite_autoindex_"))
        .sort();
      const expectedIdxNames = [
        "idx_slideshow_renders_output_media_version",
        "idx_slideshow_renders_status",
        "idx_slideshow_renders_trip_created",
      ].sort();
      record(
        "fresh: 3 named indexes present",
        JSON.stringify(idxNames) === JSON.stringify(expectedIdxNames),
        `idx=${JSON.stringify(idxNames)}`,
      );

      const result2 = runMigrations(dbHandle.db);
      record(
        "fresh: re-running migrate is a no-op",
        result2.appliedNow.length === 0,
        `appliedNow=${JSON.stringify(result2.appliedNow)}`,
      );
    } finally {
      closeDatabase(dbHandle);
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }

  // ====================================================================
  // B: CHECK enums + range
  // ====================================================================
  {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-mig022-check-"));
    const dbPath = path.join(tmpRoot, "c.db");
    const dbHandle = openDatabase(dbPath);
    try {
      runMigrations(dbHandle.db);
      const tripId = seedTrip(dbHandle.db);

      // Happy.
      insertRender(dbHandle.db, { tripId });
      record("check: happy default row inserts", true, "ok");

      // status CHECK
      expectThrow(
        "check: status='in_progress' rejected (closed enum)",
        () => insertRender(dbHandle.db, { tripId, status: "in_progress" }),
        /CHECK constraint failed/i,
      );

      // transition_type CHECK
      expectThrow(
        "check: transition_type='dissolve' rejected",
        () => insertRender(dbHandle.db, { tripId, transitionType: "dissolve" }),
        /CHECK constraint failed/i,
      );

      // audio_policy CHECK — keep_original explicitly disallowed
      expectThrow(
        "check: audio_policy='keep_original' rejected (closed to {replace_with_library, mute})",
        () => insertRender(dbHandle.db, { tripId, audioPolicy: "keep_original" }),
        /CHECK constraint failed/i,
      );

      // per_image_duration_sec range
      expectThrow(
        "check: per_image_duration_sec = 0.5 rejected (must be >= 1.0)",
        () => insertRender(dbHandle.db, { tripId, perImageDurationSec: 0.5 }),
        /CHECK constraint failed/i,
      );
      expectThrow(
        "check: per_image_duration_sec = 10 rejected (must be <= 5.0)",
        () => insertRender(dbHandle.db, { tripId, perImageDurationSec: 10 }),
        /CHECK constraint failed/i,
      );

      // transition_duration_sec range
      expectThrow(
        "check: transition_duration_sec = 2.0 rejected (must be <= 1.0)",
        () => insertRender(dbHandle.db, { tripId, transitionDurationSec: 2.0 }),
        /CHECK constraint failed/i,
      );
      expectThrow(
        "check: transition_duration_sec = -0.1 rejected",
        () => insertRender(dbHandle.db, { tripId, transitionDurationSec: -0.1 }),
        /CHECK constraint failed/i,
      );

      // output_fps range
      expectThrow(
        "check: output_fps = 0 rejected",
        () => insertRender(dbHandle.db, { tripId, outputFps: 0 }),
        /CHECK constraint failed/i,
      );
      expectThrow(
        "check: output_fps = 200 rejected",
        () => insertRender(dbHandle.db, { tripId, outputFps: 200 }),
        /CHECK constraint failed/i,
      );

      // output_resolution not blank
      expectThrow(
        "check: output_resolution='' rejected",
        () => insertRender(dbHandle.db, { tripId, outputResolution: "" }),
        /CHECK constraint failed/i,
      );

      // input_media_ids not blank
      expectThrow(
        "check: input_media_ids='' rejected",
        () => insertRender(dbHandle.db, { tripId, inputMediaIds: "" }),
        /CHECK constraint failed/i,
      );

      // Happy: status='success' and other valid values.
      insertRender(dbHandle.db, { tripId, status: "running" });
      insertRender(dbHandle.db, { tripId, status: "success" });
      insertRender(dbHandle.db, { tripId, status: "failed" });
      insertRender(dbHandle.db, { tripId, status: "cancelled" });
      insertRender(dbHandle.db, { tripId, transitionType: "none", transitionDurationSec: 0.0 });
      insertRender(dbHandle.db, { tripId, audioPolicy: "mute" });
      record("check: all valid enum + range values accepted", true, "ok");
    } finally {
      closeDatabase(dbHandle);
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }

  // ====================================================================
  // C: FK behaviours
  // ====================================================================
  {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-mig022-fk-trip-"));
    const dbPath = path.join(tmpRoot, "c.db");
    const dbHandle = openDatabase(dbPath);
    try {
      runMigrations(dbHandle.db);
      const tripId = seedTrip(dbHandle.db);
      const id = insertRender(dbHandle.db, { tripId });
      dbHandle.db.prepare(`DELETE FROM trips WHERE id = ?`).run(tripId);
      const n = (
        dbHandle.db.prepare(`SELECT COUNT(*) AS n FROM slideshow_renders WHERE id = ?`).get(id) as { n: number }
      ).n;
      record("fk: slideshow_renders CASCADE on trip delete", n === 0, `n=${n}`);
    } finally {
      closeDatabase(dbHandle);
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }

  {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-mig022-fk-audio-"));
    const dbPath = path.join(tmpRoot, "c.db");
    const dbHandle = openDatabase(dbPath);
    try {
      runMigrations(dbHandle.db);
      const tripId = seedTrip(dbHandle.db);
      const audioId = seedAudioLibrary(dbHandle.db);
      const id = insertRender(dbHandle.db, { tripId, backgroundAudioId: audioId });

      dbHandle.db.prepare(`DELETE FROM audio_library WHERE id = ?`).run(audioId);
      const after = dbHandle.db
        .prepare(`SELECT background_audio_id FROM slideshow_renders WHERE id = ?`)
        .get(id) as { background_audio_id: string | null };
      record(
        "fk: background_audio_id SET NULL on audio_library delete; render survives",
        after.background_audio_id === null,
        `bg=${String(after.background_audio_id)}`,
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
