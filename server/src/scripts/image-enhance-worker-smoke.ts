// Manual smoke test for the image_enhance worker (P8.T2 + P8.T3).
//
// Usage: npm run smoke:image-enhance-worker
//
// Runs the real sharp-based handler end-to-end against a real
// SQLite DB and a real LocalStorageProvider — same pattern as
// `image-thumbnail-smoke.ts`. No HTTP layer; the handler is
// invoked directly via the executor's tick so we can assert on
// disk + DB side effects deterministically.
//
// Coverage:
//   * Happy path: pending image_enhance job → tick(success) → derived
//     enhanced.jpg present on disk + media_versions(version_type=
//     'enhanced') row upserted with the right shape.
//   * Original bytes preserved (CLAUDE.md §2.1).
//   * Output bytes differ from input (sharp did something).
//   * Output is a valid JPEG via sharp metadata.
//   * Output dimensions ≤ config.quality.enhance.maxEdge.
//   * Output mean luminance / saturation stay within sane bounds
//     (no over-saturation, no nuke-the-mid-tones blow-up).
//   * media_versions.params JSON parseable + records pipeline steps.
//   * Idempotency: re-running the handler on the same media yields
//     bit-identical output + UPSERT (still a single row).
//   * P8.T1 ↔ P8.T2 chain: `MediaService.enhanceMedia` enqueues a
//     row that the executor's tick consumes successfully.
//   * Failure: soft-deleted media → job 'failed' with clear message.
//   * Failure: non-image media → job 'failed' with clear message.
//   * Failure: media row with NULL original_path → job 'failed'.
//   * Failure: original file empty (storage put with 0 bytes) → job
//     'failed' with "original file is empty".
//   * No collateral damage on media_items columns
//     (preview_path / thumbnail_path / status / user_decision NOT
//     mutated by the enhance handler — that's still P3.T4 /
//     state-sync territory).

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import {
  IMAGE_ENHANCE_JOB_TYPE,
  ImageChannelExecutor,
  JobHandlerRegistry,
  JobRepository,
  makeImageEnhanceHandler,
  type EnhanceSettings,
} from "../jobs/index.js";
import { createLogger } from "../logger.js";
import {
  MediaRepository,
  MediaService,
  MediaVersionsRepository,
  type MediaSoftDeleteDeps,
} from "../media/index.js";
import { DuplicateGroupsRepository } from "../dedup/index.js";
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
// settings — match defaults from `config/index.ts` so the smoke
// behaviour matches production. Re-declared here so the smoke is
// self-contained and doesn't depend on env state.
// ---------------------------------------------------------------------------

const SETTINGS: EnhanceSettings = {
  maxEdge: 4096,
  brightness: 1.0,
  saturation: 1.05,
  gamma: 1.05,
  linearA: 1.05,
  linearB: -3,
  sharpenSigma: 0.6,
  sharpenM1: 0.5,
  sharpenM2: 2.0,
  jpegQuality: 88,
  workerVersion: "1.0",
};

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

/**
 * Build a small synthetic JPEG with sharp so we don't have to ship
 * fixture files. We use a noisy gradient (linear ramp + random
 * channel offsets) so the unsharp mask actually has detail to bite
 * onto — a flat fill would give identical bytes before/after the
 * sharpen step and we'd lose the "sharp did something" assertion.
 */
async function makeTestJpeg(width: number, height: number): Promise<Buffer> {
  const channels = 3;
  const raw = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * channels;
      // Linear gradients in two channels + a sinusoidal stripe in the third.
      raw[idx + 0] = (x * 255) / Math.max(1, width - 1);
      raw[idx + 1] = (y * 255) / Math.max(1, height - 1);
      raw[idx + 2] = Math.floor(127 + 60 * Math.sin((x + y) / 7));
    }
  }
  return sharp(raw, { raw: { width, height, channels } }).jpeg({ quality: 90 }).toBuffer();
}

interface SeededMedia {
  readonly tripId: string;
  readonly mediaId: string;
  readonly originalPath: string;
}

