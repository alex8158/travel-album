// ImageWorker.quality.color (P6.T4).
//
// Job handler registered as `image_quality_color` on the image-channel
// JobQueue. For one image media row:
//   1. Resolve via `media_items.original_path`.
//   2. Read bytes through `LocalStorageProvider`.
//   3. sharp pipeline: rotate (honour EXIF), resize fit-inside to
//      `config.quality.color.maxEdge`, **keep RGB** (no greyscale),
//      raw 3 bytes/pixel.
//   4. One pass over the pixel plane computes:
//        * per-channel sums → meanR / meanG / meanB
//        * HSV saturation per pixel + accumulators for mean / std and
//          low / high saturation ratios
//        * luminance per pixel (Rec.601 weights) → mean + std for
//          contrast scoring
//   5. Three orthogonal sub-classifications drive the labels:
//        * saturation     — low / normal / high (one label or none)
//        * channel cast   — balanced / warm / cool / green / magenta
//        * contrast       — low / normal / high
//      If ALL three are normal the worker emits `["color-balanced"]`
//      so "checked + nothing wrong" is distinguishable from "not yet
//      evaluated" (which is `labels` NULL or no colour-prefixed tag).
//   6. Persist via `MediaAnalysisRepository.upsertColorAnalysis` —
//      INSERT … ON CONFLICT(media_id) DO UPDATE so re-running is
//      idempotent. Labels merge against COLOR_DIMENSION_LABELS so any
//      prior `["sharp", "well-exposed"]` survives untouched.
//
// Scope per docs/tasks.md P6.T4 — colour only. Explicitly NOT in scope:
//   * Composite `quality_score` + recommendation (P6.T5).
//   * Aesthetic scoring (P10).
//   * Frontend badges / detail surface (P6.T6).
//   * Triggering this job from upload — today the row is created by
//     reprocess / manual seed and picked up by JobQueue.
//
// Idempotency:
//   * sharp's resize keep-RGB raw is deterministic over the same
//     bytes; the HSV + luminance compute is pure JS arithmetic.
//   * `MediaAnalysisRepository.upsertColorAnalysis` is a transactional
//     read-merge-write so labels survive concurrent dimension runs.
//   * `raw_result` is updated via `json_set(..., '$.color', ...)` —
//     siblings (`$.blur`, `$.exposure`, …) survive an exposure
//     re-run untouched.
//
// Failure modes — all throw, JobQueue marks the row `failed` with
// the thrown message (mirroring the other quality workers):
//   * Media row missing / soft-deleted → throw `media not found …`.
//   * Media type ≠ image → throw `media is not an image …`.
//   * `original_path` null → throw `media has no original_path …`.
//   * Source file empty → throw `original file is empty`.
//   * Sharp decode error (corrupt / unsupported) → sharp's own throw
//     bubbles up.
//
// Score formula — kept here (not in config) because it describes the
// shape of the algorithm, not user-tunable thresholds. The composite
// `color_score` ∈ [0, 1] is `min(satScore, castScore, contrastScore)`
// where:
//   * satScore       — 1 if saturation in [low, high] band, else 0.5
//                      (a flat penalty: low and high saturation both
//                      indicate a "fix me" colour state).
//   * castScore      — 1 - clamp01(max(0, spread - castThreshold)
//                      / 255). Spread is the max - min of channel
//                      means; subtracting the threshold makes the
//                      score continuous around the cast boundary.
//   * contrastScore  — 1 if luminance std in [low, high] band, else
//                      0.5 (mirrors satScore semantics).
// `min` is intentional — colour_score reports the WORST sub-issue so
// a single problem can't be hidden by two healthy axes.

import type { Readable } from "node:stream";
import { randomUUID } from "node:crypto";

import sharp from "sharp";

import type { Logger } from "../logger.js";
import type { MediaAnalysisRepository, MediaRepository } from "../media/index.js";
import type { LocalStorageProvider } from "../storage/index.js";

import type { JobHandler } from "./handlerRegistry.js";

/** Closed job_type token. Registered by `server/src/index.ts` boot. */
export const IMAGE_QUALITY_COLOR_JOB_TYPE = "image_quality_color";

