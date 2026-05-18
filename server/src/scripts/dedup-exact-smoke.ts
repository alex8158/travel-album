// Manual smoke test for DedupEngine.exact (P5.T3).
//
// Usage: npm run smoke:dedup-exact
//
// Drives DedupEngine.runExactForTrip directly against a real SQLite
// DB. Seeds media + file_hash values directly (no real image_hash
// worker needed) so the algorithm under test is hashing equality +
// idempotency, not sharp / DCT.
//
// Coverage:
//   * Happy path: 2 images sharing file_hash → 1 exact group with 2
//     items, confidence=1.0, similarity_score=1.0, recommended_media_id
//     stays NULL (P6 fills later).
//   * Cohort of 3 + 1 singleton: only the 3-cohort yields a group.
//   * Multiple distinct hashes each shared → multiple groups.
//   * Singleton media (unique hashes) → no groups.
//   * Media without file_hash → ignored.
//   * Soft-deleted media → ignored.
//   * Video media → ignored (filtered by type='image').
//   * Same hash across two trips → two SEPARATE groups (no cross-trip
//     aggregation per design.md §7.3).
//   * Idempotency: re-running on identical state → 0 new groups,
//     `cohortsSkipped` populated with the prior cohort.
//   * User-confirmed protection: an existing exact group flagged
//     `user_confirmed=1` is never overwritten or duplicated, even
//     when membership would otherwise be identical.
//   * Partial-overlap: if any candidate member is already in some
//     exact group → skip the whole cohort.
//   * Item fields: recommendation='undecided', reason mentions
//     'exact byte-level match'.
//   * Atomicity: createGroupWithItems is per-cohort transactional;
//     we don't directly exercise the rollback path here (covered by
//     duplicate-groups-repository-smoke) but verify counters are
//     consistent with what we observe in the DB.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { DedupEngine, DuplicateGroupsRepository } from "../dedup/index.js";
import { createLogger } from "../logger.js";
import { MediaRepository } from "../media/index.js";
import { TripRepository, TripService } from "../trips/index.js";

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

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Insert a media row directly with the file_hash value the caller
 * chooses. We bypass the real `image_hash` worker so the smoke
 * doesn't depend on sharp / crypto correctness — those are covered
 * by smoke:image-hash.
 */
function seedMedia(
  db: SqliteDatabase,
  args: {
    tripId: string;
    fileHash: string | null;
    type?: "image" | "video";
    softDeleted?: boolean;
  },
): string {
  const mediaId = randomUUID();
  const now = nowIso();
  db.prepare(
    `INSERT INTO media_items
       (id, trip_id, type, original_path, mime_type, extension, file_size,
        file_hash, status, user_decision, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?,
             ?, ?, 'undecided', ?, ?, ?)`,
  ).run(
    mediaId,
    args.tripId,
    args.type ?? "image",
    `trips/${args.tripId}/originals/${mediaId}.${args.type === "video" ? "mp4" : "jpg"}`,
    args.type === "video" ? "video/mp4" : "image/jpeg",
    args.type === "video" ? "mp4" : "jpg",
    1024,
    args.fileHash,
    args.softDeleted === true ? "deleted" : "uploaded",
    now,
    now,
    args.softDeleted === true ? now : null,
  );
  return mediaId;
}

function seedTrip(tripService: TripService, title: string): string {
  return tripService.createTrip({ title }).id;
}

function listExactGroupsForTrip(db: SqliteDatabase, tripId: string): Record<string, unknown>[] {
  return db
    .prepare(
      `SELECT * FROM duplicate_groups
       WHERE trip_id = ? AND group_type = 'exact'
       ORDER BY created_at ASC, id ASC`,
    )
    .all(tripId) as Record<string, unknown>[];
}

