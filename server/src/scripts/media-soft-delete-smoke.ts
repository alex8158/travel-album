// Manual smoke test for media soft-delete (P7.T1).
//
// Usage: npm run smoke:media-soft-delete
//
// Coverage:
//   * Basic happy path: DELETE on active media writes `deleted_at`
//     + flips `status` to 'deleted'; original / preview / thumbnail
//     files on disk are NOT removed.
//   * Idempotency: a second DELETE returns 200 with
//     `alreadyDeleted: true` and does not re-touch the row.
//   * Missing media: 404 NotFoundError.
//   * Read filters: gallery list + detail fetch hide soft-deleted
//     media after delete.
//   * Quality_Selector + auto-cover filters: `findBestCoverCandidate`
//     skips soft-deleted media; dedup engine's
//     `findActiveImageHashesByTripId` /
//     `findActiveImagePerceptualHashesByTripId` skip soft-deleted
//     media.
//   * Duplicate-group reference cleanup:
//       - `duplicate_groups.recommended_media_id` is reset to NULL
//         when the soft-deleted media was the group's recommendation.
//       - `duplicate_group_items` rows are LEFT untouched (design.md
//         §4.3 allows "保留记录"); UI projects them as `media: null`.
//   * Trip cover cleanup:
//       - When a non-pinned cover is the soft-deleted media, the
//         `trips.cover_media_id` is cleared AND the auto-selector
//         immediately picks a substitute (if one exists).
//       - When a user-pinned cover (`cover_set_by_user=1`) is the
//         soft-deleted media, the cover is cleared, the pin is
//         released (`cover_set_by_user=0`), and the auto-selector
//         picks a substitute.
//       - When no substitute exists, cover_media_id stays NULL.
//   * Cross-table integrity: no FK errors at any point.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { DuplicateGroupsRepository } from "../dedup/index.js";
import { createLogger } from "../logger.js";
import {
  MediaAnalysisRepository,
  MediaRepository,
  MediaService,
  MediaVersionsRepository,
  type MediaSoftDeleteDeps,
} from "../media/index.js";
import { LocalStorageProvider } from "../storage/index.js";
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

interface SeedMediaArgs {
  readonly tripId: string;
  readonly storage?: LocalStorageProvider;
  readonly thumbnailPath?: string | null;
  readonly status?: string;
  readonly qualityScore?: number | null;
  readonly isBlurry?: 0 | 1 | null;
}

