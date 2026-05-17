// Manual smoke test for the Job API (P4.T4).
//
// Usage: npm run smoke:jobs-api
//
// Boots a minimal Express app wired with the real JobsRouter +
// JobService + JobRepository over a real SQLite DB. Seeds rows
// directly with INSERT (we want to control statuses precisely, not
// drive them via the JobQueue), then exercises each endpoint over
// `fetch` against an ephemeral port. No new test framework.
//
// Coverage:
//   * GET /api/jobs → list, default pagination, newest-first ordering.
//   * GET /api/jobs?status=… → filter by status.
//   * GET /api/jobs?jobType=… → filter by job_type.
//   * GET /api/jobs?mediaId=… → filter by media id.
//   * GET /api/jobs?tripId=…  → filter through media_items LEFT JOIN.
//   * GET /api/jobs?limit=N&offset=M → pagination.
//   * GET /api/jobs?status=invalid → 400 VALIDATION_FAILED.
//   * GET /api/jobs/:id           → single row + tripId resolved.
//   * GET /api/jobs/<missing>     → 404 NOT_FOUND.
//   * POST /api/jobs/:id/retry on failed   → 200 + status='retrying' + retry_count=0.
//   * POST /api/jobs/:id/retry on success  → 200 + status='retrying'.
//   * POST /api/jobs/:id/retry on cancelled → 200 + status='retrying'.
//   * POST /api/jobs/:id/retry on retrying → 200 + status='retrying' (retry_count reset).
//   * POST /api/jobs/:id/retry on pending  → 400 INVALID_STATE_TRANSITION.
//   * POST /api/jobs/:id/retry on running  → 400 INVALID_STATE_TRANSITION.
//   * POST /api/jobs/<missing>/retry → 404.
//   * Retry does NOT directly invoke handler — JobQueue claim picks
//     it up. We verify this by NOT starting a JobQueue at all and
//     asserting status stays 'retrying' after the API call.
//   * POST /api/jobs/:id/cancel on pending  → 200 + status='cancelled'.
//   * POST /api/jobs/:id/cancel on retrying → 200 + status='cancelled'.
//   * POST /api/jobs/:id/cancel on running  → 200 + status='cancelled'.
//   * POST /api/jobs/:id/cancel on success  → 400 INVALID_STATE_TRANSITION.
//   * POST /api/jobs/:id/cancel on failed   → 400 INVALID_STATE_TRANSITION.
//   * POST /api/jobs/:id/cancel on cancelled → 400 INVALID_STATE_TRANSITION.
//   * After cancel: pending row is NOT picked up by a JobQueue tick.

import express from "express";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import {
  JobQueue,
  JobRepository,
  JobService,
  type JobHandler,
  type JobStatus,
} from "../jobs/index.js";
import { createLogger } from "../logger.js";
import { MediaRepository } from "../media/index.js";
import { makeErrorHandler, notFoundHandler } from "../middleware/errorHandler.js";
import { requestIdMiddleware } from "../middleware/requestId.js";
import { makeJobsRouter } from "../routes/jobs.js";
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

interface SeededMedia {
  readonly tripId: string;
  readonly mediaId: string;
}

