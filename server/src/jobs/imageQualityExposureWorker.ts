// ImageWorker.quality.exposure (P6.T3).
//
// Job handler registered as `image_quality_exposure` on the image-channel
// JobQueue. For one image media row:
//   1. Resolve via `media_items.original_path`.
//   2. Read bytes through `LocalStorageProvider`.
//   3. sharp pipeline: rotate (honour EXIF), resize fit-inside to
//      `config.quality.exposure.maxEdge`, grayscale, raw 1 byte/pixel.
//   4. Compute brightness stats over the resulting greyscale plane:
//        * meanBrightness ∈ [0, 255]
//        * darkPixelRatio  — fraction with luminance ≤ DARK_PIXEL_CUTOFF
//        * brightPixelRatio — fraction with luminance ≥ BRIGHT_PIXEL_CUTOFF
//   5. Classify against the configured thresholds into one of:
//        * `well-exposed`         — mean within band, both ratios low
//        * `underexposed`         — mean too low OR too many shadow pixels
//        * `overexposed`          — mean too high OR too many highlight pixels
//        * `mixed-exposure`       — BOTH ratios above MIXED_RATIO_FLOOR
//          (high-contrast or split scenes, e.g. backlit subject)
//   6. Persist via `MediaAnalysisRepository.upsertExposureAnalysis` —
//      INSERT … ON CONFLICT(media_id) DO UPDATE so re-running is
//      idempotent. Labels merge against EXPOSURE_DIMENSION_LABELS so a
//      prior `["sharp"]` from blur survives untouched.
//
// Scope per docs/tasks.md P6.T3 — exposure only. Explicitly NOT in scope:
//   * Colour (P6.T4), aesthetic (P10).
//   * Composite `quality_score` and recommendation (P6.T5).
//   * Frontend badges / detail surface (P6.T6).
//   * Triggering this job from upload — today the row is created by
//     reprocess / manual seed and picked up by JobQueue.
//
// Idempotency:
//   * sharp's resize + grayscale + raw is deterministic over the same
//     bytes (sharp 0.33 / libvips); the brightness compute is pure JS
//     arithmetic. Re-running on the same media writes the same
//     numbers.
//   * `MediaAnalysisRepository.upsertExposureAnalysis` is a transactional
//     read-merge-write so labels survive concurrent blur / exposure
//     runs on the same row without trampling.
//   * `raw_result` is updated via `json_set(..., '$.exposure', ...)` —
//     siblings (`$.blur`, `$.color`, …) survive an exposure re-run
//     untouched.
//
// Failure modes — all throw, JobQueue marks the row `failed` with
// the thrown message (mirroring `imageHashWorker.ts` /
// `imageQualityBlurWorker.ts`):
//   * Media row missing / soft-deleted → throw `media not found …`.
//   * Media type ≠ image → throw `media is not an image …`.
//   * `original_path` null → throw `media has no original_path …`.
//   * Source file empty → throw `original file is empty`.
//   * Sharp decode error (corrupt / unsupported) → sharp's own throw
//     bubbles up.
//
// Score formulas (kept here, not in config — they describe the
// algorithm shape, not user-tunable thresholds):
//   * `brightness_score` = meanBrightness / 255 ∈ [0, 1] — raw
//     normalised brightness. Useful as a per-Trip brightness
//     percentile signal at the UI layer.
//   * `exposure_score` ∈ [0, 1] = "how well-exposed":
//       - well-exposed                       → 1
//       - underexposed by mean / dark ratio  → max(0, mean / UNDER_THRESHOLD)
//       - overexposed by mean / bright ratio → max(0, (255 - mean) / (255 - OVER_THRESHOLD))
//       - mixed-exposure                     → 1 - max(dark, bright)  (severity)
//     The blends are picked so the bias / continuity matches the
//     boundary cases: at exactly UNDER_THRESHOLD mean the formula
//     yields 1 (same as well-exposed); at mean=0 it yields 0. P6.T5
//     wants this column in [0, 1] for the weighted quality_score blend.

import type { Readable } from "node:stream";
import { randomUUID } from "node:crypto";

import sharp from "sharp";

import type { Logger } from "../logger.js";
import type { MediaAnalysisRepository, MediaRepository } from "../media/index.js";
import type { LocalStorageProvider } from "../storage/index.js";

import type { JobHandler } from "./handlerRegistry.js";

/** Closed job_type token. Registered by `server/src/index.ts` boot. */
export const IMAGE_QUALITY_EXPOSURE_JOB_TYPE = "image_quality_exposure";

