// Manual smoke test for the image_quality_blur worker (P6.T2).
//
// Usage: npm run smoke:image-quality-blur
//
// Drives the full handler against a real SQLite DB and a real
// LocalStorageProvider with sharp computing the Laplacian variance.
// Uses ImageChannelExecutor as a deterministic single-concurrency tick
// harness — same pattern as image-hash-smoke / image-thumbnail-smoke.
//
// Coverage:
//   * Pure helpers: `classifyBlur` returns the right 3-class decision
//     across the {< blurry, between, ≥ maybe} ranges; `normaliseSharpness`
//     respects the half-point at the maybeThreshold and the [0, 1]
//     clamp at 2 × maybeThreshold; `computeLaplacianStats` is
//     deterministic on identical bytes and produces distinct numbers
//     for distinct images.
//   * Happy path — clear image: sharp checkerboard noise → variance
//     well above maybeThreshold → `is_blurry = 0`, `labels = ["sharp"]`,
//     `sharpness_score` near the [0, 1] ceiling. `media_analysis` row
//     gets all blur columns + `raw_result.$blur.algorithm` populated.
//   * Happy path — blurry image: the same content put through a
//     strong sharp blur → variance well below blurryThreshold →
//     `is_blurry = 1`, `labels = ["blurry"]`, `sharpness_score` near 0.
//   * Borderline path: mild blur — assert the worker decides one of
//     the three classes coherently (no contradictions between
//     `is_blurry` / `label`), without pinning a specific class.
//   * Idempotency: a second handler tick on a freshly re-inserted
//     pending job writes the same blur_score / is_blurry; row counts
//     stay at 1 per media (the UNIQUE(media_id) invariant holds).
//   * raw_result is a valid JSON string with `$.blur.algorithm` and
//     `$.blur.laplacianVariance` populated.
//   * Failure: video media → job 'failed' (handler refuses non-image
//     bytes).
//   * Failure: soft-deleted media → job 'failed'.
//   * Failure: non-existent original path → job 'failed'.
//   * Failure: empty original file → job 'failed'.
//   * No P5 regression: duplicate_groups + duplicate_group_items
//     counts are unchanged across all the above scenarios.
//   * JobQueue registration: `image_quality_blur` job claimed via the
//     production scheduler on its image channel.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import {
  IMAGE_QUALITY_BLUR_JOB_TYPE,
  ImageChannelExecutor,
  JobHandlerRegistry,
  JobQueue,
  JobRepository,
  classifyBlur,
  computeLaplacianStats,
  makeImageQualityBlurHandler,
  normaliseSharpness,
  type BlurAnalysisSettings,
  type JobHandler,
} from "../jobs/index.js";
import { createLogger } from "../logger.js";
import { MediaAnalysisRepository, MediaRepository } from "../media/index.js";
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
 * Build a high-frequency RGB checkerboard with fine alternating
 * tiles. Produces a Laplacian variance well above the default
 * "maybe" threshold (120) — the canonical "sharp" test image.
 */
async function makeSharpCheckerboard(width: number, height: number, tile: number): Promise<Buffer> {
  const channels = 3;
  const pixels = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const cell = (Math.floor(x / tile) + Math.floor(y / tile)) % 2;
      const c = cell === 0 ? 12 : 240;
      const idx = (y * width + x) * channels;
      pixels[idx] = c;
      pixels[idx + 1] = c;
      pixels[idx + 2] = c;
    }
  }
  return sharp(pixels, { raw: { width, height, channels } }).jpeg({ quality: 95 }).toBuffer();
}

/**
 * Take a sharp checkerboard and run sharp's gaussian blur at a high
 * sigma. The result has flat tiles → very low Laplacian variance,
 * landing it well under the blurryThreshold (default 50).
 */
async function makeStronglyBlurredJpeg(
  width: number,
  height: number,
  tile: number,
  sigma: number,
): Promise<Buffer> {
  const baseRaw = await sharpRawChecker(width, height, tile);
  return sharp(baseRaw, { raw: { width, height, channels: 3 } })
    .blur(sigma)
    .jpeg({ quality: 95 })
    .toBuffer();
}

async function sharpRawChecker(width: number, height: number, tile: number): Promise<Buffer> {
  const channels = 3;
  const pixels = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const cell = (Math.floor(x / tile) + Math.floor(y / tile)) % 2;
      const c = cell === 0 ? 12 : 240;
      const idx = (y * width + x) * channels;
      pixels[idx] = c;
      pixels[idx + 1] = c;
      pixels[idx + 2] = c;
    }
  }
  return pixels;
}

