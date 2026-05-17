// Manual smoke test for the JobQueue (P4.T1 + P4.T2 + P4.T3).
//
// Usage: npm run smoke:job-queue
//
// Drives the multi-channel scheduler against a real SQLite DB. Each
// case constructs a fresh `JobQueue` with deterministic handlers
// (no sharp / no exifr) so the smoke isolates the scheduler from
// the worker bodies. The "real" handler logic is already covered by
// smoke:image-thumbnail / smoke:image-metadata.
//
// Coverage (P4.T1):
//   * Empty queue → tick claims nothing
//   * Single pending image_thumbnail → tick → success
//   * Concurrency=2 with 3 pending → first tick claims 2, both run
//     in parallel, after await both success; second tick claims 1
//   * Handler error (no retry config) → job marked 'failed',
//     error_message present, queue keeps draining the rest
//   * Video channel with no handlers — pending video_metadata
//     row stays untouched even with an `image_thumbnail` claim active
//   * Channel saturation: tickChannel returns saturatedBefore=true
//     when full
//   * start / stop lifecycle: start auto-drains pending jobs;
//     stop awaits the in-flight handler
//   * stop is idempotent; tick after stop returns no claims
//   * Unknown channel name → throws
//   * Invalid concurrency in config → throws at construction
//
// Coverage (P4.T2 — retry / backoff):
//   * Always-failing handler with budget exhaustion → goes
//     pending → retrying → retrying → failed; retry_count == max;
//     handler invoked maxRetries+1 times.
//   * Handler fails twice, succeeds on third → ends 'success',
//     retry_count==2 carried on the row.
//   * Backoff gating: a row whose next_run_at is in the future is
//     NOT claimed; after the deadline elapses it IS claimed.
//   * Backoff doubling: 1st retry delay ≈ baseDelayMs, 2nd retry
//     delay ≈ 2*baseDelayMs (caps at maxDelayMs).
//   * Invalid retryConfig (negative max / base 0 with retries) →
//     throws at construction.
//
// Coverage (P4.T3 — zombie recovery):
//   * Zombie with retry budget left → recoverZombies routes to
//     'retrying' (retry_count++ + next_run_at set + error_message).
//   * Zombie with retry budget exhausted → routes to final 'failed'.
//   * Fresh 'running' row (started_at within timeout) → untouched.
//   * 'pending' / 'retrying' rows → untouched.
//   * Zombie with started_at IS NULL → treated as ancient → recovered.
//   * start() runs the scan automatically before polling fires.
//   * zombieTimeoutMs=0 disables the scan.
//   * Negative zombieTimeoutMs / non-finite → throws at construction.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import {
  JobQueue,
  JobRepository,
  type JobHandler,
  type JobQueueChannelConfig,
  type JobQueueRetryConfig,
} from "../jobs/index.js";
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

