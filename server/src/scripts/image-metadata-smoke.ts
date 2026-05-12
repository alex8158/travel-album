// Manual smoke test for the image_metadata worker (P3.T5).
//
// Usage: npm run smoke:image-metadata
//
// Drives the full P3.T2 executor + P3.T5 handler stack:
//   * Happy path with EXIF: synthesise a JPEG carrying real EXIF tags
//     via sharp.withExif, run the handler, verify a media_versions
//     row with version_type='metadata' lands and the JSON payload
//     contains the seeded tags.
//   * Happy path without EXIF: a stripped JPEG should still succeed,
//     persist `{}` as params, and not crash the executor.
//   * Idempotency: re-running keeps the same row id (UPSERT, not
//     INSERT-duplicate).
//   * Failure: missing original → job 'failed'.
//   * Recovery: executor stays alive after the failure.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import {
  ImageChannelExecutor,
  JobHandlerRegistry,
  JobRepository,
  makeImageMetadataHandler,
} from "../jobs/index.js";
import { createLogger } from "../logger.js";
import { MediaRepository, MediaVersionsRepository } from "../media/index.js";
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

/**
 * Build a JPEG with seeded EXIF tags via sharp.withExif.
 */
async function makeJpegWithExif(): Promise<Buffer> {
  // sharp's `withExif` declares only the IFD0..IFD3 groups in its TS
  // types; we put the camera-identity tags there. ISO / FNumber /
  // ExposureTime would normally live in ExifIFD (a sub-IFD that
  // sharp's typings don't expose) — they're skipped so the smoke
  // stays within typed API surface. IFD0 tags are enough to prove
  // the worker reads + persists EXIF.
  return sharp({
    create: {
      width: 800,
      height: 600,
      channels: 3,
      background: { r: 200, g: 100, b: 100 },
    },
  })
    .withExif({
      IFD0: {
        Make: "TestCam",
        Model: "TestModel-001",
        Software: "travel-album-smoke",
      },
    })
    .jpeg({ quality: 85 })
    .toBuffer();
}

/** Build a JPEG with no EXIF (sharp default doesn't add any). */
async function makeJpegWithoutExif(): Promise<Buffer> {
  return sharp({
    create: {
      width: 400,
      height: 300,
      channels: 3,
      background: { r: 50, g: 200, b: 50 },
    },
  })
    .jpeg({ quality: 85 })
    .toBuffer();
}

interface SeededMedia {
  readonly tripId: string;
  readonly mediaId: string;
  readonly originalPath: string;
}

