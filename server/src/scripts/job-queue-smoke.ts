// Manual smoke test for the JobQueue (P4.T1).
//
// Usage: npm run smoke:job-queue
//
// Drives the multi-channel scheduler against a real SQLite DB. Each
// case constructs a fresh `JobQueue` with deterministic handlers
// (no sharp / no exifr) so the smoke isolates the scheduler from
// the worker bodies. The "real" handler logic is already covered by
// smoke:image-thumbnail / smoke:image-metadata.
//
// Coverage:
//   * Empty queue → tick claims nothing
//   * Single pending image_thumbnail → tick → success
//   * Concurrency=2 with 3 pending → first tick claims 2, both run
//     in parallel, after await both success; second tick claims 1
//   * Handler error → job marked 'failed', error_message present,
//     queue keeps draining the rest
//   * Video channel with no handlers — pending video_metadata
//     row stays untouched even with an `image_thumbnail` claim active
//   * Channel saturation: tickChannel returns saturatedBefore=true
//     when full
//   * start / stop lifecycle: start auto-drains pending jobs;
//     stop awaits the in-flight handler
//   * stop is idempotent; tick after stop returns no claims
//   * Unknown channel name → throws
//   * Invalid concurrency in config → throws at construction

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

function makeQueue(jobRepo: JobRepository, channels: JobQueueChannelConfig[]): QueueRig {
  const logger = createLogger({ nodeEnv: "test" });
  return { queue: new JobQueue({ jobRepo, logger, channels }) };
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
    // CASE 4: handler throws → job 'failed' + queue keeps draining
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
