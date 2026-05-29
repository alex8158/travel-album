// Manual smoke test for the image_quality_finalize worker (P6.T5).
//
// Usage: npm run smoke:image-quality-finalize
//
// Drives the full handler against a real SQLite DB. The blur /
// exposure / color workers are run first (to populate
// `media_analysis`); the finalize handler then aggregates them.
//
// Coverage:
//   * Pure helpers:
//       - `temperColor` maps [0, 1] → [floor, 1] linearly.
//       - `aggregateQuality` correctly weighted-averages present
//         dimensions, renormalises when some are missing, returns
//         null when all three are missing, and ignores
//         non-finite / zero-weight inputs.
//   * End-to-end happy path: a sharp + well-exposed + balanced
//     image gets all three dimensions written then aggregated;
//     final `quality_score` is high; reason contains per-dimension
//     snippets; raw_result keeps $.blur / $.exposure / $.color AND
//     adds $.final_quality.
//   * Color soft-penalty: a sharp + well-exposed image that the
//     colour worker dings as `mixed-exposure / high-contrast / low-sat`
//     etc still scores ≥ 0.85 because of the colour floor (default
//     0.5) — colour cannot dominate.
//   * Partial dimensions: only blur present → final_quality uses
//     just that weight (renormalised to 1.0). Two dimensions
//     present → renormalised across the two.
//   * All-missing failure: an analysis row with all three scores
//     NULL → job 'failed' with `no dimensions available …`.
//   * Missing analysis row entirely → job 'failed' with `no
//     media_analysis row yet …`.
//   * Failure: media row missing / soft-deleted / non-image.
//   * Idempotency: re-tick writes the same quality_score, row
//     count stays 1, and the per-dimension columns / raw sub-trees
//     survive untouched.
//   * No P5 regression.
//   * JobQueue claim: `image_quality_finalize` job picked up by
//     the production scheduler on its image channel.

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
  IMAGE_QUALITY_FINALIZE_JOB_TYPE,
  ImageChannelExecutor,
  JobHandlerRegistry,
  JobQueue,
  JobRepository,
  aggregateQuality,
  makeImageQualityBlurHandler,
  makeImageQualityColorHandler,
  makeImageQualityExposureHandler,
  makeImageQualityFinalizeHandler,
  temperColor,
  type FinalizeQualitySettings,
  type JobHandler,
} from "../jobs/index.js";
import { createLogger } from "../logger.js";
import { MediaAnalysisRepository, MediaRepository, type MediaAnalysisRow } from "../media/index.js";
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

/** Sharp checkerboard JPEG (R=G=B=12 / 240). */
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
      const off = (y * width + x) * channels;
      pixels[off] = c;
      pixels[off + 1] = c;
      pixels[off + 2] = c;
    }
  }
  return sharp(pixels, { raw: { width, height, channels } }).jpeg({ quality: 95 }).toBuffer();
}

