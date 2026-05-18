// Manual smoke test for the image_hash worker (P5.T2).
//
// Usage: npm run smoke:image-hash
//
// Drives the full handler against a real SQLite DB and a real
// LocalStorageProvider with sharp + crypto computing the hashes.
// Uses ImageChannelExecutor (P3 stub) as a deterministic single-
// concurrency tick harness — same pattern as image-thumbnail-smoke.
//
// Coverage:
//   * Happy path: synthetic JPEG seeded as the original → tick →
//     job 'success'; `media_items.file_hash` is a 64-char lowercase
//     SHA256 hex; `media_items.perceptual_hash` is 32 hex chars
//     (pHash 16 + dHash 16).
//   * SHA256 matches the byte-level hash computed by node:crypto on
//     the same buffer.
//   * Idempotency: a second tick on a freshly re-inserted pending
//     job succeeds with identical hash values (same bytes →
//     deterministic algorithm).
//   * Distinct images produce different SHA256 and different
//     perceptual_hash values (with overwhelming probability).
//   * Failure: media references a non-existent original →
//     job 'failed' with a sensible error_message; media row's hash
//     columns stay NULL (UPDATE never fires).
//   * Failure: video media → job 'failed' (handler refuses to
//     hash non-image bytes).
//   * Failure: empty file → job 'failed'.
//   * Soft-delete race: media soft-deleted between findById and
//     UPDATE → handler still succeeds; hash columns NOT written.
//   * JobQueue registers `image_hash` as a known job_type and claims
//     a pending row of that type on its image channel.
//   * Pure pHash / dHash compute on equivalent images yields equal
//     hashes (deterministic over byte-identical input).
//
// Hash format documented in `imageHashWorker.ts`: pHash and dHash are
// each 16 lowercase hex chars, concatenated into the 32-char
// `perceptual_hash` column. SHA256 fills `file_hash` (64 chars).

import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import {
  computeDHash,
  computePHash,
  IMAGE_HASH_JOB_TYPE,
  ImageChannelExecutor,
  JobHandlerRegistry,
  JobQueue,
  JobRepository,
  makeImageHashHandler,
  type JobHandler,
} from "../jobs/index.js";
import { createLogger } from "../logger.js";
import { MediaRepository } from "../media/index.js";
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
// fixture helpers
// ---------------------------------------------------------------------------

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_32 = /^[0-9a-f]{32}$/;
const HEX_16 = /^[0-9a-f]{16}$/;

async function makeColoredJpeg(
  width: number,
  height: number,
  rgb: { r: number; g: number; b: number },
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: rgb,
    },
  })
    .jpeg({ quality: 85 })
    .toBuffer();
}

interface SeededImage {
  readonly tripId: string;
  readonly mediaId: string;
  readonly originalPath: string;
  readonly jpegBytes: Buffer;
}

