// Manual smoke test for migration 007 (P5.T1).
//
// Usage: npm run smoke:migration-007
//
// Verifies the schema-level acceptance points for the migration:
//   * Fresh DB: 000..007 apply cleanly in one boot.
//   * Existing DB stopped at 006: upgrading to 007 adds the two
//     duplicate tables without disturbing anything else.
//   * After upgrade, `duplicate_groups` + `duplicate_group_items`
//     exist with the documented columns, CHECK constraints, FKs,
//     and indexes.
//   * Re-running migrate is a no-op (007 already applied).
//   * Group / item rows can be inserted; enum / range CHECKs reject
//     bad values; UNIQUE (group_id, media_id) blocks duplicate
//     membership.
//   * FK strategies behave as designed:
//       - duplicate_groups.recommended_media_id → SET NULL on media delete
//       - duplicate_group_items.media_id → CASCADE on media delete
//       - duplicate_group_items.group_id → CASCADE on group delete
//       - duplicate_groups.trip_id → RESTRICT on trip hard delete
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

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

function seedTripAndMedia(
  db: SqliteDatabase,
  tripTitle = "P5.T1 Smoke Trip",
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

function insertGroup(
  db: SqliteDatabase,
  args: {
    tripId: string;
    groupType?: string;
    recommendedMediaId?: string | null;
    confidence?: number | null;
    similarityScore?: number | null;
    userConfirmed?: 0 | 1;
  },
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO duplicate_groups
       (id, trip_id, group_type, recommended_media_id, confidence, similarity_score, user_confirmed)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    args.tripId,
    args.groupType ?? "exact",
    args.recommendedMediaId ?? null,
    args.confidence ?? null,
    args.similarityScore ?? null,
    args.userConfirmed ?? 0,
  );
  return id;
}