/**
 * Generate the same balanced colourful PNG that the color smoke uses
 * for its "all-normal" fixture. Tiles average to R=G=B=150 with
 * normal saturation + contrast → color worker labels it
 * "color-balanced" (color_score = 1).
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

async function makeSolidGreyJpeg(
  width: number,
  height: number,
  intensity: number,
): Promise<Buffer> {
  const channels = 3;
  const pixels = Buffer.alloc(width * height * channels, intensity);
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

function countAnalysisRows(db: SqliteDatabase, mediaId: string): number {
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

function syntheticAnalysisRow(args: {
  sharpnessScore: number | null;
  exposureScore: number | null;
  colorScore: number | null;
  rawResult?: string | null;
}): MediaAnalysisRow {
  return {
    id: randomUUID(),
    mediaId: randomUUID(),
    blurScore: args.sharpnessScore === null ? null : args.sharpnessScore * 200,
    sharpnessScore: args.sharpnessScore,
    exposureScore: args.exposureScore,
    brightnessScore: args.exposureScore,
    colorScore: args.colorScore,
    aestheticScore: null,
    qualityScore: null,
    isBlurry: null,
    isDuplicate: null,
    isRecommended: null,
    labels: null,
    reason: null,
    rawResult: args.rawResult ?? null,
    // P12.T5 — MediaAnalysisRow gained two AI-blur columns (migration
    // 026 / P12.T3). Synthetic fixtures default to the "not yet
    // AI-checked" sentinel; this smoke targets the Code finalize
    // worker which does not read or write these.
    aiBlurClass: null,
    aiBlurReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-image-quality-finalize-smoke-"));
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

    const settings: FinalizeQualitySettings = {
      blurWeight: 0.45,
      exposureWeight: 0.35,
      colorWeight: 0.2,
      colorFloor: 0.5,
      workerVersion: "smoke-1.0",
    };

    const registry = new JobHandlerRegistry();
    registry.register(
      IMAGE_QUALITY_FINALIZE_JOB_TYPE,
      makeImageQualityFinalizeHandler({ mediaRepo, mediaAnalysisRepo, jobRepo, settings, logger }),
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
    registry.register(
      IMAGE_QUALITY_COLOR_JOB_TYPE,
      makeImageQualityColorHandler({
        storage,
        mediaRepo,
        mediaAnalysisRepo,
        settings: {
          maxEdge: 256,
          lowSaturationThreshold: 0.1,
          highSaturationThreshold: 0.75,
          castThreshold: 30,
          lowContrastThreshold: 30,
          workerVersion: "smoke-1.0",
        },
        logger,
      }),
    );
    const executor = new ImageChannelExecutor({ jobRepo, registry, logger });

    // -----------------------------------------------------------------
    // CASE A: temperColor maps the raw [0, 1] onto [floor, 1] linearly.
    // -----------------------------------------------------------------
    {
      record(
        "temperColor(0, 0.5)=0.5",
        temperColor(0, 0.5) === 0.5,
        `value=${temperColor(0, 0.5)}`,
      );
      record(
        "temperColor(1, 0.5)=1",
        Math.abs(temperColor(1, 0.5) - 1) < 1e-9,
        `value=${temperColor(1, 0.5)}`,
      );
      record(
        "temperColor(0.5, 0.5)=0.75",
        Math.abs(temperColor(0.5, 0.5) - 0.75) < 1e-9,
        `value=${temperColor(0.5, 0.5)}`,
      );
      record(
        "temperColor(0.5, 0)=0.5 (no floor → identity)",
        Math.abs(temperColor(0.5, 0) - 0.5) < 1e-9,
        `value=${temperColor(0.5, 0)}`,
      );
      record(
        "temperColor(-0.5, 0.5)=0.5 (clamps raw)",
        temperColor(-0.5, 0.5) === 0.5,
        `value=${temperColor(-0.5, 0.5)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE B: aggregateQuality — weighted mean with all dimensions
    // -----------------------------------------------------------------
    {
      // All three at 1 → 1.
      const all1 = aggregateQuality(
        syntheticAnalysisRow({ sharpnessScore: 1, exposureScore: 1, colorScore: 1 }),
        settings,
      );
      record("aggregateQuality: all 1 → score 1", all1?.qualityScore === 1, JSON.stringify(all1));

      // Sharp + well-exposed + worst color → still high (color floor
      // 0.5 means color contributes at most 0.5×0.20 = 0.10 deficit).
      // 0.45×1 + 0.35×1 + 0.20×0.5 = 0.90.
      const sharpButGreyscale = aggregateQuality(
        syntheticAnalysisRow({ sharpnessScore: 1, exposureScore: 1, colorScore: 0 }),
        settings,
      );
      record(
        "aggregateQuality: sharp + well-exposed + worst color → ≥ 0.85",
        sharpButGreyscale !== null && Math.abs(sharpButGreyscale.qualityScore - 0.9) < 1e-9,
        `score=${String(sharpButGreyscale?.qualityScore)}`,
      );

      // All 0 → 0.20 × 0.5 = 0.10. With color floor protecting the
      // "all low" case from being a flat 0.5, this is now < 0.5.
      const allZero = aggregateQuality(
        syntheticAnalysisRow({ sharpnessScore: 0, exposureScore: 0, colorScore: 0 }),
        settings,
      );
      record(
        "aggregateQuality: all 0 → 0.10 (color floor floor × weight)",
        allZero !== null && Math.abs(allZero.qualityScore - 0.1) < 1e-9,
        `score=${String(allZero?.qualityScore)}`,
      );

      // All 0.5 (the "low+low+low pushes everything to 0.5" concern):
      // blur 0.5 + exp 0.5 are flat; color 0.5 tempers to 0.75.
      // 0.45×0.5 + 0.35×0.5 + 0.20×0.75 = 0.55 (NOT 0.5 — colour
      // dimension softened).
      const allHalf = aggregateQuality(
        syntheticAnalysisRow({ sharpnessScore: 0.5, exposureScore: 0.5, colorScore: 0.5 }),
        settings,
      );
      record(
        "aggregateQuality: all 0.5 → 0.55 (color tempering lifts above linear)",
        allHalf !== null && Math.abs(allHalf.qualityScore - 0.55) < 1e-9,
        `score=${String(allHalf?.qualityScore)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE C: aggregateQuality — partial dimensions + renormalisation
    // -----------------------------------------------------------------
    {
      // Only blur (sharpness=0.8) → weights renormalise to {blur: 1}.
      // score = 0.8.
      const blurOnly = aggregateQuality(
        syntheticAnalysisRow({ sharpnessScore: 0.8, exposureScore: null, colorScore: null }),
        settings,
      );
      record(
        "aggregateQuality: only blur → score = blur (weight renormalises to 1)",
        blurOnly?.qualityScore === 0.8 &&
          blurOnly.used.length === 1 &&
          Math.abs((blurOnly.used[0]?.normalisedWeight ?? 0) - 1) < 1e-9,
        JSON.stringify(blurOnly),
      );
      record(
        "aggregateQuality: only blur → skipped = ['exposure', 'color']",
        JSON.stringify(blurOnly?.skipped) === JSON.stringify(["exposure", "color"]),
        JSON.stringify(blurOnly?.skipped),
      );

      // Blur + exposure (no color) — renormalise:
      //   blur (0.45) / (0.45+0.35) = 0.5625
      //   exposure (0.35) / 0.80 = 0.4375
      //   composite = 0.5625*1 + 0.4375*0.5 = 0.78125
      const noColor = aggregateQuality(
        syntheticAnalysisRow({ sharpnessScore: 1, exposureScore: 0.5, colorScore: null }),
        settings,
      );
      record(
        "aggregateQuality: blur + exposure (no color) → renormalised composite",
        noColor !== null && Math.abs(noColor.qualityScore - 0.78125) < 1e-9,
        `score=${String(noColor?.qualityScore)} used=${JSON.stringify(noColor?.used.map((d) => d.name))}`,
      );

      // All three NULL → null aggregate (caller throws).
      const noData = aggregateQuality(
        syntheticAnalysisRow({ sharpnessScore: null, exposureScore: null, colorScore: null }),
        settings,
      );
      record("aggregateQuality: all missing → returns null", noData === null, String(noData));

      // Non-finite skipped: NaN sharpness is treated as missing.
      const withNaN = aggregateQuality(
        syntheticAnalysisRow({ sharpnessScore: Number.NaN, exposureScore: 1, colorScore: 1 }),
        settings,
      );
      record(
        "aggregateQuality: NaN sharpness is skipped, used = [exposure, color]",
        withNaN !== null &&
          withNaN.used.length === 2 &&
          withNaN.used.every((d) => d.name !== "blur"),
        JSON.stringify(withNaN?.used.map((d) => d.name)),
      );
    }

    // -----------------------------------------------------------------
    // CASE 1: end-to-end happy path — sharp checkerboard JPEG
    //         (greyscale + high-contrast on the colour side).
    // -----------------------------------------------------------------
    const sharpJpeg = await makeSharpCheckerboardJpeg(96, 96, 4);
    const seededSharp = await seedTripAndImage(
      dbHandle.db,
      tripService,
      storage,
      sharpJpeg,
      "Case1 sharp",
    );
    // Run the three per-dimension workers to populate the analysis row.
    insertJob(dbHandle.db, seededSharp.mediaId, IMAGE_QUALITY_BLUR_JOB_TYPE);
    await executor.tick();
    insertJob(dbHandle.db, seededSharp.mediaId, IMAGE_QUALITY_EXPOSURE_JOB_TYPE);
    await executor.tick();
    insertJob(dbHandle.db, seededSharp.mediaId, IMAGE_QUALITY_COLOR_JOB_TYPE);
    await executor.tick();

    const beforeFinalize = mediaAnalysisRepo.findByMediaId(seededSharp.mediaId);
    record(
      "happy: per-dimension scores populated before finalize",
      beforeFinalize !== null &&
        typeof beforeFinalize.sharpnessScore === "number" &&
        typeof beforeFinalize.exposureScore === "number" &&
        typeof beforeFinalize.colorScore === "number",
      `sharp=${String(beforeFinalize?.sharpnessScore)} exp=${String(beforeFinalize?.exposureScore)} col=${String(beforeFinalize?.colorScore)}`,
    );

    const finalizeJobId = insertJob(
      dbHandle.db,
      seededSharp.mediaId,
      IMAGE_QUALITY_FINALIZE_JOB_TYPE,
    );
    const tick1 = await executor.tick();
    record(
      "happy: finalize tick outcome=success",
      tick1.outcome === "success" && tick1.jobId === finalizeJobId,
      JSON.stringify(tick1),
    );
    const after = mediaAnalysisRepo.findByMediaId(seededSharp.mediaId);
    record(
      "happy: quality_score in [0, 1] populated",
      typeof after?.qualityScore === "number" && after.qualityScore >= 0 && after.qualityScore <= 1,
      `qualityScore=${String(after?.qualityScore)}`,
    );
    // Sharp checkerboard JPEG: blur=1 (sharp), exposure=0.5
    // (mixed-exposure dark+bright ratios), color=0.5 (low-sat +
    // high-contrast). Composite ≈ 0.45×1 + 0.35×0.5 + 0.20×0.75
    // = 0.45 + 0.175 + 0.15 = 0.775.
    record(
      "happy: sharp + mixed-exposure + greyscale → composite ≥ 0.70 (colour cannot drag it down)",
      typeof after?.qualityScore === "number" && after.qualityScore >= 0.7,
      `qualityScore=${String(after?.qualityScore)}`,
    );
    record(
      "happy: per-dimension scores survive finalize (unchanged)",
      after?.sharpnessScore === beforeFinalize?.sharpnessScore &&
        after?.exposureScore === beforeFinalize?.exposureScore &&
        after?.colorScore === beforeFinalize?.colorScore,
      JSON.stringify({
        sharp: after?.sharpnessScore,
        exp: after?.exposureScore,
        col: after?.colorScore,
      }),
    );

    // reason includes per-dimension snippets + weights summary.
    record(
      "happy: reason starts with 'final quality '",
      typeof after?.reason === "string" && after.reason.startsWith("final quality "),
      `reason=${String(after?.reason)}`,
    );
    record(
      "happy: reason mentions all three dimensions + weight breakdown",
      typeof after?.reason === "string" &&
        after.reason.includes("blur=") &&
        after.reason.includes("exposure=") &&
        after.reason.includes("color=") &&
        after.reason.includes("weights"),
      `reason=${String(after?.reason)}`,
    );

    // raw_result holds all four sub-trees: $.blur / $.exposure / $.color / $.final_quality.
    let raw: Record<string, unknown> | null = null;
    try {
      raw = JSON.parse(after?.rawResult ?? "null") as Record<string, unknown>;
    } catch (err) {
      console.log("  parse error:", describeError(err));
    }
    record(
      "happy: raw_result keeps $.blur / $.exposure / $.color",
      raw?.blur !== undefined && raw?.exposure !== undefined && raw?.color !== undefined,
      `keys=${JSON.stringify(Object.keys(raw ?? {}))}`,
    );
    record(
      "happy: raw_result.$.final_quality has algorithm + version + usedDimensions",
      raw?.final_quality !== undefined &&
        (raw.final_quality as { algorithm?: string }).algorithm ===
          "weighted-mean-with-color-floor" &&
        Array.isArray((raw.final_quality as { usedDimensions?: unknown }).usedDimensions),
      JSON.stringify(raw?.final_quality),
    );
    const finalNode = (raw?.final_quality ?? null) as {
      qualityScore?: number;
      usedDimensions?: { name: string; effectiveScore?: number; normalisedWeight?: number }[];
      skippedDimensions?: string[];
      configuredWeights?: { blur?: number; exposure?: number; color?: number };
      colorFloor?: number;
    } | null;
    record(
      "happy: raw_result.$.final_quality records all three dims as used",
      Array.isArray(finalNode?.usedDimensions) &&
        finalNode?.usedDimensions?.length === 3 &&
        JSON.stringify(finalNode?.skippedDimensions) === "[]",
      JSON.stringify(finalNode?.usedDimensions),
    );
    record(
      "happy: raw_result.$.final_quality records configuredWeights + colorFloor",
      finalNode?.colorFloor === 0.5 &&
        finalNode?.configuredWeights?.blur === 0.45 &&
        finalNode?.configuredWeights?.exposure === 0.35 &&
        finalNode?.configuredWeights?.color === 0.2,
      JSON.stringify({
        weights: finalNode?.configuredWeights,
        floor: finalNode?.colorFloor,
      }),
    );

    // -----------------------------------------------------------------
    // CASE 2: idempotency on Case1 row.
    // -----------------------------------------------------------------
    {
      const before = countAnalysisRows(dbHandle.db, seededSharp.mediaId);
      const beforeScore = after?.qualityScore ?? null;
      insertJob(dbHandle.db, seededSharp.mediaId, IMAGE_QUALITY_FINALIZE_JOB_TYPE);
      const tick = await executor.tick();
      record(
        "idempotent: re-tick success on already-finalized media",
        tick.outcome === "success",
        JSON.stringify(tick),
      );
      const afterAgain = mediaAnalysisRepo.findByMediaId(seededSharp.mediaId);
      record(
        "idempotent: quality_score unchanged across re-run",
        afterAgain?.qualityScore === beforeScore,
        `before=${String(beforeScore)} after=${String(afterAgain?.qualityScore)}`,
      );
      record(
        "idempotent: still exactly 1 media_analysis row for this media",
        before === 1 && countAnalysisRows(dbHandle.db, seededSharp.mediaId) === 1,
        `count_before=${before}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 3: partial dimensions — only blur + exposure present.
    // -----------------------------------------------------------------
    {
      const grey = await makeSolidGreyJpeg(64, 64, 128);
      const seeded = await seedTripAndImage(
        dbHandle.db,
        tripService,
        storage,
        grey,
        "Case3 partial",
      );
      // Run blur + exposure, skip colour.
      insertJob(dbHandle.db, seeded.mediaId, IMAGE_QUALITY_BLUR_JOB_TYPE);
      await executor.tick();
      insertJob(dbHandle.db, seeded.mediaId, IMAGE_QUALITY_EXPOSURE_JOB_TYPE);
      await executor.tick();
      insertJob(dbHandle.db, seeded.mediaId, IMAGE_QUALITY_FINALIZE_JOB_TYPE);
      const tick = await executor.tick();
      record(
        "partial: finalize tick outcome=success",
        tick.outcome === "success",
        JSON.stringify(tick),
      );
      const a = mediaAnalysisRepo.findByMediaId(seeded.mediaId);
      record(
        "partial: quality_score populated",
        typeof a?.qualityScore === "number",
        `qualityScore=${String(a?.qualityScore)}`,
      );
      let r: Record<string, unknown> | null = null;
      try {
        r = JSON.parse(a?.rawResult ?? "null") as Record<string, unknown>;
      } catch {
        /* ignore */
      }
      const node = (r?.final_quality ?? null) as {
        skippedDimensions?: string[];
        usedDimensions?: { name: string }[];
      } | null;
      record(
        "partial: final_quality.skippedDimensions=['color']",
        JSON.stringify(node?.skippedDimensions) === '["color"]',
        JSON.stringify(node?.skippedDimensions),
      );
      record(
        "partial: usedDimensions = ['blur', 'exposure']",
        JSON.stringify(node?.usedDimensions?.map((d) => d.name)) === '["blur","exposure"]',
        JSON.stringify(node?.usedDimensions?.map((d) => d.name)),
      );
    }

    // -----------------------------------------------------------------
    // CASE 4: all-missing failure — analysis row exists but every
    // dimension score is NULL.
    // -----------------------------------------------------------------
    {
      const grey = await makeSolidGreyJpeg(48, 48, 128);
      const seeded = await seedTripAndImage(
        dbHandle.db,
        tripService,
        storage,
        grey,
        "Case4 empty analysis",
      );
      // Seed a media_analysis row with NULL scores so the finalizer
      // has a row to read but nothing to aggregate.
      dbHandle.db
        .prepare(
          `INSERT INTO media_analysis (id, media_id, created_at, updated_at) VALUES (?, ?, ?, ?)`,
        )
        .run(randomUUID(), seeded.mediaId, new Date().toISOString(), new Date().toISOString());
      const jobId = insertJob(dbHandle.db, seeded.mediaId, IMAGE_QUALITY_FINALIZE_JOB_TYPE);
      const tick = await executor.tick();
      const job = readJob(dbHandle.db, jobId);
      record(
        "all-missing: tick outcome=failed + error mentions 'no dimensions available'",
        tick.outcome === "failed" &&
          job?.status === "failed" &&
          /no dimensions available/i.test(String(job?.error_message)),
        `outcome=${tick.outcome} err=${String(job?.error_message)}`,
      );
      const after = mediaAnalysisRepo.findByMediaId(seeded.mediaId);
      record(
        "all-missing: quality_score stays NULL on failure",
        after?.qualityScore === null,
        `qualityScore=${String(after?.qualityScore)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 5: failure — no media_analysis row exists at all.
    // -----------------------------------------------------------------
    {
      const grey = await makeSolidGreyJpeg(48, 48, 128);
      const seeded = await seedTripAndImage(
        dbHandle.db,
        tripService,
        storage,
        grey,
        "Case5 no analysis row",
      );
      // NO blur/exposure/color run → no media_analysis row.
      const jobId = insertJob(dbHandle.db, seeded.mediaId, IMAGE_QUALITY_FINALIZE_JOB_TYPE);
      const tick = await executor.tick();
      const job = readJob(dbHandle.db, jobId);
      record(
        "no analysis row: tick outcome=failed + error mentions 'no media_analysis row'",
        tick.outcome === "failed" &&
          job?.status === "failed" &&
          /no media_analysis row/i.test(String(job?.error_message)),
        `outcome=${tick.outcome} err=${String(job?.error_message)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 6: failure — soft-deleted media.
    // -----------------------------------------------------------------
    {
      const grey = await makeSolidGreyJpeg(48, 48, 128);
      const seeded = await seedTripAndImage(
        dbHandle.db,
        tripService,
        storage,
        grey,
        "Case6 soft-delete",
      );
      dbHandle.db
        .prepare(`UPDATE media_items SET deleted_at = ?, status = 'deleted' WHERE id = ?`)
        .run(new Date().toISOString(), seeded.mediaId);
      const jobId = insertJob(dbHandle.db, seeded.mediaId, IMAGE_QUALITY_FINALIZE_JOB_TYPE);
      const tick = await executor.tick();
      const job = readJob(dbHandle.db, jobId);
      record(
        "soft-deleted media: tick outcome=failed",
        tick.outcome === "failed" &&
          job?.status === "failed" &&
          /soft-deleted|not found/i.test(String(job?.error_message)),
        `outcome=${tick.outcome} err=${String(job?.error_message)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 7: failure — non-image media.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case7 video" });
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
      const jobId = insertJob(dbHandle.db, mediaId, IMAGE_QUALITY_FINALIZE_JOB_TYPE);
      const tick = await executor.tick();
      const job = readJob(dbHandle.db, jobId);
      record(
        "video media: tick outcome=failed + error mentions 'not an image'",
        tick.outcome === "failed" &&
          job?.status === "failed" &&
          /not an image/i.test(String(job?.error_message)),
        `outcome=${tick.outcome} err=${String(job?.error_message)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 8: colour does NOT dominate — sharp + well-exposed
    // balanced image. Even with worst-case colour the composite is
    // ≥ 0.85. (Real-world: a clean photo with a stylistic colour
    // grade shouldn't be punished.)
    // -----------------------------------------------------------------
    {
      const balanced = await makeBalancedColourfulPng(96, 96);
      const seeded = await seedTripAndImage(
        dbHandle.db,
        tripService,
        storage,
        balanced,
        "Case8 balanced",
        "png",
      );
      insertJob(dbHandle.db, seeded.mediaId, IMAGE_QUALITY_BLUR_JOB_TYPE);
      await executor.tick();
      insertJob(dbHandle.db, seeded.mediaId, IMAGE_QUALITY_EXPOSURE_JOB_TYPE);
      await executor.tick();
      insertJob(dbHandle.db, seeded.mediaId, IMAGE_QUALITY_COLOR_JOB_TYPE);
      await executor.tick();
      insertJob(dbHandle.db, seeded.mediaId, IMAGE_QUALITY_FINALIZE_JOB_TYPE);
      const tick = await executor.tick();
      record(
        "color-friendly: finalize tick outcome=success",
        tick.outcome === "success",
        JSON.stringify(tick),
      );
      const a = mediaAnalysisRepo.findByMediaId(seeded.mediaId);
      record(
        "color-friendly: sharp + well-exposed + balanced → quality ≥ 0.90",
        typeof a?.qualityScore === "number" && a.qualityScore >= 0.9,
        `qualityScore=${String(a?.qualityScore)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 9: no P5 regression — duplicate_groups + items still empty.
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
    // CASE 10: JobQueue claim.
    // -----------------------------------------------------------------
    {
      const grey = await makeSolidGreyJpeg(48, 48, 128);
      const seeded = await seedTripAndImage(
        dbHandle.db,
        tripService,
        storage,
        grey,
        "Case10 JobQueue",
      );
      insertJob(dbHandle.db, seeded.mediaId, IMAGE_QUALITY_EXPOSURE_JOB_TYPE);
      await executor.tick();
      const queueJobId = insertJob(dbHandle.db, seeded.mediaId, IMAGE_QUALITY_FINALIZE_JOB_TYPE);

      const handlers = new Map<string, JobHandler>();
      handlers.set(
        IMAGE_QUALITY_FINALIZE_JOB_TYPE,
        makeImageQualityFinalizeHandler({
          mediaRepo,
          mediaAnalysisRepo,
          jobRepo,
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
        "JobQueue: image_quality_finalize registered + claimed on image channel",
        tickResult.claimed.length === 1 && tickResult.claimed[0]?.jobId === queueJobId,
        `claimed=${JSON.stringify(tickResult.claimed)}`,
      );
      const qJob = readJob(dbHandle.db, queueJobId);
      record(
        "JobQueue: job ended status='success'",
        qJob?.status === "success",
        `status=${String(qJob?.status)} err=${String(qJob?.error_message)}`,
      );
      const qAnalysis = mediaAnalysisRepo.findByMediaId(seeded.mediaId);
      record(
        "JobQueue: quality_score populated by handler",
        typeof qAnalysis?.qualityScore === "number",
        `qualityScore=${String(qAnalysis?.qualityScore)}`,
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