function seedMedia(
  tripService: TripService,
  mediaRepo: MediaRepository,
  tripTitle: string,
): SeededMedia {
  const trip = tripService.createTrip({ title: tripTitle });
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

/** Insert a job row directly with a chosen status — used to set up cases. */
function insertJobAt(
  db: SqliteDatabase,
  mediaId: string,
  jobType: string,
  status: JobStatus,
  extras: {
    retryCount?: number;
    errorMessage?: string | null;
    nextRunAt?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
    createdAt?: string;
  } = {},
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO processing_jobs (
       id, media_id, job_type, status, retry_count,
       error_message, next_run_at, started_at, finished_at,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    mediaId,
    jobType,
    status,
    extras.retryCount ?? 0,
    extras.errorMessage ?? null,
    extras.nextRunAt ?? null,
    extras.startedAt ?? null,
    extras.finishedAt ?? null,
    extras.createdAt ?? now,
    now,
  );
  return id;
}

function readJobRow(db: SqliteDatabase, jobId: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM processing_jobs WHERE id = ?`).get(jobId) as
    | Record<string, unknown>
    | undefined;
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-jobs-api-smoke-"));
  const dbPath = path.join(tmpRoot, "smoke.db");
  console.log(`[smoke] dbPath=${dbPath}`);

  const dbHandle = openDatabase(dbPath);
  const logger = createLogger({ nodeEnv: "test" });

  let server: ReturnType<typeof createServer> | null = null;
  try {
    runMigrations(dbHandle.db);

    const tripService = new TripService(new TripRepository(dbHandle.db));
    const mediaRepo = new MediaRepository(dbHandle.db);
    const jobRepo = new JobRepository(dbHandle.db);
    const jobService = new JobService(jobRepo);

    // Minimal Express app — same middleware shape used by createApp()
    // for the standard error envelope. We deliberately do NOT mount
    // unrelated routers (trips / media / storage / health) so this
    // smoke only exercises the Job API surface.
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use(requestIdMiddleware);
    app.use("/api/jobs", makeJobsRouter({ service: jobService }));
    app.use(notFoundHandler);
    app.use(makeErrorHandler(logger));

    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    console.log(`[smoke] server listening on ${base}`);

    // -----------------------------------------------------------------
    // Seed trips + media + jobs covering every status we need.
    // -----------------------------------------------------------------
    const tripA = seedMedia(tripService, mediaRepo, "Jobs API Smoke A");
    const tripB = seedMedia(tripService, mediaRepo, "Jobs API Smoke B");

    // Spread createdAt by 1 ms each so the DESC ordering is deterministic.
    let counter = 0;
    function ts(offset = 0): string {
      counter += 1;
      return new Date(Date.now() + counter + offset).toISOString();
    }

    const failedJobId = insertJobAt(dbHandle.db, tripA.mediaId, "image_thumbnail", "failed", {
      retryCount: 3,
      errorMessage: "previous attempt blew up",
      finishedAt: ts(),
      createdAt: ts(),
    });
    const successJobId = insertJobAt(dbHandle.db, tripA.mediaId, "image_metadata", "success", {
      finishedAt: ts(),
      createdAt: ts(),
    });
    const cancelledJobId = insertJobAt(dbHandle.db, tripA.mediaId, "image_thumbnail", "cancelled", {
      finishedAt: ts(),
      createdAt: ts(),
    });
    const retryingJobId = insertJobAt(dbHandle.db, tripB.mediaId, "image_thumbnail", "retrying", {
      retryCount: 2,
      nextRunAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: ts(),
    });
    const pendingJobId = insertJobAt(dbHandle.db, tripB.mediaId, "image_metadata", "pending", {
      createdAt: ts(),
    });
    const runningJobId = insertJobAt(dbHandle.db, tripB.mediaId, "image_thumbnail", "running", {
      startedAt: ts(),
      createdAt: ts(),
    });

    // -----------------------------------------------------------------
    // GET /api/jobs — list + filters
    // -----------------------------------------------------------------
    {
      const res = await fetch(`${base}/api/jobs`);
      const body = (await res.json()) as { jobs: Array<{ id: string; status: string }> };
      record(
        "GET /api/jobs → 200 + lists all seeded jobs",
        res.status === 200 && body.jobs.length === 6,
        `status=${res.status} count=${body.jobs.length}`,
      );
      record(
        "GET /api/jobs → newest-first ordering (running last seeded → first listed)",
        body.jobs[0]?.id === runningJobId,
        `first=${body.jobs[0]?.id}`,
      );
    }

    {
      const res = await fetch(`${base}/api/jobs?status=failed`);
      const body = (await res.json()) as { jobs: Array<{ id: string; status: string }> };
      record(
        "GET /api/jobs?status=failed → only failed rows",
        res.status === 200 && body.jobs.length === 1 && body.jobs[0]?.status === "failed",
        `count=${body.jobs.length} first.status=${body.jobs[0]?.status ?? "(none)"}`,
      );
    }

    {
      const res = await fetch(`${base}/api/jobs?jobType=image_metadata`);
      const body = (await res.json()) as { jobs: Array<{ id: string; jobType: string }> };
      record(
        "GET /api/jobs?jobType=image_metadata → only metadata rows",
        res.status === 200 &&
          body.jobs.length === 2 &&
          body.jobs.every((j) => j.jobType === "image_metadata"),
        `count=${body.jobs.length}`,
      );
    }

    {
      const res = await fetch(`${base}/api/jobs?mediaId=${tripA.mediaId}`);
      const body = (await res.json()) as { jobs: Array<{ id: string; mediaId: string }> };
      record(
        "GET /api/jobs?mediaId=… → only that media's rows",
        res.status === 200 &&
          body.jobs.length === 3 &&
          body.jobs.every((j) => j.mediaId === tripA.mediaId),
        `count=${body.jobs.length}`,
      );
    }

    {
      const res = await fetch(`${base}/api/jobs?tripId=${tripB.tripId}`);
      const body = (await res.json()) as { jobs: Array<{ id: string; tripId: string }> };
      record(
        "GET /api/jobs?tripId=… → joins through media_items and returns 3 rows",
        res.status === 200 &&
          body.jobs.length === 3 &&
          body.jobs.every((j) => j.tripId === tripB.tripId),
        `count=${body.jobs.length}`,
      );
    }

    {
      const res = await fetch(`${base}/api/jobs?limit=2&offset=2`);
      const body = (await res.json()) as { jobs: Array<{ id: string }> };
      record(
        "GET /api/jobs?limit=2&offset=2 → page slice of 2",
        res.status === 200 && body.jobs.length === 2,
        `count=${body.jobs.length}`,
      );
    }

    {
      const res = await fetch(`${base}/api/jobs?status=banana`);
      const body = (await res.json()) as { error?: { code?: string } };
      record(
        "GET /api/jobs?status=invalid → 400 VALIDATION_FAILED",
        res.status === 400 && body.error?.code === "VALIDATION_FAILED",
        `status=${res.status} code=${body.error?.code ?? "(none)"}`,
      );
    }

    // -----------------------------------------------------------------
    // GET /api/jobs/:id
    // -----------------------------------------------------------------
    {
      const res = await fetch(`${base}/api/jobs/${failedJobId}`);
      const body = (await res.json()) as { job?: { id: string; status: string; tripId: string } };
      record(
        "GET /api/jobs/:id → 200 + row payload + tripId resolved",
        res.status === 200 &&
          body.job?.id === failedJobId &&
          body.job.status === "failed" &&
          body.job.tripId === tripA.tripId,
        `id=${body.job?.id} status=${body.job?.status} tripId=${body.job?.tripId}`,
      );
    }

    {
      const res = await fetch(`${base}/api/jobs/never-such-id`);
      const body = (await res.json()) as { error?: { code?: string } };
      record(
        "GET /api/jobs/<missing> → 404 NOT_FOUND",
        res.status === 404 && body.error?.code === "NOT_FOUND",
        `status=${res.status} code=${body.error?.code ?? "(none)"}`,
      );
    }

    // -----------------------------------------------------------------
    // POST /api/jobs/:id/retry — happy paths
    // -----------------------------------------------------------------
    {
      const res = await fetch(`${base}/api/jobs/${failedJobId}/retry`, { method: "POST" });
      const body = (await res.json()) as {
        job?: { status: string; retryCount: number; nextRunAt: string | null };
      };
      record(
        "POST retry on failed → 200 + status='retrying' + retry_count=0 + next_run_at set",
        res.status === 200 &&
          body.job?.status === "retrying" &&
          body.job.retryCount === 0 &&
          typeof body.job.nextRunAt === "string",
        `status=${res.status} jobStatus=${body.job?.status} retry_count=${body.job?.retryCount} next_run_at=${body.job?.nextRunAt ?? "(none)"}`,
      );
    }

    {
      const res = await fetch(`${base}/api/jobs/${successJobId}/retry`, { method: "POST" });
      const body = (await res.json()) as { job?: { status: string; retryCount: number } };
      record(
        "POST retry on success → 200 + status='retrying' + retry_count=0",
        res.status === 200 && body.job?.status === "retrying" && body.job.retryCount === 0,
        `jobStatus=${body.job?.status} retry_count=${body.job?.retryCount}`,
      );
    }

    {
      const res = await fetch(`${base}/api/jobs/${cancelledJobId}/retry`, { method: "POST" });
      const body = (await res.json()) as { job?: { status: string } };
      record(
        "POST retry on cancelled → 200 + status='retrying'",
        res.status === 200 && body.job?.status === "retrying",
        `jobStatus=${body.job?.status}`,
      );
    }

    {
      const res = await fetch(`${base}/api/jobs/${retryingJobId}/retry`, { method: "POST" });
      const body = (await res.json()) as { job?: { status: string; retryCount: number } };
      record(
        "POST retry on retrying → 200 + status stays 'retrying' + retry_count reset to 0",
        res.status === 200 && body.job?.status === "retrying" && body.job.retryCount === 0,
        `jobStatus=${body.job?.status} retry_count=${body.job?.retryCount}`,
      );
    }

    // Retry does NOT execute the handler — no JobQueue is running in
    // this smoke. After all the retries above, every row is `retrying`
    // and untouched by any handler.
    {
      const row = readJobRow(dbHandle.db, failedJobId);
      record(
        "retry does not directly execute handler (row stays 'retrying' with no started_at flip)",
        row?.status === "retrying" && row?.started_at === null,
        `status=${String(row?.status)} started_at=${String(row?.started_at)}`,
      );
    }

    // -----------------------------------------------------------------
    // POST /api/jobs/:id/retry — error paths
    // -----------------------------------------------------------------
    {
      const res = await fetch(`${base}/api/jobs/${pendingJobId}/retry`, { method: "POST" });
      const body = (await res.json()) as { error?: { code?: string } };
      record(
        "POST retry on pending → 400 INVALID_STATE_TRANSITION",
        res.status === 400 && body.error?.code === "INVALID_STATE_TRANSITION",
        `status=${res.status} code=${body.error?.code ?? "(none)"}`,
      );
    }

    {
      const res = await fetch(`${base}/api/jobs/${runningJobId}/retry`, { method: "POST" });
      const body = (await res.json()) as { error?: { code?: string } };
      record(
        "POST retry on running → 400 INVALID_STATE_TRANSITION",
        res.status === 400 && body.error?.code === "INVALID_STATE_TRANSITION",
        `status=${res.status} code=${body.error?.code ?? "(none)"}`,
      );
    }

    {
      const res = await fetch(`${base}/api/jobs/never-such-id/retry`, { method: "POST" });
      const body = (await res.json()) as { error?: { code?: string } };
      record(
        "POST retry on missing → 404 NOT_FOUND",
        res.status === 404 && body.error?.code === "NOT_FOUND",
        `status=${res.status} code=${body.error?.code ?? "(none)"}`,
      );
    }

    // -----------------------------------------------------------------
    // POST /api/jobs/:id/cancel — happy paths
    // -----------------------------------------------------------------
    {
      const res = await fetch(`${base}/api/jobs/${pendingJobId}/cancel`, { method: "POST" });
      const body = (await res.json()) as {
        job?: { status: string; finishedAt: string | null };
      };
      record(
        "POST cancel on pending → 200 + status='cancelled' + finished_at set",
        res.status === 200 &&
          body.job?.status === "cancelled" &&
          typeof body.job.finishedAt === "string",
        `status=${res.status} jobStatus=${body.job?.status} finishedAt=${body.job?.finishedAt ?? "(none)"}`,
      );
    }

    // Cancel a row that's currently 'retrying' — note we used the
    // retryingJobId in retry tests above, so it's currently 'retrying'
    // after the retry call (status flip → retrying with retry_count=0).
    {
      const res = await fetch(`${base}/api/jobs/${retryingJobId}/cancel`, { method: "POST" });
      const body = (await res.json()) as { job?: { status: string } };
      record(
        "POST cancel on retrying → 200 + status='cancelled'",
        res.status === 200 && body.job?.status === "cancelled",
        `jobStatus=${body.job?.status}`,
      );
    }

    {
      const res = await fetch(`${base}/api/jobs/${runningJobId}/cancel`, { method: "POST" });
      const body = (await res.json()) as { job?: { status: string } };
      record(
        "POST cancel on running → 200 + status='cancelled' (handler NOT killed)",
        res.status === 200 && body.job?.status === "cancelled",
        `jobStatus=${body.job?.status}`,
      );
    }

    // After cancel: assert that a cancelled pending row is NOT
    // claimable by a JobQueue tick. We seed a FRESH pending row
    // with a UNIQUE job_type, cancel it via the API, then boot a
    // minimal queue whose only registered handler is for that same
    // unique job_type. With no other rows matching, the queue's
    // SELECT can only consider our row — and `status='cancelled'`
    // does not match the claim WHERE clause.
    {
      const cancelTestJobType = "image_cancel_isolation_test";
      const cancelTestJobId = insertJobAt(
        dbHandle.db,
        tripB.mediaId,
        cancelTestJobType,
        "pending",
        { createdAt: ts() },
      );
      const cancelRes = await fetch(`${base}/api/jobs/${cancelTestJobId}/cancel`, {
        method: "POST",
      });
      const cancelBody = (await cancelRes.json()) as { job?: { status: string } };
      const cancelledOk = cancelRes.status === 200 && cancelBody.job?.status === "cancelled";

      const handlers = new Map<string, JobHandler>();
      let invoked = false;
      handlers.set(cancelTestJobType, async () => {
        invoked = true;
      });
      const queue = new JobQueue({
        jobRepo,
        logger,
        channels: [
          { name: "image", concurrency: 1, handlers, pollIntervalMs: 60_000 },
          { name: "video", concurrency: 1, handlers: new Map(), pollIntervalMs: 60_000 },
          { name: "ai", concurrency: 1, handlers: new Map(), pollIntervalMs: 60_000 },
        ],
        zombieTimeoutMs: 0, // disable zombie scan
      });
      const tick = await queue.tickChannel("image");
      await queue.awaitInflight("image");
      await queue.stop();
      const row = readJobRow(dbHandle.db, cancelTestJobId);
      record(
        "after cancel: JobQueue tick does NOT claim the cancelled row (isolated job_type)",
        cancelledOk &&
          row?.status === "cancelled" &&
          invoked === false &&
          tick.claimed.length === 0,
        `cancelOk=${cancelledOk} status=${String(row?.status)} invoked=${invoked} claimed=${tick.claimed.length}`,
      );
    }

    // -----------------------------------------------------------------
    // POST /api/jobs/:id/cancel — error paths
    // -----------------------------------------------------------------
    // successJobId was retried earlier, so it's currently 'retrying'.
    // Seed a fresh success row for this case.
    const freshSuccessJobId = insertJobAt(dbHandle.db, tripA.mediaId, "image_metadata", "success", {
      finishedAt: ts(),
    });
    const freshFailedJobId = insertJobAt(dbHandle.db, tripA.mediaId, "image_thumbnail", "failed", {
      finishedAt: ts(),
      errorMessage: "frozen",
    });
    const freshCancelledJobId = insertJobAt(
      dbHandle.db,
      tripA.mediaId,
      "image_thumbnail",
      "cancelled",
      { finishedAt: ts() },
    );

    {
      const res = await fetch(`${base}/api/jobs/${freshSuccessJobId}/cancel`, { method: "POST" });
      const body = (await res.json()) as { error?: { code?: string } };
      record(
        "POST cancel on success → 400 INVALID_STATE_TRANSITION",
        res.status === 400 && body.error?.code === "INVALID_STATE_TRANSITION",
        `status=${res.status} code=${body.error?.code ?? "(none)"}`,
      );
    }

    {
      const res = await fetch(`${base}/api/jobs/${freshFailedJobId}/cancel`, { method: "POST" });
      const body = (await res.json()) as { error?: { code?: string } };
      record(
        "POST cancel on failed → 400 INVALID_STATE_TRANSITION",
        res.status === 400 && body.error?.code === "INVALID_STATE_TRANSITION",
        `status=${res.status} code=${body.error?.code ?? "(none)"}`,
      );
    }

    {
      const res = await fetch(`${base}/api/jobs/${freshCancelledJobId}/cancel`, {
        method: "POST",
      });
      const body = (await res.json()) as { error?: { code?: string } };
      record(
        "POST cancel on cancelled → 400 INVALID_STATE_TRANSITION",
        res.status === 400 && body.error?.code === "INVALID_STATE_TRANSITION",
        `status=${res.status} code=${body.error?.code ?? "(none)"}`,
      );
    }

    {
      const res = await fetch(`${base}/api/jobs/never-such-id/cancel`, { method: "POST" });
      const body = (await res.json()) as { error?: { code?: string } };
      record(
        "POST cancel on missing → 404 NOT_FOUND",
        res.status === 404 && body.error?.code === "NOT_FOUND",
        `status=${res.status} code=${body.error?.code ?? "(none)"}`,
      );
    }

    // -----------------------------------------------------------------
    // Validation: bad id, bad limit
    // -----------------------------------------------------------------
    {
      // `bad.id.shape` is URL-safe but contains dots — entityIdSchema's
      // regex /^[A-Za-z0-9_-]{1,128}$/ rejects it, surfacing 400
      // VALIDATION_FAILED rather than reaching the repository.
      const res = await fetch(`${base}/api/jobs/bad.id.shape/retry`, { method: "POST" });
      const body = (await res.json()) as { error?: { code?: string } };
      record(
        "POST retry on malformed id → 400 VALIDATION_FAILED",
        res.status === 400 && body.error?.code === "VALIDATION_FAILED",
        `status=${res.status} code=${body.error?.code ?? "(none)"}`,
      );
    }

    {
      const res = await fetch(`${base}/api/jobs?limit=9999`);
      const body = (await res.json()) as { error?: { code?: string } };
      record(
        "GET /api/jobs?limit=9999 → 400 VALIDATION_FAILED",
        res.status === 400 && body.error?.code === "VALIDATION_FAILED",
        `status=${res.status} code=${body.error?.code ?? "(none)"}`,
      );
    }
  } finally {
    if (server !== null) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
    }
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