/**
 * Saturation cutoff for the "low-saturation pixel" counter. A pixel
 * with HSV saturation below this is treated as effectively greyscale
 * for the `lowSaturationRatio` aggregate.
 *
 * Algorithm-internal — bumping it changes how the ratio is reported,
 * NOT the threshold for "is the IMAGE low-sat" (that lives in the
 * configurable `lowSaturationThreshold` on the worker settings).
 */
export const LOW_SATURATION_PIXEL_CUTOFF = 0.1;
/** Mirror of {@link LOW_SATURATION_PIXEL_CUTOFF} for the high end. */
export const HIGH_SATURATION_PIXEL_CUTOFF = 0.85;
/**
 * Luminance standard deviation above which the image is also flagged
 * `color-high-contrast`. The "low" end is the env-tunable
 * `lowContrastThreshold` (the common "muddy / hazy" case); the high
 * end is hardcoded because high-contrast scenes are stylistic, not a
 * "fix me" signal — we surface the label but expose no knob.
 */
export const HIGH_CONTRAST_CUTOFF = 90;

/** Operational knobs the worker pulls from `Config.quality.color.*`. */
export interface ColorAnalysisSettings {
  readonly maxEdge: number;
  readonly lowSaturationThreshold: number;
  readonly highSaturationThreshold: number;
  readonly castThreshold: number;
  readonly lowContrastThreshold: number;
  readonly workerVersion: string;
}

export interface ImageQualityColorHandlerDeps {
  readonly storage: LocalStorageProvider;
  readonly mediaRepo: MediaRepository;
  readonly mediaAnalysisRepo: MediaAnalysisRepository;
  readonly settings: ColorAnalysisSettings;
  readonly logger: Logger;
}

/** Closed cast vocabulary — channel-balance direction. */
export type ColorCast = "balanced" | "warm-cast" | "cool-cast" | "green-cast" | "magenta-cast";
/** Closed saturation classification. */
export type SaturationClass = "low" | "normal" | "high";
/** Closed contrast classification. */
export type ContrastClass = "low" | "normal" | "high";

/** Aggregated stats over the resized RGB plane. Exported for smoke. */
export interface ColorStats {
  readonly width: number;
  readonly height: number;
  readonly pixelCount: number;
  readonly meanR: number;
  readonly meanG: number;
  readonly meanB: number;
  readonly meanSaturation: number;
  readonly saturationStd: number;
  readonly lowSaturationRatio: number;
  readonly highSaturationRatio: number;
  readonly meanLuminance: number;
  readonly luminanceStd: number;
}

/** Classification result for one media — exported for the smoke. */
export interface ColorClassification {
  readonly saturationClass: SaturationClass;
  readonly cast: ColorCast;
  readonly contrastClass: ContrastClass;
  /** Channel mean max - min (0..255), used for cast severity. */
  readonly channelSpread: number;
  readonly labels: readonly string[];
  readonly reason: string;
}

/**
 * Build the `image_quality_color` handler. Register the returned
 * value on the JobQueue's image-channel handler Map at boot.
 */