/**
 * Luminance value (0..255) at which a pixel is counted as a shadow.
 * Algorithm-internal — describes "what counts as a dark pixel" rather
 * than a tunable threshold; bumping this changes the algorithm shape.
 */
export const DARK_PIXEL_CUTOFF = 30;
/** Luminance value at which a pixel is counted as a highlight. */
export const BRIGHT_PIXEL_CUTOFF = 225;
/**
 * When BOTH dark and bright pixel ratios exceed this floor, the image
 * is classified `mixed-exposure` regardless of mean luminance.
 * Default 0.25 covers the common backlit / split-scene case (a
 * dark subject against a blown-out sky).
 */
export const MIXED_RATIO_FLOOR = 0.25;

/**
 * Operational knobs the worker pulls from `Config.quality.exposure.*`
 * + the dark / bright cutoffs above. Bundled so the handler factory
 * takes a single typed shape, and tests can construct a value without
 * depending on the whole `Config`.
 */
export interface ExposureAnalysisSettings {
  readonly maxEdge: number;
  readonly underMeanThreshold: number;
  readonly overMeanThreshold: number;
  readonly darkRatioThreshold: number;
  readonly brightRatioThreshold: number;
  readonly workerVersion: string;
}

export interface ImageQualityExposureHandlerDeps {
  readonly storage: LocalStorageProvider;
  readonly mediaRepo: MediaRepository;
  readonly mediaAnalysisRepo: MediaAnalysisRepository;
  readonly settings: ExposureAnalysisSettings;
  readonly logger: Logger;
}

/** Closed label vocabulary owned by this worker. */
export type ExposureLabel = "well-exposed" | "underexposed" | "overexposed" | "mixed-exposure";

/** Classification result for one media — exported for the smoke. */
export interface ExposureClassification {
  readonly label: ExposureLabel;
  readonly underexposed: boolean;
  readonly overexposed: boolean;
  readonly reason: string;
}

/** Brightness compute output — exported so the smoke can call directly. */
export interface BrightnessStats {
  readonly width: number;
  readonly height: number;
  readonly pixelCount: number;
  readonly meanBrightness: number;
  readonly darkPixelRatio: number;
  readonly brightPixelRatio: number;
  readonly darkPixelCutoff: number;
  readonly brightPixelCutoff: number;
}

/**
 * Build the `image_quality_exposure` handler. Register the returned
 * value on the JobQueue's image-channel handler Map at boot.
 */
