// Manual smoke test for the image_quality_color worker (P6.T4).
//
// Usage: npm run smoke:image-quality-color
//
// Drives the full handler against a real SQLite DB and a real
// LocalStorageProvider with sharp computing RGB / HSV / luminance
// statistics. Uses ImageChannelExecutor as a deterministic single-
// concurrency tick harness — same pattern as image-hash-smoke /
// image-quality-blur-smoke / image-quality-exposure-smoke.
//
// Coverage:
//   * Pure helpers:
//       - `classifyColor` over synthetic stats produces the right
//         saturation / cast / contrast classifications, the right
//         labels, and the `color-balanced` "all normal" marker.
//       - `scoreColor` falls to 0.5 for any non-normal saturation /
//         contrast and continuously drops with cast severity.
//       - `computeColorStats` is deterministic over identical bytes
//         and produces the expected channel means / saturation /
//         luminance on every fixture class.
//   * Happy path — balanced image: a moderate-saturation PNG with
//     balanced RGB means → `color_score = 1`, `labels =
//     ["color-balanced"]`.
//   * Low saturation: solid mid-grey → label includes
//     `color-low-saturation`.
//   * High saturation: solid pure red → label includes
//     `color-high-saturation`.
//   * Warm cast: red-shifted mid-grey → label includes
//     `color-warm-cast`.
//   * Cool cast: blue-shifted mid-grey → label includes
//     `color-cool-cast`.
//   * Green cast: green-shifted mid-grey → label includes
//     `color-green-cast`.
//   * Magenta cast: R/B-shifted, G-suppressed mid-grey → label
//     includes `color-magenta-cast`.
//   * Low contrast: solid grey → label includes `color-low-contrast`.
//   * High contrast: half-black half-white → label includes
//     `color-high-contrast`.
//   * raw_result.$.color is valid JSON with algorithm / version /
//     thresholds / aggregates populated.
//   * Idempotency: re-tick keeps the row count at 1 and writes the
//     same color_score / labels.
//   * Failure: video / soft-deleted / missing file / empty file →
//     job 'failed' with sensible message, no media_analysis row
//     written.
//   * Blur + exposure + color coexistence: run blur → exposure →
//     color on the same media → labels merge contains an entry from
//     each dimension, raw_result has $.blur AND $.exposure AND
//     $.color sub-trees, blur columns AND exposure columns survive
//     the colour run.
//   * No P5 regression: duplicate_groups + items still empty.
//   * JobQueue claim: `image_quality_color` job picked up via the
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
  IMAGE_QUALITY_COLOR_JOB_TYPE,
  IMAGE_QUALITY_EXPOSURE_JOB_TYPE,
  ImageChannelExecutor,
  JobHandlerRegistry,
  JobQueue,
  JobRepository,
  classifyColor,
  computeColorStats,
  makeImageQualityBlurHandler,
  makeImageQualityColorHandler,
  makeImageQualityExposureHandler,
  scoreColor,
  type ColorAnalysisSettings,
  type ColorStats,
  type JobHandler,
} from "../jobs/index.js";
import { createLogger } from "../logger.js";
import {
  COLOR_DIMENSION_LABELS,
  MediaAnalysisRepository,
  MediaRepository,
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

/** Generate a solid-colour RGB PNG with the given (R, G, B) values. */
async function makeSolidRgbPng(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
): Promise<Buffer> {
  const channels = 3;
  const pixels = Buffer.alloc(width * height * channels);
  for (let i = 0; i < width * height; i += 1) {
    const off = i * channels;
    pixels[off] = r;
    pixels[off + 1] = g;
    pixels[off + 2] = b;
  }
  // PNG keeps exact pixel values — JPEG would dither chroma slightly
  // and risk pushing fixtures across thresholds.
  return sharp(pixels, { raw: { width, height, channels } }).png().toBuffer();
}

/**
 * Generate a balanced-RGB PNG with moderate saturation + normal
 * contrast by alternating two tiles whose channel means each add
 * up to 150:
 *   tile A: (200, 200, 80)  — yellow-leaning, sat = (200-80)/200 = 0.60,
 *                             luminance ≈ 186
 *   tile B: (100, 100, 220) — cool blue,     sat = (220-100)/220 = 0.55,
 *                             luminance ≈ 114
 * Average over the image: R = 150, G = 150, B = 150 → channel-balanced.
 * Mean saturation ≈ 0.57 → "normal" band ([lowSaturationThreshold,
 * highSaturationThreshold] defaults are [0.10, 0.75]).
 * Luminance std ≈ 36 → "normal" contrast (>= lowContrastThreshold=30
 * and < HIGH_CONTRAST_CUTOFF=90).
 *
 * All three sub-classifications hit "normal" → labels reduce to
 * `["color-balanced"]` per the worker's all-clean marker rule.
 */
async function makeBalancedColourfulPng(width: number, height: number): Promise<Buffer> {
  const channels = 3;
  const pixels = Buffer.alloc(width * height * channels);
  const tile = 16;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const cell = (Math.floor(x / tile) + Math.floor(y / tile)) % 2;
      const off = (y * width + x) * channels;
      if (cell === 0) {
        pixels[off] = 200;
        pixels[off + 1] = 200;
        pixels[off + 2] = 80;
      } else {
        pixels[off] = 100;
        pixels[off + 1] = 100;
        pixels[off + 2] = 220;
      }
    }
  }
  return sharp(pixels, { raw: { width, height, channels } }).png().toBuffer();
}

