// Manual smoke test for media enhance enqueue (P8.T1).
//
// Usage: npm run smoke:media-enhance-trigger
//
// Exercises `MediaService.enhanceMedia` directly (no HTTP — same
// pattern as the other trigger smokes) against a real SQLite DB.
// P8.T1's surface is single-slot (one `image_enhance` row per call),
// so the assertions are flatter than `reprocess` (which covers two
// slots in lock-step).
//
// Coverage:
//   * Fresh image media → outcome='created' + new pending row with
//     job_type='image_enhance' on disk.
//   * Existing pending → outcome='skipped' + reason='already pending'
//     + jobs table unchanged.
//   * Existing running → outcome='skipped' + reason='already running'.
//   * Existing failed → outcome='reset' + same job id + row flipped
//     to 'retrying' with retry_count=0 + next_run_at populated +
//     error_message / started_at / finished_at cleared.
//   * Existing success → outcome='reset'.
//   * Existing cancelled → outcome='reset'.
//   * Idempotency: a second enhanceMedia after the first 'created'
//     yields 'skipped' (the same now-pending row).
//   * Missing media → NotFoundError.
//   * Soft-deleted media → NotFoundError (recycle-bin members cannot
//     be enhanced; user must restore first per P7 contract).
//   * Video media → BadRequestError (image-only per requirements
//     §7.9).
//   * Unknown-type media → BadRequestError.
//   * Malformed id → ValidationError via entityIdSchema.
//   * P8.T1 scope guard: enhance does NOT write media_versions and
//     does NOT touch media_items columns (no preview_path mutation,
//     no quality_score touch, etc.) — those are P8.T2 / P8.T3.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { DuplicateGroupsRepository } from "../dedup/index.js";
import { IMAGE_ENHANCE_JOB_TYPE, JobRepository } from "../jobs/index.js";
import { createLogger } from "../logger.js";
import {
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
// fixture helpers
// ---------------------------------------------------------------------------

interface Seeded {
  readonly tripId: string;
  readonly mediaId: string;
}

function seedImageMedia(
  tripService: TripService,
  mediaRepo: MediaRepository,
  title = "Enhance Smoke Trip",
): Seeded {
  const trip = tripService.createTrip({ title });
  const mediaId = randomUUID();
  const now = new Date().toISOString();
  mediaRepo.insert({
    id: mediaId,
    tripId: trip.id,
    type: "image",
    originalPath: `trips/${trip.id}/originals/${mediaId}.jpg`,
    fileSize: 1024,
    mimeType: "image/jpeg",
    extension: "jpg",
    createdAt: now,
    updatedAt: now,
  });
  return { tripId: trip.id, mediaId };
}

function seedMediaOfType(
  tripService: TripService,
  mediaRepo: MediaRepository,
  type: "video" | "unknown",
): Seeded {
  const trip = tripService.createTrip({ title: `Enhance Smoke ${type}` });
  const mediaId = randomUUID();
  const now = new Date().toISOString();
  mediaRepo.insert({
    id: mediaId,
    tripId: trip.id,
    type,
    originalPath: type === "video" ? `trips/${trip.id}/originals/${mediaId}.mp4` : null,
    fileSize: type === "video" ? 4096 : null,
    mimeType: type === "video" ? "video/mp4" : null,
    extension: type === "video" ? "mp4" : null,
    createdAt: now,
    updatedAt: now,
  });
  return { tripId: trip.id, mediaId };
}

function insertJobRow(
  db: SqliteDatabase,
  mediaId: string,
  status: "pending" | "running" | "failed" | "success" | "retrying" | "cancelled",
  extras: { errorMessage?: string; startedAt?: string; finishedAt?: string } = {},
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO processing_jobs
       (id, media_id, job_type, status, error_message, started_at, finished_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    mediaId,
    IMAGE_ENHANCE_JOB_TYPE,
    status,
    extras.errorMessage ?? null,
    extras.startedAt ?? null,
    extras.finishedAt ?? null,
    now,
    now,
  );
  return id;
}

function readJob(db: SqliteDatabase, jobId: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM processing_jobs WHERE id = ?`).get(jobId) as
    | Record<string, unknown>
    | undefined;
}

function countEnhanceJobs(db: SqliteDatabase, mediaId: string): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM processing_jobs WHERE media_id = ? AND job_type = ?`)
      .get(mediaId, IMAGE_ENHANCE_JOB_TYPE) as { n: number }
  ).n;
}

function readMediaRaw(db: SqliteDatabase, id: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM media_items WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
}

