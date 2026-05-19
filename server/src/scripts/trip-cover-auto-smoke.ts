// Manual smoke test for the auto-cover selector (P6.T7).
//
// Usage: npm run smoke:trip-cover-auto
//
// Coverage:
//   * Migration 009 added the `cover_set_by_user` column with the
//     intended default (0) and the existing trip CRUD still works.
//   * `autoSelectCoverForTrip` picks the highest-quality eligible
//     image in the trip and writes it via
//     `TripRepository.setAutoCover`.
//   * Filters in `findBestCoverCandidate`:
//       - excludes soft-deleted media
//       - excludes status='failed'
//       - excludes media without a thumbnail
//       - excludes is_blurry=1 media
//       - excludes type='video'
//       - excludes media without a quality_score
//   * User-pinned cover (`cover_set_by_user=1`) is NEVER overwritten
//     by the auto selector — outcome is `skipped-user-pinned`.
//   * `setCoverByUser` flips the flag + writes the cover; subsequent
//     auto runs respect the pin.
//   * `clearUserCoverFlag` releases the pin; the auto selector can
//     then replace the cover.
//   * Returns `skipped-no-candidate` when no eligible image exists
//     (e.g. all blurry / all failed / empty trip).
//   * Returns `unchanged` when the best candidate is already the
//     current cover (no redundant UPDATE).
//   * Quality_Selector handler (trip-scope) triggers auto-cover
//     refresh post-run; group-scope does not.
//   * No P5/P6 regression on the existing trip / cover-url smokes
//     (rerun outside this script).

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { DuplicateGroupsRepository } from "../dedup/index.js";
import { JobQueue, JobRepository, type JobHandler } from "../jobs/index.js";
import { createLogger } from "../logger.js";
import { MediaAnalysisRepository, MediaRepository } from "../media/index.js";
import {
  QUALITY_SELECTOR_JOB_TYPE,
  QualitySelectorService,
  encodeQualitySelectorPayload,
  makeQualitySelectorHandler,
} from "../quality/index.js";
import { autoSelectCoverForTrip, TripRepository, TripService } from "../trips/index.js";

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
  readonly type?: "image" | "video";
  readonly status?: string;
  readonly thumbnailPath?: string | null;
  readonly deletedAt?: string | null;
  /** Provided when the analysis row should be created. */
  readonly qualityScore?: number | null;
  readonly sharpnessScore?: number | null;
  readonly isBlurry?: 0 | 1 | null;
}

