// Manual smoke test for media reprocess (P3.T7 + P4.T2 R-40 fix).
//
// Usage: npm run smoke:media-reprocess
//
// Exercises MediaService.reprocess directly (no HTTP — same pattern
// as the other smokes) against a real SQLite DB:
//
// Coverage:
//   * Fresh media with no jobs → both slots "created" + actual
//     pending rows in DB.
//   * Failed job → "reset" + status flipped to 'retrying' (P4.T2
//     R-40: was 'pending') + retry_count=0 + next_run_at set +
//     error_message / started_at / finished_at cleared.
//   * Success job → "reset" → status='retrying'.
//   * Pending job → "skipped" (`reason: "already pending"`).
//   * Running job → "skipped" (`reason: "already running"`).
//   * Mixed slots (thumbnail pending + metadata failed) → one
//     "skipped" + one "reset" in the same call.
//   * Idempotency: calling reprocess twice in a row produces stable
//     results without growing the table or duplicating job rows.
//   * Missing media → NotFoundError.
//   * Soft-deleted media → NotFoundError.
//   * Non-image media (unknown) → BadRequestError.
//   * Sanity: the reset rows (now in 'retrying' with next_run_at=now)
//     are still claimable by the executor on the next tick — the
//     P4.T2 claim SELECT accepts both pending and due-retrying rows.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { BadRequestError, NotFoundError } from "../errors/AppError.js";
import {
  ImageChannelExecutor,
  JobHandlerRegistry,
  JobRepository,
  type JobHandler,
} from "../jobs/index.js";
import { createLogger } from "../logger.js";
import { MediaRepository, MediaService, MediaVersionsRepository } from "../media/index.js";
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
  db: SqliteDatabase,
  tripService: TripService,
  mediaRepo: MediaRepository,
): Seeded {
  const trip = tripService.createTrip({ title: "Reprocess Smoke Trip" });
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
  void db; // db is the same connection as repos; we just pass it for grep-ability.
  return { tripId: trip.id, mediaId };
}