async function seedTripAndImage(
  db: SqliteDatabase,
  tripService: TripService,
  storage: LocalStorageProvider,
  jpegBytes: Buffer,
  tripTitle = "Image Hash Smoke Trip",
): Promise<SeededImage> {
  const trip = tripService.createTrip({ title: tripTitle });
  const mediaId = randomUUID();
  const stored = await storage.putOriginal({
    tripId: trip.id,
    mediaId,
    extension: "jpg",
    data: jpegBytes,
  });
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO media_items
       (id, trip_id, type, original_path, mime_type, extension, file_size,
        status, user_decision, created_at, updated_at)
     VALUES (?, ?, 'image', ?, 'image/jpeg', 'jpg', ?,
             'uploaded', 'undecided', ?, ?)`,
  ).run(mediaId, trip.id, stored.logicalPath, jpegBytes.length, now, now);
  return { tripId: trip.id, mediaId, originalPath: stored.logicalPath, jpegBytes };
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

function readMedia(db: SqliteDatabase, mediaId: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM media_items WHERE id = ?`).get(mediaId) as
    | Record<string, unknown>
    | undefined;
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-image-hash-smoke-"));
  const dbPath = path.join(tmpRoot, "smoke.db");
  const storageRoot = path.join(tmpRoot, "storage");
  console.log(`[smoke] tmpRoot=${tmpRoot}`);

  const dbHandle = openDatabase(dbPath);
  try {
    runMigrations(dbHandle.db);

    const storage = LocalStorageProvider.create(storageRoot);
    const logger = createLogger({ nodeEnv: "test" });
    const tripService = new TripService(new TripRepository(dbHandle.db));
    const mediaRepo = new MediaRepository(dbHandle.db);
    const jobRepo = new JobRepository(dbHandle.db);

    const registry = new JobHandlerRegistry();
    registry.register(IMAGE_HASH_JOB_TYPE, makeImageHashHandler({ storage, mediaRepo, logger }));
    const executor = new ImageChannelExecutor({ jobRepo, registry, logger });

    // -----------------------------------------------------------------
    // CASE 1: happy path — hashes land on media_items
    // -----------------------------------------------------------------
    const blueJpeg = await makeColoredJpeg(64, 48, { r: 30, g: 60, b: 200 });
    const seeded = await seedTripAndImage(dbHandle.db, tripService, storage, blueJpeg, "Case1");
    const jobId = insertJob(dbHandle.db, seeded.mediaId, IMAGE_HASH_JOB_TYPE);

    const tick1 = await executor.tick();
    record(
      "happy: tick outcome=success",
      tick1.outcome === "success" && tick1.jobId === jobId,
      JSON.stringify(tick1),
    );
    const job1 = readJob(dbHandle.db, jobId);
    record(
      "happy: job row.status='success'",
      job1?.status === "success",
      `status=${String(job1?.status)} err=${String(job1?.error_message)}`,
    );

    const media1 = readMedia(dbHandle.db, seeded.mediaId);
    const fileHash = media1?.file_hash as string | null;
    const perceptual = media1?.perceptual_hash as string | null;
    record(
      "happy: media_items.file_hash is 64-char lowercase SHA256 hex",
      typeof fileHash === "string" && HEX_64.test(fileHash),
      `file_hash=${String(fileHash)}`,
    );
    record(
      "happy: media_items.perceptual_hash is 32 hex (pHash 16 + dHash 16)",
      typeof perceptual === "string" && HEX_32.test(perceptual),
      `perceptual_hash=${String(perceptual)}`,
    );

    // -----------------------------------------------------------------
    // CASE 2: SHA256 matches node:crypto over the same buffer.
    // -----------------------------------------------------------------
    {
      const expected = createHash("sha256").update(seeded.jpegBytes).digest("hex");
      record(
        "happy: file_hash equals SHA256 of the seeded JPEG buffer",
        fileHash === expected,
        `expected=${expected} got=${String(fileHash)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 3: pHash + dHash halves match the pure helpers on the
    // same bytes (deterministic algorithm sanity check + the half-
    // split documented in imageHashWorker.ts).
    // -----------------------------------------------------------------
    {
      const expectedP = await computePHash(seeded.jpegBytes);
      const expectedD = await computeDHash(seeded.jpegBytes);
      record("pHash helper returns 16 hex chars", HEX_16.test(expectedP), `pHash=${expectedP}`);
      record("dHash helper returns 16 hex chars", HEX_16.test(expectedD), `dHash=${expectedD}`);
      const storedP = (perceptual ?? "").slice(0, 16);
      const storedD = (perceptual ?? "").slice(16, 32);
      record(
        "perceptual_hash first 16 chars == pHash helper output",
        storedP === expectedP,
        `stored=${storedP} expected=${expectedP}`,
      );
      record(
        "perceptual_hash last 16 chars == dHash helper output",
        storedD === expectedD,
        `stored=${storedD} expected=${expectedD}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 4: idempotency — second tick on a re-inserted pending job
    // for the same media writes the same values.
    // -----------------------------------------------------------------
    {
      const reJobId = insertJob(dbHandle.db, seeded.mediaId, IMAGE_HASH_JOB_TYPE);
      const tick2 = await executor.tick();
      const reJob = readJob(dbHandle.db, reJobId);
      record(
        "idempotency: re-tick outcome=success",
        tick2.outcome === "success" && reJob?.status === "success",
        `outcome=${tick2.outcome} status=${String(reJob?.status)}`,
      );
      const media2 = readMedia(dbHandle.db, seeded.mediaId);
      record(
        "idempotency: file_hash unchanged after re-run",
        media2?.file_hash === fileHash,
        `before=${String(fileHash)} after=${String(media2?.file_hash)}`,
      );
      record(
        "idempotency: perceptual_hash unchanged after re-run",
        media2?.perceptual_hash === perceptual,
        `before=${String(perceptual)} after=${String(media2?.perceptual_hash)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 5: distinct images → distinct SHA256 and distinct
    // perceptual_hash values.
    // -----------------------------------------------------------------
    {
      const orangeJpeg = await makeColoredJpeg(64, 48, { r: 220, g: 130, b: 40 });
      const seededB = await seedTripAndImage(
        dbHandle.db,
        tripService,
        storage,
        orangeJpeg,
        "Case5",
      );
      insertJob(dbHandle.db, seededB.mediaId, IMAGE_HASH_JOB_TYPE);
      const tickB = await executor.tick();
      record(
        "distinct image: tick outcome=success",
        tickB.outcome === "success",
        JSON.stringify(tickB),
      );
      const mediaB = readMedia(dbHandle.db, seededB.mediaId);
      record(
        "distinct image: file_hash differs from CASE 1 image",
        typeof mediaB?.file_hash === "string" && mediaB.file_hash !== fileHash,
        `case1=${String(fileHash)} case5=${String(mediaB?.file_hash)}`,
      );
      record(
        "distinct image: perceptual_hash differs from CASE 1 image",
        typeof mediaB?.perceptual_hash === "string" && mediaB.perceptual_hash !== perceptual,
        `case1=${String(perceptual)} case5=${String(mediaB?.perceptual_hash)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 6: failure — non-existent original path.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case6 missing original" });
      const mediaId = randomUUID();
      const now = new Date().toISOString();
      dbHandle.db
        .prepare(
          `INSERT INTO media_items
             (id, trip_id, type, original_path, mime_type, extension, file_size,
              status, user_decision, created_at, updated_at)
           VALUES (?, ?, 'image', ?, 'image/jpeg', 'jpg', 0,
                   'uploaded', 'undecided', ?, ?)`,
        )
        .run(mediaId, trip.id, `trips/${trip.id}/originals/${mediaId}.jpg`, now, now);
      const failJobId = insertJob(dbHandle.db, mediaId, IMAGE_HASH_JOB_TYPE);
      const tickF = await executor.tick();
      const failJob = readJob(dbHandle.db, failJobId);
      record(
        "missing original: tick outcome=failed + error_message present",
        tickF.outcome === "failed" &&
          failJob?.status === "failed" &&
          typeof failJob?.error_message === "string" &&
          (failJob.error_message as string).length > 0,
        `outcome=${tickF.outcome} status=${String(failJob?.status)} err=${String(
          failJob?.error_message,
        )}`,
      );
      const mediaRow = readMedia(dbHandle.db, mediaId);
      record(
        "missing original: media_items.file_hash stays NULL on failure",
        mediaRow?.file_hash === null,
        `file_hash=${String(mediaRow?.file_hash)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 7: failure — non-image media type (refuse to hash video).
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case7 video media" });
      const mediaId = randomUUID();
      const now = new Date().toISOString();
      // Use type='video' so the handler's type guard rejects.
      dbHandle.db
        .prepare(
          `INSERT INTO media_items
             (id, trip_id, type, original_path, mime_type, extension, file_size,
              status, user_decision, created_at, updated_at)
           VALUES (?, ?, 'video', ?, 'video/mp4', 'mp4', 0,
                   'uploaded', 'undecided', ?, ?)`,
        )
        .run(mediaId, trip.id, `trips/${trip.id}/originals/${mediaId}.mp4`, now, now);
      const vidJobId = insertJob(dbHandle.db, mediaId, IMAGE_HASH_JOB_TYPE);
      const tickV = await executor.tick();
      const vidJob = readJob(dbHandle.db, vidJobId);
      record(
        "video media: tick outcome=failed + error mentions 'not an image'",
        tickV.outcome === "failed" &&
          vidJob?.status === "failed" &&
          typeof vidJob?.error_message === "string" &&
          /not an image/i.test(vidJob.error_message as string),
        `outcome=${tickV.outcome} err=${String(vidJob?.error_message)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 8: failure — empty original file.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case8 empty file" });
      const mediaId = randomUUID();
      const stored = await storage.putOriginal({
        tripId: trip.id,
        mediaId,
        extension: "jpg",
        data: Buffer.alloc(0),
      });
      const now = new Date().toISOString();
      dbHandle.db
        .prepare(
          `INSERT INTO media_items
             (id, trip_id, type, original_path, mime_type, extension, file_size,
              status, user_decision, created_at, updated_at)
           VALUES (?, ?, 'image', ?, 'image/jpeg', 'jpg', 0,
                   'uploaded', 'undecided', ?, ?)`,
        )
        .run(mediaId, trip.id, stored.logicalPath, now, now);
      const emptyJobId = insertJob(dbHandle.db, mediaId, IMAGE_HASH_JOB_TYPE);
      const tickE = await executor.tick();
      const emptyJob = readJob(dbHandle.db, emptyJobId);
      record(
        "empty file: tick outcome=failed with explanatory message",
        tickE.outcome === "failed" &&
          emptyJob?.status === "failed" &&
          typeof emptyJob?.error_message === "string" &&
          /empty/i.test(emptyJob.error_message as string),
        `outcome=${tickE.outcome} err=${String(emptyJob?.error_message)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 9: soft-delete mid-job. We don't have a real race; we
    // approximate by calling the handler directly on a row that's
    // already soft-deleted before the worker fires. The handler
    // resolves the row via mediaRepo.findById which excludes soft-
    // deleted rows, so we expect an explicit throw ("media not found
    // or soft-deleted"). That confirms the failure-path
    // discrimination at row resolution.
    // -----------------------------------------------------------------
    {
      const softJpeg = await makeColoredJpeg(48, 48, { r: 10, g: 200, b: 10 });
      const seededC = await seedTripAndImage(
        dbHandle.db,
        tripService,
        storage,
        softJpeg,
        "Case9 soft-delete",
      );
      // Soft-delete BEFORE the job is claimed.
      dbHandle.db
        .prepare(`UPDATE media_items SET deleted_at = ?, status = 'deleted' WHERE id = ?`)
        .run(new Date().toISOString(), seededC.mediaId);
      const sJobId = insertJob(dbHandle.db, seededC.mediaId, IMAGE_HASH_JOB_TYPE);
      const tickS = await executor.tick();
      const sJob = readJob(dbHandle.db, sJobId);
      record(
        "pre-soft-deleted media: tick outcome=failed with explanatory message",
        tickS.outcome === "failed" &&
          sJob?.status === "failed" &&
          typeof sJob?.error_message === "string" &&
          /soft-deleted|not found/i.test(sJob.error_message as string),
        `outcome=${tickS.outcome} err=${String(sJob?.error_message)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 10: JobQueue registers `image_hash` as a known job_type
    // and can claim a pending row of that type via its image channel.
    // (This is the integration with the production scheduler — the
    // earlier cases used the P3 stub.)
    // -----------------------------------------------------------------
    {
      const yellowJpeg = await makeColoredJpeg(48, 48, { r: 240, g: 220, b: 80 });
      const seededD = await seedTripAndImage(
        dbHandle.db,
        tripService,
        storage,
        yellowJpeg,
        "Case10 JobQueue",
      );
      const queueJobId = insertJob(dbHandle.db, seededD.mediaId, IMAGE_HASH_JOB_TYPE);

      const handlers = new Map<string, JobHandler>();
      handlers.set(IMAGE_HASH_JOB_TYPE, makeImageHashHandler({ storage, mediaRepo, logger }));
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
      const tickResult = await queue.tickChannel("image");
      await queue.awaitInflight("image");
      await queue.stop();
      record(
        "JobQueue: image_hash registered + claimed on image channel",
        tickResult.claimed.length === 1 && tickResult.claimed[0]?.jobId === queueJobId,
        `claimed=${JSON.stringify(tickResult.claimed)}`,
      );
      const qJob = readJob(dbHandle.db, queueJobId);
      record(
        "JobQueue: job ended status='success'",
        qJob?.status === "success",
        `status=${String(qJob?.status)} err=${String(qJob?.error_message)}`,
      );
      const qMedia = readMedia(dbHandle.db, seededD.mediaId);
      record(
        "JobQueue: media_items.file_hash + perceptual_hash populated",
        typeof qMedia?.file_hash === "string" &&
          HEX_64.test(qMedia.file_hash as string) &&
          typeof qMedia?.perceptual_hash === "string" &&
          HEX_32.test(qMedia.perceptual_hash as string),
        `file_hash=${String(qMedia?.file_hash)} perceptual_hash=${String(qMedia?.perceptual_hash)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 11: pure helper determinism — identical bytes yield
    // identical hashes across two invocations.
    // -----------------------------------------------------------------
    {
      const buf = await makeColoredJpeg(96, 64, { r: 80, g: 90, b: 100 });
      const p1 = await computePHash(buf);
      const p2 = await computePHash(buf);
      const d1 = await computeDHash(buf);
      const d2 = await computeDHash(buf);
      record(
        "computePHash deterministic over identical input",
        p1 === p2 && HEX_16.test(p1),
        `p1=${p1} p2=${p2}`,
      );
      record(
        "computeDHash deterministic over identical input",
        d1 === d2 && HEX_16.test(d1),
        `d1=${d1} d2=${d2}`,
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
