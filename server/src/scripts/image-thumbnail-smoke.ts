// Manual smoke test for the image_thumbnail worker (P3.T4).
//
// Usage: npm run smoke:image-thumbnail
//
// Drives the full P3.T2 executor + P3.T4 handler stack against a real
// SQLite DB and a real LocalStorageProvider, with sharp doing the
// actual encoding. No HTTP. No supertest. Native fetch / http are not
// involved — the smoke calls `executor.tick()` directly.
//
// Coverage:
//   * Happy path: synthetic JPEG seeded as the original → tick →
//     job 'success', `thumb.webp` and `preview.webp` exist under
//     `derived/{mediaId}/`, both files decode as valid WebP, both
//     `media_versions` rows present, media_items width / height /
//     thumbnail_path / preview_path populated.
//   * Idempotency: a second tick on a freshly re-inserted pending job
//     succeeds, does not duplicate `media_versions` rows, and the
//     same logical paths still serve valid WebP.
//   * Failure: media row referencing a non-existent original →
//     job 'failed' with a sensible error_message; no derived files
//     left on disk.
//
// The smoke does NOT exercise the polling loop (setInterval) — only
// `tick()` is called. The polling loop is already covered by
// smoke:image-channel-executor.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
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
  makeImageThumbnailHandler,
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
 * Build a small synthetic JPEG with sharp so we don't have to ship
 * fixture files. Returns the JPEG bytes + the original width/height.
 */
async function makeTestJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      // Simple gradient-ish colour so the bytes are non-trivial.
      background: { r: 100, g: 150, b: 200 },
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
  const trip = tripService.createTrip({ title: "Thumbnail Smoke Trip" });
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