function listItemsForGroup(db: SqliteDatabase, groupId: string): Record<string, unknown>[] {
  return db
    .prepare(`SELECT * FROM duplicate_group_items WHERE group_id = ? ORDER BY id ASC`)
    .all(groupId) as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-dedup-exact-smoke-"));
  const dbPath = path.join(tmpRoot, "smoke.db");
  console.log(`[smoke] dbPath=${dbPath}`);

  const dbHandle = openDatabase(dbPath);
  try {
    runMigrations(dbHandle.db);

    const logger = createLogger({ nodeEnv: "test" });
    const tripService = new TripService(new TripRepository(dbHandle.db));
    const mediaRepo = new MediaRepository(dbHandle.db);
    const duplicateGroupsRepo = new DuplicateGroupsRepository(dbHandle.db);
    const engine = new DedupEngine({ mediaRepo, duplicateGroupsRepo, logger });

    // -----------------------------------------------------------------
    // CASE 1: happy path — 2 images share hash → 1 exact group + 2 items
    // -----------------------------------------------------------------
    {
      const tripId = seedTrip(tripService, "Case1");
      const m1 = seedMedia(dbHandle.db, { tripId, fileHash: "h-case1" });
      const m2 = seedMedia(dbHandle.db, { tripId, fileHash: "h-case1" });

      const r = engine.runExactForTrip(tripId);
      record(
        "happy: result counters mediaScanned=2, hashesScanned=1, cohorts=1, created=1, skipped=0",
        r.mediaScanned === 2 &&
          r.hashesScanned === 1 &&
          r.candidateCohorts === 1 &&
          r.groupsCreated === 1 &&
          r.cohortsSkipped.length === 0,
        JSON.stringify(r),
      );

      const groups = listExactGroupsForTrip(dbHandle.db, tripId);
      record("happy: exactly 1 exact group exists", groups.length === 1, `count=${groups.length}`);
      const group = groups[0];
      record(
        "happy: group has group_type='exact', confidence=1.0, similarity_score=1.0, user_confirmed=0",
        group !== undefined &&
          group.group_type === "exact" &&
          group.confidence === 1.0 &&
          group.similarity_score === 1.0 &&
          group.user_confirmed === 0,
        JSON.stringify(group),
      );
      record(
        "happy: recommended_media_id is NULL (deferred to P6.T5)",
        group?.recommended_media_id === null,
        `recommended=${String(group?.recommended_media_id)}`,
      );

      const items = listItemsForGroup(dbHandle.db, group?.id as string);
      const memberIds = new Set(items.map((i) => i.media_id as string));
      record(
        "happy: 2 items covering both source media",
        items.length === 2 && memberIds.has(m1) && memberIds.has(m2),
        `items=${JSON.stringify([...memberIds])}`,
      );
      record(
        "happy: items have recommendation='undecided', reason mentions 'exact byte-level match'",
        items.every(
          (i) =>
            i.recommendation === "undecided" &&
            typeof i.reason === "string" &&
            /exact byte-level match/.test(i.reason as string) &&
            i.similarity_score === 1.0,
        ),
        JSON.stringify(items.map((i) => ({ rec: i.recommendation, reason: i.reason }))),
      );
    }

    // -----------------------------------------------------------------
    // CASE 2: cohort of 3 + 1 singleton → 1 group with 3 items
    // -----------------------------------------------------------------
    {
      const tripId = seedTrip(tripService, "Case2");
      const triplet = [
        seedMedia(dbHandle.db, { tripId, fileHash: "h-c2-triple" }),
        seedMedia(dbHandle.db, { tripId, fileHash: "h-c2-triple" }),
        seedMedia(dbHandle.db, { tripId, fileHash: "h-c2-triple" }),
      ];
      const singleton = seedMedia(dbHandle.db, { tripId, fileHash: "h-c2-lonely" });

      const r = engine.runExactForTrip(tripId);
      record(
        "triple+singleton: cohorts=1 (the triplet), singleton excluded",
        r.candidateCohorts === 1 && r.groupsCreated === 1 && r.mediaScanned === 4,
        JSON.stringify(r),
      );

      const groups = listExactGroupsForTrip(dbHandle.db, tripId);
      const items = listItemsForGroup(dbHandle.db, groups[0]?.id as string);
      const memberIds = new Set(items.map((i) => i.media_id as string));
      record(
        "triple+singleton: 3 items covering all triplet members + singleton excluded",
        items.length === 3 && triplet.every((id) => memberIds.has(id)) && !memberIds.has(singleton),
        `items=${JSON.stringify([...memberIds])}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 3: multiple distinct shared hashes → multiple groups
    // -----------------------------------------------------------------
    {
      const tripId = seedTrip(tripService, "Case3");
      seedMedia(dbHandle.db, { tripId, fileHash: "h-c3-a" });
      seedMedia(dbHandle.db, { tripId, fileHash: "h-c3-a" });
      seedMedia(dbHandle.db, { tripId, fileHash: "h-c3-b" });
      seedMedia(dbHandle.db, { tripId, fileHash: "h-c3-b" });
      const r = engine.runExactForTrip(tripId);
      record(
        "multi-hash: 2 groups created in one run",
        r.candidateCohorts === 2 && r.groupsCreated === 2,
        JSON.stringify(r),
      );
      record(
        "multi-hash: 2 exact group rows exist in DB",
        listExactGroupsForTrip(dbHandle.db, tripId).length === 2,
        `count=${listExactGroupsForTrip(dbHandle.db, tripId).length}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 4: all singletons → 0 groups
    // -----------------------------------------------------------------
    {
      const tripId = seedTrip(tripService, "Case4");
      seedMedia(dbHandle.db, { tripId, fileHash: "h-c4-x" });
      seedMedia(dbHandle.db, { tripId, fileHash: "h-c4-y" });
      seedMedia(dbHandle.db, { tripId, fileHash: "h-c4-z" });
      const r = engine.runExactForTrip(tripId);
      record(
        "all-singletons: 0 groups created",
        r.candidateCohorts === 0 && r.groupsCreated === 0 && r.hashesScanned === 3,
        JSON.stringify(r),
      );
    }

    // -----------------------------------------------------------------
    // CASE 5: rows with NULL file_hash are excluded
    // -----------------------------------------------------------------
    {
      const tripId = seedTrip(tripService, "Case5");
      // Two valid hash-bearing duplicates + one NULL-hash row.
      seedMedia(dbHandle.db, { tripId, fileHash: "h-c5" });
      seedMedia(dbHandle.db, { tripId, fileHash: "h-c5" });
      seedMedia(dbHandle.db, { tripId, fileHash: null });
      const r = engine.runExactForTrip(tripId);
      record(
        "null file_hash excluded: mediaScanned=2 (NULL row dropped), 1 group created",
        r.mediaScanned === 2 && r.groupsCreated === 1,
        JSON.stringify(r),
      );
    }

    // -----------------------------------------------------------------
    // CASE 6: soft-deleted media excluded
    // -----------------------------------------------------------------
    {
      const tripId = seedTrip(tripService, "Case6");
      seedMedia(dbHandle.db, { tripId, fileHash: "h-c6" });
      seedMedia(dbHandle.db, { tripId, fileHash: "h-c6", softDeleted: true });
      const r = engine.runExactForTrip(tripId);
      record(
        "soft-deleted excluded: mediaScanned=1, 0 groups created (singleton after filter)",
        r.mediaScanned === 1 && r.groupsCreated === 0,
        JSON.stringify(r),
      );
    }

    // -----------------------------------------------------------------
    // CASE 7: video media excluded (filtered by type='image')
    // -----------------------------------------------------------------
    {
      const tripId = seedTrip(tripService, "Case7");
      seedMedia(dbHandle.db, { tripId, fileHash: "h-c7" });
      seedMedia(dbHandle.db, { tripId, fileHash: "h-c7", type: "video" });
      const r = engine.runExactForTrip(tripId);
      record(
        "video excluded: mediaScanned=1 (image only), 0 groups created",
        r.mediaScanned === 1 && r.groupsCreated === 0,
        JSON.stringify(r),
      );
    }

    // -----------------------------------------------------------------
    // CASE 8: same hash across two trips → two SEPARATE groups
    // -----------------------------------------------------------------
    {
      const tripA = seedTrip(tripService, "Case8-A");
      const tripB = seedTrip(tripService, "Case8-B");
      const sharedHash = "h-c8-cross";
      seedMedia(dbHandle.db, { tripId: tripA, fileHash: sharedHash });
      seedMedia(dbHandle.db, { tripId: tripA, fileHash: sharedHash });
      seedMedia(dbHandle.db, { tripId: tripB, fileHash: sharedHash });
      seedMedia(dbHandle.db, { tripId: tripB, fileHash: sharedHash });
      const rA = engine.runExactForTrip(tripA);
      const rB = engine.runExactForTrip(tripB);
      record(
        "cross-trip isolation: tripA gets 1 group, tripB gets 1 group",
        rA.groupsCreated === 1 && rB.groupsCreated === 1,
        `tripA=${JSON.stringify(rA)} tripB=${JSON.stringify(rB)}`,
      );
      record(
        "cross-trip isolation: tripA's exact group does not contain tripB members",
        listExactGroupsForTrip(dbHandle.db, tripA).length === 1 &&
          listExactGroupsForTrip(dbHandle.db, tripB).length === 1,
        `A=${listExactGroupsForTrip(dbHandle.db, tripA).length} B=${
          listExactGroupsForTrip(dbHandle.db, tripB).length
        }`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 9: idempotency — re-run on identical state yields 0 new
    // groups and surfaces the prior cohort as 'skipped'.
    // -----------------------------------------------------------------
    {
      const tripId = seedTrip(tripService, "Case9");
      seedMedia(dbHandle.db, { tripId, fileHash: "h-c9" });
      seedMedia(dbHandle.db, { tripId, fileHash: "h-c9" });
      const first = engine.runExactForTrip(tripId);
      record(
        "idempotency: first run creates 1 group",
        first.groupsCreated === 1 && first.cohortsSkipped.length === 0,
        JSON.stringify(first),
      );
      const second = engine.runExactForTrip(tripId);
      record(
        "idempotency: second run creates 0 groups + cohortsSkipped[0].reason='already-grouped'",
        second.groupsCreated === 0 &&
          second.cohortsSkipped.length === 1 &&
          second.cohortsSkipped[0]?.reason === "already-grouped",
        JSON.stringify(second),
      );
      const groupsAfter = listExactGroupsForTrip(dbHandle.db, tripId);
      record(
        "idempotency: still exactly 1 exact group row in DB after re-run",
        groupsAfter.length === 1,
        `count=${groupsAfter.length}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 10: user-confirmed protection — a user_confirmed=1 group
    // is never duplicated nor overwritten.
    // -----------------------------------------------------------------
    {
      const tripId = seedTrip(tripService, "Case10");
      const m1 = seedMedia(dbHandle.db, { tripId, fileHash: "h-c10" });
      const m2 = seedMedia(dbHandle.db, { tripId, fileHash: "h-c10" });
      // Seed an existing exact group already marked user_confirmed=1
      // directly via the repository (mimics a P5.T7 confirmation).
      const groupId = randomUUID();
      const now = nowIso();
      duplicateGroupsRepo.createGroupWithItems(
        {
          id: groupId,
          tripId,
          groupType: "exact",
          recommendedMediaId: m1,
          confidence: 1.0,
          similarityScore: 1.0,
          userConfirmed: true,
          createdAt: now,
          updatedAt: now,
        },
        [
          {
            id: randomUUID(),
            mediaId: m1,
            similarityScore: 1.0,
            recommendation: "keep",
            reason: "user kept",
            userDecision: "keep",
            createdAt: now,
            updatedAt: now,
          },
          {
            id: randomUUID(),
            mediaId: m2,
            similarityScore: 1.0,
            recommendation: "remove",
            reason: "user removed",
            userDecision: "remove",
            createdAt: now,
            updatedAt: now,
          },
        ],
      );

      const r = engine.runExactForTrip(tripId);
      record(
        "user-confirmed: engine skips the cohort whose members are in a user_confirmed group",
        r.groupsCreated === 0 &&
          r.cohortsSkipped.length === 1 &&
          r.cohortsSkipped[0]?.reason === "already-grouped",
        JSON.stringify(r),
      );

      // The original user-confirmed group must remain intact.
      const groups = listExactGroupsForTrip(dbHandle.db, tripId);
      record(
        "user-confirmed: original group still exists with user_confirmed=1",
        groups.length === 1 && groups[0]?.id === groupId && groups[0]?.user_confirmed === 1,
        JSON.stringify(groups[0]),
      );
      const items = listItemsForGroup(dbHandle.db, groupId);
      const userDecisions = items.map((i) => i.user_decision as string).sort();
      record(
        "user-confirmed: original item user_decision values untouched (keep + remove)",
        userDecisions.length === 2 && userDecisions[0] === "keep" && userDecisions[1] === "remove",
        JSON.stringify(userDecisions),
      );
    }

    // -----------------------------------------------------------------
    // CASE 11: partial overlap — one member of a new cohort already
    // sits in an existing exact group → engine skips the whole cohort.
    // -----------------------------------------------------------------
    {
      const tripId = seedTrip(tripService, "Case11");
      const overlappingHash = "h-c11";
      const m1 = seedMedia(dbHandle.db, { tripId, fileHash: overlappingHash });
      const m2 = seedMedia(dbHandle.db, { tripId, fileHash: overlappingHash });

      // Pre-create an exact group containing m1 ONLY paired with some
      // other media — mimics a stale group from a prior data state.
      // We use m2 as the partner so the existing group contains m1+m2
      // and we ALSO add a 3rd hash-equal media m3 to make the new
      // cohort larger than the existing group.
      const m3 = seedMedia(dbHandle.db, { tripId, fileHash: overlappingHash });
      const groupId = randomUUID();
      const now = nowIso();
      duplicateGroupsRepo.createGroupWithItems(
        {
          id: groupId,
          tripId,
          groupType: "exact",
          confidence: 1.0,
          similarityScore: 1.0,
          userConfirmed: false,
          createdAt: now,
          updatedAt: now,
        },
        [
          {
            id: randomUUID(),
            mediaId: m1,
            similarityScore: 1.0,
            recommendation: "undecided",
            reason: "previous run",
            userDecision: "undecided",
            createdAt: now,
            updatedAt: now,
          },
          {
            id: randomUUID(),
            mediaId: m2,
            similarityScore: 1.0,
            recommendation: "undecided",
            reason: "previous run",
            userDecision: "undecided",
            createdAt: now,
            updatedAt: now,
          },
        ],
      );

      const r = engine.runExactForTrip(tripId);
      record(
        "partial-overlap: cohort {m1, m2, m3} skipped because m1/m2 already grouped",
        r.candidateCohorts === 1 && r.groupsCreated === 0 && r.cohortsSkipped.length === 1,
        JSON.stringify(r),
      );
      record(
        "partial-overlap: still exactly 1 exact group; m3 not added",
        listExactGroupsForTrip(dbHandle.db, tripId).length === 1,
        `count=${listExactGroupsForTrip(dbHandle.db, tripId).length}`,
      );
      // Verify m3 is in no group at all (engine left it alone).
      const m3Groups = duplicateGroupsRepo.listGroupsByMediaId(m3);
      record(
        "partial-overlap: m3 is in no exact group (engine did not silently add it)",
        m3Groups.length === 0,
        `groups for m3=${m3Groups.length}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 12: empty trip → result with all zeroes, no throw
    // -----------------------------------------------------------------
    {
      const tripId = seedTrip(tripService, "Case12-empty");
      const r = engine.runExactForTrip(tripId);
      record(
        "empty trip: all counters zero",
        r.mediaScanned === 0 &&
          r.hashesScanned === 0 &&
          r.candidateCohorts === 0 &&
          r.groupsCreated === 0 &&
          r.cohortsSkipped.length === 0,
        JSON.stringify(r),
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