function insertJobRow(
  db: SqliteDatabase,
  mediaId: string,
  jobType: string,
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
    jobType,
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

function countJobs(db: SqliteDatabase, mediaId: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM processing_jobs WHERE media_id = ?`).get(mediaId) as {
      n: number;
    }
  ).n;
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-media-reprocess-smoke-"));
  const dbPath = path.join(tmpRoot, "smoke.db");
  console.log(`[smoke] dbPath=${dbPath}`);

  const dbHandle = openDatabase(dbPath);
  try {
    runMigrations(dbHandle.db);

    const tripService = new TripService(new TripRepository(dbHandle.db));
    const mediaRepo = new MediaRepository(dbHandle.db);
    const mediaVersionsRepo = new MediaVersionsRepository(dbHandle.db);
    const jobRepo = new JobRepository(dbHandle.db);
    const mediaService = new MediaService(mediaRepo, tripService, mediaVersionsRepo, jobRepo);

    // ---------------------------------------------------------------------
    // CASE 1: media with no existing jobs → both slots "created"
    // ---------------------------------------------------------------------
    {
      const seeded = seedImageMedia(dbHandle.db, tripService, mediaRepo);
      const result = mediaService.reprocess(seeded.mediaId);
      record(
        "fresh media: both slots → created",
        result.results.length === 2 &&
          result.results.every((r) => r.outcome === "created") &&
          result.results.some((r) => r.jobType === "image_thumbnail") &&
          result.results.some((r) => r.jobType === "image_metadata"),
        JSON.stringify(result.results.map((r) => `${r.jobType}=${r.outcome}`)),
      );
      // The DB now has 2 pending rows for this media.
      const thumbRow = readJob(dbHandle.db, result.results[0]!.jobId);
      record(
        "fresh media: created job is pending + no error/started/finished",
        thumbRow?.status === "pending" &&
          thumbRow?.error_message === null &&
          thumbRow?.started_at === null &&
          thumbRow?.finished_at === null,
        `status=${String(thumbRow?.status)}`,
      );
    }

    // ---------------------------------------------------------------------
    // CASE 2: failed job → reset + cleared fields
    // ---------------------------------------------------------------------
    {
      const seeded = seedImageMedia(dbHandle.db, tripService, mediaRepo);
      const oldJobId = insertJobRow(dbHandle.db, seeded.mediaId, "image_thumbnail", "failed", {
        errorMessage: "previous run blew up",
        startedAt: "2026-05-12T00:00:00.000Z",
        finishedAt: "2026-05-12T00:00:01.000Z",
      });
      const result = mediaService.reprocess(seeded.mediaId);
      const thumbResult = result.results.find((r) => r.jobType === "image_thumbnail")!;
      record(
        "failed → reset: same job id, outcome='reset'",
        thumbResult.outcome === "reset" && thumbResult.jobId === oldJobId,
        JSON.stringify(thumbResult),
      );
      const row = readJob(dbHandle.db, oldJobId);
      // P4.T2 R-40: reprocess now lands the row in `retrying` (the
      // §4.3-canonical re-entry point), not `pending`. retry_count
      // resets to 0 (user-driven "start over"); next_run_at is
      // populated so the JobQueue / ImageChannelExecutor SELECT
      // sees the row as immediately due.
      record(
        "failed → reset: row.status=retrying + retry_count=0 + next_run_at set + error/started/finished cleared",
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
        "failed → reset: metadata slot has no prior job → created",
        result.results.find((r) => r.jobType === "image_metadata")?.outcome === "created",
        `metadata outcome=${result.results.find((r) => r.jobType === "image_metadata")?.outcome}`,
      );
    }

    // ---------------------------------------------------------------------
    // CASE 3: success → reset
    // ---------------------------------------------------------------------
    {
      const seeded = seedImageMedia(dbHandle.db, tripService, mediaRepo);
      const oldJobId = insertJobRow(dbHandle.db, seeded.mediaId, "image_thumbnail", "success", {
        finishedAt: "2026-05-12T00:01:00.000Z",
      });
      const result = mediaService.reprocess(seeded.mediaId);
      const thumbResult = result.results.find((r) => r.jobType === "image_thumbnail")!;
      record(
        "success → reset: same id, outcome='reset'",
        thumbResult.outcome === "reset" && thumbResult.jobId === oldJobId,
        JSON.stringify(thumbResult),
      );
      const row = readJob(dbHandle.db, oldJobId);
      record(
        "success → reset: row flipped to retrying (P4.T2 R-40)",
        row?.status === "retrying" && row?.retry_count === 0,
        `status=${String(row?.status)} retry_count=${String(row?.retry_count)}`,
      );
    }

    // ---------------------------------------------------------------------
    // CASE 4: pending → skipped
    // ---------------------------------------------------------------------
    {
      const seeded = seedImageMedia(dbHandle.db, tripService, mediaRepo);
      const oldJobId = insertJobRow(dbHandle.db, seeded.mediaId, "image_thumbnail", "pending");
      const result = mediaService.reprocess(seeded.mediaId);
      const thumbResult = result.results.find((r) => r.jobType === "image_thumbnail")!;
      record(
        "pending → skipped with reason 'already pending'",
        thumbResult.outcome === "skipped" &&
          thumbResult.jobId === oldJobId &&
          thumbResult.reason === "already pending",
        JSON.stringify(thumbResult),
      );
      // No duplicate job row was inserted.
      const n = countJobs(dbHandle.db, seeded.mediaId);
      record(
        "pending → skipped: total job rows for this media = 2 (1 prior + 1 new metadata 'created')",
        n === 2,
        `count=${n}`,
      );
    }

    // ---------------------------------------------------------------------
    // CASE 5: running → skipped
    // ---------------------------------------------------------------------
    {
      const seeded = seedImageMedia(dbHandle.db, tripService, mediaRepo);
      const oldJobId = insertJobRow(dbHandle.db, seeded.mediaId, "image_thumbnail", "running", {
        startedAt: "2026-05-12T00:00:00.000Z",
      });
      const result = mediaService.reprocess(seeded.mediaId);
      const thumbResult = result.results.find((r) => r.jobType === "image_thumbnail")!;
      record(
        "running → skipped with reason 'already running'",
        thumbResult.outcome === "skipped" &&
          thumbResult.jobId === oldJobId &&
          thumbResult.reason === "already running",
        JSON.stringify(thumbResult),
      );
      // The running row stays running.
      const row = readJob(dbHandle.db, oldJobId);
      record(
        "running → skipped: row still 'running' (not flipped)",
        row?.status === "running",
        `status=${String(row?.status)}`,
      );
    }

    // ---------------------------------------------------------------------
    // CASE 6: mixed — thumbnail pending + metadata failed
    // ---------------------------------------------------------------------
    {
      const seeded = seedImageMedia(dbHandle.db, tripService, mediaRepo);
      const pendingId = insertJobRow(dbHandle.db, seeded.mediaId, "image_thumbnail", "pending");
      const failedId = insertJobRow(dbHandle.db, seeded.mediaId, "image_metadata", "failed", {
        errorMessage: "exifr broke",
      });
      const result = mediaService.reprocess(seeded.mediaId);
      const tr = result.results.find((r) => r.jobType === "image_thumbnail")!;
      const mr = result.results.find((r) => r.jobType === "image_metadata")!;
      record(
        "mixed: thumbnail skipped + metadata reset",
        tr.outcome === "skipped" &&
          tr.jobId === pendingId &&
          mr.outcome === "reset" &&
          mr.jobId === failedId,
        `thumb=${tr.outcome} meta=${mr.outcome}`,
      );
    }

    // ---------------------------------------------------------------------
    // CASE 7: idempotency — second call right after first
    // ---------------------------------------------------------------------
    {
      const seeded = seedImageMedia(dbHandle.db, tripService, mediaRepo);
      // First call creates both slots
      const first = mediaService.reprocess(seeded.mediaId);
      // Second call should see them both pending and skip
      const second = mediaService.reprocess(seeded.mediaId);
      record(
        "idempotency: first call → both created",
        first.results.every((r) => r.outcome === "created"),
        JSON.stringify(first.results.map((r) => r.outcome)),
      );
      record(
        "idempotency: second call → both skipped (already pending)",
        second.results.every((r) => r.outcome === "skipped" && r.reason === "already pending"),
        JSON.stringify(second.results.map((r) => `${r.outcome}/${r.reason ?? ""}`)),
      );
      record(
        "idempotency: total job rows for this media stays 2",
        countJobs(dbHandle.db, seeded.mediaId) === 2,
        `count=${countJobs(dbHandle.db, seeded.mediaId)}`,
      );
    }

    // ---------------------------------------------------------------------
    // CASE 8: missing media → NotFoundError
    // ---------------------------------------------------------------------
    {
      let threw: unknown;
      try {
        mediaService.reprocess("definitely-not-a-real-id");
      } catch (err) {
        threw = err;
      }
      record("missing media → NotFoundError", threw instanceof NotFoundError, describeError(threw));
    }

    // ---------------------------------------------------------------------
    // CASE 9: soft-deleted media → NotFoundError
    // ---------------------------------------------------------------------
    {
      const seeded = seedImageMedia(dbHandle.db, tripService, mediaRepo);
      dbHandle.db
        .prepare(`UPDATE media_items SET deleted_at = ?, status = 'deleted' WHERE id = ?`)
        .run(new Date().toISOString(), seeded.mediaId);
      let threw: unknown;
      try {
        mediaService.reprocess(seeded.mediaId);
      } catch (err) {
        threw = err;
      }
      record(
        "soft-deleted media → NotFoundError",
        threw instanceof NotFoundError,
        describeError(threw),
      );
    }

    // ---------------------------------------------------------------------
    // CASE 10: non-image media → BadRequestError
    // ---------------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Bad-type trip" });
      const unknownId = randomUUID();
      const now = new Date().toISOString();
      mediaRepo.insert({
        id: unknownId,
        tripId: trip.id,
        type: "unknown",
        originalPath: null,
        fileSize: 0,
        mimeType: null,
        extension: "txt",
        createdAt: now,
        updatedAt: now,
      });
      let threw: unknown;
      try {
        mediaService.reprocess(unknownId);
      } catch (err) {
        threw = err;
      }
      record(
        "non-image media → BadRequestError",
        threw instanceof BadRequestError,
        describeError(threw),
      );
    }

    // ---------------------------------------------------------------------
    // CASE 11: executor actually picks up the reset rows
    // ---------------------------------------------------------------------
    {
      const seeded = seedImageMedia(dbHandle.db, tripService, mediaRepo);
      // Pre-seed a failed thumbnail job, then reprocess to reset it.
      insertJobRow(dbHandle.db, seeded.mediaId, "image_thumbnail", "failed", {
        errorMessage: "before reset",
      });
      const result = mediaService.reprocess(seeded.mediaId);
      const thumbResult = result.results.find((r) => r.jobType === "image_thumbnail")!;
      record(
        "executor handoff: reset outcome set",
        thumbResult.outcome === "reset",
        JSON.stringify(thumbResult),
      );

      // Stand up a tiny executor + stub thumbnail handler so we can
      // verify the reset row is now claimable. Earlier cases left
      // a backlog of pending image_* rows for OTHER media (each case
      // seeded its own media + jobs). The executor sorts by
      // created_at ASC, so it drains the backlog before reaching
      // this case's row. Drain to idle, then assert.
      const noopThumb: JobHandler = async () => {
        /* no-op success */
      };
      const noopMeta: JobHandler = async () => {
        /* no-op success */
      };
      const registry = new JobHandlerRegistry();
      registry.register("image_thumbnail", noopThumb);
      registry.register("image_metadata", noopMeta);
      const logger = createLogger({ nodeEnv: "test" });
      const exec = new ImageChannelExecutor({ jobRepo, registry, logger });

      let successCount = 0;
      let safety = 1000;
      while (safety-- > 0) {
        const t = await exec.tick();
        if (t.outcome === "idle") break;
        if (t.outcome === "success") successCount += 1;
      }
      record(
        "executor handoff: drain produced at least 2 success ticks",
        successCount >= 2,
        `successCount=${successCount}`,
      );
      const finalThumb = readJob(dbHandle.db, thumbResult.jobId);
      record(
        "executor handoff: reset thumbnail job now status='success'",
        finalThumb?.status === "success",
        `status=${String(finalThumb?.status)}`,
      );
    }
  } finally {
    closeDatabase(dbHandle);
    await rm(tmpRoot, { recursive: true, force: true });
    console.log(`[smoke] cleaned up ${tmpRoot}`);
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
