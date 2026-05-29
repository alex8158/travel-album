// Manual smoke test for migration 020 (P12.T2 — scene_group_items).
//
// Usage: npm run smoke:migration-020
//
// Verifies:
//   * Fresh DB: 000..020 apply cleanly.
//   * `scene_group_items` exists with 9 columns from design.md §4.2
//     in spec order with the right NOT NULL flags.
//   * UNIQUE(scene_group_id, media_id) enforced.
//   * UNIQUE(scene_group_id, rank_in_group) enforced.
//   * selection_round >= 0 / rank_in_group >= 0 CHECK fire.
//   * FK scene_group_id ON DELETE CASCADE — deleting group removes items.
//   * FK media_id ON DELETE CASCADE — deleting media removes items.

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

function seedFixture(db: SqliteDatabase): { tripId: string; mediaIds: string[]; groupId: string } {
  const now = new Date().toISOString();
  const tripId = randomUUID();
  db.prepare(`INSERT INTO trips (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
    tripId,
    "Smoke 020",
    now,
    now,
  );
  const mediaIds: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO media_items
         (id, trip_id, type, original_path, mime_type, extension, file_size,
          status, user_decision, created_at, updated_at)
       VALUES (?, ?, 'image', ?, 'image/jpeg', 'jpg', 1024,
               'processed', 'undecided', ?, ?)`,
    ).run(id, tripId, `trips/${tripId}/originals/${id}.jpg`, now, now);
    mediaIds.push(id);
  }
  const groupId = randomUUID();
  db.prepare(
    `INSERT INTO scene_groups
       (id, trip_id, selection_round, group_index, member_count, algorithm_version)
     VALUES (?, ?, 1, 0, 0, 'code-time-gps-1.0')`,
  ).run(groupId, tripId);
  return { tripId, mediaIds, groupId };
}

