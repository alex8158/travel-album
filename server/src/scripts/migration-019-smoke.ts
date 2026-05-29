// Manual smoke test for migration 019 (P12.T2 — scene_groups).
//
// Usage: npm run smoke:migration-019
//
// Verifies:
//   * Fresh DB: 000..019 apply cleanly in one boot.
//   * `scene_groups` exists with the 12 columns from design.md §4.2
//     in spec order with the right NOT NULL flags.
//   * UNIQUE(trip_id, selection_round, group_index) enforced.
//   * member_count / selection_round / group_index >= 0 CHECK guards
//     fire.
//   * algorithm_version not-blank CHECK fires.
//   * FK trip_id ON DELETE CASCADE — deleting trip removes its groups.
//   * FK representative_media_id ON DELETE SET NULL — deleting the
//     representative media leaves the group in place with NULL rep.
//   * Re-running migrate is a no-op.

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

function seedTrip(db: SqliteDatabase, title = "Smoke 019 Trip"): string {
  const tripId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO trips (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
    tripId,
    title,
    now,
    now,
  );
  return tripId;
}

function seedImage(db: SqliteDatabase, tripId: string): string {
  const mediaId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO media_items
       (id, trip_id, type, original_path, mime_type, extension, file_size,
        status, user_decision, created_at, updated_at)
     VALUES (?, ?, 'image', ?, 'image/jpeg', 'jpg', 1234,
             'processed', 'undecided', ?, ?)`,
  ).run(mediaId, tripId, `trips/${tripId}/originals/${mediaId}.jpg`, now, now);
  return mediaId;
}

function insertGroup(
  db: SqliteDatabase,
  args: {
    id?: string;
    tripId: string;
    selectionRound?: number;
    groupIndex?: number;
    representativeMediaId?: string | null;
    memberCount?: number;
    algorithmVersion?: string;
  },
): string {
  const id = args.id ?? randomUUID();
  db.prepare(
    `INSERT INTO scene_groups
       (id, trip_id, selection_round, group_index,
        captured_at_start, captured_at_end,
        gps_center_lat, gps_center_lon,
        representative_media_id, member_count, algorithm_version)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`,
  ).run(
    id,
    args.tripId,
    args.selectionRound ?? 1,
    args.groupIndex ?? 0,
    args.representativeMediaId ?? null,
    args.memberCount ?? 0,
    args.algorithmVersion ?? "code-time-gps-1.0",
  );
  return id;
}

async function main(): Promise<void> {
  // ====================================================================
  // CASE GROUP A: fresh DB applies 000..019; schema present
  // ====================================================================
  {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-mig019-fresh-"));
    const dbPath = path.join(tmpRoot, "fresh.db");
    const dbHandle = openDatabase(dbPath);
    try {
      const result = runMigrations(dbHandle.db);
      record(
        "fresh: 019 included in appliedNow",
        result.appliedNow.includes("019_create_scene_groups.sql"),
        `appliedNow.last=${result.appliedNow[result.appliedNow.length - 1] ?? ""}`,
      );

      // Schema: 12 columns in spec order.
      const cols = dbHandle.db.prepare(`PRAGMA table_info(scene_groups)`).all() as {
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }[];
      const colNames = cols.map((c) => c.name);
      const expectedCols = [
        "id",
        "trip_id",
        "selection_round",
        "group_index",
        "captured_at_start",
        "captured_at_end",
        "gps_center_lat",
        "gps_center_lon",
        "representative_media_id",
        "member_count",
        "algorithm_version",
        "created_at",
      ];
      record(
        "fresh: scene_groups has 12 columns in spec order",
        JSON.stringify(colNames) === JSON.stringify(expectedCols),
        `columns=${JSON.stringify(colNames)}`,
      );

      // Required NOT NULL columns.
      const requiredNotNull = [
        "id",
        "trip_id",
        "selection_round",
        "group_index",
        "member_count",
        "algorithm_version",
        "created_at",
      ];
      const notNullOk = requiredNotNull.every((name) => {
        const c = cols.find((x) => x.name === name);
        return c?.notnull === 1;
      });
      record(
        "fresh: required columns are NOT NULL",
        notNullOk,
        `notnull check ok=${notNullOk}`,
      );

      // Indexes (drop the auto PK index from the count).
      const idxRows = dbHandle.db
        .prepare(`PRAGMA index_list('scene_groups')`)
        .all() as { name: string }[];
      const idxNames = idxRows
        .map((r) => r.name)
        .filter((n) => !n.startsWith("sqlite_autoindex_"))
        .sort();
      const expectedIdxNames = [
        "idx_scene_groups_representative_media",
        "idx_scene_groups_trip_round_index",
      ].sort();
      record(
        "fresh: 2 named indexes present (UNIQUE trip+round+index + representative_media)",
        JSON.stringify(idxNames) === JSON.stringify(expectedIdxNames),
        `idx=${JSON.stringify(idxNames)}`,
      );

      const integrity = dbHandle.db.prepare(`PRAGMA integrity_check`).get() as {
        integrity_check: string;
      };
      record("fresh: integrity_check === 'ok'", integrity.integrity_check === "ok", integrity.integrity_check);

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
  // CASE GROUP B: CHECK constraints + UNIQUE enforced
  // ====================================================================
  {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-mig019-check-"));
    const dbPath = path.join(tmpRoot, "c.db");
    const dbHandle = openDatabase(dbPath);
    try {
      runMigrations(dbHandle.db);
      const tripId = seedTrip(dbHandle.db);

      // Happy: round=1, group_index=0
      const g0 = insertGroup(dbHandle.db, { tripId, selectionRound: 1, groupIndex: 0 });
      record(
        "check: insert with valid round + group_index succeeds",
        g0.length > 0,
        `id=${g0.slice(0, 8)}`,
      );

      // UNIQUE(trip_id, selection_round, group_index) fires.
      expectThrow(
        "check: duplicate (trip, round, group_index) rejected by UNIQUE",
        () => insertGroup(dbHandle.db, { tripId, selectionRound: 1, groupIndex: 0 }),
        /UNIQUE constraint failed/i,
      );

      // CHECK selection_round >= 0 fires on -1.
      expectThrow(
        "check: selection_round = -1 rejected",
        () => insertGroup(dbHandle.db, { tripId, selectionRound: -1, groupIndex: 1 }),
        /CHECK constraint failed/i,
      );

      // CHECK group_index >= 0 fires on -1.
      expectThrow(
        "check: group_index = -1 rejected",
        () => insertGroup(dbHandle.db, { tripId, selectionRound: 1, groupIndex: -1 }),
        /CHECK constraint failed/i,
      );

      // CHECK member_count >= 0 fires on -1.
      expectThrow(
        "check: member_count = -1 rejected",
        () => insertGroup(dbHandle.db, { tripId, selectionRound: 2, groupIndex: 0, memberCount: -1 }),
        /CHECK constraint failed/i,
      );

      // CHECK algorithm_version not-blank fires on ''.
      expectThrow(
        "check: algorithm_version = '' rejected",
        () => insertGroup(dbHandle.db, { tripId, selectionRound: 2, groupIndex: 0, algorithmVersion: "" }),
        /CHECK constraint failed/i,
      );

      // selection_round=0 IS allowed (reserved for user override layer
      // in curated_selections, but scene_groups doesn't restrict it).
      const g00 = insertGroup(dbHandle.db, { tripId, selectionRound: 0, groupIndex: 0 });
      record(
        "check: selection_round = 0 allowed (no restriction in scene_groups itself)",
        g00.length > 0,
        "ok",
      );

      // Different round can re-use the same group_index.
      const g1 = insertGroup(dbHandle.db, { tripId, selectionRound: 2, groupIndex: 0 });
      record(
        "check: different round can re-use group_index=0",
        g1.length > 0,
        "ok",
      );
    } finally {
      closeDatabase(dbHandle);
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }

  // ====================================================================
  // CASE GROUP C: FK behaviours
  // ====================================================================
  {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-mig019-fk-"));
    const dbPath = path.join(tmpRoot, "c.db");
    const dbHandle = openDatabase(dbPath);
    try {
      runMigrations(dbHandle.db);
      const tripId = seedTrip(dbHandle.db);
      const mediaId = seedImage(dbHandle.db, tripId);

      const groupId = insertGroup(dbHandle.db, {
        tripId,
        selectionRound: 1,
        groupIndex: 0,
        representativeMediaId: mediaId,
      });

      // representative SET NULL on media delete.
      dbHandle.db.prepare(`DELETE FROM media_items WHERE id = ?`).run(mediaId);
      const afterMediaDelete = dbHandle.db
        .prepare(`SELECT representative_media_id FROM scene_groups WHERE id = ?`)
        .get(groupId) as { representative_media_id: string | null };
      record(
        "fk: representative_media_id → SET NULL on media delete; group survives",
        afterMediaDelete.representative_media_id === null,
        `rep=${String(afterMediaDelete.representative_media_id)}`,
      );

      // Trip CASCADE: deleting the trip removes the group.
      dbHandle.db.prepare(`DELETE FROM trips WHERE id = ?`).run(tripId);
      const afterTripDelete = dbHandle.db
        .prepare(`SELECT COUNT(*) AS n FROM scene_groups WHERE id = ?`)
        .get(groupId) as { n: number };
      record(
        "fk: scene_groups CASCADE on trip delete (group row gone)",
        afterTripDelete.n === 0,
        `count=${afterTripDelete.n}`,
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