export function makeImageQualityExposureHandler(deps: ImageQualityExposureHandlerDeps): JobHandler {
  return async (job) => {
    const correlation = { jobId: job.id, mediaId: job.mediaId };

    // ---- 1. Resolve media row ------------------------------------------
    const media = deps.mediaRepo.findById(job.mediaId);
    if (media === null) {
      throw new Error(`media not found or soft-deleted: ${job.mediaId}`);
    }
    if (media.type !== "image") {
      throw new Error(`media is not an image (type='${media.type}'); refusing to analyse exposure`);
    }
    if (media.originalPath === null) {
      throw new Error("media has no original_path; cannot read source bytes");
    }

    // ---- 2. Read original bytes ----------------------------------------
    const sourceStream = await deps.storage.read(media.originalPath);
    const sourceBuf = await streamToBuffer(sourceStream);
    if (sourceBuf.length === 0) {
      throw new Error("original file is empty");
    }

    // ---- 3. Compute brightness stats -----------------------------------
    const stats = await computeBrightnessStats(sourceBuf, deps.settings.maxEdge);

    // ---- 4. Classify + normalise ---------------------------------------
    const classification = classifyExposure(stats, {
      underMean: deps.settings.underMeanThreshold,
      overMean: deps.settings.overMeanThreshold,
      darkRatio: deps.settings.darkRatioThreshold,
      brightRatio: deps.settings.brightRatioThreshold,
      mixedRatio: MIXED_RATIO_FLOOR,
    });
    const brightnessScore = stats.meanBrightness / 255;
    const exposureScore = scoreExposure(stats, classification, {
      underMean: deps.settings.underMeanThreshold,
      overMean: deps.settings.overMeanThreshold,
    });

    // ---- 5. Persist on media_analysis ----------------------------------
    const now = new Date().toISOString();
    const rawExposureJson = JSON.stringify({
      algorithm: "histogram-mean-thresholds",
      version: deps.settings.workerVersion,
      // Resize target the worker actually used. If the original was
      // smaller than maxEdge, sharp's withoutEnlargement keeps it
      // smaller — the actual dims are reported here, not maxEdge.
      resized: { width: stats.width, height: stats.height, maxEdge: deps.settings.maxEdge },
      pixelCount: stats.pixelCount,
      meanBrightness: roundTo(stats.meanBrightness, 4),
      darkPixelRatio: roundTo(stats.darkPixelRatio, 6),
      brightPixelRatio: roundTo(stats.brightPixelRatio, 6),
      darkPixelCutoff: stats.darkPixelCutoff,
      brightPixelCutoff: stats.brightPixelCutoff,
      underexposed: classification.underexposed,
      overexposed: classification.overexposed,
      exposureLabel: classification.label,
      thresholds: {
        underMean: deps.settings.underMeanThreshold,
        overMean: deps.settings.overMeanThreshold,
        darkRatio: deps.settings.darkRatioThreshold,
        brightRatio: deps.settings.brightRatioThreshold,
        mixedRatio: MIXED_RATIO_FLOOR,
      },
      computedAt: now,
    });

    const changed = deps.mediaAnalysisRepo.upsertExposureAnalysis({
      id: randomUUID(),
      mediaId: media.id,
      exposureScore,
      brightnessScore,
      // The repository merges this against existing labels using the
      // closed EXPOSURE_DIMENSION_LABELS vocabulary — sibling dimension
      // labels (e.g. "sharp" from P6.T2) survive an exposure re-run.
      exposureLabels: [classification.label],
      reason: classification.reason,
      rawExposureJson,
      updatedAt: now,
    });
    if (changed === 0) {
      deps.logger.warn(
        { ...correlation, mediaId: media.id },
        "image_quality_exposure: upsert reported 0 changes",
      );
    }

    deps.logger.info(
      {
        ...correlation,
        originalPath: media.originalPath,
        fileBytes: sourceBuf.length,
        resized: { width: stats.width, height: stats.height },
        meanBrightness: roundTo(stats.meanBrightness, 3),
        darkPixelRatio: roundTo(stats.darkPixelRatio, 3),
        brightPixelRatio: roundTo(stats.brightPixelRatio, 3),
        classification: classification.label,
        exposureScore: roundTo(exposureScore, 3),
        brightnessScore: roundTo(brightnessScore, 3),
      },
      "image_quality_exposure: scores computed and persisted",
    );
  };
}

// ---------------------------------------------------------------------------
// pure helpers (exported for the smoke)
// ---------------------------------------------------------------------------

/**
 * Run the sharp pipeline + 1-pass histogram-ish compute over the
 * greyscale plane. Exported so the smoke can drive the algorithm
 * directly without going through the handler / storage / DB.
 *
 * Counts all pixels (no border drop) because exposure is a global
 * statistic, unlike Laplacian variance which is interior-only.
 */
export async function computeBrightnessStats(
  sourceBuf: Buffer,
  maxEdge: number,
): Promise<BrightnessStats> {
  if (maxEdge < 1) {
    throw new Error(`maxEdge ${maxEdge} too small (must be ≥ 1)`);
  }

  const { data, info } = await sharp(sourceBuf)
    .rotate()
    .resize(maxEdge, maxEdge, { fit: "inside", withoutEnlargement: true })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const pixelCount = width * height;
  if (data.length !== pixelCount) {
    throw new Error(
      `image_quality_exposure: unexpected grayscale buffer length ${data.length} (expected ${pixelCount})`,
    );
  }
  if (pixelCount === 0) {
    throw new Error(`image_quality_exposure: resized image has zero pixels (${width}×${height})`);
  }

  let sum = 0;
  let darkCount = 0;
  let brightCount = 0;
  for (let i = 0; i < pixelCount; i += 1) {
    const v = data[i] as number;
    sum += v;
    if (v <= DARK_PIXEL_CUTOFF) darkCount += 1;
    if (v >= BRIGHT_PIXEL_CUTOFF) brightCount += 1;
  }

  return {
    width,
    height,
    pixelCount,
    meanBrightness: sum / pixelCount,
    darkPixelRatio: darkCount / pixelCount,
    brightPixelRatio: brightCount / pixelCount,
    darkPixelCutoff: DARK_PIXEL_CUTOFF,
    brightPixelCutoff: BRIGHT_PIXEL_CUTOFF,
  };
}