interface SeededImage {
  readonly tripId: string;
  readonly mediaId: string;
  readonly originalPath: string;
  readonly bytes: Buffer;
}

async function seedTripAndImage(
  db: SqliteDatabase,
  tripService: TripService,
  storage: LocalStorageProvider,
  bytes: Buffer,
  tripTitle: string,
): Promise<SeededImage> {
  const trip = tripService.createTrip({ title: tripTitle });
  const mediaId = randomUUID();
  const stored = await storage.putOriginal({
    tripId: trip.id,
    mediaId,
    extension: "jpg",
    data: bytes,
  });
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO media_items
       (id, trip_id, type, original_path, mime_type, extension, file_size,
        status, user_decision, created_at, updated_at)
     VALUES (?, ?, 'image', ?, 'image/jpeg', 'jpg', ?,
             'uploaded', 'undecided', ?, ?)`,
  ).run(mediaId, trip.id, stored.logicalPath, bytes.length, now, now);
  return { tripId: trip.id, mediaId, originalPath: stored.logicalPath, bytes };
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

function countAnalysisRows(db: SqliteDatabase, mediaId?: string): number {
  if (mediaId === undefined) {
    return (db.prepare(`SELECT COUNT(*) AS n FROM media_analysis`).get() as { n: number }).n;
  }
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM media_analysis WHERE media_id = ?`).get(mediaId) as {
      n: number;
    }
  ).n;
}