function insertItem(
  db: SqliteDatabase,
  args: {
    groupId: string;
    mediaId: string;
    similarityScore?: number | null;
    qualityScore?: number | null;
    recommendation?: string;
    reason?: string | null;
    userDecision?: string;
  },
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO duplicate_group_items
       (id, group_id, media_id, similarity_score, quality_score,
        recommendation, reason, user_decision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    args.groupId,
    args.mediaId,
    args.similarityScore ?? null,
    args.qualityScore ?? null,
    args.recommendation ?? "undecided",
    args.reason ?? null,
    args.userDecision ?? "undecided",
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
  // ===================================================================
  // CASE GROUP A: fresh DB applies 000..007 in one shot
  // ===================================================================
  {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-mig007-fresh-"));
    const dbPath = path.join(tmpRoot, "fresh.db");
    const dbHandle = openDatabase(dbPath);
    try {
      const result = runMigrations(dbHandle.db);
      record(
        "fresh: 007 included in appliedNow",
        result.appliedNow.includes("007_create_duplicate_groups.sql"),
        `appliedNow=${JSON.stringify(result.appliedNow)}`,
      );
      record(
        "fresh: totalFiles >= 8 (000..007)",
        result.totalFiles >= 8,
        `totalFiles=${result.totalFiles}`,
      );

      // ---------------- duplicate_groups: schema ----------------
      const groupCols = dbHandle.db.prepare(`PRAGMA table_info(duplicate_groups)`).all() as {
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }[];
      const groupNames = groupCols.map((c) => c.name);
      record(
        "fresh: duplicate_groups has 9 columns in spec order",
        JSON.stringify(groupNames) ===
          JSON.stringify([
            "id",
            "trip_id",
            "group_type",
            "recommended_media_id",
            "confidence",
            "similarity_score",
            "user_confirmed",
            "created_at",
            "updated_at",
          ]),
        `columns=${JSON.stringify(groupNames)}`,
      );

      // ---------------- duplicate_group_items: schema ----------------
      const itemCols = dbHandle.db.prepare(`PRAGMA table_info(duplicate_group_items)`).all() as {
        name: string;
      }[];
      const itemNames = itemCols.map((c) => c.name);
      record(
        "fresh: duplicate_group_items has 10 columns in spec order",
        JSON.stringify(itemNames) ===
          JSON.stringify([
            "id",
            "group_id",
            "media_id",
            "similarity_score",
            "quality_score",
            "recommendation",
            "reason",
            "user_decision",
            "created_at",
            "updated_at",
          ]),
        `columns=${JSON.stringify(itemNames)}`,
      );

      // ---------------- indexes on duplicate_groups ----------------
      const groupIdx = dbHandle.db.prepare(`PRAGMA index_list(duplicate_groups)`).all() as {
        name: string;
        unique: number;
      }[];
      const groupIdxNames = groupIdx.map((i) => i.name);
      const expectedGroupIdx = [
        "idx_duplicate_groups_trip_id",
        "idx_duplicate_groups_group_type",
        "idx_duplicate_groups_recommended_media_id",
        "idx_duplicate_groups_user_confirmed",
      ];
      record(
        "fresh: duplicate_groups has 4 expected indexes",
        expectedGroupIdx.every((name) => groupIdxNames.includes(name)),
        `indexes=${JSON.stringify(groupIdxNames)}`,
      );

      // ---------------- indexes on duplicate_group_items ----------------
      const itemIdx = dbHandle.db.prepare(`PRAGMA index_list(duplicate_group_items)`).all() as {
        name: string;
        unique: number;
      }[];
      const itemIdxNames = itemIdx.map((i) => i.name);
      record(
        "fresh: duplicate_group_items has UNIQUE (group_id, media_id)",
        itemIdx.some((i) => i.name === "idx_duplicate_group_items_group_media" && i.unique === 1),
        `indexes=${JSON.stringify(itemIdx)}`,
      );
      record(
        "fresh: duplicate_group_items has reverse media_id index",
        itemIdxNames.includes("idx_duplicate_group_items_media_id"),
        `indexes=${JSON.stringify(itemIdxNames)}`,
      );

      // ---------------- FK info ----------------
      const groupFks = dbHandle.db.prepare(`PRAGMA foreign_key_list(duplicate_groups)`).all() as {
        table: string;
        from: string;
        to: string;
        on_delete: string;
      }[];
      record(
        "fresh: duplicate_groups.trip_id → trips ON DELETE RESTRICT",
        groupFks.some(
          (fk) => fk.from === "trip_id" && fk.table === "trips" && fk.on_delete === "RESTRICT",
        ),
        `fks=${JSON.stringify(groupFks)}`,
      );
      record(
        "fresh: duplicate_groups.recommended_media_id → media_items ON DELETE SET NULL",
        groupFks.some(
          (fk) =>
            fk.from === "recommended_media_id" &&
            fk.table === "media_items" &&
            fk.on_delete === "SET NULL",
        ),
        `fks=${JSON.stringify(groupFks)}`,
      );
      const itemFks = dbHandle.db
        .prepare(`PRAGMA foreign_key_list(duplicate_group_items)`)
        .all() as {
        table: string;
        from: string;
        to: string;
        on_delete: string;
      }[];
      record(
        "fresh: duplicate_group_items.group_id → duplicate_groups ON DELETE CASCADE",
        itemFks.some(
          (fk) =>
            fk.from === "group_id" && fk.table === "duplicate_groups" && fk.on_delete === "CASCADE",
        ),
        `fks=${JSON.stringify(itemFks)}`,
      );
      record(
        "fresh: duplicate_group_items.media_id → media_items ON DELETE CASCADE",
        itemFks.some(
          (fk) =>
            fk.from === "media_id" && fk.table === "media_items" && fk.on_delete === "CASCADE",
        ),
        `fks=${JSON.stringify(itemFks)}`,
      );

      // ---------------- CHECK constraints (group_type / ranges / enums) ----------------
      const seeded = seedTripAndMedia(dbHandle.db);
      // Good insert: minimal mandatory fields only.
      const gid = insertGroup(dbHandle.db, { tripId: seeded.tripId, groupType: "exact" });
      record(
        "fresh: insert duplicate_groups with group_type='exact' works",
        typeof gid === "string" && gid.length > 0,
        `id=${gid}`,
      );
      // Good insert: 'similar' + scores + recommended.
      const gid2 = insertGroup(dbHandle.db, {
        tripId: seeded.tripId,
        groupType: "similar",
        recommendedMediaId: seeded.mediaId,
        confidence: 0.92,
        similarityScore: 0.87,
        userConfirmed: 0,
      });
      record(
        "fresh: insert duplicate_groups with similar + scores + recommended works",
        typeof gid2 === "string" && gid2.length > 0,
        `id=${gid2}`,
      );
      // Bad: unknown group_type rejected.
      expectThrow(
        "fresh: group_type CHECK rejects unknown value",
        () => insertGroup(dbHandle.db, { tripId: seeded.tripId, groupType: "definitely_not_real" }),
        /CHECK constraint failed: duplicate_groups_group_type_enum/,
      );
      // Bad: confidence > 1 rejected.
      expectThrow(
        "fresh: confidence CHECK rejects > 1",
        () => insertGroup(dbHandle.db, { tripId: seeded.tripId, confidence: 1.5 }),
        /CHECK constraint failed: duplicate_groups_confidence_range/,
      );
      // Bad: similarity_score < 0 rejected.
      expectThrow(
        "fresh: similarity_score CHECK rejects < 0",
        () => insertGroup(dbHandle.db, { tripId: seeded.tripId, similarityScore: -0.1 }),
        /CHECK constraint failed: duplicate_groups_similarity_score_range/,
      );
      // Bad: user_confirmed=2 rejected.
      expectThrow(
        "fresh: user_confirmed CHECK rejects value other than 0/1",
        () => {
          const id = randomUUID();
          dbHandle.db
            .prepare(
              `INSERT INTO duplicate_groups
                 (id, trip_id, group_type, user_confirmed)
               VALUES (?, ?, 'exact', 2)`,
            )
            .run(id, seeded.tripId);
        },
        /CHECK constraint failed: duplicate_groups_user_confirmed_bool/,
      );

      // ---------------- duplicate_group_items: enum / range CHECKs ----------------
      const goodItem = insertItem(dbHandle.db, {
        groupId: gid,
        mediaId: seeded.mediaId,
        similarityScore: 0.95,
        qualityScore: 0.6,
        recommendation: "keep",
        reason: "best resolution",
        userDecision: "undecided",
      });
      record(
        "fresh: insert duplicate_group_items with full payload works",
        typeof goodItem === "string" && goodItem.length > 0,
        `id=${goodItem}`,
      );
      expectThrow(
        "fresh: recommendation CHECK rejects unknown value",
        () =>
          insertItem(dbHandle.db, {
            groupId: gid2,
            mediaId: seeded.mediaId,
            recommendation: "delete_lol",
          }),
        /CHECK constraint failed: duplicate_group_items_recommendation_enum/,
      );
      expectThrow(
        "fresh: user_decision CHECK rejects unknown value",
        () =>
          insertItem(dbHandle.db, {
            groupId: gid2,
            mediaId: seeded.mediaId,
            userDecision: "trash",
          }),
        /CHECK constraint failed: duplicate_group_items_user_decision_enum/,
      );
      expectThrow(
        "fresh: quality_score CHECK rejects > 1",
        () =>
          insertItem(dbHandle.db, {
            groupId: gid2,
            mediaId: seeded.mediaId,
            qualityScore: 1.5,
          }),
        /CHECK constraint failed: duplicate_group_items_quality_score_range/,
      );

      // ---------------- UNIQUE (group_id, media_id) ----------------
      expectThrow(
        "fresh: UNIQUE (group_id, media_id) blocks duplicate membership",
        () => insertItem(dbHandle.db, { groupId: gid, mediaId: seeded.mediaId }),
        /UNIQUE constraint failed/,
      );

      // ---------------- FK behaviour ----------------
      // Re-fetch group #2 — recommended_media_id is set to seeded.mediaId.
      // Deleting that media row should SET NULL on the group rather than
      // failing the delete or cascading the group away.
      dbHandle.db.prepare(`DELETE FROM media_items WHERE id = ?`).run(seeded.mediaId);
      const after = dbHandle.db
        .prepare(`SELECT recommended_media_id FROM duplicate_groups WHERE id = ?`)
        .get(gid2) as { recommended_media_id: string | null } | undefined;
      record(
        "fresh: media delete sets recommended_media_id to NULL (safety net)",
        after?.recommended_media_id === null,
        `recommended_media_id=${String(after?.recommended_media_id)}`,
      );
      // The group row itself survives the media delete.
      const groupSurvives = dbHandle.db
        .prepare(`SELECT COUNT(*) AS n FROM duplicate_groups WHERE id = ?`)
        .get(gid2) as { n: number };
      record(
        "fresh: duplicate_groups row survives media delete (only recommended_media_id reset)",
        groupSurvives.n === 1,
        `count=${groupSurvives.n}`,
      );
      // duplicate_group_items WAS cascaded from media side (the only
      // item in gid pointed at seeded.mediaId).
      const itemsAfterMediaDelete = dbHandle.db
        .prepare(`SELECT COUNT(*) AS n FROM duplicate_group_items WHERE media_id = ?`)
        .get(seeded.mediaId) as { n: number };
      record(
        "fresh: duplicate_group_items cascades from media_items delete",
        itemsAfterMediaDelete.n === 0,
        `count=${itemsAfterMediaDelete.n}`,
      );

      // duplicate_group_items cascades from duplicate_groups delete.
      const seeded2 = seedTripAndMedia(dbHandle.db, "Group-cascade fixture");
      const gid3 = insertGroup(dbHandle.db, { tripId: seeded2.tripId });
      insertItem(dbHandle.db, { groupId: gid3, mediaId: seeded2.mediaId });
      dbHandle.db.prepare(`DELETE FROM duplicate_groups WHERE id = ?`).run(gid3);
      const itemsAfterGroupDelete = dbHandle.db
        .prepare(`SELECT COUNT(*) AS n FROM duplicate_group_items WHERE group_id = ?`)
        .get(gid3) as { n: number };
      record(
        "fresh: duplicate_group_items cascades from duplicate_groups delete",
        itemsAfterGroupDelete.n === 0,
        `count=${itemsAfterGroupDelete.n}`,
      );

      // trip delete RESTRICT when groups exist.
      // First make sure dbHandle has foreign_keys ON (openDatabase already sets it).
      expectThrow(
        "fresh: deleting a trip with duplicate_groups is RESTRICTed",
        () => {
          // gid + gid2 still point at seeded.tripId via trip_id.
          dbHandle.db.prepare(`DELETE FROM trips WHERE id = ?`).run(seeded.tripId);
        },
        /FOREIGN KEY constraint failed/,
      );

      // FK + integrity clean.
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
  // CASE GROUP B: upgrade scenario — stop at 006, then apply 007.
  // Pre-existing trip / media / version rows must survive untouched.
  // ===================================================================
  {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-mig007-upgrade-"));
    const dbPath = path.join(tmpRoot, "upgrade.db");
    console.log(`[smoke] upgradeDbPath=${dbPath}`);

    let knownTripId = "";
    let knownMediaId = "";

    // ---- Stage 1: simulate previous release stopping at 006 ----
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
      ];
      for (const name of oldFiles) {
        const sql = await readFile(path.join(migrationsDir, name), "utf8");
        stage1.db.exec(sql);
        stage1.db.prepare(`INSERT INTO _schema_migrations (name) VALUES (?)`).run(name);
      }
      const seeded = seedTripAndMedia(stage1.db, "Pre-007 fixture");
      knownTripId = seeded.tripId;
      knownMediaId = seeded.mediaId;

      // Sanity: duplicate_groups should NOT exist before 007.
      const beforeTables = stage1.db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='duplicate_groups'`)
        .all() as { name: string }[];
      record(
        "upgrade-before: duplicate_groups does not exist on 006 schema",
        beforeTables.length === 0,
        `tables=${JSON.stringify(beforeTables)}`,
      );
    } finally {
      closeDatabase(stage1);
    }

    // ---- Stage 2: re-open, run migrations → 007 (and any later
    // siblings added by future tasks like 008) apply in order. The
    // tight "exactly [007]" assertion was loosened when 008 landed
    // (P6.T1) so this smoke does not need a refresh per migration. ----
    const stage2 = openDatabase(dbPath);
    try {
      const result = runMigrations(stage2.db);
      record(
        "upgrade: appliedNow includes 007 as the first newly-applied file",
        result.appliedNow[0] === "007_create_duplicate_groups.sql" &&
          result.appliedNow.includes("007_create_duplicate_groups.sql"),
        `appliedNow=${JSON.stringify(result.appliedNow)}`,
      );

      // Existing trip + media rows untouched.
      const tripRow = stage2.db
        .prepare(`SELECT id, title FROM trips WHERE id = ?`)
        .get(knownTripId) as { id: string; title: string } | undefined;
      record(
        "upgrade: pre-existing trip preserved",
        tripRow?.id === knownTripId && tripRow?.title === "Pre-007 fixture",
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

      // New tables exist and accept inserts after upgrade.
      const gid = insertGroup(stage2.db, {
        tripId: knownTripId,
        groupType: "similar",
        recommendedMediaId: knownMediaId,
        confidence: 0.8,
        similarityScore: 0.7,
      });
      const iid = insertItem(stage2.db, {
        groupId: gid,
        mediaId: knownMediaId,
        similarityScore: 0.7,
        recommendation: "keep",
        reason: "P5.T1 smoke",
      });
      record(
        "upgrade: post-007 insert into duplicate_groups + duplicate_group_items works",
        typeof gid === "string" && typeof iid === "string",
        `gid=${gid} iid=${iid}`,
      );

      // FK + integrity clean.
      const fkRows = stage2.db.prepare(`PRAGMA foreign_key_check`).all();
      record(
        "upgrade: PRAGMA foreign_key_check clean post-007",
        fkRows.length === 0,
        `rows=${JSON.stringify(fkRows)}`,
      );
      const integrity = stage2.db.prepare(`PRAGMA integrity_check`).all() as {
        integrity_check: string;
      }[];
      record(
        "upgrade: PRAGMA integrity_check ok post-007",
        integrity.length === 1 && integrity[0]?.integrity_check === "ok",
        `result=${JSON.stringify(integrity)}`,
      );

      // Idempotency: running again is a no-op.
      const again = runMigrations(stage2.db);
      record(
        "upgrade: re-running migrate is a no-op (007 already applied)",
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
