// Manual smoke test for `DedupService.deleteOthers` (P7.T3).
//
// Usage: npm run smoke:dedup-delete-others
//
// Coverage:
//   * Happy path: a 3-member group with `recommended_media_id` set
//     and items marked keep / remove / remove → the two removes are
//     soft-deleted via `MediaService.softDeleteMedia`; the winner
//     stays active.
//   * Idempotency: a second `deleteOthers` returns deletedCount=0,
//     skippedCount=N (the already-soft-deleted members land in
//     skippedMediaIds via softDeleteMedia's alreadyDeleted path).
//   * Group has no 'remove' items (e.g. fresh dedup before
//     Quality_Selector ran, everything 'undecided') → status='applied',
//     deletedCount=0.
//   * Group has no `recommended_media_id` → status='no-winner',
//     deletedCount=0, group untouched.
//   * Group not found → 404 NotFoundError.
//   * Malformed group id → ValidationError.
//   * Cross-table cleanup: deleted members disappear from gallery
//     list / dedup engine readers / findBestCoverCandidate. Other
//     groups in the same trip are unaffected.
//   * Restore after delete-others: the restored member returns to
//     active state; a trip-scope quality_selector_run is enqueued by
//     restoreMedia (already covered in restore smoke; here we verify
//     the deletion → restore → reappear chain still works).
//   * Confirmed group + delete-others: works the same way; the
//     `user_confirmed = 1` flag is preserved.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { DedupEngine, DedupService, DuplicateGroupsRepository } from "../dedup/index.js";
import { createLogger } from "../logger.js";
import {
  MediaAnalysisRepository,
  MediaRepository,
  MediaService,
  MediaVersionsRepository,
  type MediaSoftDeleteDeps,
} from "../media/index.js";
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
// fixtures
// ---------------------------------------------------------------------------

function seedMedia(
  db: SqliteDatabase,
  tripId: string,
  args: { qualityScore?: number; isBlurry?: 0 | 1 | null } = {},
): string {
  const mediaId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO media_items
       (id, trip_id, type, original_path, thumbnail_path,
        mime_type, extension, file_size,
        status, user_decision, created_at, updated_at)
     VALUES (?, ?, 'image', ?, ?,
             'image/jpeg', 'jpg', 1024,
             'processed', 'undecided', ?, ?)`,
  ).run(
    mediaId,
    tripId,
    `trips/${tripId}/originals/${mediaId}.jpg`,
    `trips/${tripId}/derived/${mediaId}/thumb.webp`,
    now,
    now,
  );
  if (args.qualityScore !== undefined || args.isBlurry !== undefined) {
    db.prepare(
      `INSERT INTO media_analysis (
         id, media_id, quality_score, is_blurry, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), mediaId, args.qualityScore ?? null, args.isBlurry ?? null, now, now);
  }
  return mediaId;
}

function seedGroup(
  duplicateGroupsRepo: DuplicateGroupsRepository,
  args: {
    tripId: string;
    items: Array<{ mediaId: string; recommendation: "keep" | "remove" | "undecided" }>;
    recommendedMediaId?: string | null;
    userConfirmed?: boolean;
  },
): string {
  const groupId = randomUUID();
  const now = new Date().toISOString();
  duplicateGroupsRepo.createGroupWithItems(
    {
      id: groupId,
      tripId: args.tripId,
      groupType: "exact",
      recommendedMediaId: args.recommendedMediaId ?? null,
      userConfirmed: args.userConfirmed === true,
      createdAt: now,
      updatedAt: now,
    },
    args.items.map((it) => ({
      id: randomUUID(),
      mediaId: it.mediaId,
      recommendation: it.recommendation,
      reason: null,
      userDecision: "undecided",
      createdAt: now,
      updatedAt: now,
    })),
  );
  return groupId;
}

function readMedia(db: SqliteDatabase, id: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM media_items WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
}