function insertItem(
  db: SqliteDatabase,
  args: {
    id?: string;
    sceneGroupId: string;
    mediaId: string;
    selectionRound?: number;
    rankInGroup?: number;
    groupScore?: number | null;
    similarityScore?: number | null;
    reason?: string | null;
  },
): string {
  const id = args.id ?? randomUUID();
  db.prepare(
    `INSERT INTO scene_group_items
       (id, scene_group_id, media_id, selection_round,
        group_score, similarity_score, rank_in_group, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    args.sceneGroupId,
    args.mediaId,
    args.selectionRound ?? 1,
    args.groupScore ?? null,
    args.similarityScore ?? null,
    args.rankInGroup ?? 0,
    args.reason ?? null,
  );
  return id;
}

async function main(): Promise<void> {
  // ====================================================================
  // CASE GROUP A: schema
  // ====================================================================
  {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-mig020-schema-"));
    const dbPath = path.join(tmpRoot, "c.db");
    const dbHandle = openDatabase(dbPath);
    try {
      const result = runMigrations(dbHandle.db);
      record(
        "fresh: 020 included in appliedNow",
        result.appliedNow.includes("020_create_scene_group_items.sql"),
        `appliedNow.last=${result.appliedNow[result.appliedNow.length - 1] ?? ""}`,
      );

      const cols = dbHandle.db.prepare(`PRAGMA table_info(scene_group_items)`).all() as {
        name: string;
        notnull: number;
        pk: number;
      }[];
      const colNames = cols.map((c) => c.name);
      const expectedCols = [
        "id",
        "scene_group_id",
        "media_id",
        "selection_round",
        "group_score",
        "similarity_score",
        "rank_in_group",
        "reason",
        "created_at",
      ];
      record(
        "fresh: scene_group_items has 9 columns in spec order",
        JSON.stringify(colNames) === JSON.stringify(expectedCols),
        `columns=${JSON.stringify(colNames)}`,
      );

      const requiredNotNull = ["id", "scene_group_id", "media_id", "selection_round", "rank_in_group", "created_at"];
      const ok = requiredNotNull.every((n) => cols.find((c) => c.name === n)?.notnull === 1);
      record("fresh: required columns NOT NULL", ok, `ok=${ok}`);

      const idxRows = dbHandle.db
        .prepare(`PRAGMA index_list('scene_group_items')`)
        .all() as { name: string }[];
      const idxNames = idxRows
        .map((r) => r.name)
        .filter((n) => !n.startsWith("sqlite_autoindex_"))
        .sort();
      const expectedIdxNames = [
        "idx_scene_group_items_group_media",
        "idx_scene_group_items_group_rank",
        "idx_scene_group_items_media",
      ].sort();
      record(
        "fresh: 3 named indexes present (2 UNIQUE + 1 reverse)",
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
  // CASE GROUP B: UNIQUE + CHECK
  // ====================================================================
  {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-mig020-check-"));
    const dbPath = path.join(tmpRoot, "c.db");
    const dbHandle = openDatabase(dbPath);
    try {
      runMigrations(dbHandle.db);
      const { mediaIds, groupId } = seedFixture(dbHandle.db);

      // Happy: 3 rows with rank 0, 1, 2
      for (let i = 0; i < mediaIds.length; i += 1) {
        // mediaIds[i] guaranteed by loop bounds (mediaIds.length = 3)
        const mediaId = mediaIds[i];
        if (mediaId === undefined) continue;
        insertItem(dbHandle.db, {
          sceneGroupId: groupId,
          mediaId,
          rankInGroup: i,
        });
      }
      const count = (
        dbHandle.db.prepare(`SELECT COUNT(*) AS n FROM scene_group_items WHERE scene_group_id = ?`).get(groupId) as { n: number }
      ).n;
      record("check: 3 happy rows inserted", count === 3, `n=${count}`);

      // UNIQUE(scene_group_id, media_id) — second insert for same media in same group rejected.
      const m0 = mediaIds[0];
      if (m0) {
        expectThrow(
          "check: duplicate (scene_group_id, media_id) rejected by UNIQUE",
          () => insertItem(dbHandle.db, { sceneGroupId: groupId, mediaId: m0, rankInGroup: 99 }),
          /UNIQUE constraint failed/i,
        );
      }

      // UNIQUE(scene_group_id, rank_in_group) — different media, same rank rejected.
      const newMediaId = (() => {
        const id = randomUUID();
        const now = new Date().toISOString();
        // need a trip context for the new media; reuse the existing trip
        const tripRow = dbHandle.db
          .prepare(`SELECT trip_id FROM scene_groups WHERE id = ?`)
          .get(groupId) as { trip_id: string };
        dbHandle.db
          .prepare(
            `INSERT INTO media_items
               (id, trip_id, type, original_path, mime_type, extension, file_size,
                status, user_decision, created_at, updated_at)
             VALUES (?, ?, 'image', ?, 'image/jpeg', 'jpg', 1024,
                     'processed', 'undecided', ?, ?)`,
          )
          .run(id, tripRow.trip_id, `trips/${tripRow.trip_id}/originals/${id}.jpg`, now, now);
        return id;
      })();
      expectThrow(
        "check: duplicate (scene_group_id, rank_in_group) rejected by UNIQUE",
        () => insertItem(dbHandle.db, { sceneGroupId: groupId, mediaId: newMediaId, rankInGroup: 0 }),
        /UNIQUE constraint failed/i,
      );

      // CHECK selection_round >= 0
      expectThrow(
        "check: selection_round = -1 rejected",
        () => insertItem(dbHandle.db, { sceneGroupId: groupId, mediaId: newMediaId, selectionRound: -1, rankInGroup: 5 }),
        /CHECK constraint failed/i,
      );

      // CHECK rank_in_group >= 0
      expectThrow(
        "check: rank_in_group = -1 rejected",
        () => insertItem(dbHandle.db, { sceneGroupId: groupId, mediaId: newMediaId, rankInGroup: -1 }),
        /CHECK constraint failed/i,
      );
    } finally {
      closeDatabase(dbHandle);
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }

  // ====================================================================
  // CASE GROUP C: FK CASCADE behaviours
  // ====================================================================
  {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-mig020-fk-group-"));
    const dbPath = path.join(tmpRoot, "c.db");
    const dbHandle = openDatabase(dbPath);
    try {
      runMigrations(dbHandle.db);
      const { mediaIds, groupId } = seedFixture(dbHandle.db);
      const m0 = mediaIds[0];
      const m1 = mediaIds[1];
      if (!m0 || !m1) throw new Error("seed expected 3 media ids");
      insertItem(dbHandle.db, { sceneGroupId: groupId, mediaId: m0, rankInGroup: 0 });
      insertItem(dbHandle.db, { sceneGroupId: groupId, mediaId: m1, rankInGroup: 1 });

      // Delete group → items CASCADE gone.
      dbHandle.db.prepare(`DELETE FROM scene_groups WHERE id = ?`).run(groupId);
      const n = (
        dbHandle.db.prepare(`SELECT COUNT(*) AS n FROM scene_group_items`).get() as { n: number }
      ).n;
      record(
        "fk: scene_group_items CASCADE on scene_groups delete",
        n === 0,
        `count=${n}`,
      );
    } finally {
      closeDatabase(dbHandle);
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }

  {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-mig020-fk-media-"));
    const dbPath = path.join(tmpRoot, "c.db");
    const dbHandle = openDatabase(dbPath);
    try {
      runMigrations(dbHandle.db);
      const { mediaIds, groupId } = seedFixture(dbHandle.db);
      const m0 = mediaIds[0];
      const m1 = mediaIds[1];
      if (!m0 || !m1) throw new Error("seed expected 3 media ids");
      insertItem(dbHandle.db, { sceneGroupId: groupId, mediaId: m0, rankInGroup: 0 });
      insertItem(dbHandle.db, { sceneGroupId: groupId, mediaId: m1, rankInGroup: 1 });

      // Delete a single media → just that item disappears.
      dbHandle.db.prepare(`DELETE FROM media_items WHERE id = ?`).run(m0);
      const remaining = dbHandle.db
        .prepare(`SELECT media_id FROM scene_group_items WHERE scene_group_id = ?`)
        .all(groupId) as { media_id: string }[];
      record(
        "fk: scene_group_items CASCADE on media_items delete (only deleted media's item gone)",
        remaining.length === 1 && remaining[0]?.media_id === m1,
        `remaining media_ids=${JSON.stringify(remaining.map((r) => r.media_id))}`,
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
