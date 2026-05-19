// Manual smoke test for the image_quality_exposure worker (P6.T3).
//
// Usage: npm run smoke:image-quality-exposure
//
// Drives the full handler against a real SQLite DB and a real
// LocalStorageProvider with sharp computing brightness statistics.
// Uses ImageChannelExecutor as a deterministic single-concurrency tick
// harness — same pattern as image-hash-smoke / image-quality-blur-smoke.
//
// Coverage:
//   * Pure helpers: `classifyExposure` returns the right 4-class
//     decision across synthetic stats (under / well / over / mixed +
//     simultaneous-under-and-over fallback); `scoreExposure` is
//     well-shaped and continuous at the boundaries;
//     `computeBrightnessStats` is deterministic over identical bytes
//     and produces sensible numbers on each fixture class.
//   * Happy path — well-exposed image: solid mid-grey → mean≈128,
//     dark/bright≈0 → label=`well-exposed`, exposure_score=1,
//     brightness_score≈0.5. `media_analysis` row populated with the
//     exposure columns + `raw_result.$.exposure` filled in.
//   * Happy path — underexposed image: near-black → mean low, dark
//     ratio≈1 → label=`underexposed`.
//   * Happy path — overexposed image: near-white → mean high, bright
//     ratio≈1 → label=`overexposed`.
//   * Mixed-exposure: large checkerboard of pure black + pure white →
//     dark≈0.5, bright≈0.5 → label=`mixed-exposure`.
//   * raw_result.$.exposure is a valid JSON sub-tree with algorithm,
//     version, thresholds, and the four key statistics.
//   * Idempotency: re-tick on already-analysed media keeps the row
//     count at 1 and writes the same scores.
//   * Failure: video / soft-deleted / missing file / empty file →
//     job 'failed' with sensible message, no media_analysis row
//     created.
//   * Blur + exposure coexistence: run blur first → labels=["sharp"]
//     + raw_result.$.blur populated. Then run exposure on the same
//     media → labels include BOTH "sharp" AND the exposure label;
//     raw_result keeps $.blur intact AND adds $.exposure; the blur
//     columns (blur_score / sharpness_score / is_blurry) survive
//     untouched.
//   * No P5 regression: duplicate_groups + duplicate_group_items
//     counts are unchanged across all the above scenarios.
//   * JobQueue registration: `image_quality_exposure` job claimed via
//     the production scheduler on its image channel.
//   * Labels-merge helper (`mergeDimensionLabels`) is exercised
//     directly with synthetic inputs to lock in the rules.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import {
  BRIGHT_PIXEL_CUTOFF,
  DARK_PIXEL_CUTOFF,
  IMAGE_QUALITY_BLUR_JOB_TYPE,
  IMAGE_QUALITY_EXPOSURE_JOB_TYPE,
  ImageChannelExecutor,
  JobHandlerRegistry,
  JobQueue,
  JobRepository,
  MIXED_RATIO_FLOOR,
  classifyExposure,
  computeBrightnessStats,
  makeImageQualityBlurHandler,
  makeImageQualityExposureHandler,
  scoreExposure,
  type BrightnessStats,
  type ExposureAnalysisSettings,
  type JobHandler,
} from "../jobs/index.js";
import { createLogger } from "../logger.js";
import {
  BLUR_DIMENSION_LABELS,
  EXPOSURE_DIMENSION_LABELS,
  MediaAnalysisRepository,
  MediaRepository,
  mergeDimensionLabels,
} from "../media/index.js";
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

/** Generate a solid-colour RGB JPEG with the given grey level. */
async function makeSolidGreyJpeg(
  width: number,
  height: number,
  intensity: number,
): Promise<Buffer> {
  const channels = 3;
  const pixels = Buffer.alloc(width * height * channels, intensity);
  return sharp(pixels, { raw: { width, height, channels } }).jpeg({ quality: 95 }).toBuffer();
}

/**
 * Generate a large-tile black/white checkerboard. With a tile size of
 * `width/2`, the image is half pure black and half pure white →
 * darkPixelRatio ≈ 0.5 and brightPixelRatio ≈ 0.5 → classified as
 * `mixed-exposure`.
 */