function countMediaVersions(db: SqliteDatabase, mediaId: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM media_versions WHERE media_id = ?`).get(mediaId) as {
      n: number;
    }
  ).n;
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-media-enhance-trigger-smoke-"));
  const dbPath = path.join(tmpRoot, "smoke.db");
  console.log(`[smoke] dbPath=${dbPath}`);

  const dbHandle = openDatabase(dbPath);
  try {
    runMigrations(dbHandle.db);

    const logger = createLogger({ nodeEnv: "test" });
    const tripRepo = new TripRepository(dbHandle.db);
    const tripService = new TripService(tripRepo);
    const mediaRepo = new MediaRepository(dbHandle.db);
    const mediaVersionsRepo = new MediaVersionsRepository(dbHandle.db);
    const duplicateGroupsRepo = new DuplicateGroupsRepository(dbHandle.db);
    const jobRepo = new JobRepository(dbHandle.db);

    // softDeleteDeps wired so we can exercise the soft-deleted-media
    // branch below; matches the production wiring in `src/index.ts`.
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
    // CASE 1: fresh image media → created
    // -----------------------------------------------------------------
    {
      const seeded = seedImageMedia(tripService, mediaRepo, "Case1 fresh");
      const result = mediaService.enhanceMedia(seeded.mediaId);
      record(
        "fresh: outcome=created + jobType=image_enhance + reason absent",
        result.outcome === "created" &&
          result.jobType === IMAGE_ENHANCE_JOB_TYPE &&
          result.mediaId === seeded.mediaId &&
          result.reason === undefined,
        JSON.stringify(result),
      );
      const row = readJob(dbHandle.db, result.jobId);
      record(
        "fresh: DB row inserted as pending + no error/started/finished",
        row?.status === "pending" &&
          row?.job_type === IMAGE_ENHANCE_JOB_TYPE &&
          row?.media_id === seeded.mediaId &&
          row?.error_message === null &&
          row?.started_at === null &&
          row?.finished_at === null,
        `status=${String(row?.status)} job_type=${String(row?.job_type)}`,
      );
      record(
        "fresh: exactly 1 image_enhance row exists for this media",
        countEnhanceJobs(dbHandle.db, seeded.mediaId) === 1,
        `count=${countEnhanceJobs(dbHandle.db, seeded.mediaId)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 2: existing pending → skipped (reason 'already pending'),
    //         no second row inserted.
    // -----------------------------------------------------------------
    {
      const seeded = seedImageMedia(tripService, mediaRepo, "Case2 pending");
      const oldJobId = insertJobRow(dbHandle.db, seeded.mediaId, "pending");
      const result = mediaService.enhanceMedia(seeded.mediaId);
      record(
        "pending → skipped: same jobId, reason='already pending'",
        result.outcome === "skipped" &&
          result.jobId === oldJobId &&
          result.reason === "already pending",
        JSON.stringify(result),
      );
      record(
        "pending → skipped: still exactly 1 image_enhance row (no double-queue)",
        countEnhanceJobs(dbHandle.db, seeded.mediaId) === 1,
        `count=${countEnhanceJobs(dbHandle.db, seeded.mediaId)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 3: existing running → skipped (reason 'already running').
    // -----------------------------------------------------------------
    {
      const seeded = seedImageMedia(tripService, mediaRepo, "Case3 running");
      const oldJobId = insertJobRow(dbHandle.db, seeded.mediaId, "running", {
        startedAt: new Date().toISOString(),
      });
      const result = mediaService.enhanceMedia(seeded.mediaId);
      record(
        "running → skipped: same jobId, reason='already running'",
        result.outcome === "skipped" &&
          result.jobId === oldJobId &&
          result.reason === "already running",
        JSON.stringify(result),
      );
      // The running row is untouched — the executor is mid-handler.
      const row = readJob(dbHandle.db, oldJobId);
      record(
        "running → skipped: row still 'running' + started_at preserved",
        row?.status === "running" && typeof row?.started_at === "string",
        `status=${String(row?.status)} started_at=${String(row?.started_at)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 4: existing failed → reset (P4.T2 R-40 path: status →
    //         'retrying', retry_count → 0, next_run_at populated,
    //         error_message / started_at / finished_at cleared).
    // -----------------------------------------------------------------
    {
      const seeded = seedImageMedia(tripService, mediaRepo, "Case4 failed");
      const oldJobId = insertJobRow(dbHandle.db, seeded.mediaId, "failed", {
        errorMessage: "previous enhance pipeline blew up",
        startedAt: "2026-05-12T00:00:00.000Z",
        finishedAt: "2026-05-12T00:00:05.000Z",
      });
      const result = mediaService.enhanceMedia(seeded.mediaId);
      record(
        "failed → reset: same jobId, outcome='reset', reason absent",
        result.outcome === "reset" && result.jobId === oldJobId && result.reason === undefined,
        JSON.stringify(result),
      );
      const row = readJob(dbHandle.db, oldJobId);
      record(
        "failed → reset: row.status='retrying' + retry_count=0 + next_run_at set + error/started/finished cleared",
        row?.status === "retrying" &&
          row?.retry_count === 0 &&
          typeof row?.next_run_at === "string" &&
          (row?.next_run_at as string).length > 0 &&
          row?.error_message === null &&
          row?.started_at === null &&
          row?.finished_at === null,
        `status=${String(row?.status)} retry_count=${String(row?.retry_count)} next_run_at=${String(row?.next_run_at)} err=${String(row?.error_message)}`,
      );
      record(
        "failed → reset: still exactly 1 image_enhance row (no duplicate)",
        countEnhanceJobs(dbHandle.db, seeded.mediaId) === 1,
        `count=${countEnhanceJobs(dbHandle.db, seeded.mediaId)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 5: existing success → reset.
    // -----------------------------------------------------------------
    {
      const seeded = seedImageMedia(tripService, mediaRepo, "Case5 success");
      const oldJobId = insertJobRow(dbHandle.db, seeded.mediaId, "success", {
        finishedAt: "2026-05-12T00:10:00.000Z",
      });
      const result = mediaService.enhanceMedia(seeded.mediaId);
      record(
        "success → reset: same jobId, outcome='reset'",
        result.outcome === "reset" && result.jobId === oldJobId,
        JSON.stringify(result),
      );
      const row = readJob(dbHandle.db, oldJobId);
      record(
        "success → reset: row flipped to retrying (P4.T2 R-40)",
        row?.status === "retrying" && row?.retry_count === 0,
        `status=${String(row?.status)} retry_count=${String(row?.retry_count)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 6: existing cancelled → reset.
    // -----------------------------------------------------------------
    {
      const seeded = seedImageMedia(tripService, mediaRepo, "Case6 cancelled");
      const oldJobId = insertJobRow(dbHandle.db, seeded.mediaId, "cancelled");
      const result = mediaService.enhanceMedia(seeded.mediaId);
      record(
        "cancelled → reset: same jobId, outcome='reset'",
        result.outcome === "reset" && result.jobId === oldJobId,
        JSON.stringify(result),
      );
      const row = readJob(dbHandle.db, oldJobId);
      record(
        "cancelled → reset: row flipped to retrying",
        row?.status === "retrying" && row?.retry_count === 0,
        `status=${String(row?.status)} retry_count=${String(row?.retry_count)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 7: idempotency. Two consecutive enhance calls on a fresh
    //         media yield 'created' then 'skipped' (no duplicate row).
    // -----------------------------------------------------------------
    {
      const seeded = seedImageMedia(tripService, mediaRepo, "Case7 idempotent");
      const first = mediaService.enhanceMedia(seeded.mediaId);
      const second = mediaService.enhanceMedia(seeded.mediaId);
      record(
        "idempotent: first call 'created', second call 'skipped' on same jobId",
        first.outcome === "created" &&
          second.outcome === "skipped" &&
          second.jobId === first.jobId &&
          second.reason === "already pending",
        `first=${JSON.stringify(first)} second=${JSON.stringify(second)}`,
      );
      record(
        "idempotent: row count remains 1 after double-call",
        countEnhanceJobs(dbHandle.db, seeded.mediaId) === 1,
        `count=${countEnhanceJobs(dbHandle.db, seeded.mediaId)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 8: missing media → NotFoundError.
    // -----------------------------------------------------------------
    {
      let threw: unknown;
      try {
        mediaService.enhanceMedia(randomUUID());
      } catch (err) {
        threw = err;
      }
      record(
        "missing media → NotFoundError",
        threw !== undefined && /Media not found/.test(describeError(threw)),
        describeError(threw),
      );
    }

    // -----------------------------------------------------------------
    // CASE 9: soft-deleted media → NotFoundError. Recycle-bin members
    //         cannot be enhanced; the user must restore first. This
    //         matches the P7 contract (default reads filter
    //         `deleted_at IS NULL`).
    // -----------------------------------------------------------------
    {
      const seeded = seedImageMedia(tripService, mediaRepo, "Case9 soft-deleted");
      mediaService.softDeleteMedia(seeded.mediaId);
      let threw: unknown;
      try {
        mediaService.enhanceMedia(seeded.mediaId);
      } catch (err) {
        threw = err;
      }
      record(
        "soft-deleted media → NotFoundError (matches recycle-bin contract)",
        threw !== undefined && /Media not found/.test(describeError(threw)),
        describeError(threw),
      );
      // And no image_enhance row leaked into the queue.
      record(
        "soft-deleted media: no image_enhance row was inserted (defensive)",
        countEnhanceJobs(dbHandle.db, seeded.mediaId) === 0,
        `count=${countEnhanceJobs(dbHandle.db, seeded.mediaId)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 10: video media → BadRequestError. Enhance is image-only
    //          per requirements §7.9; video enhance is out of P8
    //          scope.
    // -----------------------------------------------------------------
    {
      const seeded = seedMediaOfType(tripService, mediaRepo, "video");
      let threw: unknown;
      try {
        mediaService.enhanceMedia(seeded.mediaId);
      } catch (err) {
        threw = err;
      }
      record(
        "video media → BadRequestError (enhance is image-only)",
        threw !== undefined &&
          /enhance is only supported for image media/.test(describeError(threw)),
        describeError(threw),
      );
      record(
        "video media: no image_enhance row was inserted",
        countEnhanceJobs(dbHandle.db, seeded.mediaId) === 0,
        `count=${countEnhanceJobs(dbHandle.db, seeded.mediaId)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 11: unknown-type media → BadRequestError.
    // -----------------------------------------------------------------
    {
      const seeded = seedMediaOfType(tripService, mediaRepo, "unknown");
      let threw: unknown;
      try {
        mediaService.enhanceMedia(seeded.mediaId);
      } catch (err) {
        threw = err;
      }
      record(
        "unknown media → BadRequestError",
        threw !== undefined &&
          /enhance is only supported for image media/.test(describeError(threw)),
        describeError(threw),
      );
    }

    // -----------------------------------------------------------------
    // CASE 12: malformed id → ValidationError via entityIdSchema.
    // -----------------------------------------------------------------
    {
      let threw: unknown;
      try {
        mediaService.enhanceMedia("not-a-valid-id!@#");
      } catch (err) {
        threw = err;
      }
      record(
        "malformed id → ValidationError",
        threw !== undefined && /Validation/.test(describeError(threw)),
        describeError(threw),
      );
    }

    // -----------------------------------------------------------------
    // CASE 13: P8.T1 scope guard — enhance does NOT write
    //          media_versions and does NOT mutate media_items columns
    //          (no preview/thumbnail/quality_score touch). The worker
    //          + version writer land in P8.T2 / P8.T3; P8.T1 is
    //          purely a queue manipulator.
    // -----------------------------------------------------------------
    {
      const seeded = seedImageMedia(tripService, mediaRepo, "Case13 scope-guard");
      const beforeMedia = readMediaRaw(dbHandle.db, seeded.mediaId);
      const beforeVersions = countMediaVersions(dbHandle.db, seeded.mediaId);
      mediaService.enhanceMedia(seeded.mediaId);
      const afterMedia = readMediaRaw(dbHandle.db, seeded.mediaId);
      const afterVersions = countMediaVersions(dbHandle.db, seeded.mediaId);
      record(
        "scope-guard: media_versions count unchanged (P8.T3 territory)",
        beforeVersions === afterVersions && afterVersions === 0,
        `before=${beforeVersions} after=${afterVersions}`,
      );
      record(
        "scope-guard: media_items.preview_path / thumbnail_path / width / height unchanged",
        beforeMedia?.preview_path === afterMedia?.preview_path &&
          beforeMedia?.thumbnail_path === afterMedia?.thumbnail_path &&
          beforeMedia?.width === afterMedia?.width &&
          beforeMedia?.height === afterMedia?.height,
        `before=${JSON.stringify({
          preview: beforeMedia?.preview_path,
          thumb: beforeMedia?.thumbnail_path,
          w: beforeMedia?.width,
          h: beforeMedia?.height,
        })} after=${JSON.stringify({
          preview: afterMedia?.preview_path,
          thumb: afterMedia?.thumbnail_path,
          w: afterMedia?.width,
          h: afterMedia?.height,
        })}`,
      );
      record(
        "scope-guard: media_items.status / user_decision / deleted_at unchanged",
        beforeMedia?.status === afterMedia?.status &&
          beforeMedia?.user_decision === afterMedia?.user_decision &&
          beforeMedia?.deleted_at === afterMedia?.deleted_at,
        `status=${String(afterMedia?.status)} user_decision=${String(afterMedia?.user_decision)} deleted_at=${String(afterMedia?.deleted_at)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 14: jobRepo NOT wired → throws (programmer-error path).
    //          Mirrors `reprocess`'s wiring guard so a misconfigured
    //          service doesn't silently no-op.
    // -----------------------------------------------------------------
    {
      const naked = new MediaService(mediaRepo, tripService, mediaVersionsRepo);
      // Use any seeded media id so the read finds something; the
      // jobRepo guard fires first.
      const seeded = seedImageMedia(tripService, mediaRepo, "Case14 naked service");
      let threw: unknown;
      try {
        naked.enhanceMedia(seeded.mediaId);
      } catch (err) {
        threw = err;
      }
      record(
        "naked service: enhance throws programmer-error when jobRepo missing",
        threw !== undefined && /jobRepo not configured/.test(describeError(threw)),
        describeError(threw),
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
