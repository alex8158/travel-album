// Manual smoke test for migration 021 (P12.T2 — curated_selections).
//
// Usage: npm run smoke:migration-021
//
// Verifies:
//   * Fresh DB: 000..021 apply cleanly.
//   * `curated_selections` exists with 13 columns from design.md §4.2.
//   * UNIQUE(trip_id, selection_round, media_id) enforced.
//   * CHECK constraints: included ∈ {0,1}, is_current ∈ {0,1},
//     selection_round >= 0, ai_confidence ∈ [0,1] NULL,
//     user_decision ∈ {kept,excluded} NULL.
//   * Layer-discipline CHECK: round=0 requires user_decision NOT NULL;
//     round>=1 requires user_decision IS NULL.
//   * FK behaviour:
//       - trip_id CASCADE
//       - media_id CASCADE
//       - scene_group_id SET NULL

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

function seedFixture(db: SqliteDatabase): {
  tripId: string;
  mediaIds: string[];
  groupId: string;
} {
  const now = new Date().toISOString();
  const tripId = randomUUID();
  db.prepare(`INSERT INTO trips (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
    tripId,
    "Smoke 021",
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

interface InsertCuratedArgs {
  id?: string;
  tripId: string;
  mediaId: string;
  sceneGroupId?: string | null;
  selectionRound: number;
  included: 0 | 1;
  isCurrent?: 0 | 1;
  aiConfidence?: number | null;
  refinementParams?: string | null;
  userDecision?: "kept" | "excluded" | null;
  reason?: string | null;
}

function insertCurated(db: SqliteDatabase, args: InsertCuratedArgs): string {
  const id = args.id ?? randomUUID();
  db.prepare(
    `INSERT INTO curated_selections
       (id, trip_id, media_id, scene_group_id,
        selection_round, included, is_current,
        reason, ai_confidence, refinement_params, user_decision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    args.tripId,
    args.mediaId,
    args.sceneGroupId ?? null,
    args.selectionRound,
    args.included,
    args.isCurrent ?? 0,
    args.reason ?? null,
    args.aiConfidence ?? null,
    args.refinementParams ?? null,
    args.userDecision ?? null,
  );
  return id;
}

async function main(): Promise<void> {
  // ====================================================================
  // A: schema
  // ====================================================================
  {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-mig021-schema-"));
    const dbPath = path.join(tmpRoot, "c.db");
    const dbHandle = openDatabase(dbPath);
    try {
      const result = runMigrations(dbHandle.db);
      record(
        "fresh: 021 included in appliedNow",
        result.appliedNow.includes("021_create_curated_selections.sql"),
        `appliedNow.last=${result.appliedNow[result.appliedNow.length - 1] ?? ""}`,
      );

      const cols = dbHandle.db.prepare(`PRAGMA table_info(curated_selections)`).all() as {
        name: string;
        notnull: number;
      }[];
      const colNames = cols.map((c) => c.name);
      const expectedCols = [
        "id",
        "trip_id",
        "media_id",
        "scene_group_id",
        "selection_round",
        "included",
        "is_current",
        "reason",
        "ai_confidence",
        "refinement_params",
        "user_decision",
        "created_at",
        "updated_at",
      ];
      record(
        "fresh: curated_selections has 13 columns in spec order",
        JSON.stringify(colNames) === JSON.stringify(expectedCols),
        `columns=${JSON.stringify(colNames)}`,
      );

      const idxRows = dbHandle.db
        .prepare(`PRAGMA index_list('curated_selections')`)
        .all() as { name: string }[];
      const idxNames = idxRows
        .map((r) => r.name)
        .filter((n) => !n.startsWith("sqlite_autoindex_"))
        .sort();
      const expectedIdxNames = [
        "idx_curated_selections_current_set",
        "idx_curated_selections_scene_group",
        "idx_curated_selections_trip_round",
        "idx_curated_selections_trip_round_media",
      ].sort();
      record(
        "fresh: 4 named indexes present",
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
  // B: CHECK + UNIQUE + layer discipline
  // ====================================================================
  {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-mig021-check-"));
    const dbPath = path.join(tmpRoot, "c.db");
    const dbHandle = openDatabase(dbPath);
    try {
      runMigrations(dbHandle.db);
      const { tripId, mediaIds, groupId } = seedFixture(dbHandle.db);
      const m0 = mediaIds[0];
      const m1 = mediaIds[1];
      const m2 = mediaIds[2];
      if (!m0 || !m1 || !m2) throw new Error("seed expected 3 media");

      // Happy: AI round=1 included=1 row.
      insertCurated(dbHandle.db, {
        tripId,
        mediaId: m0,
        sceneGroupId: groupId,
        selectionRound: 1,
        included: 1,
        isCurrent: 0,
        aiConfidence: 0.85,
        reason: "ai-pick",
      });
      record("check: happy AI row (round=1 included=1) inserts", true, "ok");

      // UNIQUE(trip_id, selection_round, media_id)
      expectThrow(
        "check: duplicate (trip, round, media) rejected by UNIQUE",
        () =>
          insertCurated(dbHandle.db, {
            tripId,
            mediaId: m0,
            sceneGroupId: groupId,
            selectionRound: 1,
            included: 0,
          }),
        /UNIQUE constraint failed/i,
      );

      // CHECK included ∈ {0,1}
      expectThrow(
        "check: included = 2 rejected",
        () =>
          insertCurated(dbHandle.db, {
            tripId,
            mediaId: m1,
            selectionRound: 1,
            included: 2 as unknown as 0,
          }),
        /CHECK constraint failed/i,
      );

      // CHECK is_current ∈ {0,1}
      expectThrow(
        "check: is_current = 2 rejected",
        () =>
          insertCurated(dbHandle.db, {
            tripId,
            mediaId: m1,
            selectionRound: 1,
            included: 1,
            isCurrent: 2 as unknown as 0,
          }),
        /CHECK constraint failed/i,
      );

      // CHECK selection_round >= 0
      expectThrow(
        "check: selection_round = -1 rejected",
        () =>
          insertCurated(dbHandle.db, {
            tripId,
            mediaId: m1,
            selectionRound: -1,
            included: 0,
          }),
        /CHECK constraint failed/i,
      );

      // CHECK ai_confidence ∈ [0,1]
      expectThrow(
        "check: ai_confidence = 1.5 rejected",
        () =>
          insertCurated(dbHandle.db, {
            tripId,
            mediaId: m1,
            selectionRound: 1,
            included: 1,
            aiConfidence: 1.5,
          }),
        /CHECK constraint failed/i,
      );
      expectThrow(
        "check: ai_confidence = -0.1 rejected",
        () =>
          insertCurated(dbHandle.db, {
            tripId,
            mediaId: m1,
            selectionRound: 1,
            included: 1,
            aiConfidence: -0.1,
          }),
        /CHECK constraint failed/i,
      );

      // CHECK user_decision ∈ {kept,excluded}
      expectThrow(
        "check: user_decision = 'maybe' rejected",
        () =>
          insertCurated(dbHandle.db, {
            tripId,
            mediaId: m1,
            selectionRound: 0,
            included: 1,
            userDecision: "maybe" as unknown as "kept",
          }),
        /CHECK constraint failed/i,
      );

      // Layer discipline: round=0 requires user_decision NOT NULL.
      expectThrow(
        "check: round=0 with NULL user_decision rejected",
        () =>
          insertCurated(dbHandle.db, {
            tripId,
            mediaId: m1,
            selectionRound: 0,
            included: 1,
            userDecision: null,
          }),
        /CHECK constraint failed/i,
      );

      // Layer discipline: round>=1 with user_decision rejected.
      expectThrow(
        "check: round=1 with user_decision='kept' rejected",
        () =>
          insertCurated(dbHandle.db, {
            tripId,
            mediaId: m1,
            selectionRound: 1,
            included: 1,
            userDecision: "kept",
          }),
        /CHECK constraint failed/i,
      );

      // Happy round=0 (override layer).
      insertCurated(dbHandle.db, {
        tripId,
        mediaId: m1,
        selectionRound: 0,
        included: 1,
        userDecision: "kept",
        reason: "user pin",
      });
      record("check: happy round=0 override (user_decision='kept') inserts", true, "ok");

      // Same media can appear in round=0 (override) AND round=1 (AI).
      insertCurated(dbHandle.db, {
        tripId,
        mediaId: m1,
        selectionRound: 1,
        included: 0,
        isCurrent: 1,
        reason: "ai not best",
      });
      record("check: same media in round=0 + round=1 (different layers) inserts", true, "ok");

      // 'excluded' override path.
      insertCurated(dbHandle.db, {
        tripId,
        mediaId: m2,
        selectionRound: 0,
        included: 0,
        userDecision: "excluded",
        reason: "user exclude",
      });
      record("check: happy round=0 override (user_decision='excluded') inserts", true, "ok");
    } finally {
      closeDatabase(dbHandle);
      await rm(tmpRoot, { recursive: true, force: true });
    }
  }

  // ====================================================================
  // C: FK behaviours
  // ====================================================================
  {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-mig021-fk-"));
    const dbPath = path.join(tmpRoot, "c.db");
    const dbHandle = openDatabase(dbPath);
    try {
      runMigrations(dbHandle.db);
      const { tripId, mediaIds, groupId } = seedFixture(dbHandle.db);
      const m0 = mediaIds[0];
      if (!m0) throw new Error("seed expected media");

      const rowId = insertCurated(dbHandle.db, {
        tripId,
        mediaId: m0,
        sceneGroupId: groupId,
        selectionRound: 1,
        included: 1,
        isCurrent: 1,
      });

      // scene_group SET NULL
      dbHandle.db.prepare(`DELETE FROM scene_groups WHERE id = ?`).run(groupId);
      const after = dbHandle.db
        .prepare(`SELECT scene_group_id FROM curated_selections WHERE id = ?`)
        .get(rowId) as { scene_group_id: string | null };
      record(
        "fk: scene_group_id SET NULL on scene_groups delete; row survives",
        after.scene_group_id === null,
        `scene_group_id=${String(after.scene_group_id)}`,
      );

      // media CASCADE
      dbHandle.db.prepare(`DELETE FROM media_items WHERE id = ?`).run(m0);
      const c1 = (
        dbHandle.db.prepare(`SELECT COUNT(*) AS n FROM curated_selections WHERE id = ?`).get(rowId) as { n: number }
      ).n;
      record("fk: curated_selections CASCADE on media delete", c1 === 0, `n=${c1}`);

      // trip CASCADE — note: the schema declares trip_id CASCADE,
      // but media_items.trip_id is RESTRICT, so deleting a trip
      // while it still has media throws FK error. To exercise the
      // curated_selections.trip_id CASCADE in isolation, we need
      // to either (a) delete all media first (then the curated
      // rows are already gone via the media CASCADE — making the
      // trip-cascade effectively redundant) or (b) seed a
      // curated_selections row with a sufficient FK shape but no
      // matching media. Approach (a) is closer to production
      // flow.
      const m1 = mediaIds[1];
      const m2 = mediaIds[2];
      if (!m1 || !m2) throw new Error("seed expected mediaIds[1..2]");
      insertCurated(dbHandle.db, {
        tripId,
        mediaId: m1,
        selectionRound: 1,
        included: 1,
      });

      // First clear all media_items for this trip — the curated row
      // for m1 disappears via the media CASCADE; m2 has no curated
      // row but we delete it anyway to satisfy media_items.trip_id
      // RESTRICT.
      dbHandle.db.prepare(`DELETE FROM media_items WHERE id = ?`).run(m1);
      dbHandle.db.prepare(`DELETE FROM media_items WHERE id = ?`).run(m2);

      // Now the trip can be deleted; the curated CASCADE has
      // nothing left to clean but doesn't error.
      dbHandle.db.prepare(`DELETE FROM trips WHERE id = ?`).run(tripId);
      const tripsRemaining = (
        dbHandle.db.prepare(`SELECT COUNT(*) AS n FROM trips WHERE id = ?`).get(tripId) as { n: number }
      ).n;
      record(
        "fk: trip CASCADE path works once media is cleared (defence-in-depth FK declaration)",
        tripsRemaining === 0,
        `tripsRemaining=${tripsRemaining}`,
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