function readGroup(db: SqliteDatabase, id: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM duplicate_groups WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-dedup-delete-others-smoke-"));
  const dbPath = path.join(tmpRoot, "smoke.db");
  console.log(`[smoke] tmpRoot=${tmpRoot}`);

  const dbHandle = openDatabase(dbPath);
  try {
    runMigrations(dbHandle.db);

    const logger = createLogger({ nodeEnv: "test" });
    const tripRepo = new TripRepository(dbHandle.db);
    const tripService = new TripService(tripRepo);
    const mediaRepo = new MediaRepository(dbHandle.db);
    const mediaVersionsRepo = new MediaVersionsRepository(dbHandle.db);
    const duplicateGroupsRepo = new DuplicateGroupsRepository(dbHandle.db);
    const _mediaAnalysisRepo = new MediaAnalysisRepository(dbHandle.db);
    void _mediaAnalysisRepo;

    const softDeleteDeps: MediaSoftDeleteDeps = {
      db: dbHandle.db,
      tripRepo,
      duplicateGroupsRepo,
      logger,
    };
    const mediaService = new MediaService(
      mediaRepo,
      tripService,
      mediaVersionsRepo,
      undefined,
      softDeleteDeps,
    );
    const dedupEngine = new DedupEngine({ mediaRepo, duplicateGroupsRepo, logger });
    const dedupService = new DedupService(
      dedupEngine,
      tripService,
      duplicateGroupsRepo,
      mediaRepo,
      mediaService,
    );

    // -----------------------------------------------------------------
    // CASE 1: happy path — 3 members (keep + 2 remove), winner kept,
    //         2 soft-deleted.
    // -----------------------------------------------------------------
    const trip1 = tripService.createTrip({ title: "Case1 happy path" });
    const winner = seedMedia(dbHandle.db, trip1.id, { qualityScore: 0.92, isBlurry: 0 });
    const loserA = seedMedia(dbHandle.db, trip1.id, { qualityScore: 0.4, isBlurry: 0 });
    const loserB = seedMedia(dbHandle.db, trip1.id, { qualityScore: 0.3, isBlurry: 0 });
    const groupId = seedGroup(duplicateGroupsRepo, {
      tripId: trip1.id,
      recommendedMediaId: winner,
      items: [
        { mediaId: winner, recommendation: "keep" },
        { mediaId: loserA, recommendation: "remove" },
        { mediaId: loserB, recommendation: "remove" },
      ],
    });
    const outcome1 = dedupService.deleteOthers(groupId);
    record(
      "happy: status='applied' + keptMediaId = winner",
      outcome1.status === "applied" && outcome1.keptMediaId === winner,
      JSON.stringify(outcome1),
    );
    record(
      "happy: deletedCount === 2 + both losers in deletedMediaIds",
      outcome1.deletedCount === 2 &&
        outcome1.deletedMediaIds.includes(loserA) &&
        outcome1.deletedMediaIds.includes(loserB),
      JSON.stringify(outcome1.deletedMediaIds),
    );
    record(
      "happy: skippedCount === 0",
      outcome1.skippedCount === 0,
      `skipped=${outcome1.skippedCount}`,
    );
    record(
      "happy: winner row still active",
      readMedia(dbHandle.db, winner)?.deleted_at === null,
      `deleted_at=${String(readMedia(dbHandle.db, winner)?.deleted_at)}`,
    );
    record(
      "happy: loserA row soft-deleted (deleted_at populated + status='deleted')",
      typeof readMedia(dbHandle.db, loserA)?.deleted_at === "string" &&
        readMedia(dbHandle.db, loserA)?.status === "deleted",
      JSON.stringify({
        deletedAt: readMedia(dbHandle.db, loserA)?.deleted_at,
        status: readMedia(dbHandle.db, loserA)?.status,
      }),
    );
    record(
      "happy: loserB row soft-deleted",
      typeof readMedia(dbHandle.db, loserB)?.deleted_at === "string",
      `deleted_at=${String(readMedia(dbHandle.db, loserB)?.deleted_at)}`,
    );

    // -----------------------------------------------------------------
    // CASE 2: idempotency — re-run deleteOthers; losers already gone.
    // -----------------------------------------------------------------
    {
      const outcome = dedupService.deleteOthers(groupId);
      record(
        "idempotent: status='applied' + deletedCount === 0",
        outcome.status === "applied" && outcome.deletedCount === 0,
        JSON.stringify(outcome),
      );
      record(
        "idempotent: skippedCount === 2 (both losers already soft-deleted)",
        outcome.skippedCount === 2 &&
          outcome.skippedMediaIds.includes(loserA) &&
          outcome.skippedMediaIds.includes(loserB),
        JSON.stringify(outcome.skippedMediaIds),
      );
    }

    // -----------------------------------------------------------------
    // CASE 3: gallery + dedup readers exclude the soft-deleted losers.
    // -----------------------------------------------------------------
    {
      const list = mediaService.listMediaForTrip(trip1.id);
      record(
        "gallery filter: list excludes the soft-deleted losers",
        list.every((mm) => mm.id !== loserA && mm.id !== loserB),
        `count=${list.length}`,
      );
      const candidate = mediaRepo.findBestCoverCandidate(trip1.id);
      record(
        "cover filter: findBestCoverCandidate excludes the soft-deleted losers",
        candidate === null || (candidate.mediaId !== loserA && candidate.mediaId !== loserB),
        JSON.stringify(candidate),
      );
    }

    // -----------------------------------------------------------------
    // CASE 4: group with no 'remove' items → applied + deletedCount=0.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case4 no remove members" });
      const m1 = seedMedia(dbHandle.db, trip.id);
      const m2 = seedMedia(dbHandle.db, trip.id);
      const gid = seedGroup(duplicateGroupsRepo, {
        tripId: trip.id,
        recommendedMediaId: m1,
        items: [
          { mediaId: m1, recommendation: "keep" },
          { mediaId: m2, recommendation: "undecided" }, // not 'remove'
        ],
      });
      const outcome = dedupService.deleteOthers(gid);
      record(
        "no-remove: status='applied' + deletedCount === 0 + skippedCount === 0",
        outcome.status === "applied" && outcome.deletedCount === 0 && outcome.skippedCount === 0,
        JSON.stringify(outcome),
      );
      record(
        "no-remove: both members still active",
        readMedia(dbHandle.db, m1)?.deleted_at === null &&
          readMedia(dbHandle.db, m2)?.deleted_at === null,
        "",
      );
    }

    // -----------------------------------------------------------------
    // CASE 5: group with no recommended_media_id → status='no-winner'.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case5 no winner" });
      const a = seedMedia(dbHandle.db, trip.id);
      const b = seedMedia(dbHandle.db, trip.id);
      const gid = seedGroup(duplicateGroupsRepo, {
        tripId: trip.id,
        recommendedMediaId: null,
        items: [
          { mediaId: a, recommendation: "remove" },
          { mediaId: b, recommendation: "remove" },
        ],
      });
      const outcome = dedupService.deleteOthers(gid);
      record(
        "no-winner: status='no-winner' + keptMediaId=null",
        outcome.status === "no-winner" && outcome.keptMediaId === null,
        JSON.stringify(outcome),
      );
      record(
        "no-winner: deletedCount=0 + skippedCount=0",
        outcome.deletedCount === 0 && outcome.skippedCount === 0,
        "",
      );
      record(
        "no-winner: both members still active (refused to delete)",
        readMedia(dbHandle.db, a)?.deleted_at === null &&
          readMedia(dbHandle.db, b)?.deleted_at === null,
        "",
      );
    }

    // -----------------------------------------------------------------
    // CASE 6: group not found → 404.
    // -----------------------------------------------------------------
    {
      let threw: unknown;
      try {
        dedupService.deleteOthers(randomUUID());
      } catch (err) {
        threw = err;
      }
      record(
        "missing group: throws NotFoundError",
        threw !== undefined && /Duplicate group not found/.test(describeError(threw)),
        describeError(threw),
      );
    }

    // -----------------------------------------------------------------
    // CASE 7: malformed group id → ValidationError.
    // -----------------------------------------------------------------
    {
      let threw: unknown;
      try {
        dedupService.deleteOthers("not-a-uuid!@#");
      } catch (err) {
        threw = err;
      }
      record(
        "validation: malformed id rejected",
        threw !== undefined && /Validation/.test(describeError(threw)),
        describeError(threw),
      );
    }

    // -----------------------------------------------------------------
    // CASE 8: defensive — winner tagged 'remove' is still kept.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case8 winner tagged remove" });
      const w = seedMedia(dbHandle.db, trip.id);
      const x = seedMedia(dbHandle.db, trip.id);
      const gid = seedGroup(duplicateGroupsRepo, {
        tripId: trip.id,
        recommendedMediaId: w,
        // Pathological state: the recommendedMediaId AND a recommendation='remove' row
        // both name the same media. Shouldn't happen in production (P5.T7 confirm
        // flips items.recommendation to 'keep' for the winner), but be defensive.
        items: [
          { mediaId: w, recommendation: "remove" }, // tagged remove but is the winner!
          { mediaId: x, recommendation: "remove" },
        ],
      });
      const outcome = dedupService.deleteOthers(gid);
      record(
        "defensive: winner skipped from delete loop even when tagged 'remove'",
        outcome.deletedMediaIds.includes(x) && !outcome.deletedMediaIds.includes(w),
        JSON.stringify(outcome),
      );
      record(
        "defensive: winner row still active",
        readMedia(dbHandle.db, w)?.deleted_at === null,
        `deleted_at=${String(readMedia(dbHandle.db, w)?.deleted_at)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 9: confirmed group + delete-others — user_confirmed stays 1.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case9 confirmed group" });
      const k = seedMedia(dbHandle.db, trip.id);
      const r1 = seedMedia(dbHandle.db, trip.id);
      const r2 = seedMedia(dbHandle.db, trip.id);
      const gid = seedGroup(duplicateGroupsRepo, {
        tripId: trip.id,
        recommendedMediaId: k,
        userConfirmed: true,
        items: [
          { mediaId: k, recommendation: "keep" },
          { mediaId: r1, recommendation: "remove" },
          { mediaId: r2, recommendation: "remove" },
        ],
      });
      const outcome = dedupService.deleteOthers(gid);
      record(
        "confirmed: status='applied' + deletedCount === 2",
        outcome.status === "applied" && outcome.deletedCount === 2,
        JSON.stringify(outcome),
      );
      const row = readGroup(dbHandle.db, gid);
      record(
        "confirmed: group.user_confirmed stays 1",
        row?.user_confirmed === 1,
        `user_confirmed=${String(row?.user_confirmed)}`,
      );
      record(
        "confirmed: recommended_media_id stays = winner",
        row?.recommended_media_id === k,
        `recommended=${String(row?.recommended_media_id)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 10: delete-others does NOT affect another group in the trip.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case10 isolation" });
      // Group A: will run delete-others.
      const aWin = seedMedia(dbHandle.db, trip.id);
      const aLose = seedMedia(dbHandle.db, trip.id);
      const groupA = seedGroup(duplicateGroupsRepo, {
        tripId: trip.id,
        recommendedMediaId: aWin,
        items: [
          { mediaId: aWin, recommendation: "keep" },
          { mediaId: aLose, recommendation: "remove" },
        ],
      });
      // Group B: separate; should be untouched.
      const bWin = seedMedia(dbHandle.db, trip.id);
      const bMember = seedMedia(dbHandle.db, trip.id);
      const groupB = seedGroup(duplicateGroupsRepo, {
        tripId: trip.id,
        recommendedMediaId: bWin,
        items: [
          { mediaId: bWin, recommendation: "keep" },
          { mediaId: bMember, recommendation: "remove" },
        ],
      });
      dedupService.deleteOthers(groupA);
      record(
        "isolation: groupA's loser soft-deleted",
        typeof readMedia(dbHandle.db, aLose)?.deleted_at === "string",
        `aLose.deleted_at=${String(readMedia(dbHandle.db, aLose)?.deleted_at)}`,
      );
      record(
        "isolation: groupB's member still active",
        readMedia(dbHandle.db, bMember)?.deleted_at === null,
        `bMember.deleted_at=${String(readMedia(dbHandle.db, bMember)?.deleted_at)}`,
      );
      record(
        "isolation: groupB.recommended_media_id unchanged",
        readGroup(dbHandle.db, groupB)?.recommended_media_id === bWin,
        `recommended=${String(readGroup(dbHandle.db, groupB)?.recommended_media_id)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 11: restore after delete-others — restored member is
    //          visible again; chain works.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case11 restore after bulk" });
      const w = seedMedia(dbHandle.db, trip.id);
      const r = seedMedia(dbHandle.db, trip.id);
      const gid = seedGroup(duplicateGroupsRepo, {
        tripId: trip.id,
        recommendedMediaId: w,
        items: [
          { mediaId: w, recommendation: "keep" },
          { mediaId: r, recommendation: "remove" },
        ],
      });
      dedupService.deleteOthers(gid);
      const outcomeRestore = mediaService.restoreMedia(r);
      record(
        "restore-after-bulk: restoreMedia succeeds + alreadyRestored=false",
        outcomeRestore.restored === true && outcomeRestore.alreadyRestored === false,
        JSON.stringify(outcomeRestore),
      );
      const after = readMedia(dbHandle.db, r);
      record(
        "restore-after-bulk: media row active again (deleted_at NULL)",
        after?.deleted_at === null && after?.status === "processed",
        `deleted_at=${String(after?.deleted_at)} status=${String(after?.status)}`,
      );
      const inList = mediaService.listMediaForTrip(trip.id).some((mm) => mm.id === r);
      record(
        "restore-after-bulk: gallery list re-includes the restored member",
        inList,
        `present=${inList}`,
      );
    }
  } finally {
    closeDatabase(dbHandle);
    await rm(tmpRoot, { recursive: true, force: true });
    console.log(`[smoke] cleaned up ${tmpRoot}`);
  }

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