/**
 * Four-class exposure decision from brightness stats. Order of
 * precedence:
 *   1. BOTH dark and bright ratios above `mixedRatio` → `mixed-exposure`.
 *      A high-contrast scene where the mean is uninformative.
 *   2. mean < underMean OR darkRatio > darkRatio → `underexposed`.
 *   3. mean > overMean OR brightRatio > brightRatio → `overexposed`.
 *   4. otherwise → `well-exposed`.
 *
 * `underexposed` / `overexposed` flags are reported alongside the
 * `label`; consumers can use them for finer UI hints (e.g. "this
 * mostly-overexposed but has a small clump of shadows").
 */
export function classifyExposure(
  stats: BrightnessStats,
  thresholds: {
    readonly underMean: number;
    readonly overMean: number;
    readonly darkRatio: number;
    readonly brightRatio: number;
    readonly mixedRatio: number;
  },
): ExposureClassification {
  const { meanBrightness, darkPixelRatio, brightPixelRatio } = stats;

  const meanUnder = meanBrightness < thresholds.underMean;
  const meanOver = meanBrightness > thresholds.overMean;
  const ratioUnder = darkPixelRatio > thresholds.darkRatio;
  const ratioOver = brightPixelRatio > thresholds.brightRatio;
  const mixed = darkPixelRatio > thresholds.mixedRatio && brightPixelRatio > thresholds.mixedRatio;

  if (mixed) {
    return {
      label: "mixed-exposure",
      underexposed: false,
      overexposed: false,
      reason: `mixed-exposure (darkPixelRatio ${roundTo(darkPixelRatio, 3)} & brightPixelRatio ${roundTo(brightPixelRatio, 3)} both above ${thresholds.mixedRatio})`,
    };
  }

  const isUnder = meanUnder || ratioUnder;
  const isOver = meanOver || ratioOver;

  if (isUnder && !isOver) {
    return {
      label: "underexposed",
      underexposed: true,
      overexposed: false,
      reason: `underexposed (mean ${roundTo(meanBrightness, 2)} < ${thresholds.underMean} or darkPixelRatio ${roundTo(darkPixelRatio, 3)} > ${thresholds.darkRatio})`,
    };
  }
  if (isOver && !isUnder) {
    return {
      label: "overexposed",
      underexposed: false,
      overexposed: true,
      reason: `overexposed (mean ${roundTo(meanBrightness, 2)} > ${thresholds.overMean} or brightPixelRatio ${roundTo(brightPixelRatio, 3)} > ${thresholds.brightRatio})`,
    };
  }
  // Both `isUnder` and `isOver` simultaneously without crossing the
  // mixedRatio floor is extremely unlikely (it means a tiny clump of
  // shadows / highlights with a centred mean). Fall through to
  // mixed-exposure as the safest classification — explicit so the
  // branch is auditable.
  if (isUnder && isOver) {
    return {
      label: "mixed-exposure",
      underexposed: false,
      overexposed: false,
      reason: `mixed-exposure (mean / ratio signals are simultaneously under and over; mean=${roundTo(meanBrightness, 2)} dark=${roundTo(darkPixelRatio, 3)} bright=${roundTo(brightPixelRatio, 3)})`,
    };
  }

  return {
    label: "well-exposed",
    underexposed: false,
    overexposed: false,
    reason: `well-exposed (mean ${roundTo(meanBrightness, 2)} in [${thresholds.underMean}, ${thresholds.overMean}]; dark ${roundTo(darkPixelRatio, 3)} & bright ${roundTo(brightPixelRatio, 3)} below ratio thresholds)`,
  };
}

/**
 * Project the brightness stats + classification onto a [0, 1]
 * "well-exposed confidence" scalar. Curves are linear-with-saturation
 * inside each class so the score is continuous around the threshold
 * boundary (a one-unit shift in mean does not produce a 0 → 1 jump).
 *
 * Exported for the smoke; the worker calls this once after
 * classification.
 */
export function scoreExposure(
  stats: BrightnessStats,
  classification: ExposureClassification,
  thresholds: { readonly underMean: number; readonly overMean: number },
): number {
  if (classification.label === "well-exposed") return 1;
  if (classification.label === "mixed-exposure") {
    const severity = Math.max(stats.darkPixelRatio, stats.brightPixelRatio);
    return clamp01(1 - severity);
  }
  if (classification.label === "underexposed") {
    if (thresholds.underMean <= 0) return 0;
    return clamp01(stats.meanBrightness / thresholds.underMean);
  }
  // overexposed
  const headroom = 255 - thresholds.overMean;
  if (headroom <= 0) return 0;
  return clamp01((255 - stats.meanBrightness) / headroom);
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

function roundTo(value: number, digits: number): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}