function seedMedia(db: SqliteDatabase, args: SeedMediaArgs): string {
  const mediaId = randomUUID();
  const now = new Date().toISOString();
  const type = args.type ?? "image";
  const status = args.status ?? "processed";
  const thumb =
    args.thumbnailPath === undefined
      ? `trips/${args.tripId}/derived/${mediaId}/thumb.webp`
      : args.thumbnailPath;
  db.prepare(
    `INSERT INTO media_items
       (id, trip_id, type, original_path, thumbnail_path,
        mime_type, extension, file_size,
        status, user_decision, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?,
             ?, ?, 1024,
             ?, 'undecided', ?, ?, ?)`,
  ).run(
    mediaId,
    args.tripId,
    type,
    `trips/${args.tripId}/originals/${mediaId}.jpg`,
    thumb,
    type === "image" ? "image/jpeg" : "video/mp4",
    type === "image" ? "jpg" : "mp4",
    status,
    now,
    now,
    args.deletedAt ?? null,
  );
  if (
    args.qualityScore !== undefined ||
    args.sharpnessScore !== undefined ||
    args.isBlurry !== undefined
  ) {
    db.prepare(
      `INSERT INTO media_analysis (
         id, media_id,
         quality_score, sharpness_score, is_blurry,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      mediaId,
      args.qualityScore ?? null,
      args.sharpnessScore ?? null,
      args.isBlurry ?? null,
      now,
      now,
    );
  }
  return mediaId;
}

function readTrip(db: SqliteDatabase, tripId: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM trips WHERE id = ?`).get(tripId) as
    | Record<string, unknown>
    | undefined;
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-trip-cover-auto-smoke-"));
  const dbPath = path.join(tmpRoot, "smoke.db");
  console.log(`[smoke] tmpRoot=${tmpRoot}`);

  const dbHandle = openDatabase(dbPath);
  try {
    const migrationResult = runMigrations(dbHandle.db);
    record(
      "migration: 009 included in appliedNow",
      migrationResult.appliedNow.includes("009_add_trips_cover_set_by_user.sql"),
      `appliedNow=${JSON.stringify(migrationResult.appliedNow)}`,
    );

    // Confirm new column exists on the trips table.
    const cols = dbHandle.db.prepare(`PRAGMA table_info(trips)`).all() as { name: string }[];
    record(
      "migration: trips.cover_set_by_user column present",
      cols.some((c) => c.name === "cover_set_by_user"),
      `columns=${cols.map((c) => c.name).join(",")}`,
    );

    const logger = createLogger({ nodeEnv: "test" });
    const tripRepo = new TripRepository(dbHandle.db);
    const tripService = new TripService(tripRepo);
    const mediaRepo = new MediaRepository(dbHandle.db);

    // -----------------------------------------------------------------
    // CASE 1: new trip starts with cover_set_by_user = 0 (auto)
    // -----------------------------------------------------------------
    const trip1 = tripService.createTrip({ title: "Case1 fresh trip" });
    record(
      "fresh trip: coverSetByUser === false",
      trip1.coverSetByUser === false,
      `coverSetByUser=${trip1.coverSetByUser}`,
    );
    record(
      "fresh trip: coverMediaId === null",
      trip1.coverMediaId === null,
      `coverMediaId=${String(trip1.coverMediaId)}`,
    );

    // -----------------------------------------------------------------
    // CASE 2: autoSelectCoverForTrip picks the highest-quality
    //         eligible image and writes cover_media_id.
    // -----------------------------------------------------------------
    const highId = seedMedia(dbHandle.db, {
      tripId: trip1.id,
      qualityScore: 0.92,
      sharpnessScore: 1,
      isBlurry: 0,
    });
    seedMedia(dbHandle.db, {
      tripId: trip1.id,
      qualityScore: 0.6,
      sharpnessScore: 0.7,
      isBlurry: 0,
    });
    seedMedia(dbHandle.db, {
      tripId: trip1.id,
      qualityScore: 0.45,
      sharpnessScore: 0.4,
      isBlurry: 0,
    });
    const outcome2 = autoSelectCoverForTrip({ tripRepo, mediaRepo, logger }, trip1.id);
    record(
      "auto-pick: status='applied' + winner is highest-quality media",
      outcome2.status === "applied" &&
        (outcome2.status === "applied" ? outcome2.coverMediaId === highId : false),
      JSON.stringify(outcome2),
    );
    const after2 = readTrip(dbHandle.db, trip1.id);
    record(
      "auto-pick: trips.cover_media_id persisted to highest-quality id",
      after2?.cover_media_id === highId,
      `cover=${String(after2?.cover_media_id)}`,
    );
    record(
      "auto-pick: trips.cover_set_by_user stayed 0",
      after2?.cover_set_by_user === 0,
      `flag=${String(after2?.cover_set_by_user)}`,
    );

    // -----------------------------------------------------------------
    // CASE 3: re-running auto-select on same data yields 'unchanged'
    //         (no redundant UPDATE).
    // -----------------------------------------------------------------
    const beforeUpdatedAt = (after2?.updated_at as string) ?? "";
    const outcome3 = autoSelectCoverForTrip({ tripRepo, mediaRepo, logger }, trip1.id);
    record(
      "idempotent: status='unchanged' when best candidate is already current cover",
      outcome3.status === "unchanged",
      JSON.stringify(outcome3),
    );
    const after3 = readTrip(dbHandle.db, trip1.id);
    record(
      "idempotent: updated_at unchanged (no write happened)",
      after3?.updated_at === beforeUpdatedAt,
      `before=${beforeUpdatedAt} after=${String(after3?.updated_at)}`,
    );

    // -----------------------------------------------------------------
    // CASE 4: setCoverByUser flips flag; subsequent auto-select is
    //         skipped-user-pinned even when a better candidate exists.
    // -----------------------------------------------------------------
    {
      // Pick the lower-quality (0.45) media on purpose to prove the
      // pin overrides quality ranking.
      const lowerId = seedMedia(dbHandle.db, {
        tripId: trip1.id,
        qualityScore: 0.55,
        sharpnessScore: 0.6,
        isBlurry: 0,
      });
      const pinned = tripService.setCoverByUser(trip1.id, lowerId);
      record(
        "user pin: coverSetByUser === true",
        pinned.coverSetByUser === true,
        `flag=${pinned.coverSetByUser}`,
      );
      record(
        "user pin: coverMediaId set to the lower-quality id",
        pinned.coverMediaId === lowerId,
        `cover=${String(pinned.coverMediaId)}`,
      );
      const outcome = autoSelectCoverForTrip({ tripRepo, mediaRepo, logger }, trip1.id);
      record(
        "user pin: auto-select status='skipped-user-pinned'",
        outcome.status === "skipped-user-pinned",
        JSON.stringify(outcome),
      );
      const row = readTrip(dbHandle.db, trip1.id);
      record(
        "user pin: cover_media_id NOT overwritten by auto-select",
        row?.cover_media_id === lowerId,
        `cover=${String(row?.cover_media_id)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 5: clearUserCoverFlag releases the pin; auto-select can
    //         then write the best candidate again.
    // -----------------------------------------------------------------
    {
      const released = tripService.clearUserCoverFlag(trip1.id);
      record(
        "release pin: coverSetByUser === false after clearUserCoverFlag",
        released.coverSetByUser === false,
        `flag=${released.coverSetByUser}`,
      );
      const outcome = autoSelectCoverForTrip({ tripRepo, mediaRepo, logger }, trip1.id);
      record(
        "release pin: auto-select status='applied' + winner is highId",
        outcome.status === "applied" &&
          (outcome.status === "applied" ? outcome.coverMediaId === highId : false),
        JSON.stringify(outcome),
      );
    }

    // -----------------------------------------------------------------
    // CASE 6: filter — blurry / video / soft-deleted / failed /
    //         missing-thumbnail / missing-quality_score are excluded.
    // -----------------------------------------------------------------
    {
      const t = tripService.createTrip({ title: "Case6 disqualifier zoo" });
      seedMedia(dbHandle.db, { tripId: t.id, qualityScore: 0.99, isBlurry: 1 }); // blurry
      seedMedia(dbHandle.db, { tripId: t.id, type: "video", qualityScore: 0.99 }); // video
      seedMedia(dbHandle.db, {
        tripId: t.id,
        qualityScore: 0.99,
        deletedAt: new Date().toISOString(),
      }); // soft-deleted
      seedMedia(dbHandle.db, { tripId: t.id, qualityScore: 0.99, status: "failed" }); // failed
      seedMedia(dbHandle.db, { tripId: t.id, qualityScore: 0.99, thumbnailPath: null }); // no thumb
      seedMedia(dbHandle.db, { tripId: t.id, sharpnessScore: 1 }); // no quality_score
      const goodId = seedMedia(dbHandle.db, {
        tripId: t.id,
        qualityScore: 0.65,
        sharpnessScore: 0.7,
        isBlurry: 0,
      });
      const outcome = autoSelectCoverForTrip({ tripRepo, mediaRepo, logger }, t.id);
      record(
        "filter zoo: auto-select skips disqualified media + picks the only eligible",
        outcome.status === "applied" &&
          (outcome.status === "applied" ? outcome.coverMediaId === goodId : false),
        JSON.stringify(outcome),
      );
    }

    // -----------------------------------------------------------------
    // CASE 7: empty / no-candidate trip → 'skipped-no-candidate',
    //         no error, no cover write.
    // -----------------------------------------------------------------
    {
      const t = tripService.createTrip({ title: "Case7 no candidate" });
      // Only blurry images.
      seedMedia(dbHandle.db, { tripId: t.id, qualityScore: 0.4, isBlurry: 1 });
      seedMedia(dbHandle.db, { tripId: t.id, qualityScore: 0.3, isBlurry: 1 });
      const outcome = autoSelectCoverForTrip({ tripRepo, mediaRepo, logger }, t.id);
      record(
        "no candidate: status='skipped-no-candidate'",
        outcome.status === "skipped-no-candidate",
        JSON.stringify(outcome),
      );
      const row = readTrip(dbHandle.db, t.id);
      record(
        "no candidate: cover_media_id stayed NULL",
        row?.cover_media_id === null,
        `cover=${String(row?.cover_media_id)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 8: missing trip → 'missing-trip', no throw.
    // -----------------------------------------------------------------
    {
      const outcome = autoSelectCoverForTrip({ tripRepo, mediaRepo, logger }, randomUUID());
      record(
        "missing trip: status='missing-trip' (no throw)",
        outcome.status === "missing-trip",
        JSON.stringify(outcome),
      );
    }

    // -----------------------------------------------------------------
    // CASE 9: tripService.setCoverByUser rejects malformed mediaId.
    // -----------------------------------------------------------------
    {
      let threw: unknown;
      try {
        tripService.setCoverByUser(trip1.id, "not-a-uuid!@#");
      } catch (err) {
        threw = err;
      }
      record(
        "validation: setCoverByUser rejects malformed media id",
        threw !== undefined && /Validation/.test(describeError(threw)),
        describeError(threw),
      );
    }

    // -----------------------------------------------------------------
    // CASE 10: tripService.setCoverByUser on missing trip → NotFoundError.
    // -----------------------------------------------------------------
    {
      let threw: unknown;
      try {
        tripService.setCoverByUser(randomUUID(), highId);
      } catch (err) {
        threw = err;
      }
      record(
        "validation: setCoverByUser on missing trip → NotFoundError",
        threw !== undefined && /Trip not found/.test(describeError(threw)),
        describeError(threw),
      );
    }

    // -----------------------------------------------------------------
    // CASE 11: end-to-end via Quality_Selector handler.
    // Setup: a trip + a duplicate group + media with analysis. Run
    // the quality_selector_run job → expect group recommendation
    // updated AND trip cover updated (since trip_scope).
    // -----------------------------------------------------------------
    {
      const t = tripService.createTrip({ title: "Case11 selector end-to-end" });
      const m1 = seedMedia(dbHandle.db, {
        tripId: t.id,
        qualityScore: 0.55,
        sharpnessScore: 0.6,
        isBlurry: 0,
      });
      const m2 = seedMedia(dbHandle.db, {
        tripId: t.id,
        qualityScore: 0.85,
        sharpnessScore: 0.9,
        isBlurry: 0,
      });

      const duplicateGroupsRepo = new DuplicateGroupsRepository(dbHandle.db);
      const mediaAnalysisRepo = new MediaAnalysisRepository(dbHandle.db);
      const jobRepo = new JobRepository(dbHandle.db);
      const groupId = randomUUID();
      const now = new Date().toISOString();
      duplicateGroupsRepo.createGroupWithItems(
        {
          id: groupId,
          tripId: t.id,
          groupType: "exact",
          createdAt: now,
          updatedAt: now,
        },
        [m1, m2].map((mid) => ({
          id: randomUUID(),
          mediaId: mid,
          recommendation: "undecided",
          reason: null,
          userDecision: "undecided",
          createdAt: now,
          updatedAt: now,
        })),
      );

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
        // Insert a selector job with trip-scope payload.
        const jobId = randomUUID();
        dbHandle.db
          .prepare(
            `INSERT INTO processing_jobs (id, media_id, job_type, status, payload, created_at, updated_at)
             VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
          )
          .run(
            jobId,
            m1,
            QUALITY_SELECTOR_JOB_TYPE,
            encodeQualitySelectorPayload({ scope: "trip", tripId: t.id }),
            now,
            now,
          );
        const tick = await queue.tickChannel("image");
        await queue.awaitInflight("image");
        record(
          "end-to-end: selector tick claimed the job",
          tick.claimed.length === 1 && tick.claimed[0]?.jobId === jobId,
          JSON.stringify(tick.claimed),
        );
        const jobRow = dbHandle.db
          .prepare(`SELECT status FROM processing_jobs WHERE id = ?`)
          .get(jobId) as { status: string } | undefined;
        record(
          "end-to-end: selector job ended 'success'",
          jobRow?.status === "success",
          `status=${String(jobRow?.status)}`,
        );
        // After the handler ran, the trip's cover should be the
        // higher-quality media (m2).
        const tRow = readTrip(dbHandle.db, t.id);
        record(
          "end-to-end: auto-cover refresh wrote highest-quality media",
          tRow?.cover_media_id === m2,
          `cover=${String(tRow?.cover_media_id)}`,
        );
      } finally {
        await queue.stop();
      }
    }

    // -----------------------------------------------------------------
    // CASE 12: group-scope selector does NOT refresh the trip cover
    //          (intentional — group-scope is ad-hoc per group).
    // -----------------------------------------------------------------
    {
      const t = tripService.createTrip({ title: "Case12 group scope" });
      const m1 = seedMedia(dbHandle.db, {
        tripId: t.id,
        qualityScore: 0.8,
        sharpnessScore: 0.8,
        isBlurry: 0,
      });
      const m2 = seedMedia(dbHandle.db, {
        tripId: t.id,
        qualityScore: 0.9,
        sharpnessScore: 0.95,
        isBlurry: 0,
      });
      const duplicateGroupsRepo = new DuplicateGroupsRepository(dbHandle.db);
      const mediaAnalysisRepo = new MediaAnalysisRepository(dbHandle.db);
      const jobRepo = new JobRepository(dbHandle.db);
      const groupId = randomUUID();
      const now = new Date().toISOString();
      duplicateGroupsRepo.createGroupWithItems(
        {
          id: groupId,
          tripId: t.id,
          groupType: "exact",
          createdAt: now,
          updatedAt: now,
        },
        [m1, m2].map((mid) => ({
          id: randomUUID(),
          mediaId: mid,
          recommendation: "undecided",
          reason: null,
          userDecision: "undecided",
          createdAt: now,
          updatedAt: now,
        })),
      );
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
        const jobId = randomUUID();
        dbHandle.db
          .prepare(
            `INSERT INTO processing_jobs (id, media_id, job_type, status, payload, created_at, updated_at)
             VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
          )
          .run(
            jobId,
            m1,
            QUALITY_SELECTOR_JOB_TYPE,
            encodeQualitySelectorPayload({ scope: "group", groupId }),
            now,
            now,
          );
        const tick = await queue.tickChannel("image");
        await queue.awaitInflight("image");
        record(
          "group-scope: selector tick succeeded",
          tick.claimed.length === 1,
          JSON.stringify(tick.claimed),
        );
        const tRow = readTrip(dbHandle.db, t.id);
        record(
          "group-scope: trip.cover_media_id STILL null (group-scope skipped cover refresh)",
          tRow?.cover_media_id === null,
          `cover=${String(tRow?.cover_media_id)}`,
        );
      } finally {
        await queue.stop();
      }
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
