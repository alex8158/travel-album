// Manual smoke test for media restore (P7.T2).
//
// Usage: npm run smoke:media-restore
//
// Coverage:
//   * Basic happy path: POST /restore on a soft-deleted media clears
//     `deleted_at`, flips `status` to 'processed', and the row
//     becomes visible to default readers again (gallery list,
//     getMediaById).
//   * Idempotency:
//       - Restore on already-active media returns
//         `alreadyRestored: true` with no DB write.
//       - Missing media returns 404 (NotFoundError).
//       - Restore an already-restored media a third time is still
//         a no-op.
//   * Delete → restore → delete cycle: media goes back and forth
//     cleanly with the FK / read filters keeping consistent.
//   * Restore re-exposes the row to dedup engine + auto-cover
//     candidate query:
//       - `findActiveImageHashesByTripId` and
//         `findActiveImagePerceptualHashesByTripId` include the row
//         again after restore.
//       - `findBestCoverCandidate` returns the row again if it
//         meets the eligibility filters.
//   * Quality_Selector enqueue: after a real restore, a pending
//     `quality_selector_run` job exists for the trip (trip-scope
//     payload). After an idempotent re-restore no extra job is
//     enqueued.
//   * Quality_Selector + cover handler: actually running the
//     enqueued job (via JobQueue.tickChannel) re-ranks duplicate
//     groups and refreshes the trip cover (already exercised by
//     other smokes; here we just confirm the chain still works
//     after restore).

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { DuplicateGroupsRepository } from "../dedup/index.js";
import { JobQueue, JobRepository, type JobHandler } from "../jobs/index.js";
import { createLogger } from "../logger.js";
import {
  MediaAnalysisRepository,
  MediaRepository,
  MediaService,
  MediaVersionsRepository,
  type MediaSoftDeleteDeps,
} from "../media/index.js";
import {
  QUALITY_SELECTOR_JOB_TYPE,
  QualitySelectorService,
  decodeQualitySelectorPayload,
  makeQualitySelectorHandler,
} from "../quality/index.js";
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