async function seedTripAndImage(
  db: SqliteDatabase,
  tripService: TripService,
  storage: LocalStorageProvider,
  jpegBytes: Buffer,
): Promise<SeededMedia> {
  const trip = tripService.createTrip({ title: "Metadata Smoke Trip" });
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
  return { tripId: trip.id, mediaId, originalPath: stored.logicalPath };
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

function readMetadataVersion(
  db: SqliteDatabase,
  mediaId: string,
): Record<string, unknown> | undefined {
  return db
    .prepare(`SELECT * FROM media_versions WHERE media_id = ? AND version_type = 'metadata'`)
    .get(mediaId) as Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-image-metadata-smoke-"));
  const dbPath = path.join(tmpRoot, "smoke.db");
  const storageRoot = path.join(tmpRoot, "storage");
  console.log(`[smoke] tmpRoot=${tmpRoot}`);

  const dbHandle = openDatabase(dbPath);
  try {
    const migration = runMigrations(dbHandle.db);
    record(
      "migrations applied (includes 006_extend_media_versions_version_type)",
      migration.appliedNow.includes("006_extend_media_versions_version_type.sql"),
      `appliedNow=${JSON.stringify(migration.appliedNow)}`,
    );

    const storage = LocalStorageProvider.create(storageRoot);
    const logger = createLogger({ nodeEnv: "test" });
    const tripService = new TripService(new TripRepository(dbHandle.db));
    const mediaRepo = new MediaRepository(dbHandle.db);
    const mediaVersionsRepo = new MediaVersionsRepository(dbHandle.db);
    const jobRepo = new JobRepository(dbHandle.db);

    const registry = new JobHandlerRegistry();
    registry.register(
      "image_metadata",
      makeImageMetadataHandler({ storage, mediaRepo, mediaVersionsRepo, logger }),
    );
    const executor = new ImageChannelExecutor({ jobRepo, registry, logger });

    // ---------------------------------------------------------------------
    // CASE 1: happy path with EXIF
    // ---------------------------------------------------------------------
    const jpegWith = await makeJpegWithExif();
    const seededWith = await seedTripAndImage(dbHandle.db, tripService, storage, jpegWith);
    const jobId1 = insertJob(dbHandle.db, seededWith.mediaId, "image_metadata");

    const tick1 = await executor.tick();
    record(
      "EXIF path: tick outcome=success",
      tick1.outcome === "success" && tick1.jobId === jobId1,
      JSON.stringify(tick1),
    );
    record(
      "EXIF path: job row.status='success'",
      readJob(dbHandle.db, jobId1)?.status === "success",
      `status=${String(readJob(dbHandle.db, jobId1)?.status)}`,
    );

    const rowWith = readMetadataVersion(dbHandle.db, seededWith.mediaId);
    record(
      "EXIF path: media_versions row exists with version_type='metadata'",
      rowWith?.version_type === "metadata",
      `version_type=${String(rowWith?.version_type)}`,
    );
    record(
      "EXIF path: file_path points at the original",
      rowWith?.file_path === seededWith.originalPath,
      `file_path=${String(rowWith?.file_path)}`,
    );
    record(
      "EXIF path: mime_type='application/json'",
      rowWith?.mime_type === "application/json",
      `mime_type=${String(rowWith?.mime_type)}`,
    );
    record(
      "EXIF path: width/height set from sharp's display dims",
      rowWith?.width === 800 && rowWith?.height === 600,
      `width=${String(rowWith?.width)} height=${String(rowWith?.height)}`,
    );
    record(
      "EXIF path: file_size NULL (no separate JSON file written)",
      rowWith?.file_size === null,
      `file_size=${String(rowWith?.file_size)}`,
    );
    record(
      "EXIF path: status='ready'",
      rowWith?.status === "ready",
      `status=${String(rowWith?.status)}`,
    );

    // Parse and inspect params JSON
    const paramsJson = String(rowWith?.params ?? "");
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(paramsJson) as Record<string, unknown>;
    } catch (err) {
      record(
        "EXIF path: params is valid JSON",
        false,
        `parse error=${describeError(err)} raw=${paramsJson.slice(0, 120)}`,
      );
    }
    record(
      "EXIF path: params is a non-empty JSON object",
      Object.keys(parsed).length > 0,
      `fields=${Object.keys(parsed).join(",")}`,
    );
    // exifr flattens IFD0 / ExifIFD into a single object. Look for
    // any of the tags we seeded.
    const seededValues = JSON.stringify(parsed).toLowerCase();
    record(
      "EXIF path: params contains seeded camera Make 'TestCam'",
      seededValues.includes("testcam"),
      `len=${seededValues.length}`,
    );
    record(
      "EXIF path: params contains seeded camera Model 'TestModel-001'",
      seededValues.includes("testmodel-001"),
      `len=${seededValues.length}`,
    );

    // ---------------------------------------------------------------------
    // CASE 2: image without EXIF still succeeds, params is '{}'
    // ---------------------------------------------------------------------
    const jpegWithout = await makeJpegWithoutExif();
    const seededWithout = await seedTripAndImage(dbHandle.db, tripService, storage, jpegWithout);
    const jobId2 = insertJob(dbHandle.db, seededWithout.mediaId, "image_metadata");
    const tick2 = await executor.tick();
    record(
      "no-EXIF path: tick outcome=success",
      tick2.outcome === "success" && tick2.jobId === jobId2,
      JSON.stringify(tick2),
    );
    const rowWithout = readMetadataVersion(dbHandle.db, seededWithout.mediaId);
    record(
      "no-EXIF path: row exists with version_type='metadata'",
      rowWithout?.version_type === "metadata",
      `version_type=${String(rowWithout?.version_type)}`,
    );
    let parsedWithout: Record<string, unknown> = {};
    try {
      parsedWithout = JSON.parse(String(rowWithout?.params ?? "")) as Record<string, unknown>;
    } catch {
      /* parsedWithout stays empty */
    }
    record(
      "no-EXIF path: params is JSON '{}' (empty object, not null)",
      rowWithout?.params === "{}" && Object.keys(parsedWithout).length === 0,
      `params=${String(rowWithout?.params)}`,
    );
    record(
      "no-EXIF path: width/height still populated from sharp",
      rowWithout?.width === 400 && rowWithout?.height === 300,
      `dims=${String(rowWithout?.width)}x${String(rowWithout?.height)}`,
    );

    // ---------------------------------------------------------------------
    // CASE 3: idempotency — second tick UPSERTs the same row
    // ---------------------------------------------------------------------
    const rowBeforeId = String(rowWith?.id);
    const jobId3 = insertJob(dbHandle.db, seededWith.mediaId, "image_metadata");
    const tick3 = await executor.tick();
    record(
      "idempotency: second tick still success",
      tick3.outcome === "success" && tick3.jobId === jobId3,
      JSON.stringify(tick3),
    );
    const rowAfter = readMetadataVersion(dbHandle.db, seededWith.mediaId);
    record(
      "idempotency: metadata row id unchanged across UPSERT",
      typeof rowAfter?.id === "string" && rowAfter.id === rowBeforeId,
      `before=${rowBeforeId} after=${String(rowAfter?.id)}`,
    );
    const totalCount = (
      dbHandle.db
        .prepare(
          `SELECT COUNT(*) AS n FROM media_versions WHERE media_id = ? AND version_type='metadata'`,
        )
        .get(seededWith.mediaId) as { n: number }
    ).n;
    record(
      "idempotency: still exactly one 'metadata' row per media",
      totalCount === 1,
      `count=${totalCount}`,
    );

    // ---------------------------------------------------------------------
    // CASE 4: failure — original file missing
    // ---------------------------------------------------------------------
    {
      const orphanMediaId = randomUUID();
      const now = new Date().toISOString();
      dbHandle.db
        .prepare(
          `INSERT INTO media_items
             (id, trip_id, type, original_path, mime_type, extension, file_size,
              status, user_decision, created_at, updated_at)
           VALUES (?, ?, 'image', ?, 'image/jpeg', 'jpg', 1024,
                   'uploaded', 'undecided', ?, ?)`,
        )
        .run(
          orphanMediaId,
          seededWith.tripId,
          `trips/${seededWith.tripId}/originals/${orphanMediaId}.jpg`,
          now,
          now,
        );
      const orphanJobId = insertJob(dbHandle.db, orphanMediaId, "image_metadata");
      const tick4 = await executor.tick();
      record(
        "failure: missing original → tick outcome=failed",
        tick4.outcome === "failed" && tick4.jobId === orphanJobId,
        JSON.stringify(tick4),
      );
      const failedJob = readJob(dbHandle.db, orphanJobId);
      record(
        "failure: job row.status='failed' with error_message present",
        failedJob?.status === "failed" &&
          typeof failedJob?.error_message === "string" &&
          (failedJob.error_message as string).length > 0,
        `status=${String(failedJob?.status)} error=${String(failedJob?.error_message)}`,
      );
      const orphanRow = readMetadataVersion(dbHandle.db, orphanMediaId);
      record(
        "failure: no metadata row written for failed media",
        orphanRow === undefined,
        `row=${JSON.stringify(orphanRow)}`,
      );
    }

    // ---------------------------------------------------------------------
    // CASE 5: recovery — executor still works after a failure
    // ---------------------------------------------------------------------
    {
      const jpegC = await makeJpegWithoutExif();
      const recovery = await seedTripAndImage(dbHandle.db, tripService, storage, jpegC);
      insertJob(dbHandle.db, recovery.mediaId, "image_metadata");
      const tick5 = await executor.tick();
      record(
        "recovery: executor still works after a failure",
        tick5.outcome === "success",
        `outcome=${tick5.outcome}`,
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