function seedImageMedia(
  tripService: TripService,
  mediaRepo: MediaRepository,
): { tripId: string; mediaId: string } {
  const trip = tripService.createTrip({ title: "JobQueue Smoke Trip" });
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

function insertJob(db: SqliteDatabase, mediaId: string, jobType: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO processing_jobs (id, media_id, job_type, status, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, ?)`,
  ).run(id, mediaId, jobType, now, now);
  return id;
}

/**
 * P4.T3: insert a job already in an arbitrary state. Used by zombie
 * recovery cases to seed a `running` row with a controllable
 * `started_at` (so we can hand-craft a row that looks like it has
 * been running long enough to be a zombie).
 */
function insertJobAt(
  db: SqliteDatabase,
  mediaId: string,
  jobType: string,
  opts: {
    status: "pending" | "running" | "failed" | "success" | "retrying" | "cancelled";
    startedAt?: string | null;
    finishedAt?: string | null;
    retryCount?: number;
    nextRunAt?: string | null;
    errorMessage?: string | null;
    createdAt?: string;
    updatedAt?: string;
  },
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO processing_jobs (
       id, media_id, job_type, status, retry_count,
       error_message, next_run_at,
       started_at, finished_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    mediaId,
    jobType,
    opts.status,
    opts.retryCount ?? 0,
    opts.errorMessage ?? null,
    opts.nextRunAt ?? null,
    opts.startedAt ?? null,
    opts.finishedAt ?? null,
    opts.createdAt ?? now,
    opts.updatedAt ?? now,
  );
  return id;
}

function readJob(db: SqliteDatabase, jobId: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM processing_jobs WHERE id = ?`).get(jobId) as
    | Record<string, unknown>
    | undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface QueueRig {
  readonly queue: JobQueue;
}

function makeQueue(
  jobRepo: JobRepository,
  channels: JobQueueChannelConfig[],
  retryConfig?: JobQueueRetryConfig,
  zombieTimeoutMs?: number,
): QueueRig {
  const logger = createLogger({ nodeEnv: "test" });
  // exactOptionalPropertyTypes: build the deps object incrementally
  // rather than passing `undefined` explicitly to optional fields.
  const deps: {
    jobRepo: JobRepository;
    logger: ReturnType<typeof createLogger>;
    channels: JobQueueChannelConfig[];
    retryConfig?: JobQueueRetryConfig;
    zombieTimeoutMs?: number;
  } = { jobRepo, logger, channels };
  if (retryConfig) deps.retryConfig = retryConfig;
  if (zombieTimeoutMs !== undefined) deps.zombieTimeoutMs = zombieTimeoutMs;
  return { queue: new JobQueue(deps) };
}

function imageChannel(handlers: Map<string, JobHandler>, concurrency = 1): JobQueueChannelConfig {
  return { name: "image", concurrency, handlers, pollIntervalMs: 60_000 };
}

function emptyChannels(): JobQueueChannelConfig[] {
  // image + the two structural placeholders, all empty maps.
  return [
    { name: "image", concurrency: 1, handlers: new Map(), pollIntervalMs: 60_000 },
    { name: "video", concurrency: 1, handlers: new Map(), pollIntervalMs: 60_000 },
    { name: "ai", concurrency: 1, handlers: new Map(), pollIntervalMs: 60_000 },
  ];
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-job-queue-smoke-"));
  const dbPath = path.join(tmpRoot, "smoke.db");
  console.log(`[smoke] dbPath=${dbPath}`);

  const dbHandle = openDatabase(dbPath);
  try {
    runMigrations(dbHandle.db);

    const tripService = new TripService(new TripRepository(dbHandle.db));
    const mediaRepo = new MediaRepository(dbHandle.db);
    const jobRepo = new JobRepository(dbHandle.db);

    // ---------------------------------------------------------------------
    // CASE 1: empty queue → tickChannel claims nothing
    // ---------------------------------------------------------------------
    {
      const handlers = new Map<string, JobHandler>();
      handlers.set("image_thumbnail", async () => {
        /* no-op */
      });
      const { queue } = makeQueue(jobRepo, [imageChannel(handlers)]);
      const result = await queue.tickChannel("image");
      record(
        "empty queue: tickChannel returns 0 claims",
        result.claimed.length === 0 && !result.saturatedBefore,
        JSON.stringify(result),
      );
    }

    // ---------------------------------------------------------------------
    // CASE 2: single pending → tick → await → success
    // ---------------------------------------------------------------------
    {
      const seeded = seedImageMedia(tripService, mediaRepo);
      const jobId = insertJob(dbHandle.db, seeded.mediaId, "image_thumbnail");
      const handlers = new Map<string, JobHandler>();
      let ran = false;
      handlers.set("image_thumbnail", async () => {
        ran = true;
      });
      const { queue } = makeQueue(jobRepo, [imageChannel(handlers)]);
      const tick = await queue.tickChannel("image");
      await queue.awaitInflight("image");
      const row = readJob(dbHandle.db, jobId);
      record(
        "single pending: tick claimed=1 + handler ran + row.status='success'",
        tick.claimed.length === 1 &&
          tick.claimed[0]?.jobId === jobId &&
          ran &&
          row?.status === "success",
        `claimed=${JSON.stringify(tick.claimed)} ran=${ran} status=${String(row?.status)}`,
      );
    }

    // ---------------------------------------------------------------------
    // CASE 3: concurrency=2 with 3 pending — parallel + back-pressure
    // ---------------------------------------------------------------------
    {
      const seeded = seedImageMedia(tripService, mediaRepo);
      const j1 = insertJob(dbHandle.db, seeded.mediaId, "image_thumbnail");
      const j2 = insertJob(dbHandle.db, seeded.mediaId, "image_thumbnail");
      const j3 = insertJob(dbHandle.db, seeded.mediaId, "image_thumbnail");
      const handlers = new Map<string, JobHandler>();
      let inflightPeak = 0;
      let inflightNow = 0;
      handlers.set("image_thumbnail", async () => {
        inflightNow += 1;
        if (inflightNow > inflightPeak) inflightPeak = inflightNow;
        await sleep(40);
        inflightNow -= 1;
      });
      const { queue } = makeQueue(jobRepo, [imageChannel(handlers, 2)]);
      const tick1 = await queue.tickChannel("image");
      record(
        "concurrency=2: first tick claims 2",
        tick1.claimed.length === 2,
        `claimed=${JSON.stringify(tick1.claimed)}`,
      );
      record(
        "concurrency=2: inflightCount=2 immediately after first tick",
        queue.inflightCount("image") === 2,
        `inflight=${queue.inflightCount("image")}`,
      );
      // Second tick BEFORE await: should report saturatedBefore=true
      // and claim 0.
      const tick2 = await queue.tickChannel("image");
      record(
        "concurrency=2: second tick before drain → saturated, claimed=0",
        tick2.saturatedBefore && tick2.claimed.length === 0,
        JSON.stringify(tick2),
      );
      // Now drain.
      await queue.awaitInflight("image");
      record(
        "concurrency=2: peak inflight reached 2 (real parallel run)",
        inflightPeak === 2,
        `inflightPeak=${inflightPeak}`,
      );
      // Third tick: claims the leftover one.
      const tick3 = await queue.tickChannel("image");
      await queue.awaitInflight("image");
      record(
        "concurrency=2: third tick claims the remaining 1",
        tick3.claimed.length === 1,
        `claimed=${JSON.stringify(tick3.claimed)}`,
      );
      // All three jobs landed status='success'.
      const allSucceeded =
        readJob(dbHandle.db, j1)?.status === "success" &&
        readJob(dbHandle.db, j2)?.status === "success" &&
        readJob(dbHandle.db, j3)?.status === "success";
      record("concurrency=2: all 3 jobs final status='success'", allSucceeded, `j1+j2+j3`);
    }

    // ---------------------------------------------------------------------
    // CASE 4: handler throws (no retry config) → job 'failed' + queue
    //          keeps draining. With the P4.T2 default `maxRetries=0`,
    //          a single throw goes straight to `failed` — matching the
    //          original P4.T1 behaviour. (Retry path is exercised by
    //          CASE 13+ below with an explicit retryConfig.)
    // ---------------------------------------------------------------------
    {
      const seeded = seedImageMedia(tripService, mediaRepo);
      const failId = insertJob(dbHandle.db, seeded.mediaId, "image_thumbnail");
      const okId = insertJob(dbHandle.db, seeded.mediaId, "image_thumbnail");
      const handlers = new Map<string, JobHandler>();
      let calls = 0;
      handlers.set("image_thumbnail", async (job) => {
        calls += 1;
        if (job.id === failId) throw new Error("simulated handler failure");
        // okId path succeeds
      });
      // No `retryConfig` argument — defaults to `maxRetries=0`.
      const { queue } = makeQueue(jobRepo, [imageChannel(handlers)]);
      await queue.tickChannel("image");
      await queue.awaitInflight("image");
      await queue.tickChannel("image");
      await queue.awaitInflight("image");

      const failRow = readJob(dbHandle.db, failId);
      const okRow = readJob(dbHandle.db, okId);
      record(
        "handler throws: failed job → status='failed' + error_message present",
        failRow?.status === "failed" &&
          typeof failRow?.error_message === "string" &&
          /simulated handler failure/.test(failRow.error_message as string),
        `status=${String(failRow?.status)} err=${String(failRow?.error_message)}`,
      );
      record(
        "handler throws: queue continued + sibling job success",
        okRow?.status === "success" && calls === 2,
        `okStatus=${String(okRow?.status)} totalCalls=${calls}`,
      );
    }

    // ---------------------------------------------------------------------
    // CASE 5: video channel with no handlers — pending video_metadata
    //         row stays untouched
    // ---------------------------------------------------------------------
    {
      const seeded = seedImageMedia(tripService, mediaRepo);
      const vId = insertJob(dbHandle.db, seeded.mediaId, "video_metadata");
      const handlers = new Map<string, JobHandler>();
      handlers.set("image_thumbnail", async () => {
        /* never matches video_metadata */
      });
      // Multi-channel queue with empty video channel.
      const { queue } = makeQueue(jobRepo, [
        imageChannel(handlers, 2),
        { name: "video", concurrency: 1, handlers: new Map(), pollIntervalMs: 60_000 },
        { name: "ai", concurrency: 1, handlers: new Map(), pollIntervalMs: 60_000 },
      ]);
      const tickI = await queue.tickChannel("image");
      const tickV = await queue.tickChannel("video");
      await queue.awaitInflight("image");
      await queue.awaitInflight("video");
      const vRow = readJob(dbHandle.db, vId);
      record(
        "video channel with no handlers: video_metadata stays pending",
        tickI.claimed.length === 0 && tickV.claimed.length === 0 && vRow?.status === "pending",
        `image=${tickI.claimed.length} video=${tickV.claimed.length} videoStatus=${String(
          vRow?.status,
        )}`,
      );
    }

    // ---------------------------------------------------------------------
    // CASE 6: start / stop auto-drain + idempotency
    // ---------------------------------------------------------------------
    {
      const seeded = seedImageMedia(tripService, mediaRepo);
      const j1 = insertJob(dbHandle.db, seeded.mediaId, "image_thumbnail");
      const handlers = new Map<string, JobHandler>();
      handlers.set("image_thumbnail", async () => {
        /* no-op */
      });
      const { queue } = makeQueue(jobRepo, [
        { name: "image", concurrency: 1, handlers, pollIntervalMs: 25 },
        { name: "video", concurrency: 1, handlers: new Map(), pollIntervalMs: 25 },
        { name: "ai", concurrency: 1, handlers: new Map(), pollIntervalMs: 25 },
      ]);
      queue.start();
      // start() fires an immediate first tick — wait for inflight.
      // The job should land 'success' almost immediately.
      // Spin until the row is finalised (cap at 500ms total).
      let finalStatus: unknown = "pending";
      for (let i = 0; i < 50; i += 1) {
        finalStatus = readJob(dbHandle.db, j1)?.status;
        if (finalStatus === "success" || finalStatus === "failed") break;
        await sleep(10);
      }
      record(
        "start(): immediate tick drains pending job to success",
        finalStatus === "success",
        `status=${String(finalStatus)}`,
      );

      // Idempotent start.
      queue.start();
      record(
        "start() is idempotent (state still 'running')",
        queue.getState() === "running",
        `state=${queue.getState()}`,
      );

      // stop drains and settles to 'stopped'.
      await queue.stop();
      record(
        "stop() → state 'stopped'",
        queue.getState() === "stopped",
        `state=${queue.getState()}`,
      );

      // Idempotent stop.
      await queue.stop();
      record("stop() is idempotent", queue.getState() === "stopped", `state=${queue.getState()}`);

      // tick after stop → no claims.
      const newPending = insertJob(dbHandle.db, seeded.mediaId, "image_thumbnail");
      const tickAfter = await queue.tickChannel("image");
      const pendingRow = readJob(dbHandle.db, newPending);
      record(
        "tickChannel after stop → 0 claims + new job stays pending",
        tickAfter.claimed.length === 0 && pendingRow?.status === "pending",
        `claimed=${tickAfter.claimed.length} status=${String(pendingRow?.status)}`,
      );
    }

    // ---------------------------------------------------------------------
    // CASE 7: stop while a handler is mid-flight → awaits handler
    //
    // Note: the smoke's earlier cases leave older pending rows in the
    // shared DB. The queue claims by created_at ASC, so we capture
    // whichever job_id this tick actually grabs (not necessarily the
    // one we just inserted for this case) and assert on it.
    // ---------------------------------------------------------------------
    {
      const seeded = seedImageMedia(tripService, mediaRepo);
      insertJob(dbHandle.db, seeded.mediaId, "image_thumbnail");
      const handlers = new Map<string, JobHandler>();
      let started = false;
      let finished = false;
      handlers.set("image_thumbnail", async () => {
        started = true;
        await sleep(80);
        finished = true;
      });
      const { queue } = makeQueue(jobRepo, [
        { name: "image", concurrency: 1, handlers, pollIntervalMs: 60_000 },
        { name: "video", concurrency: 1, handlers: new Map(), pollIntervalMs: 60_000 },
        { name: "ai", concurrency: 1, handlers: new Map(), pollIntervalMs: 60_000 },
      ]);
      // tickChannel resolves after CLAIMING (handler runs async in
      // background). Capture the claimed job id so the post-stop
      // assertion targets the right row.
      const tickPromise = queue.tickChannel("image");
      const tickResult = await tickPromise;
      const claimedJobId = tickResult.claimed[0]?.jobId;
      // Wait until the handler has actually entered (started flag).
      for (let i = 0; i < 50 && !started; i += 1) await sleep(5);
      record("stop() mid-flight: handler entered before stop", started, `started=${started}`);
      await queue.stop();
      const claimedRow = claimedJobId ? readJob(dbHandle.db, claimedJobId) : undefined;
      record("stop() mid-flight: handler ran to completion", finished, `finished=${finished}`);
      record(
        "stop() mid-flight: claimed job row landed status='success'",
        claimedRow?.status === "success",
        `jobId=${String(claimedJobId)} status=${String(claimedRow?.status)}`,
      );
      record(
        "stop() mid-flight: inflightCount drained to 0",
        queue.inflightCount("image") === 0,
        `inflight=${queue.inflightCount("image")}`,
      );
    }

    // ---------------------------------------------------------------------
    // CASE 8: unknown channel name → throws
    // ---------------------------------------------------------------------
    {
      const handlers = new Map<string, JobHandler>();
      handlers.set("image_thumbnail", async () => {
        /* */
      });
      const { queue } = makeQueue(jobRepo, [imageChannel(handlers)]);
      let threw: unknown;
      try {
        await queue.tickChannel("video" as never);
      } catch (err) {
        threw = err;
      }
      record(
        "tickChannel('video') on image-only queue → throws unknown-channel",
        threw instanceof Error && /unknown channel/.test(threw.message),
        describeError(threw),
      );
    }

    // ---------------------------------------------------------------------
    // CASE 9: invalid concurrency at construction → throws
    // ---------------------------------------------------------------------
    {
      let threw: unknown;
      try {
        new JobQueue({
          jobRepo,
          logger: createLogger({ nodeEnv: "test" }),
          channels: [{ name: "image", concurrency: 0, handlers: new Map() }],
        });
      } catch (err) {
        threw = err;
      }
      record(
        "construction with concurrency<1 → throws",
        threw instanceof Error && /concurrency/.test(threw.message),
        describeError(threw),
      );
    }

    // ---------------------------------------------------------------------
    // CASE 10: duplicate channel name at construction → throws
    // ---------------------------------------------------------------------
    {
      let threw: unknown;
      try {
        new JobQueue({
          jobRepo,
          logger: createLogger({ nodeEnv: "test" }),
          channels: [
            { name: "image", concurrency: 1, handlers: new Map() },
            { name: "image", concurrency: 1, handlers: new Map() },
          ],
        });
      } catch (err) {
        threw = err;
      }
      record(
        "construction with duplicate channel → throws",
        threw instanceof Error && /duplicate channel/.test(threw.message),
        describeError(threw),
      );
    }

    // ---------------------------------------------------------------------
    // CASE 11: empty-channels rig (no handlers anywhere) — no claims
    // ---------------------------------------------------------------------
    {
      const seeded = seedImageMedia(tripService, mediaRepo);
      const j1 = insertJob(dbHandle.db, seeded.mediaId, "image_thumbnail");
      const { queue } = makeQueue(jobRepo, emptyChannels());
      const results = await queue.tickAll();
      record(
        "tickAll on empty-handler queue: all 3 channels claim 0",
        results.every((r) => r.claimed.length === 0) && results.length === 3,
        JSON.stringify(results.map((r) => `${r.channel}=${r.claimed.length}`)),
      );
      record(
        "tickAll on empty-handler queue: pending row stays pending",
        readJob(dbHandle.db, j1)?.status === "pending",
        `status=${String(readJob(dbHandle.db, j1)?.status)}`,
      );
    }

    // ---------------------------------------------------------------------
    // CASE 12: channelNames + getState introspection
    // ---------------------------------------------------------------------
    {
      const handlers = new Map<string, JobHandler>();
      handlers.set("image_thumbnail", async () => {
        /* */
      });
      const { queue } = makeQueue(jobRepo, [
        { name: "image", concurrency: 1, handlers, pollIntervalMs: 60_000 },
        { name: "video", concurrency: 1, handlers: new Map(), pollIntervalMs: 60_000 },
        { name: "ai", concurrency: 1, handlers: new Map(), pollIntervalMs: 60_000 },
      ]);
      record(
        "channelNames returns image / video / ai",
        JSON.stringify(queue.channelNames()) === JSON.stringify(["image", "video", "ai"]),
        JSON.stringify(queue.channelNames()),
      );
      record(
        "fresh queue getState() === 'idle'",
        queue.getState() === "idle",
        `state=${queue.getState()}`,
      );
    }

    // =====================================================================
    // P4.T2 retry cases. Each constructs an isolated media + a fresh
    // queue with `retryConfig` set so the new branch in `runHandler`
    // is exercised end-to-end. We use small delays (10ms base, 50ms
    // max) so the smoke stays fast yet observable.
    //
    // Each retry case uses a UNIQUE job_type (e.g. "image_retry_t13").
    // JobQueue's `claimNextPendingByJobTypes` only matches rows whose
    // job_type is in the channel's registered handler set, so the
    // retry cases are isolated from any stale `image_thumbnail` rows
    // left behind by earlier P4.T1 cases. The job_type still starts
    // with `image_` so other code paths (smoke-only ImageChannelExecutor)
    // would also treat them as image-channel jobs if they ever ran.
    // =====================================================================

    // ---------------------------------------------------------------------
    // CASE 13: always-failing handler → exhausts budget → 'failed'
    //
    // maxRetries=2 ⇒ total attempts = 3 (1 initial + 2 retries).
    // After each attempt that throws but has budget left, the row
    // flips to 'retrying' with retry_count++ and next_run_at = now+delay.
    // After budget exhausted, the next attempt's catch hits the
    // "no retries remaining" branch and writes 'failed'.
    // ---------------------------------------------------------------------
    {
      const jobType = "image_retry_t13";
      const seeded = seedImageMedia(tripService, mediaRepo);
      const jobId = insertJob(dbHandle.db, seeded.mediaId, jobType);
      const handlers = new Map<string, JobHandler>();
      let calls = 0;
      handlers.set(jobType, async () => {
        calls += 1;
        throw new Error(`boom #${calls}`);
      });
      const retryConfig: JobQueueRetryConfig = {
        maxRetries: 2,
        baseDelayMs: 10,
        maxDelayMs: 50,
      };
      const { queue } = makeQueue(jobRepo, [imageChannel(handlers)], retryConfig);

      // Attempt 1
      await queue.tickChannel("image");
      await queue.awaitInflight("image");
      const afterAttempt1 = readJob(dbHandle.db, jobId);
      record(
        "retry: after attempt 1 → status='retrying' + retry_count=1 + next_run_at set",
        afterAttempt1?.status === "retrying" &&
          afterAttempt1?.retry_count === 1 &&
          typeof afterAttempt1?.next_run_at === "string",
        `status=${String(afterAttempt1?.status)} retry_count=${String(afterAttempt1?.retry_count)} next_run_at=${String(afterAttempt1?.next_run_at)}`,
      );

      // Wait past the first backoff (base=10ms), then tick.
      await sleep(30);
      await queue.tickChannel("image");
      await queue.awaitInflight("image");
      const afterAttempt2 = readJob(dbHandle.db, jobId);
      record(
        "retry: after attempt 2 → status='retrying' + retry_count=2",
        afterAttempt2?.status === "retrying" && afterAttempt2?.retry_count === 2,
        `status=${String(afterAttempt2?.status)} retry_count=${String(afterAttempt2?.retry_count)}`,
      );

      // Wait past the second backoff (~20ms). Third attempt should be
      // the final one and land 'failed'.
      await sleep(40);
      await queue.tickChannel("image");
      await queue.awaitInflight("image");
      const finalRow = readJob(dbHandle.db, jobId);
      record(
        "retry: after attempt 3 → status='failed' + retry_count=2 + error_message present",
        finalRow?.status === "failed" &&
          finalRow?.retry_count === 2 &&
          typeof finalRow?.error_message === "string" &&
          /boom/.test(finalRow.error_message as string),
        `status=${String(finalRow?.status)} retry_count=${String(finalRow?.retry_count)} err=${String(finalRow?.error_message)}`,
      );
      record(
        "retry: handler invoked exactly maxRetries+1 times",
        calls === 3,
        `calls=${calls} (expected 3)`,
      );
    }

    // ---------------------------------------------------------------------
    // CASE 14: handler fails twice, succeeds on third → ends 'success'
    //
    // retry_count carried at the moment of success is the post-bump
    // value from the most recent retry (2 in this scenario).
    // ---------------------------------------------------------------------
    {
      const jobType = "image_retry_t14";
      const seeded = seedImageMedia(tripService, mediaRepo);
      const jobId = insertJob(dbHandle.db, seeded.mediaId, jobType);
      const handlers = new Map<string, JobHandler>();
      let calls = 0;
      handlers.set(jobType, async () => {
        calls += 1;
        if (calls < 3) throw new Error(`transient #${calls}`);
      });
      const retryConfig: JobQueueRetryConfig = {
        maxRetries: 3,
        baseDelayMs: 10,
        maxDelayMs: 50,
      };
      const { queue } = makeQueue(jobRepo, [imageChannel(handlers)], retryConfig);

      // Attempt 1 — fail → retrying
      await queue.tickChannel("image");
      await queue.awaitInflight("image");
      await sleep(30);
      // Attempt 2 — fail → retrying
      await queue.tickChannel("image");
      await queue.awaitInflight("image");
      await sleep(40);
      // Attempt 3 — success
      await queue.tickChannel("image");
      await queue.awaitInflight("image");
      const finalRow = readJob(dbHandle.db, jobId);
      record(
        "retry-then-succeed: final status='success' + retry_count==2 + error_message cleared",
        finalRow?.status === "success" &&
          finalRow?.retry_count === 2 &&
          finalRow?.error_message === null,
        `status=${String(finalRow?.status)} retry_count=${String(finalRow?.retry_count)} err=${String(finalRow?.error_message)}`,
      );
      record("retry-then-succeed: handler invoked exactly 3 times", calls === 3, `calls=${calls}`);
    }

    // ---------------------------------------------------------------------
    // CASE 15: next_run_at gating — a retrying row whose backoff has
    //          NOT yet elapsed is NOT claimed by a tick, but IS claimed
    //          once the deadline passes.
    //
    // We use baseDelayMs=200 so the gap is visible without flakiness.
    // ---------------------------------------------------------------------
    {
      const jobType = "image_retry_t15";
      const seeded = seedImageMedia(tripService, mediaRepo);
      const jobId = insertJob(dbHandle.db, seeded.mediaId, jobType);
      const handlers = new Map<string, JobHandler>();
      let calls = 0;
      handlers.set(jobType, async () => {
        calls += 1;
        if (calls === 1) throw new Error("first-time fail");
        // second call succeeds
      });
      const retryConfig: JobQueueRetryConfig = {
        maxRetries: 3,
        baseDelayMs: 200,
        maxDelayMs: 1000,
      };
      const { queue } = makeQueue(jobRepo, [imageChannel(handlers)], retryConfig);

      // Attempt 1 → retrying, next_run_at ~ now+200ms
      await queue.tickChannel("image");
      await queue.awaitInflight("image");
      const afterFirst = readJob(dbHandle.db, jobId);
      record(
        "backoff gating: after fail row status='retrying'",
        afterFirst?.status === "retrying",
        `status=${String(afterFirst?.status)} next_run_at=${String(afterFirst?.next_run_at)}`,
      );

      // Tick immediately (well before 200ms). next_run_at gate should
      // refuse the claim → no new handler invocation.
      const earlyTick = await queue.tickChannel("image");
      await queue.awaitInflight("image");
      record(
        "backoff gating: tick before next_run_at → claimed=0 + handler not re-called",
        earlyTick.claimed.length === 0 && calls === 1,
        `claimed=${earlyTick.claimed.length} calls=${calls}`,
      );
      const stillRetrying = readJob(dbHandle.db, jobId);
      record(
        "backoff gating: row stays in 'retrying' (untouched)",
        stillRetrying?.status === "retrying" && stillRetrying?.retry_count === 1,
        `status=${String(stillRetrying?.status)} retry_count=${String(stillRetrying?.retry_count)}`,
      );

      // Wait past the backoff, then tick — now the row IS claimed and
      // the second invocation succeeds.
      await sleep(220);
      const lateTick = await queue.tickChannel("image");
      await queue.awaitInflight("image");
      const finalRow = readJob(dbHandle.db, jobId);
      record(
        "backoff gating: tick after next_run_at → claimed=1 + handler ran again",
        lateTick.claimed.length === 1 && lateTick.claimed[0]?.jobId === jobId && calls === 2,
        `claimed=${lateTick.claimed.length} calls=${calls}`,
      );
      record(
        "backoff gating: final status='success'",
        finalRow?.status === "success" && finalRow?.retry_count === 1,
        `status=${String(finalRow?.status)} retry_count=${String(finalRow?.retry_count)}`,
      );
    }

    // ---------------------------------------------------------------------
    // CASE 16: exponential doubling of backoff (capped by maxDelayMs)
    //
    // With baseDelayMs=100, maxDelayMs=500:
    //   * 1st retry → delay ≈ 100ms (retryCount before = 0; 100 * 2^0)
    //   * 2nd retry → delay ≈ 200ms (retryCount before = 1; 100 * 2^1)
    //   * 3rd retry → delay ≈ 400ms (retryCount before = 2; 100 * 2^2)
    //   * 4th retry → delay capped at 500ms (would otherwise be 800)
    //
    // We capture the gap between updated_at and next_run_at for the
    // first two retries and assert the ratio is ~2x.
    // ---------------------------------------------------------------------
    {
      const jobType = "image_retry_t16";
      const seeded = seedImageMedia(tripService, mediaRepo);
      const jobId = insertJob(dbHandle.db, seeded.mediaId, jobType);
      const handlers = new Map<string, JobHandler>();
      handlers.set(jobType, async () => {
        throw new Error("always fail for doubling test");
      });
      const retryConfig: JobQueueRetryConfig = {
        maxRetries: 4,
        baseDelayMs: 100,
        maxDelayMs: 500,
      };
      const { queue } = makeQueue(jobRepo, [imageChannel(handlers)], retryConfig);

      function gapMs(row: Record<string, unknown> | undefined): number {
        if (!row) return -1;
        const t0 = Date.parse(row.updated_at as string);
        const t1 = Date.parse(row.next_run_at as string);
        return t1 - t0;
      }

      await queue.tickChannel("image");
      await queue.awaitInflight("image");
      const g1 = gapMs(readJob(dbHandle.db, jobId));

      await sleep(g1 + 30);
      await queue.tickChannel("image");
      await queue.awaitInflight("image");
      const g2 = gapMs(readJob(dbHandle.db, jobId));

      // 1st gap ≈ 100ms, 2nd gap ≈ 200ms (allow generous slack since
      // the SQL only stores ms precision in ISO strings and timers
      // are coarse). Expect g2/g1 in [1.5, 3].
      const ratio = g1 > 0 ? g2 / g1 : 0;
      record(
        "backoff doubling: 2nd retry delay ≈ 2x first retry delay",
        g1 >= 50 && g1 <= 250 && g2 >= 100 && g2 <= 500 && ratio >= 1.5 && ratio <= 3,
        `g1=${g1}ms g2=${g2}ms ratio=${ratio.toFixed(2)}`,
      );
    }

    // ---------------------------------------------------------------------
    // CASE 17: invalid retryConfig at construction → throws
    // ---------------------------------------------------------------------
    {
      let threwNeg: unknown;
      try {
        new JobQueue({
          jobRepo,
          logger: createLogger({ nodeEnv: "test" }),
          channels: [{ name: "image", concurrency: 1, handlers: new Map() }],
          retryConfig: { maxRetries: -1, baseDelayMs: 10, maxDelayMs: 50 },
        });
      } catch (err) {
        threwNeg = err;
      }
      record(
        "construction with maxRetries<0 → throws",
        threwNeg instanceof Error && /maxRetries/.test(threwNeg.message),
        describeError(threwNeg),
      );

      let threwBase: unknown;
      try {
        new JobQueue({
          jobRepo,
          logger: createLogger({ nodeEnv: "test" }),
          channels: [{ name: "image", concurrency: 1, handlers: new Map() }],
          retryConfig: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 50 },
        });
      } catch (err) {
        threwBase = err;
      }
      record(
        "construction with baseDelayMs=0 + maxRetries>0 → throws",
        threwBase instanceof Error && /baseDelayMs/.test(threwBase.message),
        describeError(threwBase),
      );

      let threwOrder: unknown;
      try {
        new JobQueue({
          jobRepo,
          logger: createLogger({ nodeEnv: "test" }),
          channels: [{ name: "image", concurrency: 1, handlers: new Map() }],
          retryConfig: { maxRetries: 1, baseDelayMs: 100, maxDelayMs: 50 },
        });
      } catch (err) {
        threwOrder = err;
      }
      record(
        "construction with maxDelayMs<baseDelayMs → throws",
        threwOrder instanceof Error && /maxDelayMs/.test(threwOrder.message),
        describeError(threwOrder),
      );
    }

    // =====================================================================
    // P4.T3 zombie recovery cases. Each case seeds a row directly in
    // `running` state with an explicit `started_at` so we can put it
    // on either side of the timeout cutoff deterministically. The
    // queue is constructed with a small `zombieTimeoutMs` (e.g. 50ms)
    // so the cutoff is observable without long sleeps. As in the
    // P4.T2 cases, each P4.T3 case uses a UNIQUE job_type
    // (`image_zombie_tN`) to avoid colliding with rows from earlier
    // cases — claim is filtered by registered handler types.
    // =====================================================================

    // ---------------------------------------------------------------------
    // CASE 18: zombie with retry budget → recoverZombies → 'retrying'
    // ---------------------------------------------------------------------
    {
      const jobType = "image_zombie_t18";
      const seeded = seedImageMedia(tripService, mediaRepo);
      // started_at = 10s ago, zombieTimeoutMs=50ms → definitely a zombie.
      const startedAt = new Date(Date.now() - 10_000).toISOString();
      const jobId = insertJobAt(dbHandle.db, seeded.mediaId, jobType, {
        status: "running",
        startedAt,
        retryCount: 0,
      });
      const handlers = new Map<string, JobHandler>();
      handlers.set(jobType, async () => {
        /* never invoked — recoverZombies runs before any tick */
      });
      const retryConfig: JobQueueRetryConfig = {
        maxRetries: 3,
        baseDelayMs: 100,
        maxDelayMs: 500,
      };
      const { queue } = makeQueue(jobRepo, [imageChannel(handlers)], retryConfig, 50);
      const result = queue.recoverZombies();
      const row = readJob(dbHandle.db, jobId);
      record(
        "zombie + retry budget: result = scanned 1 / recovered 1 / failed 0",
        result.scanned === 1 && result.recovered === 1 && result.failed === 0,
        JSON.stringify(result),
      );
      record(
        "zombie + retry budget: row → status='retrying' + retry_count=1 + next_run_at set",
        row?.status === "retrying" &&
          row?.retry_count === 1 &&
          typeof row?.next_run_at === "string",
        `status=${String(row?.status)} retry_count=${String(row?.retry_count)} next_run_at=${String(row?.next_run_at)}`,
      );
      record(
        "zombie + retry budget: row.error_message describes zombie",
        typeof row?.error_message === "string" && /zombie/.test(row.error_message as string),
        `err=${String(row?.error_message)}`,
      );
    }

    // ---------------------------------------------------------------------
    // CASE 19: zombie with budget exhausted → recoverZombies → 'failed'
    // ---------------------------------------------------------------------
    {
      const jobType = "image_zombie_t19";
      const seeded = seedImageMedia(tripService, mediaRepo);
      const startedAt = new Date(Date.now() - 10_000).toISOString();
      // retry_count already at max → no more retries.
      const jobId = insertJobAt(dbHandle.db, seeded.mediaId, jobType, {
        status: "running",
        startedAt,
        retryCount: 2,
      });
      const handlers = new Map<string, JobHandler>();
      handlers.set(jobType, async () => {
        /* unused */
      });
      const retryConfig: JobQueueRetryConfig = {
        maxRetries: 2,
        baseDelayMs: 100,
        maxDelayMs: 500,
      };
      const { queue } = makeQueue(jobRepo, [imageChannel(handlers)], retryConfig, 50);
      const result = queue.recoverZombies();
      const row = readJob(dbHandle.db, jobId);
      record(
        "zombie + budget exhausted: result = scanned 1 / recovered 0 / failed 1",
        result.scanned === 1 && result.recovered === 0 && result.failed === 1,
        JSON.stringify(result),
      );
      record(
        "zombie + budget exhausted: row → status='failed' + retry_count unchanged + finished_at set",
        row?.status === "failed" && row?.retry_count === 2 && typeof row?.finished_at === "string",
        `status=${String(row?.status)} retry_count=${String(row?.retry_count)} finished_at=${String(row?.finished_at)}`,
      );
    }

    // ---------------------------------------------------------------------
    // CASE 20: fresh 'running' row (started_at within timeout) → untouched
    // ---------------------------------------------------------------------
    {
      const jobType = "image_zombie_t20";
      const seeded = seedImageMedia(tripService, mediaRepo);
      // started_at just now, zombieTimeoutMs=5_000ms → not a zombie.
      const startedAt = new Date().toISOString();
      const jobId = insertJobAt(dbHandle.db, seeded.mediaId, jobType, {
        status: "running",
        startedAt,
        retryCount: 0,
      });
      const handlers = new Map<string, JobHandler>();
      handlers.set(jobType, async () => {
        /* unused */
      });
      const retryConfig: JobQueueRetryConfig = {
        maxRetries: 3,
        baseDelayMs: 100,
        maxDelayMs: 500,
      };
      const { queue } = makeQueue(jobRepo, [imageChannel(handlers)], retryConfig, 5_000);
      const result = queue.recoverZombies();
      const row = readJob(dbHandle.db, jobId);
      record(
        "fresh running: scanned 0 + row stays 'running' unchanged",
        result.scanned === 0 && row?.status === "running" && row?.started_at === startedAt,
        `result=${JSON.stringify(result)} status=${String(row?.status)} started_at=${String(row?.started_at)}`,
      );
    }

    // ---------------------------------------------------------------------
    // CASE 21: pending + retrying rows untouched by zombie scan
    // ---------------------------------------------------------------------
    {
      const jobTypeP = "image_zombie_t21_pending";
      const jobTypeR = "image_zombie_t21_retrying";
      const seeded = seedImageMedia(tripService, mediaRepo);
      const pendingId = insertJobAt(dbHandle.db, seeded.mediaId, jobTypeP, {
        status: "pending",
      });
      const retryingId = insertJobAt(dbHandle.db, seeded.mediaId, jobTypeR, {
        status: "retrying",
        retryCount: 1,
        nextRunAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const handlers = new Map<string, JobHandler>();
      handlers.set(jobTypeP, async () => {
        /* unused */
      });
      handlers.set(jobTypeR, async () => {
        /* unused */
      });
      const { queue } = makeQueue(
        jobRepo,
        [imageChannel(handlers)],
        { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 500 },
        50,
      );
      const result = queue.recoverZombies();
      const pendingRow = readJob(dbHandle.db, pendingId);
      const retryingRow = readJob(dbHandle.db, retryingId);
      record(
        "non-running rows: zombie scan ignores pending + retrying",
        result.scanned === 0 &&
          pendingRow?.status === "pending" &&
          retryingRow?.status === "retrying",
        `result=${JSON.stringify(result)} pending=${String(pendingRow?.status)} retrying=${String(retryingRow?.status)}`,
      );
    }

    // ---------------------------------------------------------------------
    // CASE 22: zombie with started_at IS NULL → still recovered
    // ---------------------------------------------------------------------
    {
      const jobType = "image_zombie_t22";
      const seeded = seedImageMedia(tripService, mediaRepo);
      const jobId = insertJobAt(dbHandle.db, seeded.mediaId, jobType, {
        status: "running",
        startedAt: null,
        retryCount: 0,
      });
      const handlers = new Map<string, JobHandler>();
      handlers.set(jobType, async () => {
        /* unused */
      });
      const { queue } = makeQueue(
        jobRepo,
        [imageChannel(handlers)],
        { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 500 },
        50,
      );
      const result = queue.recoverZombies();
      const row = readJob(dbHandle.db, jobId);
      record(
        "null started_at: row treated as ancient and recovered",
        result.scanned === 1 && row?.status === "retrying" && row?.retry_count === 1,
        `result=${JSON.stringify(result)} status=${String(row?.status)} retry_count=${String(row?.retry_count)}`,
      );
    }

    // ---------------------------------------------------------------------
    // CASE 23: start() runs recovery automatically before polling
    // ---------------------------------------------------------------------
    {
      const jobType = "image_zombie_t23";
      const seeded = seedImageMedia(tripService, mediaRepo);
      const startedAt = new Date(Date.now() - 10_000).toISOString();
      const jobId = insertJobAt(dbHandle.db, seeded.mediaId, jobType, {
        status: "running",
        startedAt,
        retryCount: 0,
      });
      const handlers = new Map<string, JobHandler>();
      handlers.set(jobType, async () => {
        /* unused — backoff delay (200ms) keeps the retrying row
         * away from claim until after we read it. */
      });
      const { queue } = makeQueue(
        jobRepo,
        [{ name: "image", concurrency: 1, handlers, pollIntervalMs: 60_000 }],
        { maxRetries: 3, baseDelayMs: 200, maxDelayMs: 1_000 },
        50,
      );
      queue.start();
      // start() ran recoverZombies synchronously before scheduling
      // setInterval and the eager first poll. Even with the eager
      // poll, the row is now `retrying` with next_run_at ~200ms out,
      // so claim won't fire it again immediately.
      const row = readJob(dbHandle.db, jobId);
      record(
        "start(): zombie scan auto-runs and routes row to 'retrying'",
        row?.status === "retrying" && row?.retry_count === 1,
        `status=${String(row?.status)} retry_count=${String(row?.retry_count)}`,
      );
      await queue.stop();
    }

    // ---------------------------------------------------------------------
    // CASE 24: zombieTimeoutMs=0 disables the scan entirely
    // ---------------------------------------------------------------------
    {
      const jobType = "image_zombie_t24";
      const seeded = seedImageMedia(tripService, mediaRepo);
      const startedAt = new Date(Date.now() - 10_000).toISOString();
      const jobId = insertJobAt(dbHandle.db, seeded.mediaId, jobType, {
        status: "running",
        startedAt,
        retryCount: 0,
      });
      const handlers = new Map<string, JobHandler>();
      handlers.set(jobType, async () => {
        /* unused */
      });
      const { queue } = makeQueue(
        jobRepo,
        [imageChannel(handlers)],
        { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 500 },
        0,
      );
      record(
        "disabled: getZombieTimeoutMs returns 0",
        queue.getZombieTimeoutMs() === 0,
        `getZombieTimeoutMs=${queue.getZombieTimeoutMs()}`,
      );
      const result = queue.recoverZombies();
      const row = readJob(dbHandle.db, jobId);
      record(
        "disabled: recoverZombies short-circuits, row stays 'running'",
        result.scanned === 0 &&
          result.recovered === 0 &&
          result.failed === 0 &&
          row?.status === "running",
        `result=${JSON.stringify(result)} status=${String(row?.status)}`,
      );
    }

    // ---------------------------------------------------------------------
    // CASE 25: invalid zombieTimeoutMs at construction → throws
    // ---------------------------------------------------------------------
    {
      let threwNeg: unknown;
      try {
        new JobQueue({
          jobRepo,
          logger: createLogger({ nodeEnv: "test" }),
          channels: [{ name: "image", concurrency: 1, handlers: new Map() }],
          zombieTimeoutMs: -1,
        });
      } catch (err) {
        threwNeg = err;
      }
      record(
        "construction with zombieTimeoutMs<0 → throws",
        threwNeg instanceof Error && /zombieTimeoutMs/.test(threwNeg.message),
        describeError(threwNeg),
      );

      let threwNaN: unknown;
      try {
        new JobQueue({
          jobRepo,
          logger: createLogger({ nodeEnv: "test" }),
          channels: [{ name: "image", concurrency: 1, handlers: new Map() }],
          zombieTimeoutMs: Number.NaN,
        });
      } catch (err) {
        threwNaN = err;
      }
      record(
        "construction with zombieTimeoutMs=NaN → throws",
        threwNaN instanceof Error && /zombieTimeoutMs/.test(threwNaN.message),
        describeError(threwNaN),
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