export function makeImageQualityColorHandler(deps: ImageQualityColorHandlerDeps): JobHandler {
  return async (job) => {
    const correlation = { jobId: job.id, mediaId: job.mediaId };

    // ---- 1. Resolve media row ------------------------------------------
    const media = deps.mediaRepo.findById(job.mediaId);
    if (media === null) {
      throw new Error(`media not found or soft-deleted: ${job.mediaId}`);
    }
    if (media.type !== "image") {
      throw new Error(`media is not an image (type='${media.type}'); refusing to analyse colour`);
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

    // ---- 3. Compute colour stats ---------------------------------------
    const stats = await computeColorStats(sourceBuf, deps.settings.maxEdge);

    // ---- 4. Classify + score -------------------------------------------
    const classification = classifyColor(stats, {
      lowSaturation: deps.settings.lowSaturationThreshold,
      highSaturation: deps.settings.highSaturationThreshold,
      cast: deps.settings.castThreshold,
      lowContrast: deps.settings.lowContrastThreshold,
      highContrast: HIGH_CONTRAST_CUTOFF,
    });
    const colorScore = scoreColor(stats, classification, {
      cast: deps.settings.castThreshold,
    });

    // ---- 5. Persist on media_analysis ----------------------------------
    const now = new Date().toISOString();
    const rawColorJson = JSON.stringify({
      algorithm: "hsv-channel-balance-luminance",
      version: deps.settings.workerVersion,
      resized: { width: stats.width, height: stats.height, maxEdge: deps.settings.maxEdge },
      pixelCount: stats.pixelCount,
      meanSaturation: roundTo(stats.meanSaturation, 6),
      saturationStd: roundTo(stats.saturationStd, 6),
      lowSaturationRatio: roundTo(stats.lowSaturationRatio, 6),
      highSaturationRatio: roundTo(stats.highSaturationRatio, 6),
      meanRgb: {
        r: roundTo(stats.meanR, 4),
        g: roundTo(stats.meanG, 4),
        b: roundTo(stats.meanB, 4),
      },
      channelBalance: {
        spread: roundTo(classification.channelSpread, 4),
        max: roundTo(Math.max(stats.meanR, stats.meanG, stats.meanB), 4),
        min: roundTo(Math.min(stats.meanR, stats.meanG, stats.meanB), 4),
      },
      colorCast: classification.cast,
      meanLuminance: roundTo(stats.meanLuminance, 4),
      luminanceStd: roundTo(stats.luminanceStd, 4),
      contrastScore: roundTo(scoreContrastOnly(stats, classification), 6),
      saturationClass: classification.saturationClass,
      contrastClass: classification.contrastClass,
      colorLabel: classification.cast,
      labels: classification.labels,
      pixelCutoffs: {
        lowSaturation: LOW_SATURATION_PIXEL_CUTOFF,
        highSaturation: HIGH_SATURATION_PIXEL_CUTOFF,
        highContrast: HIGH_CONTRAST_CUTOFF,
      },
      thresholds: {
        lowSaturation: deps.settings.lowSaturationThreshold,
        highSaturation: deps.settings.highSaturationThreshold,
        cast: deps.settings.castThreshold,
        lowContrast: deps.settings.lowContrastThreshold,
        highContrast: HIGH_CONTRAST_CUTOFF,
      },
      computedAt: now,
    });

    const changed = deps.mediaAnalysisRepo.upsertColorAnalysis({
      id: randomUUID(),
      mediaId: media.id,
      colorScore,
      // Repository merges these against existing labels using the
      // closed COLOR_DIMENSION_LABELS vocabulary — sibling dimension
      // labels (e.g. "sharp" from blur, "well-exposed" from exposure)
      // survive untouched.
      colorLabels: classification.labels,
      reason: classification.reason,
      rawColorJson,
      updatedAt: now,
    });
    if (changed === 0) {
      deps.logger.warn(
        { ...correlation, mediaId: media.id },
        "image_quality_color: upsert reported 0 changes",
      );
    }

    deps.logger.info(
      {
        ...correlation,
        originalPath: media.originalPath,
        fileBytes: sourceBuf.length,
        resized: { width: stats.width, height: stats.height },
        meanSaturation: roundTo(stats.meanSaturation, 3),
        meanRgb: {
          r: roundTo(stats.meanR, 2),
          g: roundTo(stats.meanG, 2),
          b: roundTo(stats.meanB, 2),
        },
        cast: classification.cast,
        saturationClass: classification.saturationClass,
        contrastClass: classification.contrastClass,
        labels: classification.labels,
        colorScore: roundTo(colorScore, 3),
      },
      "image_quality_color: scores computed and persisted",
    );
  };
}

// ---------------------------------------------------------------------------
// pure helpers (exported for the smoke)
// ---------------------------------------------------------------------------

/**
 * Run the sharp pipeline + 1-pass RGB compute. Exported so the smoke
 * can drive the algorithm directly without going through the handler
 * / storage / DB.
 */
export async function computeColorStats(sourceBuf: Buffer, maxEdge: number): Promise<ColorStats> {
  if (maxEdge < 1) {
    throw new Error(`maxEdge ${maxEdge} too small (must be ≥ 1)`);
  }

  const { data, info } = await sharp(sourceBuf)
    .rotate()
    .resize(maxEdge, maxEdge, { fit: "inside", withoutEnlargement: true })
    // Drop alpha so the iteration step is always exactly 3 bytes/pixel.
    // (`.toColorspace("srgb")` is sharp's no-op default for ordinary
    // JPEG / PNG sources.)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  if (channels !== 3) {
    throw new Error(
      `image_quality_color: expected 3-channel RGB after removeAlpha, got ${channels}`,
    );
  }
  const pixelCount = width * height;
  if (data.length !== pixelCount * 3) {
    throw new Error(
      `image_quality_color: unexpected raw buffer length ${data.length} (expected ${pixelCount * 3})`,
    );
  }
  if (pixelCount === 0) {
    throw new Error(`image_quality_color: resized image has zero pixels (${width}×${height})`);
  }

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumSat = 0;
  let sumSatSq = 0;
  let lowSatPixels = 0;
  let highSatPixels = 0;
  let sumLum = 0;
  let sumLumSq = 0;

  for (let i = 0; i < pixelCount; i += 1) {
    const off = i * 3;
    const r = data[off] as number;
    const g = data[off + 1] as number;
    const b = data[off + 2] as number;

    sumR += r;
    sumG += g;
    sumB += b;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    // HSV saturation in [0, 1]. Pure-black pixels (max=0) report
    // S=0, which is consistent with "no colour information" — a
    // black photo has no perceivable hue.
    const sat = max === 0 ? 0 : (max - min) / max;
    sumSat += sat;
    sumSatSq += sat * sat;
    if (sat <= LOW_SATURATION_PIXEL_CUTOFF) lowSatPixels += 1;
    if (sat >= HIGH_SATURATION_PIXEL_CUTOFF) highSatPixels += 1;

    // Rec.601 luminance — close to what the eye perceives, also the
    // standard sharp uses for its `.greyscale()` op. Keeps colour
    // metrics consistent with the blur / exposure workers which
    // greyscale via sharp.
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    sumLum += lum;
    sumLumSq += lum * lum;
  }

  const n = pixelCount;
  const meanR = sumR / n;
  const meanG = sumG / n;
  const meanB = sumB / n;
  const meanSat = sumSat / n;
  // Var(X) = E[X²] - E[X]². Clamp tiny negatives from floating-point
  // round-off to 0 before sqrt.
  const satVar = Math.max(0, sumSatSq / n - meanSat * meanSat);
  const meanLum = sumLum / n;
  const lumVar = Math.max(0, sumLumSq / n - meanLum * meanLum);

  return {
    width,
    height,
    pixelCount: n,
    meanR,
    meanG,
    meanB,
    meanSaturation: meanSat,
    saturationStd: Math.sqrt(satVar),
    lowSaturationRatio: lowSatPixels / n,
    highSaturationRatio: highSatPixels / n,
    meanLuminance: meanLum,
    luminanceStd: Math.sqrt(lumVar),
  };
}