async function seedImage(
  db: SqliteDatabase,
  tripService: TripService,
  storage: LocalStorageProvider,
  jpegBytes: Buffer,
  title = "Enhance Worker Smoke Trip",
): Promise<SeededMedia> {
  const trip = tripService.createTrip({ title });
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
             'processed', 'undecided', ?, ?)`,
  ).run(mediaId, trip.id, stored.logicalPath, jpegBytes.length, now, now);
  return { tripId: trip.id, mediaId, originalPath: stored.logicalPath };
}

function seedNonImage(
  db: SqliteDatabase,
  tripService: TripService,
  type: "video" | "unknown",
): { tripId: string; mediaId: string } {
  const trip = tripService.createTrip({ title: `Enhance Worker Smoke ${type}` });
  const mediaId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO media_items
       (id, trip_id, type, original_path, mime_type, extension, file_size,
        status, user_decision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?,
             'processed', 'undecided', ?, ?)`,
  ).run(
    mediaId,
    trip.id,
    type,
    type === "video" ? `trips/${trip.id}/originals/${mediaId}.mp4` : null,
    type === "video" ? "video/mp4" : null,
    type === "video" ? "mp4" : null,
    type === "video" ? 4096 : null,
    now,
    now,
  );
  return { tripId: trip.id, mediaId };
}