async function seedMediaWithBytes(
  db: SqliteDatabase,
  args: SeedMediaArgs,
): Promise<{ readonly id: string; readonly originalPath: string }> {
  const mediaId = randomUUID();
  const now = new Date().toISOString();
  // Synthesize a tiny "JPEG" — just enough bytes for the storage
  // provider to write a file; we never decode it.
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
  let originalPath = `trips/${args.tripId}/originals/${mediaId}.jpg`;
  if (args.storage !== undefined) {
    const stored = await args.storage.putOriginal({
      tripId: args.tripId,
      mediaId,
      extension: "jpg",
      data: bytes,
    });
    originalPath = stored.logicalPath;
  }
  db.prepare(
    `INSERT INTO media_items
       (id, trip_id, type, original_path, thumbnail_path,
        mime_type, extension, file_size,
        status, user_decision, created_at, updated_at)
     VALUES (?, ?, 'image', ?, ?,
             'image/jpeg', 'jpg', ?,
             ?, 'undecided', ?, ?)`,
  ).run(
    mediaId,
    args.tripId,
    originalPath,
    args.thumbnailPath === undefined
      ? `trips/${args.tripId}/derived/${mediaId}/thumb.webp`
      : args.thumbnailPath,
    bytes.length,
    args.status ?? "processed",
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
  return { id: mediaId, originalPath };
}

function readMedia(db: SqliteDatabase, id: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM media_items WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
}

function readTrip(db: SqliteDatabase, id: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM trips WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
}

function readGroup(db: SqliteDatabase, id: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM duplicate_groups WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
}

function readItems(db: SqliteDatabase, groupId: string): Record<string, unknown>[] {
  return db
    .prepare(`SELECT * FROM duplicate_group_items WHERE group_id = ? ORDER BY media_id ASC`)
    .all(groupId) as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-media-soft-delete-smoke-"));
  const dbPath = path.join(tmpRoot, "smoke.db");
  const storageRoot = path.join(tmpRoot, "storage");
  console.log(`[smoke] tmpRoot=${tmpRoot}`);

  const dbHandle = openDatabase(dbPath);
  try {
    runMigrations(dbHandle.db);

    const logger = createLogger({ nodeEnv: "test" });
    const storage = LocalStorageProvider.create(storageRoot);
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

    // -----------------------------------------------------------------
    // CASE 1: happy path — DELETE on active media flips deleted_at +
    //         status, leaves files on disk.
    // -----------------------------------------------------------------
    const trip1 = tripService.createTrip({ title: "Case1 happy path" });
    const seeded = await seedMediaWithBytes(dbHandle.db, { tripId: trip1.id, storage });
    const beforeFileExists = existsSync(path.join(storageRoot, seeded.originalPath));
    const outcome1 = mediaService.softDeleteMedia(seeded.id);
    record(
      "happy: deleted=true + alreadyDeleted=false",
      outcome1.deleted === true && outcome1.alreadyDeleted === false,
      JSON.stringify(outcome1),
    );
    const row1 = readMedia(dbHandle.db, seeded.id);
    record(
      "happy: media row deleted_at populated",
      typeof row1?.deleted_at === "string" && (row1.deleted_at as string).length > 0,
      `deleted_at=${String(row1?.deleted_at)}`,
    );
    record(
      "happy: media row status='deleted'",
      row1?.status === "deleted",
      `status=${String(row1?.status)}`,
    );
    const afterFileExists = existsSync(path.join(storageRoot, seeded.originalPath));
    record(
      "happy: original file NOT removed from disk (soft delete, not hard)",
      beforeFileExists === true && afterFileExists === true,
      `before=${beforeFileExists} after=${afterFileExists}`,
    );

    // -----------------------------------------------------------------
    // CASE 2: idempotency — second DELETE returns alreadyDeleted=true,
    //         no side effects.
    // -----------------------------------------------------------------
    {
      const before = row1?.deleted_at as string | null;
      const outcome = mediaService.softDeleteMedia(seeded.id);
      record(
        "idempotent: deleted=true + alreadyDeleted=true",
        outcome.deleted === true && outcome.alreadyDeleted === true,
        JSON.stringify(outcome),
      );
      const after = readMedia(dbHandle.db, seeded.id);
      record(
        "idempotent: deleted_at unchanged across re-call",
        after?.deleted_at === before,
        `before=${String(before)} after=${String(after?.deleted_at)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 3: missing media → NotFoundError.
    // -----------------------------------------------------------------
    {
      let threw: unknown;
      try {
        mediaService.softDeleteMedia(randomUUID());
      } catch (err) {
        threw = err;
      }
      record(
        "missing: softDeleteMedia on unknown id throws NotFoundError",
        threw !== undefined && /Media not found/.test(describeError(threw)),
        describeError(threw),
      );
    }

    // -----------------------------------------------------------------
    // CASE 4: malformed id → ValidationError (zod via entityIdSchema).
    // -----------------------------------------------------------------
    {
      let threw: unknown;
      try {
        mediaService.softDeleteMedia("not-a-uuid!@#");
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
    // CASE 5: read filters — gallery list + getMediaById hide
    //         soft-deleted media.
    // -----------------------------------------------------------------
    {
      const list = mediaService.listMediaForTrip(trip1.id);
      record(
        "read filter: listMediaForTrip excludes soft-deleted",
        list.every((m) => m.id !== seeded.id),
        `count=${list.length} containsDeleted=${list.some((m) => m.id === seeded.id)}`,
      );
      let threw: unknown;
      try {
        mediaService.getMediaById(seeded.id);
      } catch (err) {
        threw = err;
      }
      record(
        "read filter: getMediaById returns 404 on soft-deleted",
        threw !== undefined && /Media not found/.test(describeError(threw)),
        describeError(threw),
      );
    }

    // -----------------------------------------------------------------
    // CASE 6: dedup engine read paths skip soft-deleted media.
    // -----------------------------------------------------------------
    {
      // Seed a media with file_hash + perceptual_hash so the
      // engine's projection methods can pick it up.
      const tripId = trip1.id;
      const activeMediaId = randomUUID();
      const now = new Date().toISOString();
      dbHandle.db
        .prepare(
          `INSERT INTO media_items
             (id, trip_id, type, original_path, thumbnail_path,
              file_hash, perceptual_hash,
              mime_type, extension, file_size,
              status, user_decision, created_at, updated_at)
           VALUES (?, ?, 'image', ?, ?,
                   ?, ?,
                   'image/jpeg', 'jpg', 1024,
                   'processed', 'undecided', ?, ?)`,
        )
        .run(
          activeMediaId,
          tripId,
          `trips/${tripId}/originals/${activeMediaId}.jpg`,
          `trips/${tripId}/derived/${activeMediaId}/thumb.webp`,
          "a".repeat(64),
          "b".repeat(32),
          now,
          now,
        );
      const deletedMediaId = randomUUID();
      dbHandle.db
        .prepare(
          `INSERT INTO media_items
             (id, trip_id, type, original_path, thumbnail_path,
              file_hash, perceptual_hash,
              mime_type, extension, file_size,
              status, user_decision, created_at, updated_at, deleted_at)
           VALUES (?, ?, 'image', ?, ?,
                   ?, ?,
                   'image/jpeg', 'jpg', 1024,
                   'deleted', 'undecided', ?, ?, ?)`,
        )
        .run(
          deletedMediaId,
          tripId,
          `trips/${tripId}/originals/${deletedMediaId}.jpg`,
          `trips/${tripId}/derived/${deletedMediaId}/thumb.webp`,
          "c".repeat(64),
          "d".repeat(32),
          now,
          now,
          now,
        );
      const hashes = mediaRepo.findActiveImageHashesByTripId(tripId);
      record(
        "dedup filter: findActiveImageHashesByTripId excludes soft-deleted",
        hashes.some((h) => h.id === activeMediaId) && !hashes.some((h) => h.id === deletedMediaId),
        `count=${hashes.length}`,
      );
      const phashes = mediaRepo.findActiveImagePerceptualHashesByTripId(tripId);
      record(
        "dedup filter: findActiveImagePerceptualHashesByTripId excludes soft-deleted",
        phashes.some((h) => h.id === activeMediaId) &&
          !phashes.some((h) => h.id === deletedMediaId),
        `count=${phashes.length}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 7: findBestCoverCandidate skips soft-deleted media.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case7 best cover filter" });
      await seedMediaWithBytes(dbHandle.db, {
        tripId: trip.id,
        storage,
        qualityScore: 0.95,
        isBlurry: 0,
        status: "processed",
      });
      // Then soft-delete it and confirm the candidate slot is now empty.
      const candidate = mediaRepo.findBestCoverCandidate(trip.id);
      record(
        "auto-cover filter: pre-delete finds the 0.95 candidate",
        candidate !== null && candidate.qualityScore === 0.95,
        JSON.stringify(candidate),
      );
      const target = (
        dbHandle.db.prepare(`SELECT id FROM media_items WHERE trip_id = ?`).get(trip.id) as
          | { id: string }
          | undefined
      )?.id;
      if (target !== undefined) {
        mediaService.softDeleteMedia(target);
      }
      const after = mediaRepo.findBestCoverCandidate(trip.id);
      record(
        "auto-cover filter: post-delete returns null (only candidate was soft-deleted)",
        after === null,
        JSON.stringify(after),
      );
    }

    // -----------------------------------------------------------------
    // CASE 8: duplicate-group reference cleanup —
    //         `recommended_media_id` cleared when the soft-deleted
    //         media was the group's recommendation; items rows stay.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case8 dedup ref cleanup" });
      const m1 = await seedMediaWithBytes(dbHandle.db, { tripId: trip.id, storage });
      const m2 = await seedMediaWithBytes(dbHandle.db, { tripId: trip.id, storage });
      const groupId = randomUUID();
      const now = new Date().toISOString();
      duplicateGroupsRepo.createGroupWithItems(
        {
          id: groupId,
          tripId: trip.id,
          groupType: "exact",
          recommendedMediaId: m1.id,
          createdAt: now,
          updatedAt: now,
        },
        [m1.id, m2.id].map((mid) => ({
          id: randomUUID(),
          mediaId: mid,
          recommendation: mid === m1.id ? "keep" : "remove",
          reason: null,
          userDecision: "undecided",
          createdAt: now,
          updatedAt: now,
        })),
      );
      const outcome = mediaService.softDeleteMedia(m1.id);
      record(
        "dedup cleanup: clearedRecommendedGroups includes the affected group",
        outcome.clearedRecommendedGroups.includes(groupId),
        JSON.stringify(outcome.clearedRecommendedGroups),
      );
      const groupRow = readGroup(dbHandle.db, groupId);
      record(
        "dedup cleanup: duplicate_groups.recommended_media_id reset to NULL",
        groupRow?.recommended_media_id === null,
        `recommended_media_id=${String(groupRow?.recommended_media_id)}`,
      );
      const items = readItems(dbHandle.db, groupId);
      record(
        "dedup cleanup: duplicate_group_items rows preserved (UI projects media:null)",
        items.length === 2 &&
          items.some((r) => r["media_id"] === m1.id) &&
          items.some((r) => r["media_id"] === m2.id),
        `count=${items.length}`,
      );
      const m1Item = items.find((r) => r["media_id"] === m1.id);
      record(
        "dedup cleanup: soft-deleted member's user_decision UNCHANGED (still 'undecided')",
        m1Item?.user_decision === "undecided",
        `user_decision=${String(m1Item?.user_decision)}`,
      );
      // Group survives — no FK errors.
      record(
        "dedup cleanup: group row survives (no FK error)",
        groupRow !== undefined,
        `group=${groupRow !== undefined ? "present" : "missing"}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 9: trip cover cleanup —
    //   * auto-cover (cover_set_by_user=0) cleared; auto-pick picks
    //     the next-best.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case9 auto cover cleanup" });
      const high = await seedMediaWithBytes(dbHandle.db, {
        tripId: trip.id,
        storage,
        qualityScore: 0.95,
        isBlurry: 0,
      });
      const mid = await seedMediaWithBytes(dbHandle.db, {
        tripId: trip.id,
        storage,
        qualityScore: 0.7,
        isBlurry: 0,
      });
      // Manually set high as auto-cover (cover_set_by_user stays 0).
      tripRepo.setAutoCover(trip.id, high.id, new Date().toISOString());
      const beforeRow = readTrip(dbHandle.db, trip.id);
      record(
        "auto cover cleanup: setup — cover_media_id = high.id",
        beforeRow?.cover_media_id === high.id,
        `cover=${String(beforeRow?.cover_media_id)}`,
      );
      const outcome = mediaService.softDeleteMedia(high.id);
      record(
        "auto cover cleanup: clearedCoverTrips includes the affected trip",
        outcome.clearedCoverTrips.includes(trip.id),
        JSON.stringify(outcome.clearedCoverTrips),
      );
      const afterRow = readTrip(dbHandle.db, trip.id);
      // The auto-cover refresh post-tx picks mid (the next-best
      // remaining candidate).
      record(
        "auto cover cleanup: post-delete cover_media_id = mid.id (auto-pick replacement)",
        afterRow?.cover_media_id === mid.id,
        `cover=${String(afterRow?.cover_media_id)}`,
      );
      record(
        "auto cover cleanup: cover_set_by_user stays 0",
        afterRow?.cover_set_by_user === 0,
        `flag=${String(afterRow?.cover_set_by_user)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 10: trip cover cleanup —
    //   * user-pinned (cover_set_by_user=1) cleared, pin released,
    //     auto-pick takes over.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case10 user pin cleanup" });
      const pinned = await seedMediaWithBytes(dbHandle.db, {
        tripId: trip.id,
        storage,
        qualityScore: 0.4,
        isBlurry: 0,
      });
      const better = await seedMediaWithBytes(dbHandle.db, {
        tripId: trip.id,
        storage,
        qualityScore: 0.9,
        isBlurry: 0,
      });
      // Pin the lower-quality one as a user choice.
      tripService.setCoverByUser(trip.id, pinned.id);
      const beforeRow = readTrip(dbHandle.db, trip.id);
      record(
        "user pin cleanup: setup — pinned + cover_set_by_user=1",
        beforeRow?.cover_media_id === pinned.id && beforeRow?.cover_set_by_user === 1,
        JSON.stringify({
          cover: beforeRow?.cover_media_id,
          pinned: beforeRow?.cover_set_by_user,
        }),
      );
      const outcome = mediaService.softDeleteMedia(pinned.id);
      record(
        "user pin cleanup: clearedCoverTrips includes the affected trip",
        outcome.clearedCoverTrips.includes(trip.id),
        JSON.stringify(outcome.clearedCoverTrips),
      );
      const afterRow = readTrip(dbHandle.db, trip.id);
      record(
        "user pin cleanup: cover_set_by_user released to 0 (auto can take over)",
        afterRow?.cover_set_by_user === 0,
        `flag=${String(afterRow?.cover_set_by_user)}`,
      );
      record(
        "user pin cleanup: auto-pick replaced cover with the better-quality remaining media",
        afterRow?.cover_media_id === better.id,
        `cover=${String(afterRow?.cover_media_id)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 11: trip cover cleanup —
    //   * No replacement available → cover stays NULL.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case11 no replacement" });
      const only = await seedMediaWithBytes(dbHandle.db, {
        tripId: trip.id,
        storage,
        qualityScore: 0.6,
        isBlurry: 0,
      });
      tripRepo.setAutoCover(trip.id, only.id, new Date().toISOString());
      const outcome = mediaService.softDeleteMedia(only.id);
      record(
        "no replacement: clearedCoverTrips includes the trip",
        outcome.clearedCoverTrips.includes(trip.id),
        JSON.stringify(outcome.clearedCoverTrips),
      );
      const row = readTrip(dbHandle.db, trip.id);
      record(
        "no replacement: cover_media_id stays NULL (no eligible candidate)",
        row?.cover_media_id === null,
        `cover=${String(row?.cover_media_id)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 12: delete on media that's nobody's cover / nobody's
    //          recommendation → clearedCoverTrips + clearedGroups empty.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case12 unreferenced media" });
      const m = await seedMediaWithBytes(dbHandle.db, { tripId: trip.id, storage });
      const outcome = mediaService.softDeleteMedia(m.id);
      record(
        "unreferenced: clearedCoverTrips empty",
        outcome.clearedCoverTrips.length === 0,
        JSON.stringify(outcome.clearedCoverTrips),
      );
      record(
        "unreferenced: clearedRecommendedGroups empty",
        outcome.clearedRecommendedGroups.length === 0,
        JSON.stringify(outcome.clearedRecommendedGroups),
      );
      const row = readMedia(dbHandle.db, m.id);
      record(
        "unreferenced: media row still flipped to deleted",
        typeof row?.deleted_at === "string",
        `deleted_at=${String(row?.deleted_at)}`,
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
