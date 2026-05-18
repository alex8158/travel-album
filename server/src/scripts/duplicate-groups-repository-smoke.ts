// Manual smoke test for DuplicateGroupsRepository.
//
// Usage: npm run smoke:duplicate-groups-repository
//
// Drives the Repository directly against a fresh SQLite DB (after
// the full migration set has been applied) so the smoke covers
// every public method plus the constraint behaviour that surfaces
// to callers.
//
// Coverage:
//   * insertGroup: minimal + full payloads.
//   * insertGroup: CHECK / FK violations propagate.
//   * insertItem: minimal + full payloads.
//   * insertItem: CHECK / FK / UNIQUE violations propagate.
//   * findGroupById: round-trips a row + nullable boolean coercion.
//   * findGroupById: returns null for an unknown id.
//   * listByTripId: returns groups newest-first; isolates by trip.
//   * listItemsByGroupId: ordered similarity-DESC NULLS LAST, then id ASC.
//   * listByTripIdWithItems: hydrates items alongside each group.
//   * listGroupsByMediaId: reverse lookup through items.
//   * deleteGroup: cascades item rows via FK.
//   * createGroupWithItems: success path writes group + all items.
//   * createGroupWithItems: failure path (e.g. UNIQUE on items)
//     rolls back the entire transaction — no group row leaks.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import {
  DuplicateGroupsRepository,
  type DuplicateGroupInsertData,
  type DuplicateGroupItemInsertData,
  type DuplicateGroupItemSeedData,
} from "../dedup/index.js";

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

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function seedTrip(db: SqliteDatabase, title = "Dedup Repo Smoke Trip"): string {
  const tripId = randomUUID();
  const now = nowIso();
  db.prepare(`INSERT INTO trips (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
    tripId,
    title,
    now,
    now,
  );
  return tripId;
}

function seedMedia(db: SqliteDatabase, tripId: string): string {
  const mediaId = randomUUID();
  const now = nowIso();
  db.prepare(
    `INSERT INTO media_items
       (id, trip_id, type, original_path, mime_type, extension, file_size,
        status, user_decision, created_at, updated_at)
     VALUES (?, ?, 'image', ?, 'image/jpeg', 'jpg', 1024,
             'uploaded', 'undecided', ?, ?)`,
  ).run(mediaId, tripId, `trips/${tripId}/originals/${mediaId}.jpg`, now, now);
  return mediaId;
}

function makeGroup(args: {
  tripId: string;
  groupType?: DuplicateGroupInsertData["groupType"];
  recommendedMediaId?: string | null;
  confidence?: number | null;
  similarityScore?: number | null;
  userConfirmed?: boolean;
}): DuplicateGroupInsertData {
  const now = nowIso();
  const data: DuplicateGroupInsertData = {
    id: randomUUID(),
    tripId: args.tripId,
    groupType: args.groupType ?? "exact",
    recommendedMediaId: args.recommendedMediaId ?? null,
    confidence: args.confidence ?? null,
    similarityScore: args.similarityScore ?? null,
    userConfirmed: args.userConfirmed ?? false,
    createdAt: now,
    updatedAt: now,
  };
  return data;
}

function makeItem(args: {
  groupId: string;
  mediaId: string;
  similarityScore?: number | null;
  qualityScore?: number | null;
  recommendation?: DuplicateGroupItemInsertData["recommendation"];
  reason?: string | null;
  userDecision?: DuplicateGroupItemInsertData["userDecision"];
}): DuplicateGroupItemInsertData {
  const now = nowIso();
  return {
    id: randomUUID(),
    groupId: args.groupId,
    mediaId: args.mediaId,
    similarityScore: args.similarityScore ?? null,
    qualityScore: args.qualityScore ?? null,
    recommendation: args.recommendation ?? "undecided",
    reason: args.reason ?? null,
    userDecision: args.userDecision ?? "undecided",
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-dedup-repo-smoke-"));
  const dbPath = path.join(tmpRoot, "smoke.db");
  console.log(`[smoke] dbPath=${dbPath}`);

  const dbHandle = openDatabase(dbPath);
  try {
    runMigrations(dbHandle.db);
    const repo = new DuplicateGroupsRepository(dbHandle.db);

    // -----------------------------------------------------------------
    // Shared fixtures: two trips, each with two media rows so the
    // listing assertions can isolate by trip / media.
    // -----------------------------------------------------------------
    const tripA = seedTrip(dbHandle.db, "Trip A");
    const tripB = seedTrip(dbHandle.db, "Trip B");
    const aMedia1 = seedMedia(dbHandle.db, tripA);
    const aMedia2 = seedMedia(dbHandle.db, tripA);
    const bMedia1 = seedMedia(dbHandle.db, tripB);
    const bMedia2 = seedMedia(dbHandle.db, tripB);

    // -----------------------------------------------------------------
    // CASE 1: insertGroup minimal + findGroupById
    // -----------------------------------------------------------------
    {
      const g = makeGroup({ tripId: tripA });
      repo.insertGroup(g);
      const fetched = repo.findGroupById(g.id);
      record(
        "insertGroup minimal + findGroupById round-trips id / tripId / groupType",
        fetched !== null &&
          fetched.id === g.id &&
          fetched.tripId === tripA &&
          fetched.groupType === "exact" &&
          fetched.recommendedMediaId === null &&
          fetched.confidence === null &&
          fetched.similarityScore === null &&
          fetched.userConfirmed === false,
        `fetched=${JSON.stringify(fetched)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 2: insertGroup with full payload (incl. userConfirmed=true)
    // -----------------------------------------------------------------
    {
      const g = makeGroup({
        tripId: tripA,
        groupType: "similar",
        recommendedMediaId: aMedia1,
        confidence: 0.85,
        similarityScore: 0.9,
        userConfirmed: true,
      });
      repo.insertGroup(g);
      const fetched = repo.findGroupById(g.id);
      record(
        "insertGroup full payload preserves all fields + userConfirmed boolean",
        fetched !== null &&
          fetched.groupType === "similar" &&
          fetched.recommendedMediaId === aMedia1 &&
          fetched.confidence === 0.85 &&
          fetched.similarityScore === 0.9 &&
          fetched.userConfirmed === true,
        `fetched=${JSON.stringify(fetched)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 3: findGroupById returns null for unknown id
    // -----------------------------------------------------------------
    {
      const missing = repo.findGroupById(randomUUID());
      record("findGroupById returns null for unknown id", missing === null, `result=${missing}`);
    }

    // -----------------------------------------------------------------
    // CASE 4: insertGroup CHECK / FK violations propagate
    // -----------------------------------------------------------------
    expectThrow(
      "insertGroup with unknown group_type → CHECK throws",
      () =>
        repo.insertGroup(
          makeGroup({
            tripId: tripA,
            groupType: "definitely_not_real" as never,
          }),
        ),
      /CHECK constraint failed: duplicate_groups_group_type_enum/,
    );
    expectThrow(
      "insertGroup with trip_id pointing nowhere → FK throws",
      () => repo.insertGroup(makeGroup({ tripId: randomUUID() })),
      /FOREIGN KEY constraint failed/,
    );
    expectThrow(
      "insertGroup with confidence > 1 → CHECK throws",
      () => repo.insertGroup(makeGroup({ tripId: tripA, confidence: 1.5 })),
      /CHECK constraint failed: duplicate_groups_confidence_range/,
    );
    expectThrow(
      "insertGroup with similarity_score < 0 → CHECK throws",
      () => repo.insertGroup(makeGroup({ tripId: tripA, similarityScore: -0.1 })),
      /CHECK constraint failed: duplicate_groups_similarity_score_range/,
    );

    // -----------------------------------------------------------------
    // CASE 5: insertItem minimal + listItemsByGroupId
    // -----------------------------------------------------------------
    let groupForItems = "";
    {
      const g = makeGroup({ tripId: tripA, groupType: "exact" });
      repo.insertGroup(g);
      groupForItems = g.id;
      repo.insertItem(makeItem({ groupId: g.id, mediaId: aMedia1 }));
      repo.insertItem(
        makeItem({
          groupId: g.id,
          mediaId: aMedia2,
          similarityScore: 0.99,
          qualityScore: 0.7,
          recommendation: "keep",
          reason: "best resolution",
          userDecision: "keep",
        }),
      );
      const items = repo.listItemsByGroupId(g.id);
      // Sorted similarity DESC NULLs LAST: aMedia2 (0.99) → aMedia1 (NULL)
      record(
        "insertItem + listItemsByGroupId returns 2 rows ordered similarity DESC NULLS LAST",
        items.length === 2 &&
          items[0]?.mediaId === aMedia2 &&
          items[0]?.similarityScore === 0.99 &&
          items[1]?.mediaId === aMedia1 &&
          items[1]?.similarityScore === null,
        `items=${JSON.stringify(items.map((i) => ({ media: i.mediaId, s: i.similarityScore })))}`,
      );
      record(
        "insertItem full payload preserves recommendation / reason / userDecision",
        items[0]?.recommendation === "keep" &&
          items[0]?.reason === "best resolution" &&
          items[0]?.userDecision === "keep" &&
          items[0]?.qualityScore === 0.7,
        `item0=${JSON.stringify(items[0])}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 6: insertItem UNIQUE / FK / CHECK violations propagate
    // -----------------------------------------------------------------
    expectThrow(
      "insertItem with duplicate (group_id, media_id) → UNIQUE throws",
      () => repo.insertItem(makeItem({ groupId: groupForItems, mediaId: aMedia1 })),
      /UNIQUE constraint failed: duplicate_group_items\.group_id, duplicate_group_items\.media_id/,
    );
    expectThrow(
      "insertItem with unknown group_id → FK throws",
      () => repo.insertItem(makeItem({ groupId: randomUUID(), mediaId: aMedia1 })),
      /FOREIGN KEY constraint failed/,
    );
    expectThrow(
      "insertItem with unknown media_id → FK throws",
      () => repo.insertItem(makeItem({ groupId: groupForItems, mediaId: randomUUID() })),
      /FOREIGN KEY constraint failed/,
    );
    expectThrow(
      "insertItem with unknown recommendation → CHECK throws",
      () =>
        repo.insertItem(
          makeItem({
            groupId: groupForItems,
            mediaId: bMedia1,
            recommendation: "delete_lol" as never,
          }),
        ),
      /CHECK constraint failed: duplicate_group_items_recommendation_enum/,
    );

    // -----------------------------------------------------------------
    // CASE 7: listByTripId — newest-first, trip isolation
    // -----------------------------------------------------------------
    {
      // Two groups in tripB seeded with controlled timestamps so the
      // ordering is deterministic.
      const olderId = randomUUID();
      const newerId = randomUUID();
      const olderTime = "2026-05-17T10:00:00.000Z";
      const newerTime = "2026-05-17T11:00:00.000Z";
      repo.insertGroup({
        id: olderId,
        tripId: tripB,
        groupType: "exact",
        createdAt: olderTime,
        updatedAt: olderTime,
      });
      repo.insertGroup({
        id: newerId,
        tripId: tripB,
        groupType: "similar",
        createdAt: newerTime,
        updatedAt: newerTime,
      });
      const tripBGroups = repo.listByTripId(tripB);
      record(
        "listByTripId returns 2 groups for tripB, newest first",
        tripBGroups.length === 2 &&
          tripBGroups[0]?.id === newerId &&
          tripBGroups[1]?.id === olderId,
        `ids=${JSON.stringify(tripBGroups.map((g) => g.id))}`,
      );
      const tripAGroups = repo.listByTripId(tripA);
      record(
        "listByTripId for tripA does not leak tripB rows",
        tripAGroups.every((g) => g.tripId === tripA),
        `tripIds=${JSON.stringify([...new Set(tripAGroups.map((g) => g.tripId))])}`,
      );
      const unknownTripGroups = repo.listByTripId(randomUUID());
      record(
        "listByTripId returns [] for unknown trip",
        unknownTripGroups.length === 0,
        `count=${unknownTripGroups.length}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 8: listGroupsByMediaId — reverse lookup through items
    // -----------------------------------------------------------------
    {
      // Add bMedia2 to one of the tripB groups (the second one
      // listed). It should then surface in listGroupsByMediaId.
      const tripBGroups = repo.listByTripId(tripB);
      const targetGroup = tripBGroups[0];
      if (!targetGroup) throw new Error("smoke fixture missing");
      repo.insertItem(makeItem({ groupId: targetGroup.id, mediaId: bMedia2 }));
      const groupsForMedia = repo.listGroupsByMediaId(bMedia2);
      record(
        "listGroupsByMediaId surfaces the group bMedia2 was just added to",
        groupsForMedia.some((g) => g.id === targetGroup.id),
        `ids=${JSON.stringify(groupsForMedia.map((g) => g.id))}`,
      );
      // bMedia1 hasn't been added anywhere → expect [].
      const groupsForBMedia1 = repo.listGroupsByMediaId(bMedia1);
      record(
        "listGroupsByMediaId returns [] for media never added to any group",
        groupsForBMedia1.length === 0,
        `count=${groupsForBMedia1.length}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 9: listByTripIdWithItems hydrates items per group
    // -----------------------------------------------------------------
    {
      const bundles = repo.listByTripIdWithItems(tripA);
      // tripA has CASE 1 group (empty), CASE 2 group (empty),
      // CASE 5 group (2 items). Find that case-5 group by item count.
      const richest = bundles.slice().sort((a, b) => b.items.length - a.items.length)[0];
      record(
        "listByTripIdWithItems hydrates per-group items array",
        richest !== undefined && richest.items.length === 2,
        `richest items count=${richest?.items.length}`,
      );
      record(
        "listByTripIdWithItems returns every group for the trip",
        bundles.length === repo.listByTripId(tripA).length,
        `bundles=${bundles.length} groups=${repo.listByTripId(tripA).length}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 10: deleteGroup cascades items via FK
    // -----------------------------------------------------------------
    {
      const removed = repo.deleteGroup(groupForItems);
      record("deleteGroup returns 1 for the deleted row", removed === 1, `changes=${removed}`);
      const gone = repo.findGroupById(groupForItems);
      record("deleteGroup removes the group row", gone === null, `found=${JSON.stringify(gone)}`);
      const orphanItems = repo.listItemsByGroupId(groupForItems);
      record(
        "deleteGroup cascades items via FK (none remain)",
        orphanItems.length === 0,
        `remaining=${orphanItems.length}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 11: deleteGroup for unknown id returns 0
    // -----------------------------------------------------------------
    {
      const removed = repo.deleteGroup(randomUUID());
      record("deleteGroup returns 0 for missing id", removed === 0, `changes=${removed}`);
    }

    // -----------------------------------------------------------------
    // CASE 12: createGroupWithItems success — writes group + N items
    // atomically, wiring the group's id into each item.
    // -----------------------------------------------------------------
    {
      const newGroup = makeGroup({ tripId: tripA, groupType: "exact" });
      const seedItems: DuplicateGroupItemSeedData[] = [
        {
          id: randomUUID(),
          mediaId: aMedia1,
          similarityScore: 1.0,
          recommendation: "keep",
          reason: "first member",
          userDecision: "undecided",
          createdAt: newGroup.createdAt,
          updatedAt: newGroup.updatedAt,
        },
        {
          id: randomUUID(),
          mediaId: aMedia2,
          similarityScore: 0.95,
          recommendation: "remove",
          reason: "duplicate of first",
          userDecision: "undecided",
          createdAt: newGroup.createdAt,
          updatedAt: newGroup.updatedAt,
        },
      ];
      repo.createGroupWithItems(newGroup, seedItems);
      const fetched = repo.findGroupById(newGroup.id);
      const hydratedItems = repo.listItemsByGroupId(newGroup.id);
      record(
        "createGroupWithItems success: group row exists",
        fetched !== null && fetched.id === newGroup.id,
        `fetched=${JSON.stringify(fetched)}`,
      );
      record(
        "createGroupWithItems success: 2 item rows wired to the new group id",
        hydratedItems.length === 2 && hydratedItems.every((i) => i.groupId === newGroup.id),
        `items=${JSON.stringify(hydratedItems.map((i) => ({ id: i.id, groupId: i.groupId })))}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 13: createGroupWithItems failure rolls back the group too
    // (atomicity guarantee per user-spec).
    //
    // We trigger the failure with a UNIQUE (group_id, media_id) clash
    // inside the items array: same mediaId twice.
    // -----------------------------------------------------------------
    {
      const groupBefore = repo.listByTripId(tripA).length;
      const failingGroup = makeGroup({ tripId: tripA, groupType: "similar" });
      const dupedItems: DuplicateGroupItemSeedData[] = [
        {
          id: randomUUID(),
          mediaId: aMedia1,
          createdAt: failingGroup.createdAt,
          updatedAt: failingGroup.updatedAt,
        },
        {
          // Second insert with the same mediaId → UNIQUE violation
          id: randomUUID(),
          mediaId: aMedia1,
          createdAt: failingGroup.createdAt,
          updatedAt: failingGroup.updatedAt,
        },
      ];
      let threw: unknown;
      try {
        repo.createGroupWithItems(failingGroup, dupedItems);
      } catch (err) {
        threw = err;
      }
      record(
        "createGroupWithItems failure: UNIQUE on duplicate items throws",
        threw instanceof Error && /UNIQUE constraint failed/.test(threw.message),
        describeError(threw),
      );
      // Group row must NOT exist (rolled back with the failing item).
      const afterFailure = repo.findGroupById(failingGroup.id);
      record(
        "createGroupWithItems failure: group row rolled back (does not exist)",
        afterFailure === null,
        `found=${JSON.stringify(afterFailure)}`,
      );
      // Trip group count unchanged.
      const groupAfter = repo.listByTripId(tripA).length;
      record(
        "createGroupWithItems failure: trip's group count unchanged",
        groupAfter === groupBefore,
        `before=${groupBefore} after=${groupAfter}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 14: createGroupWithItems with empty items array still
    // writes the group (Repository does not enforce semantic
    // minimum — that's a Service-layer rule).
    // -----------------------------------------------------------------
    {
      const lonelyGroup = makeGroup({ tripId: tripB, groupType: "candidate" });
      repo.createGroupWithItems(lonelyGroup, []);
      const fetched = repo.findGroupById(lonelyGroup.id);
      record(
        "createGroupWithItems with [] items still writes the group",
        fetched !== null && fetched.groupType === "candidate",
        `fetched=${JSON.stringify(fetched)}`,
      );
    }
  } finally {
    closeDatabase(dbHandle);
    await rm(tmpRoot, { recursive: true, force: true });
    console.log(`[smoke] cleaned up ${tmpRoot}`);
  }

  // -------------------------------------------------------------------
  // summary
  // -------------------------------------------------------------------
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
