// Manual smoke test for the image-channel job executor (P3.T2).
//
// Usage: npm run smoke:image-channel-executor
//
// Drives every state-machine and concurrency branch of the executor
// against a real SQLite database (temp file, migrations applied,
// then disposed). No HTTP server is booted — the smoke calls
// `executor.tick()` directly so timing is deterministic.
//
// Coverage:
//   * Empty DB → tick is idle.
//   * Success path: pending → running → success, with finished_at /
//     started_at / error_message correct.
//   * Failed path: handler throws → status='failed', error_message
//     contains the thrown message.
//   * No handler registered → status='failed', error_message names
//     the job type.
//   * Channel filter: a pending video_metadata job is NOT claimed.
//   * Single concurrency: a slow handler in-flight makes a second
//     concurrent tick return "skipped-inflight" without touching DB.
//   * Recovery: a tick after a thrown handler still works.
//   * Graceful shutdown: stop() awaits in-flight handler; ticks
//     after stop() return "stopped".

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import {
  ImageChannelExecutor,
  JobHandlerRegistry,
  JobRepository,
  type JobHandler,
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

function seedTripAndMedia(
  db: SqliteDatabase,
  tripService: TripService,
  mediaRepo: MediaRepository,
): { tripId: string; mediaId: string } {
  const trip = tripService.createTrip({ title: "Executor Smoke Trip" });
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
  // Touch db just to keep the typecheck for `SqliteDatabase` parameter
  // used; lint complains otherwise. Sanity: the row landed.
  const row = db.prepare(`SELECT id FROM media_items WHERE id = ?`).get(mediaId) as
    | { id: string }
    | undefined;
  if (row?.id !== mediaId) throw new Error("media row not inserted");
  return { tripId: trip.id, mediaId };
}

function insertJob(
  db: SqliteDatabase,
  mediaId: string,
  jobType: string,
  status: "pending" | "running" = "pending",
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO processing_jobs (id, media_id, job_type, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, mediaId, jobType, status, now, now);
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

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-executor-smoke-"));
  const dbPath = path.join(tmpRoot, "smoke.db");
  console.log(`[smoke] dbPath=${dbPath}`);

  const dbHandle = openDatabase(dbPath);
  try {
    const migration = runMigrations(dbHandle.db);
    record(
      "migrations applied",
      migration.appliedNow.includes("004_create_processing_jobs.sql"),
      `appliedNow=${JSON.stringify(migration.appliedNow)}`,
    );

    // nodeEnv:"test" defaults to "warn" — quiet enough for the smoke.
    // The executor logs at .info (handler ran) / .warn (no handler) /
    // .error (DB crash) — only the latter two surface here.
    const logger = createLogger({ nodeEnv: "test" });
    const tripService = new TripService(new TripRepository(dbHandle.db));
    const mediaRepo = new MediaRepository(dbHandle.db);
    const jobRepo = new JobRepository(dbHandle.db);

    const { mediaId } = seedTripAndMedia(dbHandle.db, tripService, mediaRepo);

    // ---------------------------------------------------------------------
    // CASE 1: empty DB → tick idle
    // ---------------------------------------------------------------------
    {
      const registry = new JobHandlerRegistry();
      const exec = new ImageChannelExecutor({ jobRepo, registry, logger });
      const result = await exec.tick();
      record(
        "idle DB → tick outcome=idle",
        result.outcome === "idle" && result.jobId === undefined,
        JSON.stringify(result),
      );
    }

    // ---------------------------------------------------------------------
    // CASE 2: success path
    // ---------------------------------------------------------------------
    {
      const registry = new JobHandlerRegistry();
      let ran = false;
      registry.register("image_thumbnail", async () => {
        ran = true;
      });
      const exec = new ImageChannelExecutor({ jobRepo, registry, logger });
      const jobId = insertJob(dbHandle.db, mediaId, "image_thumbnail");

      const result = await exec.tick();
      const row = readJob(dbHandle.db, jobId);

      record(
        "success path: tick outcome=success",
        result.outcome === "success" && result.jobId === jobId,
        JSON.stringify(result),
      );
      record("success path: handler actually ran", ran, `ran=${ran}`);
      record(
        "success path: row.status='success'",
        row?.status === "success",
        `status=${String(row?.status)}`,
      );
      record(
        "success path: started_at set",
        typeof row?.started_at === "string" && (row.started_at as string).length > 0,
        `started_at=${String(row?.started_at)}`,
      );
      record(
        "success path: finished_at set",
        typeof row?.finished_at === "string" && (row.finished_at as string).length > 0,
        `finished_at=${String(row?.finished_at)}`,
      );
      record(
        "success path: error_message NULL",
        row?.error_message === null,
        `error_message=${String(row?.error_message)}`,
      );
    }

    // ---------------------------------------------------------------------
    // CASE 3: failed path (handler throws)
    // ---------------------------------------------------------------------
    {
      const registry = new JobHandlerRegistry();
      registry.register("image_thumbnail", async () => {
        throw new Error("simulated thumbnail failure");
      });
      const exec = new ImageChannelExecutor({ jobRepo, registry, logger });
      const jobId = insertJob(dbHandle.db, mediaId, "image_thumbnail");

      const result = await exec.tick();
      const row = readJob(dbHandle.db, jobId);

      record(
        "failed path: tick outcome=failed",
        result.outcome === "failed" && result.jobId === jobId,
        JSON.stringify(result),
      );
      record(
        "failed path: row.status='failed'",
        row?.status === "failed",
        `status=${String(row?.status)}`,
      );
      record(
        "failed path: error_message contains thrown message",
        typeof row?.error_message === "string" &&
          /simulated thumbnail failure/.test(row.error_message as string),
        `error_message=${String(row?.error_message)}`,
      );
      record(
        "failed path: finished_at set",
        typeof row?.finished_at === "string" && (row.finished_at as string).length > 0,
        `finished_at=${String(row?.finished_at)}`,
      );
    }

    // ---------------------------------------------------------------------
    // CASE 4: no handler registered for the job type
    // ---------------------------------------------------------------------
    {
      const registry = new JobHandlerRegistry();
      // Intentionally empty.
      const exec = new ImageChannelExecutor({ jobRepo, registry, logger });
      const jobId = insertJob(dbHandle.db, mediaId, "image_brand_new_unknown");

      const result = await exec.tick();
      const row = readJob(dbHandle.db, jobId);

      record(
        "no-handler: tick outcome=no-handler",
        result.outcome === "no-handler" && result.jobId === jobId,
        JSON.stringify(result),
      );
      record(
        "no-handler: row.status='failed'",
        row?.status === "failed",
        `status=${String(row?.status)}`,
      );
      record(
        "no-handler: error_message names the job_type",
        typeof row?.error_message === "string" &&
          /image_brand_new_unknown/.test(row.error_message as string) &&
          /handler/i.test(row.error_message as string),
        `error_message=${String(row?.error_message)}`,
      );
    }

    // ---------------------------------------------------------------------
    // CASE 5: channel filter — non-image jobs are NOT claimed
    // ---------------------------------------------------------------------
    {
      const registry = new JobHandlerRegistry();
      // Register `video_metadata` so we can prove the executor isn't
      // even looking it up — the registry would respond but the SQL
      // claim filter rejects the row first.
      registry.register("video_metadata", async () => {
        throw new Error("should never run");
      });
      const exec = new ImageChannelExecutor({ jobRepo, registry, logger });
      const videoJobId = insertJob(dbHandle.db, mediaId, "video_metadata");

      const result = await exec.tick();
      const row = readJob(dbHandle.db, videoJobId);

      record(
        "channel filter: video_metadata not claimed → tick idle",
        result.outcome === "idle",
        JSON.stringify(result),
      );
      record(
        "channel filter: video_metadata row still pending",
        row?.status === "pending" && row?.started_at === null,
        `status=${String(row?.status)} started_at=${String(row?.started_at)}`,
      );
    }

    // ---------------------------------------------------------------------
    // CASE 6: single concurrency — second concurrent tick is skipped
    // ---------------------------------------------------------------------
    {
      const registry = new JobHandlerRegistry();
      let inHandler = false;
      let overlapDetected = false;
      const slow: JobHandler = async () => {
        if (inHandler) {
          overlapDetected = true;
        }
        inHandler = true;
        await sleep(80);
        inHandler = false;
      };
      registry.register("image_thumbnail", slow);

      const exec = new ImageChannelExecutor({ jobRepo, registry, logger });
      const jobAId = insertJob(dbHandle.db, mediaId, "image_thumbnail");
      const jobBId = insertJob(dbHandle.db, mediaId, "image_thumbnail");

      const [resultA, resultB] = await Promise.all([exec.tick(), exec.tick()]);
      const rowA = readJob(dbHandle.db, jobAId);
      const rowB = readJob(dbHandle.db, jobBId);

      // Only one tick claimed a job — the other should bail with
      // "skipped-inflight" without touching DB.
      const oneSucceeded =
        (resultA.outcome === "success" && resultB.outcome === "skipped-inflight") ||
        (resultB.outcome === "success" && resultA.outcome === "skipped-inflight");
      record(
        "single concurrency: parallel ticks → one success + one skipped-inflight",
        oneSucceeded,
        `A=${resultA.outcome} B=${resultB.outcome}`,
      );
      record(
        "single concurrency: handlers never overlapped",
        !overlapDetected,
        `overlapDetected=${overlapDetected}`,
      );
      record(
        "single concurrency: the skipped job is still pending",
        (rowA?.status === "success" && rowB?.status === "pending") ||
          (rowB?.status === "success" && rowA?.status === "pending"),
        `A=${String(rowA?.status)} B=${String(rowB?.status)}`,
      );

      // Drain the leftover pending job so it doesn't pollute case 7.
      const drain = await exec.tick();
      record(
        "single concurrency: leftover job drains on next tick",
        drain.outcome === "success",
        `drain=${drain.outcome}`,
      );
    }

    // ---------------------------------------------------------------------
    // CASE 7: recovery — executor survives a thrown handler
    // ---------------------------------------------------------------------
    {
      const registry = new JobHandlerRegistry();
      let calls = 0;
      registry.register("image_thumbnail", async () => {
        calls += 1;
        if (calls === 1) throw new Error("first call fails");
        // second+ calls succeed
      });
      const exec = new ImageChannelExecutor({ jobRepo, registry, logger });
      insertJob(dbHandle.db, mediaId, "image_thumbnail");
      insertJob(dbHandle.db, mediaId, "image_thumbnail");

      const r1 = await exec.tick();
      const r2 = await exec.tick();

      record(
        "recovery: first tick failed, second tick succeeded (executor still alive)",
        r1.outcome === "failed" && r2.outcome === "success",
        `r1=${r1.outcome} r2=${r2.outcome}`,
      );
    }

    // ---------------------------------------------------------------------
    // CASE 8: graceful shutdown
    // ---------------------------------------------------------------------
    {
      const registry = new JobHandlerRegistry();
      let started = false;
      let finished = false;
      registry.register("image_thumbnail", async () => {
        started = true;
        await sleep(60);
        finished = true;
      });

      // Drive tick() manually. We DON'T call start() because its
      // immediate-tick behaviour would race the explicit tick below.
      // The graceful-shutdown contract (await in-flight, refuse new
      // ticks after stop()) is identical whether or not the polling
      // loop is active — initial state "idle" permits tick().
      const exec = new ImageChannelExecutor({
        jobRepo,
        registry,
        logger,
        pollIntervalMs: 60_000,
      });
      const jobId = insertJob(dbHandle.db, mediaId, "image_thumbnail");

      const tickPromise = exec.tick();
      // Wait long enough for handler to actually start. Spin until
      // `started` flips or we time out.
      for (let i = 0; i < 50 && !started; i += 1) {
        await sleep(5);
      }
      record("graceful shutdown: handler entered before stop", started, `started=${started}`);

      // Now request stop while the handler is still sleeping.
      const stopPromise = exec.stop();

      // After stop initiated, a fresh tick must refuse.
      const blockedTick = await exec.tick();
      record(
        "graceful shutdown: tick after stop() returns outcome=stopped",
        blockedTick.outcome === "stopped",
        `outcome=${blockedTick.outcome}`,
      );

      // The in-flight handler should complete and tick should resolve
      // with success (not aborted).
      const inflightResult = await tickPromise;
      record(
        "graceful shutdown: in-flight tick still resolves cleanly",
        inflightResult.outcome === "success" && finished,
        `outcome=${inflightResult.outcome} finished=${finished}`,
      );

      // stop() promise resolves after the handler.
      await stopPromise;
      const row = readJob(dbHandle.db, jobId);
      record(
        "graceful shutdown: job row landed status='success'",
        row?.status === "success",
        `status=${String(row?.status)}`,
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