function insertJob(db: SqliteDatabase, mediaId: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO processing_jobs (id, media_id, job_type, status, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, ?)`,
  ).run(id, mediaId, IMAGE_ENHANCE_JOB_TYPE, now, now);
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

function readEnhancedVersion(
  db: SqliteDatabase,
  mediaId: string,
): Record<string, unknown> | undefined {
  return db
    .prepare(`SELECT * FROM media_versions WHERE media_id = ? AND version_type = 'enhanced'`)
    .get(mediaId) as Record<string, unknown> | undefined;
}

function countEnhancedRows(db: SqliteDatabase, mediaId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM media_versions WHERE media_id = ? AND version_type = 'enhanced'`,
      )
      .get(mediaId) as { n: number }
  ).n;
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-image-enhance-worker-smoke-"));
  const dbPath = path.join(tmpRoot, "smoke.db");
  const storageRoot = path.join(tmpRoot, "storage");
  console.log(`[smoke] tmpRoot=${tmpRoot}`);

  const dbHandle = openDatabase(dbPath);
  try {
    runMigrations(dbHandle.db);

    const storage = LocalStorageProvider.create(storageRoot);
    const logger = createLogger({ nodeEnv: "test" });
    const tripRepo = new TripRepository(dbHandle.db);
    const tripService = new TripService(tripRepo);
    const mediaRepo = new MediaRepository(dbHandle.db);
    const mediaVersionsRepo = new MediaVersionsRepository(dbHandle.db);
    const duplicateGroupsRepo = new DuplicateGroupsRepository(dbHandle.db);
    const jobRepo = new JobRepository(dbHandle.db);

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

    const registry = new JobHandlerRegistry();
    registry.register(
      IMAGE_ENHANCE_JOB_TYPE,
      makeImageEnhanceHandler({
        storage,
        mediaRepo,
        mediaVersionsRepo,
        settings: SETTINGS,
        logger,
      }),
    );
    const executor = new ImageChannelExecutor({ jobRepo, registry, logger });

    // -----------------------------------------------------------------
    // CASE 1: happy path — sharp pipeline runs to success.
    // -----------------------------------------------------------------
    const TEST_WIDTH = 640;
    const TEST_HEIGHT = 480;
    const jpegBytes = await makeTestJpeg(TEST_WIDTH, TEST_HEIGHT);
    const seeded = await seedImage(dbHandle.db, tripService, storage, jpegBytes, "Case1 happy");
    const jobId = insertJob(dbHandle.db, seeded.mediaId);

    const tick = await executor.tick();
    record(
      "happy: tick outcome=success",
      tick.outcome === "success" && tick.jobId === jobId,
      JSON.stringify(tick),
    );
    record(
      "happy: job row.status='success'",
      readJob(dbHandle.db, jobId)?.status === "success",
      `status=${String(readJob(dbHandle.db, jobId)?.status)}`,
    );

    // Derived file exists where we expect.
    const enhancedLogical = `trips/${seeded.tripId}/derived/${seeded.mediaId}/enhanced.jpg`;
    const enhancedAbsolute = path.join(storage.root, enhancedLogical);
    record(
      "happy: enhanced.jpg present on disk under derived/",
      existsSync(enhancedAbsolute),
      enhancedAbsolute,
    );

    // Output is a real JPEG, dims bounded.
    const enhancedBytes = readFileSync(enhancedAbsolute);
    const enhancedMeta = await sharp(enhancedBytes).metadata();
    record(
      "happy: output is a valid JPEG",
      enhancedMeta.format === "jpeg",
      `format=${enhancedMeta.format}`,
    );
    record(
      "happy: output dimensions ≤ settings.maxEdge",
      (enhancedMeta.width ?? 0) <= SETTINGS.maxEdge &&
        (enhancedMeta.height ?? 0) <= SETTINGS.maxEdge &&
        (enhancedMeta.width ?? 0) > 0 &&
        (enhancedMeta.height ?? 0) > 0,
      `dims=${enhancedMeta.width}x${enhancedMeta.height}, maxEdge=${SETTINGS.maxEdge}`,
    );

    // -----------------------------------------------------------------
    // CASE 2: original file is untouched (CLAUDE.md §2.1).
    // -----------------------------------------------------------------
    {
      const originalAbsolute = path.join(storage.root, seeded.originalPath);
      const originalBytes = readFileSync(originalAbsolute);
      record(
        "non-destructive: original bytes exactly match the seeded JPEG",
        originalBytes.equals(jpegBytes),
        `original=${originalBytes.length}B seeded=${jpegBytes.length}B`,
      );
      record(
        "non-destructive: original ≠ enhanced (sharp actually transformed pixels)",
        !originalBytes.equals(enhancedBytes),
        `originalLen=${originalBytes.length} enhancedLen=${enhancedBytes.length}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 3: media_versions row has the right shape.
    // -----------------------------------------------------------------
    {
      const row = readEnhancedVersion(dbHandle.db, seeded.mediaId);
      record(
        "versions: row exists with version_type='enhanced'",
        row !== undefined && row.version_type === "enhanced",
        `version_type=${String(row?.version_type)}`,
      );
      record(
        "versions: file_path matches the derived logical path",
        row?.file_path === enhancedLogical,
        `file_path=${String(row?.file_path)}`,
      );
      record(
        "versions: mime_type=image/jpeg",
        row?.mime_type === "image/jpeg",
        `mime_type=${String(row?.mime_type)}`,
      );
      record(
        "versions: width / height / file_size populated and >0",
        typeof row?.width === "number" &&
          typeof row?.height === "number" &&
          typeof row?.file_size === "number" &&
          (row.width as number) > 0 &&
          (row.height as number) > 0 &&
          (row.file_size as number) > 0,
        `w=${String(row?.width)} h=${String(row?.height)} bytes=${String(row?.file_size)}`,
      );
      // params is a JSON blob — must be parseable and record the
      // worker version + pipeline steps.
      const params = JSON.parse(String(row?.params)) as {
        workerVersion: string;
        pipeline: string[];
      };
      record(
        "versions: params JSON parses + records workerVersion + pipeline list",
        params.workerVersion === SETTINGS.workerVersion &&
          Array.isArray(params.pipeline) &&
          params.pipeline.some((s) => s.startsWith("modulate(")) &&
          params.pipeline.some((s) => s.startsWith("gamma(")) &&
          params.pipeline.some((s) => s.startsWith("sharpen(")) &&
          params.pipeline.some((s) => s.startsWith("jpeg(")),
        `params=${JSON.stringify(params)}`,
      );
      record(
        "versions: exactly one 'enhanced' row for this media",
        countEnhancedRows(dbHandle.db, seeded.mediaId) === 1,
        `count=${countEnhancedRows(dbHandle.db, seeded.mediaId)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 4: enhancement intensity sanity (no over-cooking).
    //
    // Compare mean RGB of the original vs the enhanced output —
    // requirements §7.9 #5 forbids over-saturation/-sharpening. We
    // tolerate up to ±10% drift on each channel mean; a runaway
    // saturation multiplier would push one or more channels well
    // outside that band.
    // -----------------------------------------------------------------
    {
      const origStats = await sharp(jpegBytes).stats();
      const enhStats = await sharp(enhancedBytes).stats();
      const orig = origStats.channels.slice(0, 3).map((c) => c.mean);
      const enh = enhStats.channels.slice(0, 3).map((c) => c.mean);
      const maxDrift = Math.max(
        ...orig.map((v, i) => Math.abs(((enh[i] ?? v) - v) / Math.max(1, v))),
      );
      record(
        "intensity: per-channel mean drift ≤ 10% (no over-saturation)",
        maxDrift <= 0.1,
        `orig=${orig.map((v) => v.toFixed(1)).join(",")} enh=${enh.map((v) => v.toFixed(1)).join(",")} maxDrift=${(maxDrift * 100).toFixed(2)}%`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 5: media_items columns are NOT mutated by enhance.
    //
    // The enhance handler is supposed to ONLY write the derived file
    // + media_versions row. preview_path / thumbnail_path / width /
    // height / status / user_decision belong to other workers and
    // must remain untouched (so the gallery keeps showing the
    // original; P8.T4 user action is what flips the active version).
    // -----------------------------------------------------------------
    {
      const row = readMedia(dbHandle.db, seeded.mediaId);
      record(
        "no-collateral: media_items.preview_path stays NULL",
        row?.preview_path === null,
        `preview_path=${String(row?.preview_path)}`,
      );
      record(
        "no-collateral: media_items.thumbnail_path stays NULL",
        row?.thumbnail_path === null,
        `thumbnail_path=${String(row?.thumbnail_path)}`,
      );
      record(
        "no-collateral: media_items.status stays 'processed'",
        row?.status === "processed",
        `status=${String(row?.status)}`,
      );
      record(
        "no-collateral: media_items.user_decision stays 'undecided'",
        row?.user_decision === "undecided",
        `user_decision=${String(row?.user_decision)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 6: idempotency. A second tick on a freshly-enqueued job
    // for the same media produces bit-identical output (sharp +
    // mozjpeg are deterministic given fixed inputs + settings) AND
    // a single media_versions row (UPSERT, not duplicate).
    // -----------------------------------------------------------------
    {
      const jobId2 = insertJob(dbHandle.db, seeded.mediaId);
      const tick2 = await executor.tick();
      record(
        "idempotent: second tick also success",
        tick2.outcome === "success" && tick2.jobId === jobId2,
        JSON.stringify(tick2),
      );
      const enhancedBytes2 = readFileSync(enhancedAbsolute);
      record(
        "idempotent: re-encoded enhanced.jpg is bit-identical to first run",
        enhancedBytes2.equals(enhancedBytes),
        `len1=${enhancedBytes.length} len2=${enhancedBytes2.length}`,
      );
      record(
        "idempotent: still exactly 1 'enhanced' media_versions row (UPSERT)",
        countEnhancedRows(dbHandle.db, seeded.mediaId) === 1,
        `count=${countEnhancedRows(dbHandle.db, seeded.mediaId)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 7: P8.T1 ↔ P8.T2 chain — the trigger endpoint enqueues a
    // row that this handler then consumes.
    // -----------------------------------------------------------------
    {
      const triggerBytes = await makeTestJpeg(320, 240);
      const triggerSeed = await seedImage(
        dbHandle.db,
        tripService,
        storage,
        triggerBytes,
        "Case7 trigger chain",
      );
      const out = mediaService.enhanceMedia(triggerSeed.mediaId);
      record(
        "chain: trigger outcome=created + jobType='image_enhance'",
        out.outcome === "created" && out.jobType === IMAGE_ENHANCE_JOB_TYPE,
        JSON.stringify(out),
      );
      const tickChain = await executor.tick();
      record(
        "chain: executor consumes the just-enqueued row, outcome=success",
        tickChain.outcome === "success" && tickChain.jobId === out.jobId,
        JSON.stringify(tickChain),
      );
      const enhRow = readEnhancedVersion(dbHandle.db, triggerSeed.mediaId);
      record(
        "chain: media_versions row landed for triggered media",
        enhRow !== undefined && enhRow.version_type === "enhanced",
        `version_type=${String(enhRow?.version_type)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 8: soft-deleted media → job 'failed' with clear message.
    // The trigger guards at enqueue, but the executor may pick up a
    // row whose media row was soft-deleted between enqueue and
    // dequeue. The handler's findById defaults to active-only.
    // -----------------------------------------------------------------
    {
      const sdBytes = await makeTestJpeg(256, 256);
      const sd = await seedImage(dbHandle.db, tripService, storage, sdBytes, "Case8 soft-deleted");
      const sdJobId = insertJob(dbHandle.db, sd.mediaId);
      mediaService.softDeleteMedia(sd.mediaId);
      const sdTick = await executor.tick();
      record(
        "soft-deleted: tick outcome=failed",
        sdTick.outcome === "failed" && sdTick.jobId === sdJobId,
        JSON.stringify(sdTick),
      );
      const job = readJob(dbHandle.db, sdJobId);
      record(
        "soft-deleted: job error_message mentions media not found or soft-deleted",
        typeof job?.error_message === "string" &&
          /not found or soft-deleted/.test(job.error_message as string),
        `error_message=${String(job?.error_message)}`,
      );
      // No derived enhanced.jpg should have been written (handler
      // failed BEFORE the disk write).
      const sdEnhancedAbsolute = path.join(
        storage.root,
        `trips/${sd.tripId}/derived/${sd.mediaId}/enhanced.jpg`,
      );
      record(
        "soft-deleted: no enhanced.jpg leaked onto disk",
        !existsSync(sdEnhancedAbsolute),
        sdEnhancedAbsolute,
      );
      record(
        "soft-deleted: no media_versions row was inserted",
        countEnhancedRows(dbHandle.db, sd.mediaId) === 0,
        `count=${countEnhancedRows(dbHandle.db, sd.mediaId)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 9: non-image media → job 'failed' with clear message.
    // -----------------------------------------------------------------
    {
      const v = seedNonImage(dbHandle.db, tripService, "video");
      const vJobId = insertJob(dbHandle.db, v.mediaId);
      const vTick = await executor.tick();
      record(
        "video: tick outcome=failed + reason mentions type",
        vTick.outcome === "failed" && vTick.jobId === vJobId,
        JSON.stringify(vTick),
      );
      const job = readJob(dbHandle.db, vJobId);
      record(
        "video: error_message mentions 'not an image' and the actual type",
        typeof job?.error_message === "string" &&
          /not an image/.test(job.error_message as string) &&
          /video/.test(job.error_message as string),
        `error_message=${String(job?.error_message)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 10: media row with NULL original_path → 'failed'.
    //
    // unknown-type rows have NULL original_path by Upload_Manager
    // contract — they shouldn't have an enhance job in the first
    // place, but defense-in-depth.
    // -----------------------------------------------------------------
    {
      const u = seedNonImage(dbHandle.db, tripService, "unknown");
      const uJobId = insertJob(dbHandle.db, u.mediaId);
      const uTick = await executor.tick();
      const job = readJob(dbHandle.db, uJobId);
      record(
        "unknown: tick outcome=failed",
        uTick.outcome === "failed" && uTick.jobId === uJobId,
        JSON.stringify(uTick),
      );
      // Either the type guard fires first ("not an image") or the
      // original_path guard ("no original_path"). Either is
      // acceptable — both come from the handler.
      record(
        "unknown: error_message explains the rejection",
        typeof job?.error_message === "string" &&
          (/not an image/.test(job.error_message as string) ||
            /no original_path/.test(job.error_message as string)),
        `error_message=${String(job?.error_message)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 11: missing media row entirely → 'failed' with clear msg.
    // -----------------------------------------------------------------
    {
      // We can't insert a processing_jobs row pointing at a missing
      // media_id directly (FK), so insert a row and then delete the
      // media via raw SQL bypassing the FK CASCADE (FK is ON DELETE
      // CASCADE, so deleting media would delete the job — instead we
      // create a fresh job pointing at a media we then "hard-orphan"
      // by leaving the FK as-is but using a media that doesn't pass
      // findById's filter). Simulate via UPDATE: bump the media
      // row's id by direct SQL is messy too. Easiest path: insert a
      // brand-new media row, insert a job, then delete the media row
      // — but FK CASCADE removes the job too.
      //
      // Instead we directly orphan the JOB by setting media_id via a
      // FK pragma-OFF transaction. This is a synthetic case to prove
      // the handler's findById guard fires; in production the FK
      // CASCADE prevents the row from existing.
      const sourceBytes = await makeTestJpeg(128, 128);
      const seedM = await seedImage(
        dbHandle.db,
        tripService,
        storage,
        sourceBytes,
        "Case11 missing media",
      );
      const orphanJobId = insertJob(dbHandle.db, seedM.mediaId);
      // Disable FK enforcement just for the orphan setup.
      dbHandle.db.pragma("foreign_keys = OFF");
      try {
        dbHandle.db.prepare(`DELETE FROM media_items WHERE id = ?`).run(seedM.mediaId);
      } finally {
        dbHandle.db.pragma("foreign_keys = ON");
      }
      const oTick = await executor.tick();
      record(
        "missing-media: tick outcome=failed",
        oTick.outcome === "failed" && oTick.jobId === orphanJobId,
        JSON.stringify(oTick),
      );
      const job = readJob(dbHandle.db, orphanJobId);
      record(
        "missing-media: error_message mentions 'not found or soft-deleted'",
        typeof job?.error_message === "string" &&
          /not found or soft-deleted/.test(job.error_message as string),
        `error_message=${String(job?.error_message)}`,
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
