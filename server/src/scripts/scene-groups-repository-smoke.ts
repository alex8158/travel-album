// Manual smoke test for SceneGroupsRepository + SceneGroupItemsRepository
// (P12.T2). These two repositories are tightly coupled — design.md
// §7.8.3 requires L2 to write `scene_groups` and `scene_group_items`
// in a single transaction — so this smoke exercises both surfaces
// in one harness and explicitly demonstrates the cross-repo
// transactional pattern the future P12.T4 worker will use.
//
// Usage: npm run smoke:scene-groups-repository
//
// Coverage:
//   * SceneGroupsRepository:
//       - insert
//       - findById
//       - listByTripRound, listByTrip, countByTripRound
//       - updateMemberCount, updateRepresentative
//   * SceneGroupItemsRepository:
//       - insert, insertMany (transactional)
//       - findById, listByGroup (rank-ordered), listByMedia
//       - deleteByGroup
//   * Cross-repo transaction guard:
//       - When a multi-row insertMany is wrapped in db.transaction
//         and one row violates UNIQUE, the WHOLE batch rolls back.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import {
  SceneGroupItemsRepository,
  SceneGroupsRepository,
  type SceneGroupInsertData,
  type SceneGroupItemInsertData,
} from "../media/index.js";

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

function seedFixture(
  db: SqliteDatabase,
): { tripId: string; mediaIds: string[] } {
  const now = new Date().toISOString();
  const tripId = randomUUID();
  db.prepare(`INSERT INTO trips (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
    tripId,
    "Smoke SceneGroups",
    now,
    now,
  );
  const mediaIds: string[] = [];
  for (let i = 0; i < 4; i += 1) {
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
  return { tripId, mediaIds };
}

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-scene-groups-repo-"));
  const dbPath = path.join(tmpRoot, "c.db");
  const dbHandle = openDatabase(dbPath);

  try {
    runMigrations(dbHandle.db);

    const { tripId, mediaIds } = seedFixture(dbHandle.db);
    const groupsRepo = new SceneGroupsRepository(dbHandle.db);
    const itemsRepo = new SceneGroupItemsRepository(dbHandle.db);
    const m0 = mediaIds[0];
    const m1 = mediaIds[1];
    const m2 = mediaIds[2];
    const m3 = mediaIds[3];
    if (!m0 || !m1 || !m2 || !m3) throw new Error("seed expected 4 media");

    // ----------------------------------------------------------------
    // SceneGroupsRepository: insert + findById
    // ----------------------------------------------------------------
    const group1Data: SceneGroupInsertData = {
      id: randomUUID(),
      tripId,
      selectionRound: 1,
      groupIndex: 0,
      capturedAtStart: "2026-01-01T08:00:00.000Z",
      capturedAtEnd: "2026-01-01T08:05:00.000Z",
      gpsCenterLat: 35.0,
      gpsCenterLon: 139.0,
      representativeMediaId: m0,
      memberCount: 0,
      algorithmVersion: "code-time-gps-1.0",
    };
    const group1 = groupsRepo.insert(group1Data);
    record(
      "groups: insert returns view with all fields populated",
      group1.id === group1Data.id &&
        group1.tripId === tripId &&
        group1.selectionRound === 1 &&
        group1.groupIndex === 0 &&
        group1.capturedAtStart === "2026-01-01T08:00:00.000Z" &&
        group1.gpsCenterLat === 35.0 &&
        group1.representativeMediaId === m0 &&
        group1.memberCount === 0 &&
        group1.algorithmVersion === "code-time-gps-1.0" &&
        typeof group1.createdAt === "string" &&
        group1.createdAt.length > 0,
      `id=${group1.id.slice(0, 8)} round=${group1.selectionRound} algo=${group1.algorithmVersion}`,
    );

    const found = groupsRepo.findById(group1.id);
    record("groups: findById returns the inserted view", found?.id === group1.id, `found=${found?.id?.slice(0, 8) ?? "null"}`);

    const missing = groupsRepo.findById(randomUUID());
    record("groups: findById returns null for unknown id", missing === null, `missing=${missing}`);

    // ----------------------------------------------------------------
    // SceneGroupsRepository: a second group + listByTripRound / listByTrip
    // ----------------------------------------------------------------
    const group2Data: SceneGroupInsertData = {
      id: randomUUID(),
      tripId,
      selectionRound: 1,
      groupIndex: 1,
      capturedAtStart: null,
      capturedAtEnd: null,
      gpsCenterLat: null,
      gpsCenterLon: null,
      representativeMediaId: null,
      algorithmVersion: "code-time-gps-1.0",
    };
    groupsRepo.insert(group2Data);

    const round1List = groupsRepo.listByTripRound(tripId, 1);
    record(
      "groups: listByTripRound returns groups ordered by group_index ASC",
      round1List.length === 2 &&
        round1List[0]?.groupIndex === 0 &&
        round1List[1]?.groupIndex === 1,
      `len=${round1List.length} indices=${round1List.map((g) => g.groupIndex).join(",")}`,
    );

    // Round 2 group.
    const group3Data: SceneGroupInsertData = {
      id: randomUUID(),
      tripId,
      selectionRound: 2,
      groupIndex: 0,
      capturedAtStart: null,
      capturedAtEnd: null,
      gpsCenterLat: null,
      gpsCenterLon: null,
      representativeMediaId: null,
      algorithmVersion: "embedding-1.0",
    };
    groupsRepo.insert(group3Data);

    const allTrip = groupsRepo.listByTrip(tripId);
    record(
      "groups: listByTrip returns rounds DESC then group_index ASC",
      allTrip.length === 3 &&
        allTrip[0]?.selectionRound === 2 &&
        allTrip[1]?.selectionRound === 1 &&
        allTrip[2]?.selectionRound === 1,
      `len=${allTrip.length} rounds=${allTrip.map((g) => g.selectionRound).join(",")}`,
    );

    record(
      "groups: countByTripRound matches",
      groupsRepo.countByTripRound(tripId, 1) === 2 && groupsRepo.countByTripRound(tripId, 2) === 1,
      `r1=${groupsRepo.countByTripRound(tripId, 1)} r2=${groupsRepo.countByTripRound(tripId, 2)}`,
    );

    // ----------------------------------------------------------------
    // SceneGroupItemsRepository: insertMany + listByGroup
    // ----------------------------------------------------------------
    const itemsToInsert: SceneGroupItemInsertData[] = [
      {
        id: randomUUID(),
        sceneGroupId: group1.id,
        mediaId: m0,
        selectionRound: 1,
        groupScore: 0.95,
        similarityScore: 1.0,
        rankInGroup: 0,
        reason: "representative",
      },
      {
        id: randomUUID(),
        sceneGroupId: group1.id,
        mediaId: m1,
        selectionRound: 1,
        groupScore: 0.85,
        similarityScore: 0.93,
        rankInGroup: 1,
        reason: "embedding distance=0.07",
      },
      {
        id: randomUUID(),
        sceneGroupId: group1.id,
        mediaId: m2,
        selectionRound: 1,
        groupScore: 0.80,
        similarityScore: 0.91,
        rankInGroup: 2,
        reason: "embedding distance=0.09",
      },
    ];
    const insertedItems = itemsRepo.insertMany(itemsToInsert);
    record(
      "items: insertMany inserts 3 rows in transaction; returns views in input order",
      insertedItems.length === 3 &&
        insertedItems[0]?.mediaId === m0 &&
        insertedItems[2]?.mediaId === m2 &&
        insertedItems[1]?.reason === "embedding distance=0.07",
      `len=${insertedItems.length}`,
    );

    const byGroup = itemsRepo.listByGroup(group1.id);
    record(
      "items: listByGroup returns rank-ordered",
      byGroup.length === 3 &&
        byGroup[0]?.rankInGroup === 0 &&
        byGroup[1]?.rankInGroup === 1 &&
        byGroup[2]?.rankInGroup === 2,
      `ranks=${byGroup.map((it) => it.rankInGroup).join(",")}`,
    );

    // Single insert path.
    const singleItem = itemsRepo.insert({
      id: randomUUID(),
      sceneGroupId: group1.id,
      mediaId: m3,
      selectionRound: 1,
      groupScore: 0.7,
      similarityScore: 0.88,
      rankInGroup: 3,
      reason: "embedding distance=0.12",
    });
    record(
      "items: insert (single) row works alongside insertMany",
      singleItem.mediaId === m3 && singleItem.rankInGroup === 3,
      `media=${singleItem.mediaId.slice(0, 8)} rank=${singleItem.rankInGroup}`,
    );

    const byMedia = itemsRepo.listByMedia(m0);
    record(
      "items: listByMedia returns the group(s) this media belongs to",
      byMedia.length === 1 && byMedia[0]?.sceneGroupId === group1.id,
      `groups for m0=${byMedia.map((it) => it.sceneGroupId.slice(0, 8)).join(",")}`,
    );

    // ----------------------------------------------------------------
    // SceneGroupsRepository: updateMemberCount + updateRepresentative
    // ----------------------------------------------------------------
    const updateCnt = groupsRepo.updateMemberCount(group1.id, 4);
    record(
      "groups: updateMemberCount sets value + returns 1 row affected",
      updateCnt === 1 && groupsRepo.findById(group1.id)?.memberCount === 4,
      `cnt=${updateCnt} memberCount=${groupsRepo.findById(group1.id)?.memberCount}`,
    );

    const repUpd = groupsRepo.updateRepresentative(group2Data.id, m2);
    record(
      "groups: updateRepresentative sets value",
      repUpd === 1 && groupsRepo.findById(group2Data.id)?.representativeMediaId === m2,
      `rep=${groupsRepo.findById(group2Data.id)?.representativeMediaId?.slice(0, 8)}`,
    );

    // Null is allowed (rep cleared).
    groupsRepo.updateRepresentative(group2Data.id, null);
    record(
      "groups: updateRepresentative(null) clears the value",
      groupsRepo.findById(group2Data.id)?.representativeMediaId === null,
      `rep=${String(groupsRepo.findById(group2Data.id)?.representativeMediaId)}`,
    );

    // memberCount = -1 throws repository-level guard.
    expectThrow(
      "groups: updateMemberCount(-1) throws",
      () => groupsRepo.updateMemberCount(group1.id, -1),
      /memberCount must be >= 0/i,
    );

    // ----------------------------------------------------------------
    // SceneGroupItemsRepository: deleteByGroup
    // ----------------------------------------------------------------
    const delCnt = itemsRepo.deleteByGroup(group1.id);
    record(
      "items: deleteByGroup removes all 4 items in the group",
      delCnt === 4 && itemsRepo.listByGroup(group1.id).length === 0,
      `del=${delCnt}`,
    );

    // ----------------------------------------------------------------
    // Cross-repo transactional guard.
    // Mid-batch UNIQUE violation must roll back the whole insertMany.
    // ----------------------------------------------------------------
    // First seed a "blocker" row so the 2nd insertMany row collides.
    itemsRepo.insert({
      id: randomUUID(),
      sceneGroupId: group1.id,
      mediaId: m1,
      selectionRound: 1,
      groupScore: 0.5,
      similarityScore: 0.5,
      rankInGroup: 0,
      reason: "blocker",
    });

    const before = itemsRepo.listByGroup(group1.id).length;
    expectThrow(
      "items: insertMany rolls back ALL rows when one row violates UNIQUE (transactional guard)",
      () =>
        itemsRepo.insertMany([
          {
            id: randomUUID(),
            sceneGroupId: group1.id,
            mediaId: m0,
            selectionRound: 1,
            groupScore: 0.95,
            similarityScore: 1.0,
            rankInGroup: 5,
            reason: "OK row that should ALSO roll back",
          },
          {
            // duplicate (group, media) — UNIQUE fires here, rolls back the previous one too
            id: randomUUID(),
            sceneGroupId: group1.id,
            mediaId: m1,
            selectionRound: 1,
            groupScore: 0.85,
            similarityScore: 0.93,
            rankInGroup: 6,
            reason: "duplicate row that should trigger rollback",
          },
        ]),
      /UNIQUE constraint failed/i,
    );
    const after = itemsRepo.listByGroup(group1.id).length;
    record(
      "items: insertMany rollback leaves item count unchanged",
      before === after,
      `before=${before} after=${after}`,
    );

    // ----------------------------------------------------------------
    // Cross-repo: FK CASCADE from scene_groups → scene_group_items
    // ----------------------------------------------------------------
    // Insert one fresh group + 2 items, then delete the group.
    const tmpGroup = groupsRepo.insert({
      id: randomUUID(),
      tripId,
      selectionRound: 3,
      groupIndex: 0,
      capturedAtStart: null,
      capturedAtEnd: null,
      gpsCenterLat: null,
      gpsCenterLon: null,
      representativeMediaId: null,
      algorithmVersion: "v1",
    });
    itemsRepo.insertMany([
      {
        id: randomUUID(),
        sceneGroupId: tmpGroup.id,
        mediaId: m0,
        selectionRound: 3,
        groupScore: null,
        similarityScore: null,
        rankInGroup: 0,
        reason: null,
      },
      {
        id: randomUUID(),
        sceneGroupId: tmpGroup.id,
        mediaId: m1,
        selectionRound: 3,
        groupScore: null,
        similarityScore: null,
        rankInGroup: 1,
        reason: null,
      },
    ]);
    record(
      "cross-repo: tmpGroup has 2 items before group delete",
      itemsRepo.listByGroup(tmpGroup.id).length === 2,
      "ok",
    );
    dbHandle.db.prepare(`DELETE FROM scene_groups WHERE id = ?`).run(tmpGroup.id);
    record(
      "cross-repo: deleting scene_groups row cascades to scene_group_items (0 remain)",
      itemsRepo.listByGroup(tmpGroup.id).length === 0,
      "ok",
    );

    const passed = results.filter((r) => r.ok).length;
    const failed = results.length - passed;
    console.log(`\n[smoke] summary: ${passed}/${results.length} passed`);
    if (failed > 0) {
      console.log(
        `[smoke] failures: ${results.filter((r) => !r.ok).map((r) => r.name).join(", ")}`,
      );
      process.exit(1);
    }
  } finally {
    closeDatabase(dbHandle);
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`[smoke] uncaught error: ${describeError(err)}`);
  process.exit(1);
});