function seedMedia(
  db: SqliteDatabase,
  args: {
    tripId: string;
    thumbnailPath?: string | null;
    status?: string;
    qualityScore?: number | null;
    isBlurry?: 0 | 1 | null;
    fileHash?: string;
    perceptualHash?: string;
  },
): string {
  const mediaId = randomUUID();
  const now = new Date().toISOString();
  const status = args.status ?? "processed";
  const thumb =
    args.thumbnailPath === undefined
      ? `trips/${args.tripId}/derived/${mediaId}/thumb.webp`
      : args.thumbnailPath;
  db.prepare(
    `INSERT INTO media_items
       (id, trip_id, type, original_path, thumbnail_path,
        file_hash, perceptual_hash,
        mime_type, extension, file_size,
        status, user_decision, created_at, updated_at)
     VALUES (?, ?, 'image', ?, ?,
             ?, ?,
             'image/jpeg', 'jpg', 1024,
             ?, 'undecided', ?, ?)`,
  ).run(
    mediaId,
    args.tripId,
    `trips/${args.tripId}/originals/${mediaId}.jpg`,
    thumb,
    args.fileHash ?? null,
    args.perceptualHash ?? null,
    status,
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

function findPendingSelectorJobs(db: SqliteDatabase, mediaId: string): Record<string, unknown>[] {
  return db
    .prepare(
      `SELECT * FROM processing_jobs WHERE media_id = ? AND job_type = ? AND status = 'pending'`,
    )
    .all(mediaId, QUALITY_SELECTOR_JOB_TYPE) as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-media-restore-smoke-"));
  const dbPath = path.join(tmpRoot, "smoke.db");
  const storageRoot = path.join(tmpRoot, "storage");
  console.log(`[smoke] tmpRoot=${tmpRoot}`);

  const dbHandle = openDatabase(dbPath);
  try {
    runMigrations(dbHandle.db);

    const logger = createLogger({ nodeEnv: "test" });
    const storage = LocalStorageProvider.create(storageRoot);
    void storage;
    const tripRepo = new TripRepository(dbHandle.db);
    const tripService = new TripService(tripRepo);
    const mediaRepo = new MediaRepository(dbHandle.db);
    const mediaVersionsRepo = new MediaVersionsRepository(dbHandle.db);
    const mediaAnalysisRepo = new MediaAnalysisRepository(dbHandle.db);
    const duplicateGroupsRepo = new DuplicateGroupsRepository(dbHandle.db);
    const jobRepo = new JobRepository(dbHandle.db);

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
      jobRepo,
      softDeleteDeps,
    );

    // -----------------------------------------------------------------
    // CASE 1: happy path — delete then restore.
    // -----------------------------------------------------------------
    const trip1 = tripService.createTrip({ title: "Case1 happy path" });
    const m1 = seedMedia(dbHandle.db, {
      tripId: trip1.id,
      qualityScore: 0.85,
      isBlurry: 0,
    });
    mediaService.softDeleteMedia(m1);
    const afterDelete = readMedia(dbHandle.db, m1);
    record(
      "happy: soft-delete set deleted_at + status='deleted' (precondition)",
      typeof afterDelete?.deleted_at === "string" && afterDelete.status === "deleted",
      `deleted_at=${String(afterDelete?.deleted_at)} status=${String(afterDelete?.status)}`,
    );

    const outcome1 = mediaService.restoreMedia(m1);
    record(
      "happy: restored=true + alreadyRestored=false",
      outcome1.restored === true && outcome1.alreadyRestored === false,
      JSON.stringify(outcome1),
    );
    record("happy: tripId returned", outcome1.tripId === trip1.id, `tripId=${outcome1.tripId}`);
    record(
      "happy: qualitySelectorEnqueued=true",
      outcome1.qualitySelectorEnqueued === true,
      `qualitySelectorEnqueued=${outcome1.qualitySelectorEnqueued}`,
    );

    const afterRestore = readMedia(dbHandle.db, m1);
    record(
      "happy: deleted_at cleared",
      afterRestore?.deleted_at === null,
      `deleted_at=${String(afterRestore?.deleted_at)}`,
    );
    record(
      "happy: status reset to 'processed'",
      afterRestore?.status === "processed",
      `status=${String(afterRestore?.status)}`,
    );

    // Gallery + detail visibility.
    {
      const list = mediaService.listMediaForTrip(trip1.id);
      record(
        "happy: gallery list includes restored media",
        list.some((mm) => mm.id === m1),
        `count=${list.length} present=${list.some((mm) => mm.id === m1)}`,
      );
      const detail = mediaService.getMediaById(m1);
      record(
        "happy: getMediaById returns restored row (no 404)",
        detail.id === m1 && detail.deletedAt === null,
        `id=${detail.id} deletedAt=${String(detail.deletedAt)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 2: idempotency — restore on already-active media is a no-op.
    // -----------------------------------------------------------------
    {
      const before = readMedia(dbHandle.db, m1);
      const beforeUpdatedAt = before?.updated_at as string;
      const outcome = mediaService.restoreMedia(m1);
      record(
        "idempotent: restored=true + alreadyRestored=true",
        outcome.restored === true && outcome.alreadyRestored === true,
        JSON.stringify(outcome),
      );
      record(
        "idempotent: qualitySelectorEnqueued=false (skip enqueue when nothing changed)",
        outcome.qualitySelectorEnqueued === false,
        `qualitySelectorEnqueued=${outcome.qualitySelectorEnqueued}`,
      );
      const after = readMedia(dbHandle.db, m1);
      record(
        "idempotent: updated_at unchanged (no write happened)",
        after?.updated_at === beforeUpdatedAt,
        `before=${beforeUpdatedAt} after=${String(after?.updated_at)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 3: missing media → NotFoundError.
    // -----------------------------------------------------------------
    {
      let threw: unknown;
      try {
        mediaService.restoreMedia(randomUUID());
      } catch (err) {
        threw = err;
      }
      record(
        "missing: restoreMedia on unknown id throws NotFoundError",
        threw !== undefined && /Media not found/.test(describeError(threw)),
        describeError(threw),
      );
    }

    // -----------------------------------------------------------------
    // CASE 4: malformed id → ValidationError.
    // -----------------------------------------------------------------
    {
      let threw: unknown;
      try {
        mediaService.restoreMedia("not-a-uuid!@#");
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
    // CASE 5: delete → restore → delete cycle stays stable.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case5 cycle" });
      const m = seedMedia(dbHandle.db, { tripId: trip.id, qualityScore: 0.6 });
      mediaService.softDeleteMedia(m);
      const r1 = mediaService.restoreMedia(m);
      record(
        "cycle: first restore alreadyRestored=false",
        r1.alreadyRestored === false,
        JSON.stringify(r1),
      );
      const d2 = mediaService.softDeleteMedia(m);
      record(
        "cycle: re-delete alreadyDeleted=false (fresh soft-delete)",
        d2.alreadyDeleted === false,
        JSON.stringify(d2),
      );
      const r2 = mediaService.restoreMedia(m);
      record(
        "cycle: second restore alreadyRestored=false (still works)",
        r2.alreadyRestored === false,
        JSON.stringify(r2),
      );
      const row = readMedia(dbHandle.db, m);
      record(
        "cycle: final state active",
        row?.deleted_at === null && row?.status === "processed",
        `deleted_at=${String(row?.deleted_at)} status=${String(row?.status)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 6: restore re-exposes the row to dedup engine readers.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case6 dedup re-expose" });
      const m = seedMedia(dbHandle.db, {
        tripId: trip.id,
        qualityScore: 0.7,
        fileHash: "a".repeat(64),
        perceptualHash: "b".repeat(32),
      });
      mediaService.softDeleteMedia(m);
      const beforeFile = mediaRepo.findActiveImageHashesByTripId(trip.id);
      const beforePhash = mediaRepo.findActiveImagePerceptualHashesByTripId(trip.id);
      record(
        "dedup re-expose: post-delete file-hash list excludes the media",
        !beforeFile.some((h) => h.id === m),
        `count=${beforeFile.length}`,
      );
      record(
        "dedup re-expose: post-delete pHash list excludes the media",
        !beforePhash.some((h) => h.id === m),
        `count=${beforePhash.length}`,
      );
      mediaService.restoreMedia(m);
      const afterFile = mediaRepo.findActiveImageHashesByTripId(trip.id);
      const afterPhash = mediaRepo.findActiveImagePerceptualHashesByTripId(trip.id);
      record(
        "dedup re-expose: post-restore file-hash list includes the media",
        afterFile.some((h) => h.id === m),
        `count=${afterFile.length}`,
      );
      record(
        "dedup re-expose: post-restore pHash list includes the media",
        afterPhash.some((h) => h.id === m),
        `count=${afterPhash.length}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 7: restore makes media eligible again for auto-cover.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case7 cover re-expose" });
      const m = seedMedia(dbHandle.db, {
        tripId: trip.id,
        qualityScore: 0.92,
        isBlurry: 0,
      });
      mediaService.softDeleteMedia(m);
      record(
        "cover re-expose: post-delete findBestCoverCandidate returns null",
        mediaRepo.findBestCoverCandidate(trip.id) === null,
        "",
      );
      mediaService.restoreMedia(m);
      const candidate = mediaRepo.findBestCoverCandidate(trip.id);
      record(
        "cover re-expose: post-restore findBestCoverCandidate returns the media",
        candidate?.mediaId === m && candidate?.qualityScore === 0.92,
        JSON.stringify(candidate),
      );
    }

    // -----------------------------------------------------------------
    // CASE 8: a fresh restore enqueues exactly one quality_selector_run
    //         (trip-scope) job. Idempotent restore does not enqueue.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case8 selector enqueue" });
      const m = seedMedia(dbHandle.db, {
        tripId: trip.id,
        qualityScore: 0.5,
        isBlurry: 0,
      });
      mediaService.softDeleteMedia(m);
      // Clear any selector jobs from earlier soft-deletes in this case
      // (none in current MediaService design, but defensive).
      mediaService.restoreMedia(m);
      const pending = findPendingSelectorJobs(dbHandle.db, m);
      record(
        "enqueue: exactly one quality_selector_run pending for restored media",
        pending.length === 1,
        `count=${pending.length}`,
      );
      const payload = decodeQualitySelectorPayload((pending[0]?.payload as string | null) ?? null);
      record(
        "enqueue: payload scope='trip' + tripId matches media's trip",
        payload?.scope === "trip" && payload.tripId === trip.id,
        JSON.stringify(payload),
      );
      // Re-restore → no additional enqueue.
      const r = mediaService.restoreMedia(m);
      const pendingAfter = findPendingSelectorJobs(dbHandle.db, m);
      record(
        "enqueue: idempotent re-restore does NOT add a second job",
        pendingAfter.length === 1 && r.qualitySelectorEnqueued === false,
        `count=${pendingAfter.length} flag=${r.qualitySelectorEnqueued}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 9: end-to-end with JobQueue — selector handler picks up the
    //   restore-enqueued job and refreshes the cover.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case9 selector chain" });
      const m = seedMedia(dbHandle.db, {
        tripId: trip.id,
        qualityScore: 0.95,
        isBlurry: 0,
      });
      // Set the cover to m first (auto-pick simulation).
      tripRepo.setAutoCover(trip.id, m, new Date().toISOString());
      mediaService.softDeleteMedia(m);
      // The delete cleared the cover already.
      const afterDeleteCover = readTrip(dbHandle.db, trip.id);
      record(
        "selector chain: post-delete cover_media_id is NULL",
        afterDeleteCover?.cover_media_id === null,
        `cover=${String(afterDeleteCover?.cover_media_id)}`,
      );
      mediaService.restoreMedia(m);

      // Drive the enqueued selector job.
      const qualitySelectorService = new QualitySelectorService({
        duplicateGroupsRepo,
        mediaAnalysisRepo,
        mediaRepo,
        logger,
      });
      const handlers = new Map<string, JobHandler>();
      handlers.set(
        QUALITY_SELECTOR_JOB_TYPE,
        makeQualitySelectorHandler({
          service: qualitySelectorService,
          mediaRepo,
          tripRepo,
          logger,
        }),
      );
      const queue = new JobQueue({
        jobRepo,
        logger,
        channels: [
          { name: "image", concurrency: 1, handlers, pollIntervalMs: 60_000 },
          { name: "video", concurrency: 1, handlers: new Map(), pollIntervalMs: 60_000 },
          { name: "ai", concurrency: 1, handlers: new Map(), pollIntervalMs: 60_000 },
        ],
        zombieTimeoutMs: 0,
      });
      try {
        // The queue may have other pending selector jobs from earlier
        // cases. Drain everything to be safe (cap at 16 ticks).
        for (let i = 0; i < 16; i += 1) {
          const tick = await queue.tickChannel("image");
          await queue.awaitInflight("image");
          if (tick.claimed.length === 0) break;
        }
      } finally {
        await queue.stop();
      }
      const afterRestoreCover = readTrip(dbHandle.db, trip.id);
      record(
        "selector chain: post-restore + handler run, cover_media_id = restored media id",
        afterRestoreCover?.cover_media_id === m,
        `cover=${String(afterRestoreCover?.cover_media_id)}`,
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