function countDuplicateGroupRows(db: SqliteDatabase): { groups: number; items: number } {
  const g = db.prepare(`SELECT COUNT(*) AS n FROM duplicate_groups`).get() as { n: number };
  const i = db.prepare(`SELECT COUNT(*) AS n FROM duplicate_group_items`).get() as { n: number };
  return { groups: g.n, items: i.n };
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-image-quality-blur-smoke-"));
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
    const mediaAnalysisRepo = new MediaAnalysisRepository(dbHandle.db);
    const jobRepo = new JobRepository(dbHandle.db);

    const settings: BlurAnalysisSettings = {
      blurThresholdBlurry: 50,
      blurThresholdMaybe: 120,
      maxEdge: 256,
      workerVersion: "smoke-1.0",
    };

    const registry = new JobHandlerRegistry();
    registry.register(
      IMAGE_QUALITY_BLUR_JOB_TYPE,
      makeImageQualityBlurHandler({ storage, mediaRepo, mediaAnalysisRepo, settings, logger }),
    );
    const executor = new ImageChannelExecutor({ jobRepo, registry, logger });

    // -----------------------------------------------------------------
    // CASE A: pure helpers — classifyBlur 3-class decisions
    // -----------------------------------------------------------------
    {
      const blurry = classifyBlur(10, { blurry: 50, maybe: 120 });
      record(
        "classifyBlur(10): is_blurry=1 + label='blurry'",
        blurry.isBlurry === 1 && blurry.label === "blurry",
        JSON.stringify(blurry),
      );
      const sharp = classifyBlur(300, { blurry: 50, maybe: 120 });
      record(
        "classifyBlur(300): is_blurry=0 + label='sharp'",
        sharp.isBlurry === 0 && sharp.label === "sharp",
        JSON.stringify(sharp),
      );
      const maybe = classifyBlur(80, { blurry: 50, maybe: 120 });
      record(
        "classifyBlur(80): is_blurry=null + label='maybe-blurry'",
        maybe.isBlurry === null && maybe.label === "maybe-blurry",
        JSON.stringify(maybe),
      );
      // Boundary: at exactly the maybe threshold the row is sharp.
      const atMaybe = classifyBlur(120, { blurry: 50, maybe: 120 });
      record(
        "classifyBlur(120) boundary: is_blurry=0 (>= maybe)",
        atMaybe.isBlurry === 0,
        JSON.stringify(atMaybe),
      );
      // Boundary: at exactly the blurry threshold the row is borderline.
      const atBlurry = classifyBlur(50, { blurry: 50, maybe: 120 });
      record(
        "classifyBlur(50) boundary: is_blurry=null (in middle)",
        atBlurry.isBlurry === null,
        JSON.stringify(atBlurry),
      );
    }

    // -----------------------------------------------------------------
    // CASE B: pure helper — normaliseSharpness curve
    // -----------------------------------------------------------------
    {
      const zero = normaliseSharpness(0, 120);
      record("normaliseSharpness(0)=0", zero === 0, `value=${zero}`);
      const half = normaliseSharpness(120, 120);
      record("normaliseSharpness(maybe)=0.5", Math.abs(half - 0.5) < 1e-9, `value=${half}`);
      const ceiling = normaliseSharpness(240, 120);
      record("normaliseSharpness(2×maybe)=1 (clamp)", ceiling === 1, `value=${ceiling}`);
      const overshoot = normaliseSharpness(10_000, 120);
      record("normaliseSharpness(10000) stays clamped at 1", overshoot === 1, `value=${overshoot}`);
      const negative = normaliseSharpness(-3, 120);
      record("normaliseSharpness(negative)=0", negative === 0, `value=${negative}`);
    }

    // -----------------------------------------------------------------
    // CASE C: computeLaplacianStats deterministic + distinct on
    // distinct images.
    // -----------------------------------------------------------------
    {
      const sharpA = await makeSharpCheckerboard(96, 96, 4);
      const sharpB = await makeSharpCheckerboard(96, 96, 4);
      const blurry = await makeStronglyBlurredJpeg(96, 96, 4, 6);
      const sa1 = await computeLaplacianStats(sharpA, 96);
      const sa2 = await computeLaplacianStats(sharpA, 96);
      const sb = await computeLaplacianStats(sharpB, 96);
      const bl = await computeLaplacianStats(blurry, 96);
      record(
        "computeLaplacianStats deterministic on identical bytes",
        Math.abs(sa1.variance - sa2.variance) < 1e-6,
        `v1=${sa1.variance} v2=${sa2.variance}`,
      );
      record(
        "computeLaplacianStats identical content → identical variance",
        Math.abs(sa1.variance - sb.variance) < 1e-6,
        `va=${sa1.variance} vb=${sb.variance}`,
      );
      record(
        "computeLaplacianStats: sharp variance >> blurry variance",
        sa1.variance > settings.blurThresholdMaybe && bl.variance < settings.blurThresholdBlurry,
        `sharp=${sa1.variance} blurry=${bl.variance}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 1: happy path — clear image (sharp checkerboard).
    // -----------------------------------------------------------------
    const sharpJpeg = await makeSharpCheckerboard(96, 96, 4);
    const seededClear = await seedTripAndImage(
      dbHandle.db,
      tripService,
      storage,
      sharpJpeg,
      "Case1 sharp",
    );
    const jobId1 = insertJob(dbHandle.db, seededClear.mediaId, IMAGE_QUALITY_BLUR_JOB_TYPE);
    const tick1 = await executor.tick();
    record(
      "clear: tick outcome=success",
      tick1.outcome === "success" && tick1.jobId === jobId1,
      JSON.stringify(tick1),
    );
    const job1 = readJob(dbHandle.db, jobId1);
    record(
      "clear: job row.status='success'",
      job1?.status === "success",
      `status=${String(job1?.status)} err=${String(job1?.error_message)}`,
    );
    const analysis1 = mediaAnalysisRepo.findByMediaId(seededClear.mediaId);
    record(
      "clear: media_analysis row exists with blur_score + sharpness_score",
      analysis1 !== null &&
        typeof analysis1.blurScore === "number" &&
        typeof analysis1.sharpnessScore === "number",
      JSON.stringify(analysis1),
    );
    record(
      "clear: is_blurry=0",
      analysis1?.isBlurry === 0,
      `is_blurry=${String(analysis1?.isBlurry)}`,
    );
    record(
      "clear: labels=['sharp']",
      analysis1?.labels === JSON.stringify(["sharp"]),
      `labels=${String(analysis1?.labels)}`,
    );
    record(
      "clear: sharpness_score in [0, 1] band, > 0.5",
      typeof analysis1?.sharpnessScore === "number" &&
        analysis1.sharpnessScore > 0.5 &&
        analysis1.sharpnessScore <= 1,
      `sharpness=${String(analysis1?.sharpnessScore)}`,
    );
    record(
      "clear: reason text starts with 'sharp ('",
      typeof analysis1?.reason === "string" && analysis1.reason.startsWith("sharp ("),
      `reason=${String(analysis1?.reason)}`,
    );

    // raw_result is valid JSON and exposes $.blur with the algorithm
    // identifier the worker stamps in.
    record(
      "clear: raw_result is non-null string",
      typeof analysis1?.rawResult === "string" && (analysis1.rawResult?.length ?? 0) > 0,
      `len=${String(analysis1?.rawResult?.length)}`,
    );
    let raw1: Record<string, unknown> | null = null;
    try {
      raw1 = JSON.parse(analysis1?.rawResult ?? "null") as Record<string, unknown>;
    } catch (err) {
      raw1 = null;
      console.log("  parse error:", describeError(err));
    }
    const blurNode = (raw1?.blur ?? null) as Record<string, unknown> | null;
    record(
      "clear: raw_result.$.blur.algorithm='laplacian-variance'",
      blurNode?.algorithm === "laplacian-variance",
      JSON.stringify(blurNode?.algorithm),
    );
    record(
      "clear: raw_result.$.blur.laplacianVariance matches blur_score (rounded)",
      typeof blurNode?.laplacianVariance === "number" &&
        typeof analysis1?.blurScore === "number" &&
        Math.abs((blurNode.laplacianVariance as number) - analysis1.blurScore) < 1e-3,
      `raw=${String(blurNode?.laplacianVariance)} col=${String(analysis1?.blurScore)}`,
    );
    record(
      "clear: raw_result.$.blur.version stamped from settings",
      blurNode?.version === settings.workerVersion,
      JSON.stringify(blurNode?.version),
    );

    // -----------------------------------------------------------------
    // CASE 2: happy path — blurry image.
    // -----------------------------------------------------------------
    {
      const blurryJpeg = await makeStronglyBlurredJpeg(96, 96, 4, 6);
      const seededBlur = await seedTripAndImage(
        dbHandle.db,
        tripService,
        storage,
        blurryJpeg,
        "Case2 blurry",
      );
      insertJob(dbHandle.db, seededBlur.mediaId, IMAGE_QUALITY_BLUR_JOB_TYPE);
      const tick = await executor.tick();
      record("blurry: tick outcome=success", tick.outcome === "success", JSON.stringify(tick));
      const analysis = mediaAnalysisRepo.findByMediaId(seededBlur.mediaId);
      record(
        "blurry: is_blurry=1",
        analysis?.isBlurry === 1,
        `is_blurry=${String(analysis?.isBlurry)} variance=${String(analysis?.blurScore)}`,
      );
      record(
        "blurry: labels=['blurry']",
        analysis?.labels === JSON.stringify(["blurry"]),
        `labels=${String(analysis?.labels)}`,
      );
      record(
        "blurry: sharpness_score in [0, 0.5) (< maybe → < 0.5)",
        typeof analysis?.sharpnessScore === "number" &&
          analysis.sharpnessScore >= 0 &&
          analysis.sharpnessScore < 0.5,
        `sharpness=${String(analysis?.sharpnessScore)}`,
      );
      record(
        "blurry: reason text starts with 'blurry ('",
        typeof analysis?.reason === "string" && analysis.reason.startsWith("blurry ("),
        `reason=${String(analysis?.reason)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 3: borderline image — assert internal coherence only.
    // -----------------------------------------------------------------
    {
      const borderlineJpeg = await makeStronglyBlurredJpeg(96, 96, 4, 1.5);
      const seededBorder = await seedTripAndImage(
        dbHandle.db,
        tripService,
        storage,
        borderlineJpeg,
        "Case3 borderline",
      );
      insertJob(dbHandle.db, seededBorder.mediaId, IMAGE_QUALITY_BLUR_JOB_TYPE);
      const tick = await executor.tick();
      record("borderline: tick outcome=success", tick.outcome === "success", JSON.stringify(tick));
      const analysis = mediaAnalysisRepo.findByMediaId(seededBorder.mediaId);
      const label =
        analysis?.labels === null ? null : (JSON.parse(analysis?.labels ?? "[]") as string[]);
      const labelName = label?.[0] ?? null;
      // Coherence: is_blurry / labels / reason all agree on one class.
      const classOK =
        (analysis?.isBlurry === 1 &&
          labelName === "blurry" &&
          (analysis?.reason ?? "").startsWith("blurry (")) ||
        (analysis?.isBlurry === 0 &&
          labelName === "sharp" &&
          (analysis?.reason ?? "").startsWith("sharp (")) ||
        (analysis?.isBlurry === null &&
          labelName === "maybe-blurry" &&
          (analysis?.reason ?? "").startsWith("borderline ("));
      record(
        "borderline: is_blurry / labels / reason agree on one class",
        classOK,
        `is_blurry=${String(analysis?.isBlurry)} label=${labelName} reason=${String(analysis?.reason)}`,
      );
      record(
        "borderline: blur_score is finite + non-negative",
        typeof analysis?.blurScore === "number" &&
          Number.isFinite(analysis.blurScore) &&
          analysis.blurScore >= 0,
        `blur_score=${String(analysis?.blurScore)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 4: idempotency — re-tick same media writes same blur_score
    // and does not insert a second row.
    // -----------------------------------------------------------------
    {
      const beforeCount = countAnalysisRows(dbHandle.db, seededClear.mediaId);
      const reJobId = insertJob(dbHandle.db, seededClear.mediaId, IMAGE_QUALITY_BLUR_JOB_TYPE);
      const tick = await executor.tick();
      const reJob = readJob(dbHandle.db, reJobId);
      record(
        "idempotent: re-tick success on already-analysed media",
        tick.outcome === "success" && reJob?.status === "success",
        `outcome=${tick.outcome} status=${String(reJob?.status)}`,
      );
      const after = mediaAnalysisRepo.findByMediaId(seededClear.mediaId);
      record(
        "idempotent: blur_score unchanged across re-run",
        analysis1 !== null &&
          after !== null &&
          Math.abs((analysis1.blurScore ?? 0) - (after.blurScore ?? 0)) < 1e-6,
        `before=${String(analysis1?.blurScore)} after=${String(after?.blurScore)}`,
      );
      const afterCount = countAnalysisRows(dbHandle.db, seededClear.mediaId);
      record(
        "idempotent: still exactly 1 media_analysis row for this media",
        beforeCount === 1 && afterCount === 1,
        `before=${beforeCount} after=${afterCount}`,
      );
      record(
        "idempotent: updated_at advanced (or stayed equal) on re-run",
        typeof after?.updatedAt === "string" &&
          typeof analysis1?.updatedAt === "string" &&
          after.updatedAt >= analysis1.updatedAt,
        `before=${String(analysis1?.updatedAt)} after=${String(after?.updatedAt)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 5: failure — video media type.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case5 video media" });
      const mediaId = randomUUID();
      const now = new Date().toISOString();
      dbHandle.db
        .prepare(
          `INSERT INTO media_items
             (id, trip_id, type, original_path, mime_type, extension, file_size,
              status, user_decision, created_at, updated_at)
           VALUES (?, ?, 'video', ?, 'video/mp4', 'mp4', 0,
                   'uploaded', 'undecided', ?, ?)`,
        )
        .run(mediaId, trip.id, `trips/${trip.id}/originals/${mediaId}.mp4`, now, now);
      const vidJobId = insertJob(dbHandle.db, mediaId, IMAGE_QUALITY_BLUR_JOB_TYPE);
      const tick = await executor.tick();
      const vidJob = readJob(dbHandle.db, vidJobId);
      record(
        "video media: tick outcome=failed + error mentions 'not an image'",
        tick.outcome === "failed" &&
          vidJob?.status === "failed" &&
          typeof vidJob?.error_message === "string" &&
          /not an image/i.test(vidJob.error_message as string),
        `outcome=${tick.outcome} err=${String(vidJob?.error_message)}`,
      );
      record(
        "video media: no media_analysis row inserted",
        countAnalysisRows(dbHandle.db, mediaId) === 0,
        `count=${countAnalysisRows(dbHandle.db, mediaId)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 6: failure — soft-deleted media.
    // -----------------------------------------------------------------
    {
      const greyJpeg = await makeSharpCheckerboard(64, 64, 4);
      const seededSoft = await seedTripAndImage(
        dbHandle.db,
        tripService,
        storage,
        greyJpeg,
        "Case6 soft-delete",
      );
      dbHandle.db
        .prepare(`UPDATE media_items SET deleted_at = ?, status = 'deleted' WHERE id = ?`)
        .run(new Date().toISOString(), seededSoft.mediaId);
      const sJobId = insertJob(dbHandle.db, seededSoft.mediaId, IMAGE_QUALITY_BLUR_JOB_TYPE);
      const tick = await executor.tick();
      const sJob = readJob(dbHandle.db, sJobId);
      record(
        "soft-deleted media: tick outcome=failed with explanatory message",
        tick.outcome === "failed" &&
          sJob?.status === "failed" &&
          typeof sJob?.error_message === "string" &&
          /soft-deleted|not found/i.test(sJob.error_message as string),
        `outcome=${tick.outcome} err=${String(sJob?.error_message)}`,
      );
      record(
        "soft-deleted media: no media_analysis row written",
        countAnalysisRows(dbHandle.db, seededSoft.mediaId) === 0,
        `count=${countAnalysisRows(dbHandle.db, seededSoft.mediaId)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 7: failure — non-existent original path.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case7 missing file" });
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
      const mJobId = insertJob(dbHandle.db, mediaId, IMAGE_QUALITY_BLUR_JOB_TYPE);
      const tick = await executor.tick();
      const mJob = readJob(dbHandle.db, mJobId);
      record(
        "missing file: tick outcome=failed + error_message present",
        tick.outcome === "failed" &&
          mJob?.status === "failed" &&
          typeof mJob?.error_message === "string" &&
          (mJob.error_message as string).length > 0,
        `outcome=${tick.outcome} status=${String(mJob?.status)} err=${String(mJob?.error_message)}`,
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
      const eJobId = insertJob(dbHandle.db, mediaId, IMAGE_QUALITY_BLUR_JOB_TYPE);
      const tick = await executor.tick();
      const eJob = readJob(dbHandle.db, eJobId);
      record(
        "empty file: tick outcome=failed with 'empty' in message",
        tick.outcome === "failed" &&
          eJob?.status === "failed" &&
          typeof eJob?.error_message === "string" &&
          /empty/i.test(eJob.error_message as string),
        `outcome=${tick.outcome} err=${String(eJob?.error_message)}`,
      );
    }

    // Note: "media row missing entirely" is unreachable in production
    // — `processing_jobs.media_id` has a FK to `media_items.id`, so a
    // job pointing at a vanished media cannot exist in the first
    // place. The soft-delete branch (CASE 6) covers the only realistic
    // "media not found from the handler's POV" path: an active row was
    // soft-deleted after the job row was created.

    // -----------------------------------------------------------------
    // CASE 9: no P5 regression — duplicate_groups + items unchanged.
    // We never wrote any duplicate_groups in this smoke; both should
    // still be 0 after the blur worker has done all its work above.
    // -----------------------------------------------------------------
    {
      const counts = countDuplicateGroupRows(dbHandle.db);
      record(
        "no P5 regression: duplicate_groups + duplicate_group_items still empty",
        counts.groups === 0 && counts.items === 0,
        JSON.stringify(counts),
      );
    }

    // -----------------------------------------------------------------
    // CASE 10: JobQueue claim — production scheduler picks up
    // image_quality_blur jobs on the image channel.
    // -----------------------------------------------------------------
    {
      const yellowJpeg = await makeSharpCheckerboard(64, 64, 4);
      const seededQ = await seedTripAndImage(
        dbHandle.db,
        tripService,
        storage,
        yellowJpeg,
        "Case11 JobQueue",
      );
      const queueJobId = insertJob(dbHandle.db, seededQ.mediaId, IMAGE_QUALITY_BLUR_JOB_TYPE);

      const handlers = new Map<string, JobHandler>();
      handlers.set(
        IMAGE_QUALITY_BLUR_JOB_TYPE,
        makeImageQualityBlurHandler({ storage, mediaRepo, mediaAnalysisRepo, settings, logger }),
      );
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
        "JobQueue: image_quality_blur registered + claimed on image channel",
        tickResult.claimed.length === 1 && tickResult.claimed[0]?.jobId === queueJobId,
        `claimed=${JSON.stringify(tickResult.claimed)}`,
      );
      const qJob = readJob(dbHandle.db, queueJobId);
      record(
        "JobQueue: job ended status='success'",
        qJob?.status === "success",
        `status=${String(qJob?.status)} err=${String(qJob?.error_message)}`,
      );
      const qAnalysis = mediaAnalysisRepo.findByMediaId(seededQ.mediaId);
      record(
        "JobQueue: media_analysis row populated by handler",
        qAnalysis !== null && typeof qAnalysis.blurScore === "number",
        JSON.stringify(qAnalysis),
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