/**
 * Compose the three orthogonal sub-classifications + emit the labels
 * + a one-line human-readable reason.
 *
 * Cast direction is determined by channel-mean dominance:
 *   * `spread = max(R,G,B) - min(R,G,B)`. When `spread < cast` →
 *     `balanced`.
 *   * Otherwise: if G is the lowest channel by a clear margin AND
 *     R + B are close to each other → `magenta-cast` (R/B both high,
 *     G low — the classic green-cast complementary).
 *   * Else the highest channel decides: R → `warm-cast`,
 *     G → `green-cast`, B → `cool-cast`.
 *
 * Labels:
 *   * Always emits at most ONE saturation label (or none if normal).
 *   * Always emits at most ONE cast label (or none if balanced).
 *   * Always emits at most ONE contrast label (or none if normal).
 *   * If ALL three are normal → emits `["color-balanced"]` so the
 *     "checked + nothing wrong" signal is explicit in the label
 *     array (distinguishing from "not yet evaluated" where the
 *     column is NULL or has no colour-prefixed entries).
 */
export function classifyColor(
  stats: ColorStats,
  thresholds: {
    readonly lowSaturation: number;
    readonly highSaturation: number;
    readonly cast: number;
    readonly lowContrast: number;
    readonly highContrast: number;
  },
): ColorClassification {
  const max = Math.max(stats.meanR, stats.meanG, stats.meanB);
  const min = Math.min(stats.meanR, stats.meanG, stats.meanB);
  const spread = max - min;

  const cast = classifyCast(stats, spread, thresholds.cast);

  const saturationClass: SaturationClass =
    stats.meanSaturation < thresholds.lowSaturation
      ? "low"
      : stats.meanSaturation > thresholds.highSaturation
        ? "high"
        : "normal";

  const contrastClass: ContrastClass =
    stats.luminanceStd < thresholds.lowContrast
      ? "low"
      : stats.luminanceStd > thresholds.highContrast
        ? "high"
        : "normal";

  const labels: string[] = [];
  if (saturationClass === "low") labels.push("color-low-saturation");
  else if (saturationClass === "high") labels.push("color-high-saturation");
  if (cast !== "balanced") labels.push(`color-${cast}`);
  if (contrastClass === "low") labels.push("color-low-contrast");
  else if (contrastClass === "high") labels.push("color-high-contrast");
  if (labels.length === 0) labels.push("color-balanced");

  const reasonParts: string[] = [];
  if (saturationClass !== "normal") {
    reasonParts.push(`saturation=${saturationClass} (meanSat ${roundTo(stats.meanSaturation, 3)})`);
  }
  if (cast !== "balanced") {
    reasonParts.push(`${cast} (channel spread ${roundTo(spread, 2)} > ${thresholds.cast})`);
  }
  if (contrastClass !== "normal") {
    reasonParts.push(`contrast=${contrastClass} (lumStd ${roundTo(stats.luminanceStd, 2)})`);
  }
  const reason =
    reasonParts.length === 0
      ? `color-balanced (meanSat ${roundTo(stats.meanSaturation, 3)}, channel spread ${roundTo(spread, 2)} ≤ ${thresholds.cast}, lumStd ${roundTo(stats.luminanceStd, 2)})`
      : `colour issues — ${reasonParts.join("; ")}`;

  return { saturationClass, cast, contrastClass, channelSpread: spread, labels, reason };
}