/**
 * Generate a half-black half-white PNG with two equally-sized solid
 * regions. Mean R = G = B = 127.5 → balanced. Luminance std ≈ 127.5
 * → far above HIGH_CONTRAST_CUTOFF (90). Saturation = 0 in both
 * regions → low saturation.
 */
async function makeHighContrastMonoPng(width: number, height: number): Promise<Buffer> {
  const channels = 3;
  const pixels = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    const intensity = y < height / 2 ? 0 : 255;
    for (let x = 0; x < width; x += 1) {
      const off = (y * width + x) * channels;
      pixels[off] = intensity;
      pixels[off + 1] = intensity;
      pixels[off + 2] = intensity;
    }
  }
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
  extension: "jpg" | "png" = "png",
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
  meanR: number;
  meanG: number;
  meanB: number;
  meanSaturation: number;
  luminanceStd: number;
}): ColorStats {
  return {
    width: 100,
    height: 100,
    pixelCount: 10_000,
    meanR: args.meanR,
    meanG: args.meanG,
    meanB: args.meanB,
    meanSaturation: args.meanSaturation,
    saturationStd: 0,
    lowSaturationRatio: args.meanSaturation < 0.1 ? 1 : 0,
    highSaturationRatio: args.meanSaturation > 0.85 ? 1 : 0,
    meanLuminance: 0.299 * args.meanR + 0.587 * args.meanG + 0.114 * args.meanB,
    luminanceStd: args.luminanceStd,
  };
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-image-quality-color-smoke-"));
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

    const settings: ColorAnalysisSettings = {
      maxEdge: 256,
      lowSaturationThreshold: 0.1,
      highSaturationThreshold: 0.75,
      castThreshold: 30,
      lowContrastThreshold: 30,
      workerVersion: "smoke-1.0",
    };
    const classifyThresholds = {
      lowSaturation: settings.lowSaturationThreshold,
      highSaturation: settings.highSaturationThreshold,
      cast: settings.castThreshold,
      lowContrast: settings.lowContrastThreshold,
      highContrast: 90,
    };

    const registry = new JobHandlerRegistry();
    registry.register(
      IMAGE_QUALITY_COLOR_JOB_TYPE,
      makeImageQualityColorHandler({
        storage,
        mediaRepo,
        mediaAnalysisRepo,
        settings,
        logger,
      }),
    );
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
    registry.register(
      IMAGE_QUALITY_EXPOSURE_JOB_TYPE,
      makeImageQualityExposureHandler({
        storage,
        mediaRepo,
        mediaAnalysisRepo,
        settings: {
          maxEdge: 256,
          underMeanThreshold: 70,
          overMeanThreshold: 185,
          darkRatioThreshold: 0.5,
          brightRatioThreshold: 0.5,
          workerVersion: "smoke-1.0",
        },
        logger,
      }),
    );
    const executor = new ImageChannelExecutor({ jobRepo, registry, logger });

    // -----------------------------------------------------------------
    // CASE A: classifyColor — saturation classes
    // -----------------------------------------------------------------
    {
      const low = classifyColor(
        syntheticStats({
          meanR: 128,
          meanG: 128,
          meanB: 128,
          meanSaturation: 0.05,
          luminanceStd: 50,
        }),
        classifyThresholds,
      );
      record(
        "classifyColor: low saturation → 'color-low-saturation'",
        low.saturationClass === "low" && low.labels.includes("color-low-saturation"),
        JSON.stringify(low.labels),
      );
      const high = classifyColor(
        syntheticStats({
          meanR: 220,
          meanG: 130,
          meanB: 130,
          meanSaturation: 0.9,
          luminanceStd: 50,
        }),
        classifyThresholds,
      );
      record(
        "classifyColor: high saturation → 'color-high-saturation'",
        high.saturationClass === "high" && high.labels.includes("color-high-saturation"),
        JSON.stringify(high.labels),
      );
      const normal = classifyColor(
        syntheticStats({
          meanR: 150,
          meanG: 150,
          meanB: 150,
          meanSaturation: 0.4,
          luminanceStd: 50,
        }),
        classifyThresholds,
      );
      record(
        "classifyColor: normal sat + balanced + normal contrast → ['color-balanced']",
        normal.labels.length === 1 && normal.labels[0] === "color-balanced",
        JSON.stringify(normal.labels),
      );
    }

    // -----------------------------------------------------------------
    // CASE B: classifyColor — cast directions
    // -----------------------------------------------------------------
    {
      const warm = classifyColor(
        syntheticStats({
          meanR: 190,
          meanG: 130,
          meanB: 130,
          meanSaturation: 0.3,
          luminanceStd: 50,
        }),
        classifyThresholds,
      );
      record(
        "classifyColor: R-dominant → 'color-warm-cast'",
        warm.cast === "warm-cast" && warm.labels.includes("color-warm-cast"),
        JSON.stringify(warm),
      );
      const cool = classifyColor(
        syntheticStats({
          meanR: 130,
          meanG: 130,
          meanB: 190,
          meanSaturation: 0.3,
          luminanceStd: 50,
        }),
        classifyThresholds,
      );
      record(
        "classifyColor: B-dominant → 'color-cool-cast'",
        cool.cast === "cool-cast" && cool.labels.includes("color-cool-cast"),
        JSON.stringify(cool),
      );
      const green = classifyColor(
        syntheticStats({
          meanR: 130,
          meanG: 190,
          meanB: 130,
          meanSaturation: 0.3,
          luminanceStd: 50,
        }),
        classifyThresholds,
      );
      record(
        "classifyColor: G-dominant → 'color-green-cast'",
        green.cast === "green-cast" && green.labels.includes("color-green-cast"),
        JSON.stringify(green),
      );
      const magenta = classifyColor(
        syntheticStats({
          meanR: 190,
          meanG: 100,
          meanB: 190,
          meanSaturation: 0.3,
          luminanceStd: 50,
        }),
        classifyThresholds,
      );
      record(
        "classifyColor: G lowest + R≈B → 'color-magenta-cast'",
        magenta.cast === "magenta-cast" && magenta.labels.includes("color-magenta-cast"),
        JSON.stringify(magenta),
      );
    }

    // -----------------------------------------------------------------
    // CASE C: classifyColor — contrast classes
    // -----------------------------------------------------------------
    {
      const lowC = classifyColor(
        syntheticStats({
          meanR: 150,
          meanG: 150,
          meanB: 150,
          meanSaturation: 0.4,
          luminanceStd: 10,
        }),
        classifyThresholds,
      );
      record(
        "classifyColor: lumStd=10 → 'color-low-contrast'",
        lowC.contrastClass === "low" && lowC.labels.includes("color-low-contrast"),
        JSON.stringify(lowC.labels),
      );
      const highC = classifyColor(
        syntheticStats({
          meanR: 150,
          meanG: 150,
          meanB: 150,
          meanSaturation: 0.4,
          luminanceStd: 120,
        }),
        classifyThresholds,
      );
      record(
        "classifyColor: lumStd=120 → 'color-high-contrast'",
        highC.contrastClass === "high" && highC.labels.includes("color-high-contrast"),
        JSON.stringify(highC.labels),
      );
    }

    // -----------------------------------------------------------------
    // CASE D: scoreColor curve
    // -----------------------------------------------------------------
    {
      // All normal → score = 1.
      const ok = classifyColor(
        syntheticStats({
          meanR: 150,
          meanG: 150,
          meanB: 150,
          meanSaturation: 0.4,
          luminanceStd: 50,
        }),
        classifyThresholds,
      );
      const okScore = scoreColor(
        syntheticStats({
          meanR: 150,
          meanG: 150,
          meanB: 150,
          meanSaturation: 0.4,
          luminanceStd: 50,
        }),
        ok,
        { cast: 30 },
      );
      record("scoreColor: all-normal → 1", okScore === 1, `value=${okScore}`);

      // Strong cast → cast severity drops the score.
      const castStats = syntheticStats({
        meanR: 200,
        meanG: 110,
        meanB: 110,
        meanSaturation: 0.4,
        luminanceStd: 50,
      });
      const cast = classifyColor(castStats, classifyThresholds);
      const castScore = scoreColor(castStats, cast, { cast: 30 });
      record(
        "scoreColor: spread 90 > 30 → score in (0, 1)",
        castScore > 0 && castScore < 1,
        `value=${castScore}`,
      );

      // Low saturation → flat 0.5 floor.
      const lowSatStats = syntheticStats({
        meanR: 150,
        meanG: 150,
        meanB: 150,
        meanSaturation: 0.05,
        luminanceStd: 50,
      });
      const lowSat = classifyColor(lowSatStats, classifyThresholds);
      const lowSatScore = scoreColor(lowSatStats, lowSat, { cast: 30 });
      record("scoreColor: low saturation → 0.5", lowSatScore === 0.5, `value=${lowSatScore}`);
    }

    // -----------------------------------------------------------------
    // CASE E: computeColorStats determinism + ordering
    // -----------------------------------------------------------------
    {
      const balanced = await makeBalancedColourfulPng(96, 96);
      const a1 = await computeColorStats(balanced, 96);
      const a2 = await computeColorStats(balanced, 96);
      record(
        "computeColorStats deterministic over identical bytes",
        Math.abs(a1.meanSaturation - a2.meanSaturation) < 1e-9 &&
          Math.abs(a1.meanR - a2.meanR) < 1e-9,
        `m1=${a1.meanSaturation} m2=${a2.meanSaturation}`,
      );
      record(
        "computeColorStats: balanced fixture has R ≈ G ≈ B (channel spread small)",
        Math.abs(a1.meanR - a1.meanG) < 30 &&
          Math.abs(a1.meanG - a1.meanB) < 30 &&
          Math.abs(a1.meanR - a1.meanB) < 30,
        `R=${a1.meanR} G=${a1.meanG} B=${a1.meanB}`,
      );

      const grey = await makeSolidRgbPng(64, 64, 128, 128, 128);
      const greyStats = await computeColorStats(grey, 64);
      record(
        "computeColorStats: solid grey → meanSat ≈ 0, lumStd ≈ 0",
        greyStats.meanSaturation < 0.01 && greyStats.luminanceStd < 0.5,
        `sat=${greyStats.meanSaturation} lumStd=${greyStats.luminanceStd}`,
      );

      const pureRed = await makeSolidRgbPng(64, 64, 255, 0, 0);
      const redStats = await computeColorStats(pureRed, 64);
      record(
        "computeColorStats: pure red → meanSat = 1, R ≫ G, R ≫ B",
        redStats.meanSaturation > 0.99 &&
          redStats.meanR > 200 &&
          redStats.meanG < 30 &&
          redStats.meanB < 30,
        `sat=${redStats.meanSaturation} R=${redStats.meanR} G=${redStats.meanG} B=${redStats.meanB}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 1: happy path — balanced colourful image.
    // -----------------------------------------------------------------
    const balancedPng = await makeBalancedColourfulPng(96, 96);
    const seededBalanced = await seedTripAndImage(
      dbHandle.db,
      tripService,
      storage,
      balancedPng,
      "Case1 balanced",
    );
    const jobId1 = insertJob(dbHandle.db, seededBalanced.mediaId, IMAGE_QUALITY_COLOR_JOB_TYPE);
    const tick1 = await executor.tick();
    record(
      "balanced: tick outcome=success",
      tick1.outcome === "success" && tick1.jobId === jobId1,
      JSON.stringify(tick1),
    );
    const a1 = mediaAnalysisRepo.findByMediaId(seededBalanced.mediaId);
    record(
      "balanced: color_score = 1",
      a1?.colorScore === 1,
      `colorScore=${String(a1?.colorScore)}`,
    );
    record(
      "balanced: labels = ['color-balanced']",
      a1?.labels === JSON.stringify(["color-balanced"]),
      `labels=${String(a1?.labels)}`,
    );
    record(
      "balanced: reason starts with 'color-balanced ('",
      typeof a1?.reason === "string" && a1.reason.startsWith("color-balanced ("),
      `reason=${String(a1?.reason)}`,
    );
    let rawBalanced: Record<string, unknown> | null = null;
    try {
      rawBalanced = JSON.parse(a1?.rawResult ?? "null") as Record<string, unknown>;
    } catch (err) {
      console.log("  parse error:", describeError(err));
    }
    const colorNode = (rawBalanced?.color ?? null) as Record<string, unknown> | null;
    record(
      "balanced: raw_result.$.color.algorithm='hsv-channel-balance-luminance'",
      colorNode?.algorithm === "hsv-channel-balance-luminance",
      JSON.stringify(colorNode?.algorithm),
    );
    record(
      "balanced: raw_result.$.color.version stamped from settings",
      colorNode?.version === settings.workerVersion,
      JSON.stringify(colorNode?.version),
    );
    record(
      "balanced: raw_result.$.color exposes meanRgb / saturation / luminance / thresholds",
      typeof colorNode?.meanSaturation === "number" &&
        typeof (colorNode?.meanRgb as Record<string, unknown>)?.r === "number" &&
        typeof colorNode?.luminanceStd === "number" &&
        typeof (colorNode?.thresholds as Record<string, unknown>)?.cast === "number" &&
        typeof (colorNode?.pixelCutoffs as Record<string, unknown>)?.highContrast === "number",
      JSON.stringify(colorNode),
    );

    // -----------------------------------------------------------------
    // CASE 2: low saturation — solid mid-grey.
    // -----------------------------------------------------------------
    {
      const grey = await makeSolidRgbPng(64, 64, 128, 128, 128);
      const seeded = await seedTripAndImage(dbHandle.db, tripService, storage, grey, "Case2 grey");
      insertJob(dbHandle.db, seeded.mediaId, IMAGE_QUALITY_COLOR_JOB_TYPE);
      const tick = await executor.tick();
      record("low-sat: tick outcome=success", tick.outcome === "success", JSON.stringify(tick));
      const a = mediaAnalysisRepo.findByMediaId(seeded.mediaId);
      const labels = JSON.parse(a?.labels ?? "[]") as string[];
      record(
        "low-sat: labels contain 'color-low-saturation' + 'color-low-contrast'",
        labels.includes("color-low-saturation") && labels.includes("color-low-contrast"),
        `labels=${String(a?.labels)}`,
      );
      record(
        "low-sat: color_score = 0.5 (worst-of penalty)",
        a?.colorScore === 0.5,
        `colorScore=${String(a?.colorScore)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 3: high saturation — pure red.
    // -----------------------------------------------------------------
    {
      const red = await makeSolidRgbPng(64, 64, 255, 0, 0);
      const seeded = await seedTripAndImage(dbHandle.db, tripService, storage, red, "Case3 red");
      insertJob(dbHandle.db, seeded.mediaId, IMAGE_QUALITY_COLOR_JOB_TYPE);
      const tick = await executor.tick();
      record("high-sat: tick outcome=success", tick.outcome === "success", JSON.stringify(tick));
      const a = mediaAnalysisRepo.findByMediaId(seeded.mediaId);
      const labels = JSON.parse(a?.labels ?? "[]") as string[];
      record(
        "high-sat: labels contain 'color-high-saturation' + 'color-warm-cast'",
        labels.includes("color-high-saturation") && labels.includes("color-warm-cast"),
        `labels=${String(a?.labels)}`,
      );
      record(
        "high-sat: color_score < 1 (cast severity pulls it down)",
        typeof a?.colorScore === "number" && a.colorScore > 0 && a.colorScore <= 0.5,
        `colorScore=${String(a?.colorScore)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 4: warm cast — moderately saturated R-dominant.
    // -----------------------------------------------------------------
    {
      const warm = await makeSolidRgbPng(64, 64, 190, 130, 130);
      const seeded = await seedTripAndImage(
        dbHandle.db,
        tripService,
        storage,
        warm,
        "Case4 warm cast",
      );
      insertJob(dbHandle.db, seeded.mediaId, IMAGE_QUALITY_COLOR_JOB_TYPE);
      const tick = await executor.tick();
      record("warm-cast: tick outcome=success", tick.outcome === "success", JSON.stringify(tick));
      const a = mediaAnalysisRepo.findByMediaId(seeded.mediaId);
      const labels = JSON.parse(a?.labels ?? "[]") as string[];
      record(
        "warm-cast: labels include 'color-warm-cast'",
        labels.includes("color-warm-cast"),
        `labels=${String(a?.labels)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 5: cool cast — B-dominant.
    // -----------------------------------------------------------------
    {
      const cool = await makeSolidRgbPng(64, 64, 130, 130, 190);
      const seeded = await seedTripAndImage(
        dbHandle.db,
        tripService,
        storage,
        cool,
        "Case5 cool cast",
      );
      insertJob(dbHandle.db, seeded.mediaId, IMAGE_QUALITY_COLOR_JOB_TYPE);
      const tick = await executor.tick();
      record("cool-cast: tick outcome=success", tick.outcome === "success", JSON.stringify(tick));
      const a = mediaAnalysisRepo.findByMediaId(seeded.mediaId);
      const labels = JSON.parse(a?.labels ?? "[]") as string[];
      record(
        "cool-cast: labels include 'color-cool-cast'",
        labels.includes("color-cool-cast"),
        `labels=${String(a?.labels)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 6: green cast — G-dominant.
    // -----------------------------------------------------------------
    {
      const green = await makeSolidRgbPng(64, 64, 130, 190, 130);
      const seeded = await seedTripAndImage(
        dbHandle.db,
        tripService,
        storage,
        green,
        "Case6 green cast",
      );
      insertJob(dbHandle.db, seeded.mediaId, IMAGE_QUALITY_COLOR_JOB_TYPE);
      const tick = await executor.tick();
      record("green-cast: tick outcome=success", tick.outcome === "success", JSON.stringify(tick));
      const a = mediaAnalysisRepo.findByMediaId(seeded.mediaId);
      const labels = JSON.parse(a?.labels ?? "[]") as string[];
      record(
        "green-cast: labels include 'color-green-cast'",
        labels.includes("color-green-cast"),
        `labels=${String(a?.labels)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 7: magenta cast — R≈B high, G low.
    // -----------------------------------------------------------------
    {
      const magenta = await makeSolidRgbPng(64, 64, 190, 100, 190);
      const seeded = await seedTripAndImage(
        dbHandle.db,
        tripService,
        storage,
        magenta,
        "Case7 magenta cast",
      );
      insertJob(dbHandle.db, seeded.mediaId, IMAGE_QUALITY_COLOR_JOB_TYPE);
      const tick = await executor.tick();
      record(
        "magenta-cast: tick outcome=success",
        tick.outcome === "success",
        JSON.stringify(tick),
      );
      const a = mediaAnalysisRepo.findByMediaId(seeded.mediaId);
      const labels = JSON.parse(a?.labels ?? "[]") as string[];
      record(
        "magenta-cast: labels include 'color-magenta-cast'",
        labels.includes("color-magenta-cast"),
        `labels=${String(a?.labels)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 8: high contrast — half-black half-white.
    // -----------------------------------------------------------------
    {
      const high = await makeHighContrastMonoPng(64, 64);
      const seeded = await seedTripAndImage(
        dbHandle.db,
        tripService,
        storage,
        high,
        "Case8 high contrast",
      );
      insertJob(dbHandle.db, seeded.mediaId, IMAGE_QUALITY_COLOR_JOB_TYPE);
      const tick = await executor.tick();
      record(
        "high-contrast: tick outcome=success",
        tick.outcome === "success",
        JSON.stringify(tick),
      );
      const a = mediaAnalysisRepo.findByMediaId(seeded.mediaId);
      const labels = JSON.parse(a?.labels ?? "[]") as string[];
      record(
        "high-contrast: labels include 'color-high-contrast'",
        labels.includes("color-high-contrast"),
        `labels=${String(a?.labels)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 9: idempotency on Case1 row.
    // -----------------------------------------------------------------
    {
      const before = countAnalysisRows(dbHandle.db, seededBalanced.mediaId);
      const reJobId = insertJob(dbHandle.db, seededBalanced.mediaId, IMAGE_QUALITY_COLOR_JOB_TYPE);
      const tick = await executor.tick();
      const reJob = readJob(dbHandle.db, reJobId);
      record(
        "idempotent: re-tick success on already-analysed media",
        tick.outcome === "success" && reJob?.status === "success",
        `outcome=${tick.outcome} status=${String(reJob?.status)}`,
      );
      const after = mediaAnalysisRepo.findByMediaId(seededBalanced.mediaId);
      record(
        "idempotent: color_score unchanged across re-run",
        Math.abs((a1?.colorScore ?? -1) - (after?.colorScore ?? -2)) < 1e-6,
        `before=${String(a1?.colorScore)} after=${String(after?.colorScore)}`,
      );
      const afterCount = countAnalysisRows(dbHandle.db, seededBalanced.mediaId);
      record(
        "idempotent: still exactly 1 media_analysis row for this media",
        before === 1 && afterCount === 1,
        `before=${before} after=${afterCount}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 10: blur + exposure + color coexistence.
    // -----------------------------------------------------------------
    {
      const sharpJpeg = await makeSharpCheckerboardJpeg(96, 96, 4);
      const seeded = await seedTripAndImage(
        dbHandle.db,
        tripService,
        storage,
        sharpJpeg,
        "Case10 all-3 dimensions",
        "jpg",
      );
      // Step 1: run blur.
      insertJob(dbHandle.db, seeded.mediaId, IMAGE_QUALITY_BLUR_JOB_TYPE);
      const tickBlur = await executor.tick();
      record(
        "coexistence: blur tick success",
        tickBlur.outcome === "success",
        JSON.stringify(tickBlur),
      );
      const afterBlur = mediaAnalysisRepo.findByMediaId(seeded.mediaId);
      const blurScore = afterBlur?.blurScore ?? null;
      const sharpness = afterBlur?.sharpnessScore ?? null;

      // Step 2: run exposure.
      insertJob(dbHandle.db, seeded.mediaId, IMAGE_QUALITY_EXPOSURE_JOB_TYPE);
      const tickExp = await executor.tick();
      record(
        "coexistence: exposure tick success",
        tickExp.outcome === "success",
        JSON.stringify(tickExp),
      );
      const afterExp = mediaAnalysisRepo.findByMediaId(seeded.mediaId);
      const exposureScore = afterExp?.exposureScore ?? null;
      const brightnessScore = afterExp?.brightnessScore ?? null;

      // Step 3: run colour.
      insertJob(dbHandle.db, seeded.mediaId, IMAGE_QUALITY_COLOR_JOB_TYPE);
      const tickColor = await executor.tick();
      record(
        "coexistence: color tick success",
        tickColor.outcome === "success",
        JSON.stringify(tickColor),
      );

      const after = mediaAnalysisRepo.findByMediaId(seeded.mediaId);
      const labels = JSON.parse(after?.labels ?? "[]") as string[];
      // Labels must contain "sharp" (blur), an exposure-vocab entry,
      // and at least one colour-prefixed entry.
      const hasBlur = labels.includes("sharp");
      const hasExposure = labels.some((l) =>
        ["well-exposed", "underexposed", "overexposed", "mixed-exposure"].includes(l),
      );
      const hasColor = labels.some((l) =>
        (COLOR_DIMENSION_LABELS as readonly string[]).includes(l),
      );
      // Colour may emit multiple labels per image (e.g. low-saturation
      // AND high-contrast). We just need at least one entry from each
      // of the three dimensions.
      record(
        "coexistence: labels contain blur + exposure + color entries",
        hasBlur && hasExposure && hasColor && labels.length >= 3,
        `labels=${after?.labels ?? ""}`,
      );

      // raw_result must hold $.blur, $.exposure, AND $.color sub-trees.
      let raw: Record<string, unknown> | null = null;
      try {
        raw = JSON.parse(after?.rawResult ?? "null") as Record<string, unknown>;
      } catch (err) {
        console.log("  parse error:", describeError(err));
      }
      record(
        "coexistence: raw_result.$.blur survived",
        raw?.blur !== undefined &&
          (raw?.blur as { algorithm?: string }).algorithm === "laplacian-variance",
        JSON.stringify(raw?.blur),
      );
      record(
        "coexistence: raw_result.$.exposure survived",
        raw?.exposure !== undefined &&
          (raw?.exposure as { algorithm?: string }).algorithm === "histogram-mean-thresholds",
        JSON.stringify(raw?.exposure),
      );
      record(
        "coexistence: raw_result.$.color added",
        raw?.color !== undefined &&
          (raw?.color as { algorithm?: string }).algorithm === "hsv-channel-balance-luminance",
        JSON.stringify(raw?.color),
      );

      // Per-dimension typed columns must all be present + unchanged
      // from their prior values where applicable.
      record(
        "coexistence: blur_score / sharpness_score / is_blurry survived color run",
        after?.blurScore === blurScore &&
          after?.sharpnessScore === sharpness &&
          after?.isBlurry === afterBlur?.isBlurry,
        `blur_score=${String(after?.blurScore)} sharpness=${String(after?.sharpnessScore)} isBlurry=${String(after?.isBlurry)}`,
      );
      record(
        "coexistence: exposure_score / brightness_score survived color run",
        after?.exposureScore === exposureScore && after?.brightnessScore === brightnessScore,
        `exposureScore=${String(after?.exposureScore)} brightnessScore=${String(after?.brightnessScore)}`,
      );
      record(
        "coexistence: color_score populated",
        typeof after?.colorScore === "number",
        `colorScore=${String(after?.colorScore)}`,
      );

      // Step 4: re-run blur on the same media. Colour + exposure
      // labels must still survive, as must their raw_result sub-trees.
      insertJob(dbHandle.db, seeded.mediaId, IMAGE_QUALITY_BLUR_JOB_TYPE);
      const tickBlurAgain = await executor.tick();
      record(
        "coexistence: blur re-tick success",
        tickBlurAgain.outcome === "success",
        JSON.stringify(tickBlurAgain),
      );
      const afterAgain = mediaAnalysisRepo.findByMediaId(seeded.mediaId);
      const labelsAgain = JSON.parse(afterAgain?.labels ?? "[]") as string[];
      const stillExposure = labelsAgain.some((l) =>
        ["well-exposed", "underexposed", "overexposed", "mixed-exposure"].includes(l),
      );
      const stillColor = labelsAgain.some((l) =>
        (COLOR_DIMENSION_LABELS as readonly string[]).includes(l),
      );
      record(
        "coexistence: after blur re-run, exposure + color labels still present",
        labelsAgain.includes("sharp") && stillExposure && stillColor,
        `labels=${afterAgain?.labels ?? ""}`,
      );
      let rawAgain: Record<string, unknown> | null = null;
      try {
        rawAgain = JSON.parse(afterAgain?.rawResult ?? "null") as Record<string, unknown>;
      } catch (err) {
        console.log("  parse error:", describeError(err));
      }
      record(
        "coexistence: after blur re-run, raw_result.$.color and $.exposure still present",
        rawAgain?.color !== undefined && rawAgain?.exposure !== undefined,
        `keys=${JSON.stringify(Object.keys(rawAgain ?? {}))}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 11: failure — video media.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case11 video" });
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
      const vidJobId = insertJob(dbHandle.db, mediaId, IMAGE_QUALITY_COLOR_JOB_TYPE);
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
    // CASE 12: failure — soft-deleted media.
    // -----------------------------------------------------------------
    {
      const grey = await makeSolidRgbPng(64, 64, 128, 128, 128);
      const seededSoft = await seedTripAndImage(
        dbHandle.db,
        tripService,
        storage,
        grey,
        "Case12 soft-delete",
      );
      dbHandle.db
        .prepare(`UPDATE media_items SET deleted_at = ?, status = 'deleted' WHERE id = ?`)
        .run(new Date().toISOString(), seededSoft.mediaId);
      const sJobId = insertJob(dbHandle.db, seededSoft.mediaId, IMAGE_QUALITY_COLOR_JOB_TYPE);
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
    // CASE 13: failure — missing file.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case13 missing file" });
      const mediaId = randomUUID();
      const now = new Date().toISOString();
      dbHandle.db
        .prepare(
          `INSERT INTO media_items
             (id, trip_id, type, original_path, mime_type, extension, file_size,
              status, user_decision, created_at, updated_at)
           VALUES (?, ?, 'image', ?, 'image/png', 'png', 0,
                   'uploaded', 'undecided', ?, ?)`,
        )
        .run(mediaId, trip.id, `trips/${trip.id}/originals/${mediaId}.png`, now, now);
      const mJobId = insertJob(dbHandle.db, mediaId, IMAGE_QUALITY_COLOR_JOB_TYPE);
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
    // CASE 14: failure — empty file.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case14 empty file" });
      const mediaId = randomUUID();
      const stored = await storage.putOriginal({
        tripId: trip.id,
        mediaId,
        extension: "png",
        data: Buffer.alloc(0),
      });
      const now = new Date().toISOString();
      dbHandle.db
        .prepare(
          `INSERT INTO media_items
             (id, trip_id, type, original_path, mime_type, extension, file_size,
              status, user_decision, created_at, updated_at)
           VALUES (?, ?, 'image', ?, 'image/png', 'png', 0,
                   'uploaded', 'undecided', ?, ?)`,
        )
        .run(mediaId, trip.id, stored.logicalPath, now, now);
      const eJobId = insertJob(dbHandle.db, mediaId, IMAGE_QUALITY_COLOR_JOB_TYPE);
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
    // CASE 15: no P5 regression — duplicate_groups + items still empty.
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
    // CASE 16: JobQueue claim — production scheduler picks up
    // image_quality_color jobs on the image channel.
    // -----------------------------------------------------------------
    {
      const qBytes = await makeBalancedColourfulPng(64, 64);
      const seededQ = await seedTripAndImage(
        dbHandle.db,
        tripService,
        storage,
        qBytes,
        "Case16 JobQueue",
      );
      const queueJobId = insertJob(dbHandle.db, seededQ.mediaId, IMAGE_QUALITY_COLOR_JOB_TYPE);

      const handlers = new Map<string, JobHandler>();
      handlers.set(
        IMAGE_QUALITY_COLOR_JOB_TYPE,
        makeImageQualityColorHandler({
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
        "JobQueue: image_quality_color registered + claimed on image channel",
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
        qAnalysis !== null && typeof qAnalysis.colorScore === "number",
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