function readMedia(db: SqliteDatabase, mediaId: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM media_items WHERE id = ?`).get(mediaId) as
    | Record<string, unknown>
    | undefined;
}

function readVersions(db: SqliteDatabase, mediaId: string): Record<string, unknown>[] {
  return db
    .prepare(`SELECT * FROM media_versions WHERE media_id = ? ORDER BY version_type`)
    .all(mediaId) as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-image-thumbnail-smoke-"));
  const dbPath = path.join(tmpRoot, "smoke.db");
  const storageRoot = path.join(tmpRoot, "storage");
  console.log(`[smoke] tmpRoot=${tmpRoot}`);

  const dbHandle = openDatabase(dbPath);
  try {
    const migration = runMigrations(dbHandle.db);
    record(
      "migrations applied (includes 005_create_media_versions)",
      migration.appliedNow.includes("005_create_media_versions.sql"),
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
      "image_thumbnail",
      makeImageThumbnailHandler({ storage, mediaRepo, mediaVersionsRepo, logger }),
    );
    const executor = new ImageChannelExecutor({ jobRepo, registry, logger });

    // ---------------------------------------------------------------------
    // CASE 1: happy path
    // ---------------------------------------------------------------------
    const TEST_WIDTH = 1280;
    const TEST_HEIGHT = 720;
    const jpegBytes = await makeTestJpeg(TEST_WIDTH, TEST_HEIGHT);
    const seeded = await seedTripAndImage(dbHandle.db, tripService, storage, jpegBytes);
    const jobId = insertJob(dbHandle.db, seeded.mediaId, "image_thumbnail");

    const tick = await executor.tick();
    record(
      "happy path: tick outcome=success",
      tick.outcome === "success" && tick.jobId === jobId,
      JSON.stringify(tick),
    );
    record(
      "happy path: job row.status='success'",
      readJob(dbHandle.db, jobId)?.status === "success",
      `status=${String(readJob(dbHandle.db, jobId)?.status)}`,
    );

    // Storage assertions
    const thumbLogical = `trips/${seeded.tripId}/derived/${seeded.mediaId}/thumb.webp`;
    const previewLogical = `trips/${seeded.tripId}/derived/${seeded.mediaId}/preview.webp`;
    const thumbAbsolute = path.join(storage.root, thumbLogical);
    const previewAbsolute = path.join(storage.root, previewLogical);

    record(
      "happy path: thumb.webp file written under derived/",
      existsSync(thumbAbsolute),
      thumbAbsolute,
    );
    record(
      "happy path: preview.webp file written under derived/",
      existsSync(previewAbsolute),
      previewAbsolute,
    );

    // Verify the bytes really are WebP via sharp metadata
    const thumbMeta = await sharp(thumbAbsolute).metadata();
    record(
      "happy path: thumb.webp is a valid webp + longest edge <= 320",
      thumbMeta.format === "webp" &&
        Math.max(thumbMeta.width ?? 0, thumbMeta.height ?? 0) <= 320 &&
        Math.max(thumbMeta.width ?? 0, thumbMeta.height ?? 0) > 0,
      `format=${thumbMeta.format} dims=${thumbMeta.width}x${thumbMeta.height}`,
    );

    const previewMeta = await sharp(previewAbsolute).metadata();
    record(
      "happy path: preview.webp is a valid webp + longest edge <= 1600",
      previewMeta.format === "webp" &&
        Math.max(previewMeta.width ?? 0, previewMeta.height ?? 0) <= 1600 &&
        Math.max(previewMeta.width ?? 0, previewMeta.height ?? 0) > 0,
      `format=${previewMeta.format} dims=${previewMeta.width}x${previewMeta.height}`,
    );

    // Verify the path matches what /storage/:logicalPath would serve.
    // The storage route reads via storage.read(logicalPath) — replicate
    // the resolution here without booting an HTTP server.
    const thumbViaProvider = await storage.read(thumbLogical);
    let thumbBytes = 0;
    for await (const chunk of thumbViaProvider) {
      thumbBytes += (chunk as Buffer).length;
    }
    record(
      "happy path: thumb.webp is readable via /storage/<thumbnail_path>",
      thumbBytes > 0,
      `bytes=${thumbBytes}`,
    );

    // media_items assertions
    const mediaAfter = readMedia(dbHandle.db, seeded.mediaId);
    record(
      "happy path: media_items.width / height updated to source dims",
      mediaAfter?.width === TEST_WIDTH && mediaAfter?.height === TEST_HEIGHT,
      `width=${String(mediaAfter?.width)} height=${String(mediaAfter?.height)}`,
    );
    record(
      "happy path: media_items.thumbnail_path / preview_path set",
      mediaAfter?.thumbnail_path === thumbLogical && mediaAfter?.preview_path === previewLogical,
      `thumbnail_path=${String(mediaAfter?.thumbnail_path)} preview_path=${String(
        mediaAfter?.preview_path,
      )}`,
    );

    // media_versions assertions
    const versions = readVersions(dbHandle.db, seeded.mediaId);
    record(
      "happy path: media_versions has exactly 2 rows (preview + thumbnail)",
      versions.length === 2 &&
        versions.some((v) => v.version_type === "thumbnail") &&
        versions.some((v) => v.version_type === "preview"),
      `count=${versions.length} types=${versions.map((v) => v.version_type).join(",")}`,
    );

    const thumbVersion = versions.find((v) => v.version_type === "thumbnail");
    record(
      "happy path: thumbnail media_versions row carries mime/width/height/size/path",
      thumbVersion?.mime_type === "image/webp" &&
        typeof thumbVersion?.width === "number" &&
        typeof thumbVersion?.height === "number" &&
        typeof thumbVersion?.file_size === "number" &&
        thumbVersion?.file_path === thumbLogical &&
        thumbVersion?.status === "ready",
      `mime=${String(thumbVersion?.mime_type)} dims=${String(thumbVersion?.width)}x${String(
        thumbVersion?.height,
      )} size=${String(thumbVersion?.file_size)}`,
    );

    // ---------------------------------------------------------------------
    // CASE 2: idempotency
    // ---------------------------------------------------------------------
    const jobId2 = insertJob(dbHandle.db, seeded.mediaId, "image_thumbnail");
    const tick2 = await executor.tick();
    record(
      "idempotency: second tick still success",
      tick2.outcome === "success" && tick2.jobId === jobId2,
      JSON.stringify(tick2),
    );
    const versions2 = readVersions(dbHandle.db, seeded.mediaId);
    record(
      "idempotency: media_versions still has exactly 2 rows (upsert, no duplicates)",
      versions2.length === 2,
      `count=${versions2.length}`,
    );
    // Confirm the row ids stayed (upsert preserved the original ids).
    const thumbId1 = thumbVersion?.id;
    const thumbId2 = versions2.find((v) => v.version_type === "thumbnail")?.id;
    record(
      "idempotency: thumbnail row id unchanged across upserts",
      thumbId1 !== undefined && thumbId1 === thumbId2,
      `before=${String(thumbId1)} after=${String(thumbId2)}`,
    );
    record(
      "idempotency: derived files still readable",
      existsSync(thumbAbsolute) && existsSync(previewAbsolute),
      `thumb=${existsSync(thumbAbsolute)} preview=${existsSync(previewAbsolute)}`,
    );

    // ---------------------------------------------------------------------
    // CASE 3: failure — original_path points at a non-existent file
    // ---------------------------------------------------------------------
    {
      // Insert a media row whose original_path is a logical path but
      // no file lives there.
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
          seeded.tripId,
          `trips/${seeded.tripId}/originals/${orphanMediaId}.jpg`,
          now,
          now,
        );
      const orphanJobId = insertJob(dbHandle.db, orphanMediaId, "image_thumbnail");
      const tick3 = await executor.tick();
      record(
        "failure: missing original → tick outcome=failed",
        tick3.outcome === "failed" && tick3.jobId === orphanJobId,
        JSON.stringify(tick3),
      );
      const failedJob = readJob(dbHandle.db, orphanJobId);
      record(
        "failure: job row.status='failed' with error_message present",
        failedJob?.status === "failed" &&
          typeof failedJob?.error_message === "string" &&
          (failedJob.error_message as string).length > 0,
        `status=${String(failedJob?.status)} error=${String(failedJob?.error_message)}`,
      );
      const orphanThumbAbsolute = path.join(
        storage.root,
        `trips/${seeded.tripId}/derived/${orphanMediaId}/thumb.webp`,
      );
      record(
        "failure: no derived thumb.webp written for the failed job",
        !existsSync(orphanThumbAbsolute),
        orphanThumbAbsolute,
      );
      const orphanMediaAfter = readMedia(dbHandle.db, orphanMediaId);
      record(
        "failure: orphan media row's width / paths remain NULL",
        orphanMediaAfter?.width === null &&
          orphanMediaAfter?.height === null &&
          orphanMediaAfter?.thumbnail_path === null &&
          orphanMediaAfter?.preview_path === null,
        `width=${String(orphanMediaAfter?.width)} thumb=${String(
          orphanMediaAfter?.thumbnail_path,
        )}`,
      );
      const orphanVersions = readVersions(dbHandle.db, orphanMediaId);
      record(
        "failure: orphan media has no media_versions rows",
        orphanVersions.length === 0,
        `count=${orphanVersions.length}`,
      );
    }

    // ---------------------------------------------------------------------
    // CASE 4: executor still alive after a failure
    // ---------------------------------------------------------------------
    {
      const tempJpeg = await makeTestJpeg(800, 600);
      const recovery = await seedTripAndImage(dbHandle.db, tripService, storage, tempJpeg);
      insertJob(dbHandle.db, recovery.mediaId, "image_thumbnail");
      const tick4 = await executor.tick();
      record(
        "recovery: executor still works after a previous failure",
        tick4.outcome === "success",
        `outcome=${tick4.outcome}`,
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