function classifyCast(stats: ColorStats, spread: number, castThreshold: number): ColorCast {
  if (spread < castThreshold) return "balanced";

  const { meanR, meanG, meanB } = stats;
  const max = Math.max(meanR, meanG, meanB);
  const min = Math.min(meanR, meanG, meanB);

  // Magenta cast: green is the lowest by a clear margin AND R and B
  // are roughly balanced (within half the cast threshold). This is
  // the classic green-cast complementary tint.
  if (
    meanG === min &&
    Math.abs(meanR - meanB) < castThreshold / 2 &&
    (meanR + meanB) / 2 - meanG >= castThreshold
  ) {
    return "magenta-cast";
  }
  if (max === meanR) return "warm-cast";
  if (max === meanG) return "green-cast";
  return "cool-cast";
}

/**
 * Project the colour stats + classification onto a [0, 1] composite
 * health score. Worst-of approach so one bad axis cannot be hidden
 * by two good ones.
 */
export function scoreColor(
  stats: ColorStats,
  classification: ColorClassification,
  thresholds: { readonly cast: number },
): number {
  const satScore = classification.saturationClass === "normal" ? 1 : 0.5;
  const contrastScore = scoreContrastOnly(stats, classification);
  // Cast score: linear from 1 at the threshold down to 0 when spread
  // equals the full 0..255 channel range. Subtracting the threshold
  // keeps the score continuous: at exactly `cast` the score is 1.
  const castScore =
    classification.cast === "balanced"
      ? 1
      : clamp01(1 - Math.max(0, classification.channelSpread - thresholds.cast) / 255);
  return Math.min(satScore, castScore, contrastScore);
}

function scoreContrastOnly(_stats: ColorStats, classification: ColorClassification): number {
  return classification.contrastClass === "normal" ? 1 : 0.5;
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