async function makeMixedExposureJpeg(width: number, height: number, tile: number): Promise<Buffer> {
  const channels = 3;
  const pixels = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const cell = (Math.floor(x / tile) + Math.floor(y / tile)) % 2;
      const c = cell === 0 ? 0 : 255;
      const idx = (y * width + x) * channels;
      pixels[idx] = c;
      pixels[idx + 1] = c;
      pixels[idx + 2] = c;
    }
  }
  // PNG keeps the pure-0 / pure-255 pixels uncompressed; JPEG would
  // dither them slightly off the cutoffs. PNG is fine here — the
  // worker reads bytes through sharp regardless of container.
  return sharp(pixels, { raw: { width, height, channels } }).png().toBuffer();
}

/** Same checkerboard pattern that the blur smoke uses for "sharp". */
async function makeSharpCheckerboardJpeg(
  width: number,
  height: number,
  tile: number,
): Promise<Buffer> {
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
  extension: "jpg" | "png" = "jpg",
): Promise<SeededImage> {
  const trip = tripService.createTrip({ title: tripTitle });
  const mediaId = randomUUID();
  const stored = await storage.putOriginal({ tripId: trip.id, mediaId, extension, data: bytes });
  const now = new Date().toISOString();
  const mime = extension === "png" ? "image/png" : "image/jpeg";
  db.prepare(
    `INSERT INTO media_items
       (id, trip_id, type, original_path, mime_type, extension, file_size,
        status, user_decision, created_at, updated_at)
     VALUES (?, ?, 'image', ?, ?, ?, ?,
             'uploaded', 'undecided', ?, ?)`,
  ).run(mediaId, trip.id, stored.logicalPath, mime, extension, bytes.length, now, now);
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

function syntheticStats(args: {
  meanBrightness: number;
  darkPixelRatio: number;
  brightPixelRatio: number;
}): BrightnessStats {
  return {
    width: 100,
    height: 100,
    pixelCount: 10_000,
    meanBrightness: args.meanBrightness,
    darkPixelRatio: args.darkPixelRatio,
    brightPixelRatio: args.brightPixelRatio,
    darkPixelCutoff: DARK_PIXEL_CUTOFF,
    brightPixelCutoff: BRIGHT_PIXEL_CUTOFF,
  };
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-image-quality-exposure-smoke-"));
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

    const settings: ExposureAnalysisSettings = {
      maxEdge: 256,
      underMeanThreshold: 70,
      overMeanThreshold: 185,
      darkRatioThreshold: 0.5,
      brightRatioThreshold: 0.5,
      workerVersion: "smoke-1.0",
    };
    const classifyThresholds = {
      underMean: settings.underMeanThreshold,
      overMean: settings.overMeanThreshold,
      darkRatio: settings.darkRatioThreshold,
      brightRatio: settings.brightRatioThreshold,
      mixedRatio: MIXED_RATIO_FLOOR,
    };

    const registry = new JobHandlerRegistry();
    registry.register(
      IMAGE_QUALITY_EXPOSURE_JOB_TYPE,
      makeImageQualityExposureHandler({
        storage,
        mediaRepo,
        mediaAnalysisRepo,
        settings,
        logger,
      }),
    );
    // Blur handler also registered — the blur+exposure coexistence
    // case needs both workers wired so it can run blur, then exposure,
    // through the same executor.
    registry.register(
      IMAGE_QUALITY_BLUR_JOB_TYPE,
      makeImageQualityBlurHandler({
        storage,
        mediaRepo,
        mediaAnalysisRepo,
        settings: {
          blurThresholdBlurry: 50,
          blurThresholdMaybe: 120,
          maxEdge: 256,
          workerVersion: "smoke-1.0",
        },
        logger,
      }),
    );
    const executor = new ImageChannelExecutor({ jobRepo, registry, logger });

    // -----------------------------------------------------------------
    // CASE A: pure helpers — classifyExposure across the 4 classes
    // -----------------------------------------------------------------
    {
      const u = classifyExposure(
        syntheticStats({ meanBrightness: 20, darkPixelRatio: 0.99, brightPixelRatio: 0 }),
        classifyThresholds,
      );
      record(
        "classifyExposure(mean=20, dark=0.99, bright=0): label='underexposed'",
        u.label === "underexposed" && u.underexposed === true && u.overexposed === false,
        JSON.stringify(u),
      );
      const o = classifyExposure(
        syntheticStats({ meanBrightness: 240, darkPixelRatio: 0, brightPixelRatio: 0.99 }),
        classifyThresholds,
      );
      record(
        "classifyExposure(mean=240, dark=0, bright=0.99): label='overexposed'",
        o.label === "overexposed" && o.overexposed === true && o.underexposed === false,
        JSON.stringify(o),
      );
      const w = classifyExposure(
        syntheticStats({ meanBrightness: 128, darkPixelRatio: 0.05, brightPixelRatio: 0.05 }),
        classifyThresholds,
      );
      record(
        "classifyExposure(mean=128, dark=0.05, bright=0.05): label='well-exposed'",
        w.label === "well-exposed",
        JSON.stringify(w),
      );
      const m = classifyExposure(
        syntheticStats({ meanBrightness: 128, darkPixelRatio: 0.4, brightPixelRatio: 0.4 }),
        classifyThresholds,
      );
      record(
        "classifyExposure(mean=128, dark=0.4, bright=0.4): label='mixed-exposure'",
        m.label === "mixed-exposure",
        JSON.stringify(m),
      );
      // Boundary: mean exactly at underMean (70) stays well-exposed.
      const boundary = classifyExposure(
        syntheticStats({ meanBrightness: 70, darkPixelRatio: 0.1, brightPixelRatio: 0.1 }),
        classifyThresholds,
      );
      record(
        "classifyExposure(mean=70 boundary): well-exposed (strictly <)",
        boundary.label === "well-exposed",
        JSON.stringify(boundary),
      );
    }

    // -----------------------------------------------------------------
    // CASE B: pure helper — scoreExposure curves
    // -----------------------------------------------------------------
    {
      const wellStats = syntheticStats({
        meanBrightness: 128,
        darkPixelRatio: 0,
        brightPixelRatio: 0,
      });
      const wellScore = scoreExposure(
        wellStats,
        {
          label: "well-exposed",
          underexposed: false,
          overexposed: false,
          reason: "x",
        },
        { underMean: 70, overMean: 185 },
      );
      record("scoreExposure(well-exposed)=1", wellScore === 1, `value=${wellScore}`);

      const underStats = syntheticStats({
        meanBrightness: 0,
        darkPixelRatio: 1,
        brightPixelRatio: 0,
      });
      const underScore = scoreExposure(
        underStats,
        {
          label: "underexposed",
          underexposed: true,
          overexposed: false,
          reason: "x",
        },
        { underMean: 70, overMean: 185 },
      );
      record("scoreExposure(under, mean=0)=0", underScore === 0, `value=${underScore}`);

      const overStats = syntheticStats({
        meanBrightness: 255,
        darkPixelRatio: 0,
        brightPixelRatio: 1,
      });
      const overScore = scoreExposure(
        overStats,
        {
          label: "overexposed",
          underexposed: false,
          overexposed: true,
          reason: "x",
        },
        { underMean: 70, overMean: 185 },
      );
      record("scoreExposure(over, mean=255)=0", overScore === 0, `value=${overScore}`);

      const mixedStats = syntheticStats({
        meanBrightness: 128,
        darkPixelRatio: 0.5,
        brightPixelRatio: 0.5,
      });
      const mixedScore = scoreExposure(
        mixedStats,
        {
          label: "mixed-exposure",
          underexposed: false,
          overexposed: false,
          reason: "x",
        },
        { underMean: 70, overMean: 185 },
      );
      record(
        "scoreExposure(mixed, dark=0.5, bright=0.5)=0.5",
        Math.abs(mixedScore - 0.5) < 1e-9,
        `value=${mixedScore}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE C: mergeDimensionLabels semantics
    // -----------------------------------------------------------------
    {
      // Empty start: returns just the new labels.
      const fresh = mergeDimensionLabels(null, BLUR_DIMENSION_LABELS, ["sharp"]);
      record(
        "mergeDimensionLabels(null + sharp)=['sharp']",
        fresh === '["sharp"]',
        `merged=${fresh}`,
      );

      // Existing exposure label survives a blur write.
      const blurOverExposure = mergeDimensionLabels(
        JSON.stringify(["overexposed"]),
        BLUR_DIMENSION_LABELS,
        ["blurry"],
      );
      record(
        "mergeDimensionLabels: blur write preserves exposure label",
        blurOverExposure === '["overexposed","blurry"]',
        `merged=${blurOverExposure}`,
      );

      // Blur re-run replaces blur label but keeps exposure.
      const blurReplace = mergeDimensionLabels(
        JSON.stringify(["overexposed", "sharp"]),
        BLUR_DIMENSION_LABELS,
        ["blurry"],
      );
      record(
        "mergeDimensionLabels: blur re-run replaces 'sharp' → 'blurry', keeps exposure",
        blurReplace === '["overexposed","blurry"]',
        `merged=${blurReplace}`,
      );

      // Exposure write that adds a label, leaving blur intact.
      const exposureKeepsBlur = mergeDimensionLabels(
        JSON.stringify(["sharp"]),
        EXPOSURE_DIMENSION_LABELS,
        ["well-exposed"],
      );
      record(
        "mergeDimensionLabels: exposure write keeps existing 'sharp'",
        exposureKeepsBlur === '["sharp","well-exposed"]',
        `merged=${exposureKeepsBlur}`,
      );

      // Malformed existing JSON treated as empty.
      const malformed = mergeDimensionLabels("not-json", BLUR_DIMENSION_LABELS, ["sharp"]);
      record(
        "mergeDimensionLabels: malformed existing JSON treated as empty",
        malformed === '["sharp"]',
        `merged=${malformed}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE D: computeBrightnessStats determinism + ordering
    // -----------------------------------------------------------------
    {
      const grey = await makeSolidGreyJpeg(96, 96, 128);
      const a1 = await computeBrightnessStats(grey, 96);
      const a2 = await computeBrightnessStats(grey, 96);
      record(
        "computeBrightnessStats deterministic over identical bytes",
        Math.abs(a1.meanBrightness - a2.meanBrightness) < 1e-9,
        `m1=${a1.meanBrightness} m2=${a2.meanBrightness}`,
      );
      const dark = await makeSolidGreyJpeg(96, 96, 20);
      const bright = await makeSolidGreyJpeg(96, 96, 240);
      const ds = await computeBrightnessStats(dark, 96);
      const bs = await computeBrightnessStats(bright, 96);
      record(
        "computeBrightnessStats: dark mean < grey mean < bright mean",
        ds.meanBrightness < a1.meanBrightness && a1.meanBrightness < bs.meanBrightness,
        `dark=${ds.meanBrightness} grey=${a1.meanBrightness} bright=${bs.meanBrightness}`,
      );
      record(
        "computeBrightnessStats: dark.darkPixelRatio ≈ 1, bright.brightPixelRatio ≈ 1",
        ds.darkPixelRatio > 0.95 && bs.brightPixelRatio > 0.95,
        `darkR=${ds.darkPixelRatio} brightR=${bs.brightPixelRatio}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 1: happy path — well-exposed image (solid mid-grey).
    // -----------------------------------------------------------------
    const wellJpeg = await makeSolidGreyJpeg(96, 96, 128);
    const seededWell = await seedTripAndImage(
      dbHandle.db,
      tripService,
      storage,
      wellJpeg,
      "Case1 well-exposed",
    );
    const jobId1 = insertJob(dbHandle.db, seededWell.mediaId, IMAGE_QUALITY_EXPOSURE_JOB_TYPE);
    const tick1 = await executor.tick();
    record(
      "well-exposed: tick outcome=success",
      tick1.outcome === "success" && tick1.jobId === jobId1,
      JSON.stringify(tick1),
    );
    const analysisWell = mediaAnalysisRepo.findByMediaId(seededWell.mediaId);
    record(
      "well-exposed: exposure_score=1 + brightness_score ≈ 0.5",
      analysisWell?.exposureScore === 1 &&
        typeof analysisWell?.brightnessScore === "number" &&
        Math.abs((analysisWell.brightnessScore ?? 0) - 128 / 255) < 0.02,
      `exposureScore=${String(analysisWell?.exposureScore)} brightnessScore=${String(analysisWell?.brightnessScore)}`,
    );
    record(
      "well-exposed: labels=['well-exposed']",
      analysisWell?.labels === JSON.stringify(["well-exposed"]),
      `labels=${String(analysisWell?.labels)}`,
    );
    record(
      "well-exposed: reason starts with 'well-exposed ('",
      typeof analysisWell?.reason === "string" && analysisWell.reason.startsWith("well-exposed ("),
      `reason=${String(analysisWell?.reason)}`,
    );
    // raw_result.$.exposure shape.
    let rawWell: Record<string, unknown> | null = null;
    try {
      rawWell = JSON.parse(analysisWell?.rawResult ?? "null") as Record<string, unknown>;
    } catch (err) {
      console.log("  parse error:", describeError(err));
    }
    const expNode = (rawWell?.exposure ?? null) as Record<string, unknown> | null;
    record(
      "well-exposed: raw_result.$.exposure.algorithm='histogram-mean-thresholds'",
      expNode?.algorithm === "histogram-mean-thresholds",
      JSON.stringify(expNode?.algorithm),
    );
    record(
      "well-exposed: raw_result.$.exposure.exposureLabel='well-exposed'",
      expNode?.exposureLabel === "well-exposed",
      JSON.stringify(expNode?.exposureLabel),
    );
    record(
      "well-exposed: raw_result.$.exposure.version stamped from settings",
      expNode?.version === settings.workerVersion,
      JSON.stringify(expNode?.version),
    );
    record(
      "well-exposed: raw_result.$.exposure exposes meanBrightness + ratios + thresholds + cutoffs",
      typeof expNode?.meanBrightness === "number" &&
        typeof expNode?.darkPixelRatio === "number" &&
        typeof expNode?.brightPixelRatio === "number" &&
        typeof expNode?.darkPixelCutoff === "number" &&
        typeof expNode?.brightPixelCutoff === "number" &&
        typeof (expNode?.thresholds as Record<string, unknown>)?.underMean === "number",
      JSON.stringify(expNode),
    );

    // -----------------------------------------------------------------
    // CASE 2: underexposed image (solid near-black).
    // -----------------------------------------------------------------
    {
      const darkJpeg = await makeSolidGreyJpeg(96, 96, 20);
      const seeded = await seedTripAndImage(
        dbHandle.db,
        tripService,
        storage,
        darkJpeg,
        "Case2 underexposed",
      );
      insertJob(dbHandle.db, seeded.mediaId, IMAGE_QUALITY_EXPOSURE_JOB_TYPE);
      const tick = await executor.tick();
      record(
        "underexposed: tick outcome=success",
        tick.outcome === "success",
        JSON.stringify(tick),
      );
      const a = mediaAnalysisRepo.findByMediaId(seeded.mediaId);
      record(
        "underexposed: labels=['underexposed']",
        a?.labels === JSON.stringify(["underexposed"]),
        `labels=${String(a?.labels)}`,
      );
      record(
        "underexposed: brightness_score low (≤ 0.25)",
        typeof a?.brightnessScore === "number" && a.brightnessScore <= 0.25,
        `brightness=${String(a?.brightnessScore)}`,
      );
      record(
        "underexposed: exposure_score in [0, 1) (mean ≪ underMean → low)",
        typeof a?.exposureScore === "number" && a.exposureScore >= 0 && a.exposureScore < 0.5,
        `exposureScore=${String(a?.exposureScore)}`,
      );
      record(
        "underexposed: reason starts with 'underexposed ('",
        typeof a?.reason === "string" && a.reason.startsWith("underexposed ("),
        `reason=${String(a?.reason)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 3: overexposed image (solid near-white).
    // -----------------------------------------------------------------
    {
      const lightJpeg = await makeSolidGreyJpeg(96, 96, 240);
      const seeded = await seedTripAndImage(
        dbHandle.db,
        tripService,
        storage,
        lightJpeg,
        "Case3 overexposed",
      );
      insertJob(dbHandle.db, seeded.mediaId, IMAGE_QUALITY_EXPOSURE_JOB_TYPE);
      const tick = await executor.tick();
      record("overexposed: tick outcome=success", tick.outcome === "success", JSON.stringify(tick));
      const a = mediaAnalysisRepo.findByMediaId(seeded.mediaId);
      record(
        "overexposed: labels=['overexposed']",
        a?.labels === JSON.stringify(["overexposed"]),
        `labels=${String(a?.labels)}`,
      );
      record(
        "overexposed: brightness_score high (≥ 0.85)",
        typeof a?.brightnessScore === "number" && a.brightnessScore >= 0.85,
        `brightness=${String(a?.brightnessScore)}`,
      );
      record(
        "overexposed: exposure_score in [0, 1) (mean ≫ overMean → low)",
        typeof a?.exposureScore === "number" && a.exposureScore >= 0 && a.exposureScore < 0.5,
        `exposureScore=${String(a?.exposureScore)}`,
      );
      record(
        "overexposed: reason starts with 'overexposed ('",
        typeof a?.reason === "string" && a.reason.startsWith("overexposed ("),
        `reason=${String(a?.reason)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 4: mixed-exposure image (half-black + half-white).
    // -----------------------------------------------------------------
    {
      const mixedPng = await makeMixedExposureJpeg(96, 96, 48);
      const seeded = await seedTripAndImage(
        dbHandle.db,
        tripService,
        storage,
        mixedPng,
        "Case4 mixed",
        "png",
      );
      insertJob(dbHandle.db, seeded.mediaId, IMAGE_QUALITY_EXPOSURE_JOB_TYPE);
      const tick = await executor.tick();
      record(
        "mixed-exposure: tick outcome=success",
        tick.outcome === "success",
        JSON.stringify(tick),
      );
      const a = mediaAnalysisRepo.findByMediaId(seeded.mediaId);
      record(
        "mixed-exposure: labels=['mixed-exposure']",
        a?.labels === JSON.stringify(["mixed-exposure"]),
        `labels=${String(a?.labels)}`,
      );
      record(
        "mixed-exposure: exposure_score ≈ 0.5 (severity = max(0.5, 0.5))",
        typeof a?.exposureScore === "number" && Math.abs(a.exposureScore - 0.5) < 0.05,
        `exposureScore=${String(a?.exposureScore)}`,
      );
      record(
        "mixed-exposure: reason starts with 'mixed-exposure ('",
        typeof a?.reason === "string" && a.reason.startsWith("mixed-exposure ("),
        `reason=${String(a?.reason)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 5: idempotency on Case1 row.
    // -----------------------------------------------------------------
    {
      const before = countAnalysisRows(dbHandle.db, seededWell.mediaId);
      const reJobId = insertJob(dbHandle.db, seededWell.mediaId, IMAGE_QUALITY_EXPOSURE_JOB_TYPE);
      const tick = await executor.tick();
      const reJob = readJob(dbHandle.db, reJobId);
      record(
        "idempotent: re-tick success on already-analysed media",
        tick.outcome === "success" && reJob?.status === "success",
        `outcome=${tick.outcome} status=${String(reJob?.status)}`,
      );
      const after = mediaAnalysisRepo.findByMediaId(seededWell.mediaId);
      record(
        "idempotent: exposure_score unchanged across re-run",
        Math.abs((analysisWell?.exposureScore ?? -1) - (after?.exposureScore ?? -2)) < 1e-6,
        `before=${String(analysisWell?.exposureScore)} after=${String(after?.exposureScore)}`,
      );
      const afterCount = countAnalysisRows(dbHandle.db, seededWell.mediaId);
      record(
        "idempotent: still exactly 1 media_analysis row for this media",
        before === 1 && afterCount === 1,
        `before=${before} after=${afterCount}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 6: blur + exposure coexistence — labels merged, raw_result
    // keeps both sub-trees, blur columns survive.
    // -----------------------------------------------------------------
    {
      const sharpJpeg = await makeSharpCheckerboardJpeg(96, 96, 4);
      const seeded = await seedTripAndImage(
        dbHandle.db,
        tripService,
        storage,
        sharpJpeg,
        "Case6 blur+exposure",
      );
      // Step 1: run blur worker.
      insertJob(dbHandle.db, seeded.mediaId, IMAGE_QUALITY_BLUR_JOB_TYPE);
      const tickBlur = await executor.tick();
      record(
        "blur+exposure: blur tick success",
        tickBlur.outcome === "success",
        JSON.stringify(tickBlur),
      );
      const afterBlur = mediaAnalysisRepo.findByMediaId(seeded.mediaId);
      const blurScore = afterBlur?.blurScore ?? null;
      const sharpness = afterBlur?.sharpnessScore ?? null;
      record(
        "blur+exposure: after blur, labels=['sharp'] + blur_score / sharpness_score populated",
        afterBlur?.labels === JSON.stringify(["sharp"]) &&
          typeof blurScore === "number" &&
          typeof sharpness === "number",
        JSON.stringify(afterBlur),
      );

      // Step 2: run exposure worker on the same media (sharp checkerboard
      // has rgb means 12+240 ≈ 126 → well-exposed).
      insertJob(dbHandle.db, seeded.mediaId, IMAGE_QUALITY_EXPOSURE_JOB_TYPE);
      const tickExp = await executor.tick();
      record(
        "blur+exposure: exposure tick success",
        tickExp.outcome === "success",
        JSON.stringify(tickExp),
      );
      const after = mediaAnalysisRepo.findByMediaId(seeded.mediaId);

      // Labels should contain BOTH the existing "sharp" AND the new
      // exposure label. Order: blur came first → "sharp" appears
      // before the exposure entry.
      const labelArr = JSON.parse(after?.labels ?? "[]") as string[];
      record(
        "blur+exposure: labels merged — contains 'sharp' AND an exposure label",
        labelArr.includes("sharp") &&
          labelArr.some((l) => (EXPOSURE_DIMENSION_LABELS as readonly string[]).includes(l)) &&
          labelArr.length === 2,
        `labels=${after?.labels ?? ""}`,
      );

      // raw_result keeps BOTH $.blur (from step 1) and $.exposure (step 2).
      let rawNode: Record<string, unknown> | null = null;
      try {
        rawNode = JSON.parse(after?.rawResult ?? "null") as Record<string, unknown>;
      } catch (err) {
        console.log("  parse error:", describeError(err));
      }
      record(
        "blur+exposure: raw_result.$.blur survived",
        rawNode?.blur !== undefined &&
          (rawNode?.blur as { algorithm?: string }).algorithm === "laplacian-variance",
        JSON.stringify(rawNode?.blur),
      );
      record(
        "blur+exposure: raw_result.$.exposure added",
        rawNode?.exposure !== undefined &&
          (rawNode?.exposure as { algorithm?: string }).algorithm === "histogram-mean-thresholds",
        JSON.stringify(rawNode?.exposure),
      );

      // Blur columns must be untouched by the exposure run.
      record(
        "blur+exposure: blur_score / sharpness_score / is_blurry unchanged by exposure",
        after?.blurScore === blurScore &&
          after?.sharpnessScore === sharpness &&
          after?.isBlurry === afterBlur?.isBlurry,
        `blur_score=${String(after?.blurScore)} sharpness=${String(after?.sharpnessScore)} isBlurry=${String(after?.isBlurry)}`,
      );

      // Step 3: re-run blur on the same media. Existing exposure label
      // must survive; blur label may swap if classification changes
      // (but for the same image it stays "sharp"). Most importantly:
      // exposure label still present and exposure raw_result still
      // there.
      insertJob(dbHandle.db, seeded.mediaId, IMAGE_QUALITY_BLUR_JOB_TYPE);
      const tickBlurAgain = await executor.tick();
      record(
        "blur+exposure: blur re-tick success",
        tickBlurAgain.outcome === "success",
        JSON.stringify(tickBlurAgain),
      );
      const afterAgain = mediaAnalysisRepo.findByMediaId(seeded.mediaId);
      const labelsAgain = JSON.parse(afterAgain?.labels ?? "[]") as string[];
      record(
        "blur+exposure: after blur re-run, exposure label still in labels",
        labelsAgain.some((l) => (EXPOSURE_DIMENSION_LABELS as readonly string[]).includes(l)) &&
          labelsAgain.includes("sharp"),
        `labels=${afterAgain?.labels ?? ""}`,
      );
      let rawAgain: Record<string, unknown> | null = null;
      try {
        rawAgain = JSON.parse(afterAgain?.rawResult ?? "null") as Record<string, unknown>;
      } catch (err) {
        console.log("  parse error:", describeError(err));
      }
      record(
        "blur+exposure: after blur re-run, raw_result.$.exposure still present",
        rawAgain?.exposure !== undefined,
        JSON.stringify(rawAgain?.exposure),
      );
    }

    // -----------------------------------------------------------------
    // CASE 7: failure — video media type.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case7 video media" });
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
      const vidJobId = insertJob(dbHandle.db, mediaId, IMAGE_QUALITY_EXPOSURE_JOB_TYPE);
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
    // CASE 8: failure — soft-deleted media.
    // -----------------------------------------------------------------
    {
      const greyJpeg = await makeSolidGreyJpeg(64, 64, 128);
      const seededSoft = await seedTripAndImage(
        dbHandle.db,
        tripService,
        storage,
        greyJpeg,
        "Case8 soft-delete",
      );
      dbHandle.db
        .prepare(`UPDATE media_items SET deleted_at = ?, status = 'deleted' WHERE id = ?`)
        .run(new Date().toISOString(), seededSoft.mediaId);
      const sJobId = insertJob(dbHandle.db, seededSoft.mediaId, IMAGE_QUALITY_EXPOSURE_JOB_TYPE);
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
    // CASE 9: failure — missing file.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case9 missing file" });
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
      const mJobId = insertJob(dbHandle.db, mediaId, IMAGE_QUALITY_EXPOSURE_JOB_TYPE);
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
    // CASE 10: failure — empty original file.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case10 empty file" });
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
      const eJobId = insertJob(dbHandle.db, mediaId, IMAGE_QUALITY_EXPOSURE_JOB_TYPE);
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

    // -----------------------------------------------------------------
    // CASE 11: no P5 regression — duplicate_groups + items still empty.
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
    // CASE 12: JobQueue claim — production scheduler picks up
    // image_quality_exposure jobs on the image channel.
    // -----------------------------------------------------------------
    {
      const qJpeg = await makeSolidGreyJpeg(64, 64, 128);
      const seededQ = await seedTripAndImage(
        dbHandle.db,
        tripService,
        storage,
        qJpeg,
        "Case12 JobQueue",
      );
      const queueJobId = insertJob(dbHandle.db, seededQ.mediaId, IMAGE_QUALITY_EXPOSURE_JOB_TYPE);

      const handlers = new Map<string, JobHandler>();
      handlers.set(
        IMAGE_QUALITY_EXPOSURE_JOB_TYPE,
        makeImageQualityExposureHandler({
          storage,
          mediaRepo,
          mediaAnalysisRepo,
          settings,
          logger,
        }),
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
        "JobQueue: image_quality_exposure registered + claimed on image channel",
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
        qAnalysis !== null &&
          typeof qAnalysis.exposureScore === "number" &&
          typeof qAnalysis.brightnessScore === "number",
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
