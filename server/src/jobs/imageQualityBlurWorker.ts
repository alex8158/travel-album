// ImageWorker.quality.blur (P6.T2).
//
// Job handler registered as `image_quality_blur` on the image-channel
// JobQueue. For one image media row:
//   1. Resolve via `media_items.original_path`.
//   2. Read bytes through `LocalStorageProvider`.
//   3. sharp pipeline: rotate (honour EXIF), resize fit-inside to
//      `config.quality.blur.maxEdge`, grayscale, raw 1 byte/pixel.
//   4. Convolve the resulting greyscale plane with a 4-connected 3×3
//      Laplacian kernel and compute the variance of the responses.
//      This is the canonical "Laplacian variance" sharpness signal:
//      sharp images have rich high-frequency content → high variance,
//      blurry images cluster around the local mean → low variance.
//   5. Classify against `config.quality.blurThresholdBlurry` and
//      `config.quality.blurThresholdMaybe` (already in the config
//      schema since P0; defaults 50 / 120 per design.md §11.1).
//   6. Persist via `MediaAnalysisRepository.upsertBlurAnalysis` —
//      INSERT … ON CONFLICT(media_id) DO UPDATE so re-running is
//      idempotent and downstream analysis dimensions
//      (exposure / color / aesthetic, P6.T3+) are preserved on the
//      same row.
//
// Scope per docs/tasks.md P6.T2 — blur only. Explicitly NOT in scope:
//   * Exposure (P6.T3), colour (P6.T4), aesthetic (P10).
//   * Composite `quality_score` and recommendation (P6.T5).
//   * Frontend badges / detail surface (P6.T6).
//   * Triggering this job from upload — today the row is created by
//     reprocess / manual seed and picked up by JobQueue.
//
// Idempotency:
//   * sharp's resize + grayscale + raw is deterministic over the same
//     bytes (sharp 0.33 / libvips); the Laplacian compute is pure JS
//     arithmetic. Re-running on the same media writes the same
//     numbers.
//   * The repository uses ON CONFLICT(media_id) DO UPDATE so a second
//     run is a no-op (UPDATE-with-same-values).
//   * `raw_result` is updated via `json_set(... , '$.blur', ...)` —
//     siblings (`$.exposure`, `$.color`, …) survive a blur re-run
//     untouched.
//
// Failure modes — all throw, JobQueue marks the row `failed` with
// the thrown message (mirroring `imageHashWorker.ts`):
//   * Media row missing / soft-deleted → throw `media not found …`.
//   * Media type ≠ image → throw `media is not an image …`.
//   * `original_path` null → throw `media has no original_path …`.
//   * Source file empty → throw `original file is empty`.
//   * Sharp decode error (corrupt / unsupported) → sharp's own throw
//     bubbles up.
//
// Sharpness normalisation:
//   * `sharpness_score` ∈ [0, 1] = `min(variance / (2 * maybeThreshold), 1)`.
//   * Choice rationale (see header comment of `normaliseSharpness`):
//     - "borderline" raw variance (= maybeThreshold) maps to 0.5
//     - 2× the borderline maps to the clamp ceiling
//     - a totally blurry image maps near 0
//     This keeps `sharpness_score` linear with the human-readable
//     Laplacian variance up to a soft saturation, and conveniently
//     sits in the [0, 1] band that P6.T5 wants for the weighted
//     quality_score blend.

import type { Readable } from "node:stream";
import { randomUUID } from "node:crypto";

import sharp from "sharp";

import type { Logger } from "../logger.js";
import type { MediaAnalysisRepository, MediaRepository } from "../media/index.js";
import type { LocalStorageProvider } from "../storage/index.js";

import type { JobHandler } from "./handlerRegistry.js";

/** Closed job_type token. Registered by `server/src/index.ts` boot. */
export const IMAGE_QUALITY_BLUR_JOB_TYPE = "image_quality_blur";

/**
 * Operational knobs the worker pulls from `Config.quality.*`. Bundled
 * up so the handler factory takes a single typed shape, and so tests
 * can construct a value without depending on the whole `Config`.
 */
export interface BlurAnalysisSettings {
  /** Below this raw Laplacian variance → classify as blurry. */
  readonly blurThresholdBlurry: number;
  /** At or above this raw Laplacian variance → classify as sharp. */
  readonly blurThresholdMaybe: number;
  /** Resize target for the longest side before Laplacian compute. */
  readonly maxEdge: number;
  /** Stamped into raw_result for traceability across algorithm bumps. */
  readonly workerVersion: string;
}

export interface ImageQualityBlurHandlerDeps {
  readonly storage: LocalStorageProvider;
  readonly mediaRepo: MediaRepository;
  readonly mediaAnalysisRepo: MediaAnalysisRepository;
  readonly settings: BlurAnalysisSettings;
  readonly logger: Logger;
}

/** Classification result for one media — exported for the smoke. */
export interface BlurClassification {
  readonly isBlurry: 0 | 1 | null;
  readonly label: "sharp" | "maybe-blurry" | "blurry";
  readonly reason: string;
}

/** Laplacian compute output — exported so the smoke can call directly. */
export interface LaplacianStats {
  readonly width: number;
  readonly height: number;
  readonly interiorPixelCount: number;
  readonly mean: number;
  readonly variance: number;
}

/**
 * Build the `image_quality_blur` handler. Register the returned value
 * on the JobQueue's image-channel handler Map at boot.
 */
export function makeImageQualityBlurHandler(deps: ImageQualityBlurHandlerDeps): JobHandler {
  return async (job) => {
    const correlation = { jobId: job.id, mediaId: job.mediaId };

    // ---- 1. Resolve media row ------------------------------------------
    const media = deps.mediaRepo.findById(job.mediaId);
    if (media === null) {
      throw new Error(`media not found or soft-deleted: ${job.mediaId}`);
    }
    if (media.type !== "image") {
      throw new Error(`media is not an image (type='${media.type}'); refusing to analyse blur`);
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

    // ---- 3. Compute Laplacian variance ---------------------------------
    const stats = await computeLaplacianStats(sourceBuf, deps.settings.maxEdge);

    // ---- 4. Classify + normalise ---------------------------------------
    const classification = classifyBlur(stats.variance, {
      blurry: deps.settings.blurThresholdBlurry,
      maybe: deps.settings.blurThresholdMaybe,
    });
    const sharpnessScore = normaliseSharpness(stats.variance, deps.settings.blurThresholdMaybe);

    // ---- 5. Persist on media_analysis ----------------------------------
    const now = new Date().toISOString();
    const rawBlurJson = JSON.stringify({
      algorithm: "laplacian-variance",
      version: deps.settings.workerVersion,
      // Resize target the worker actually used. If the original was
      // smaller than maxEdge, sharp's withoutEnlargement keeps it
      // smaller — the actual dims are reported here, not maxEdge.
      resized: { width: stats.width, height: stats.height, maxEdge: deps.settings.maxEdge },
      interiorPixelCount: stats.interiorPixelCount,
      laplacianMean: roundTo(stats.mean, 6),
      laplacianVariance: roundTo(stats.variance, 6),
      thresholds: {
        blurry: deps.settings.blurThresholdBlurry,
        maybe: deps.settings.blurThresholdMaybe,
      },
      classification: classification.label,
      computedAt: now,
    });

    const changed = deps.mediaAnalysisRepo.upsertBlurAnalysis({
      id: randomUUID(),
      mediaId: media.id,
      blurScore: stats.variance,
      sharpnessScore,
      isBlurry: classification.isBlurry,
      labels: JSON.stringify([classification.label]),
      reason: classification.reason,
      rawBlurJson,
      updatedAt: now,
    });
    if (changed === 0) {
      // ON CONFLICT … DO UPDATE always reports 1 change in SQLite, so
      // 0 here is unexpected. Surface it as a non-fatal log: the
      // compute work is done and a future retry will re-write.
      deps.logger.warn(
        { ...correlation, mediaId: media.id },
        "image_quality_blur: upsert reported 0 changes",
      );
    }

    deps.logger.info(
      {
        ...correlation,
        originalPath: media.originalPath,
        fileBytes: sourceBuf.length,
        resized: { width: stats.width, height: stats.height },
        laplacianVariance: roundTo(stats.variance, 3),
        classification: classification.label,
        isBlurry: classification.isBlurry,
        sharpnessScore: roundTo(sharpnessScore, 3),
      },
      "image_quality_blur: blur scores computed and persisted",
    );
  };
}

// ---------------------------------------------------------------------------
// pure helpers (exported for the smoke)
// ---------------------------------------------------------------------------

/**
 * Three-class blur decision from a raw Laplacian variance.
 *
 *   variance <  blurry            → 1 (blurry, label = "blurry")
 *   variance >= maybe             → 0 (clear,  label = "sharp")
 *   blurry <= variance < maybe    → null (label = "maybe-blurry")
 *
 * The middle bucket maps to NULL because the column semantics in
 * 008_create_media_analysis.sql are explicitly "NULL = not yet
 * evaluated / unknown" — and from the UI's standpoint a borderline
 * image really is "we don't know yet". The label and reason still
 * record the borderline state for downstream presentation.
 */
export function classifyBlur(
  variance: number,
  thresholds: { readonly blurry: number; readonly maybe: number },
): BlurClassification {
  if (!Number.isFinite(variance)) {
    return {
      isBlurry: null,
      label: "maybe-blurry",
      reason: `borderline (Laplacian variance ${String(variance)} is not finite)`,
    };
  }
  if (variance < thresholds.blurry) {
    return {
      isBlurry: 1,
      label: "blurry",
      reason: `blurry (Laplacian variance ${roundTo(variance, 2)} < ${thresholds.blurry})`,
    };
  }
  if (variance >= thresholds.maybe) {
    return {
      isBlurry: 0,
      label: "sharp",
      reason: `sharp (Laplacian variance ${roundTo(variance, 2)} ≥ ${thresholds.maybe})`,
    };
  }
  return {
    isBlurry: null,
    label: "maybe-blurry",
    reason: `borderline (Laplacian variance ${roundTo(variance, 2)} between ${thresholds.blurry} and ${thresholds.maybe})`,
  };
}

/**
 * Project an unbounded Laplacian variance to a [0, 1] sharpness
 * confidence:
 *   * variance = 0           → 0
 *   * variance = maybe       → 0.5
 *   * variance >= 2 × maybe  → 1 (clamped)
 *
 * Linear-with-saturation so the score still tracks human-readable
 * variance in the bulk of the range; the clamp keeps a single
 * very-high-contrast outlier from blowing the [0, 1] envelope that
 * P6.T5 wants for the weighted quality_score blend.
 *
 * `maybeThreshold` defines the half-point so it implicitly scales
 * the curve to whatever the project's "borderline" line is — change
 * `BLUR_THRESHOLD_MAYBE` and the normalisation moves with it. No
 * separate "sharpness anchor" knob to keep in sync.
 */
export function normaliseSharpness(variance: number, maybeThreshold: number): number {
  if (!Number.isFinite(variance) || !Number.isFinite(maybeThreshold) || maybeThreshold <= 0) {
    return 0;
  }
  const denom = 2 * maybeThreshold;
  const raw = variance / denom;
  if (raw <= 0) return 0;
  if (raw >= 1) return 1;
  return raw;
}

/**
 * Run the full sharp pipeline + 3×3 Laplacian convolution + variance
 * compute. Exported so the smoke can drive the algorithm directly,
 * sidestepping the handler / storage / DB to assert determinism and
 * exact numerics on synthetic buffers.
 *
 * The kernel is the 4-connected Laplacian
 *   [  0 -1  0
 *    -1  4 -1
 *      0 -1  0 ]
 * which is the convention used by OpenCV's `cv2.Laplacian` when
 * `ksize=1`. The 8-connected variant adds more diagonal noise without
 * meaningfully improving the blur signal for our threshold ranges.
 *
 * Only interior pixels [1..w-2] × [1..h-2] are convolved — boundary
 * pixels are skipped to avoid having to pick a border convention
 * (replicate / reflect / zero) and to keep the response variance
 * faithful to the "real" content of the image.
 */
export async function computeLaplacianStats(
  sourceBuf: Buffer,
  maxEdge: number,
): Promise<LaplacianStats> {
  if (maxEdge < 4) {
    // Need at least a 4×4 plane to have a non-empty interior after
    // dropping the 1-pixel border. Guard early with a clear message.
    throw new Error(`maxEdge ${maxEdge} too small (must be ≥ 4)`);
  }

  const { data, info } = await sharp(sourceBuf)
    .rotate()
    .resize(maxEdge, maxEdge, { fit: "inside", withoutEnlargement: true })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  if (data.length !== width * height) {
    throw new Error(
      `image_quality_blur: unexpected grayscale buffer length ${data.length} (expected ${width * height})`,
    );
  }
  if (width < 3 || height < 3) {
    throw new Error(
      `image_quality_blur: resized image too small for Laplacian (${width}×${height})`,
    );
  }

  // Welford-style running stats over the interior. With width/height
  // both ≤ 512 we'd top out at ~260k samples — a plain two-pass
  // (sum / sumOfSquares) would be fine, but a single-pass Welford
  // keeps the numerical conditioning crisp on uniform images where
  // the variance is genuinely tiny.
  let n = 0;
  let mean = 0;
  let m2 = 0;

  for (let y = 1; y < height - 1; y += 1) {
    const rowOffset = y * width;
    for (let x = 1; x < width - 1; x += 1) {
      const idx = rowOffset + x;
      const center = data[idx] as number;
      const top = data[idx - width] as number;
      const bottom = data[idx + width] as number;
      const left = data[idx - 1] as number;
      const right = data[idx + 1] as number;
      const response = 4 * center - top - bottom - left - right;
      n += 1;
      const delta = response - mean;
      mean += delta / n;
      const delta2 = response - mean;
      m2 += delta * delta2;
    }
  }

  const variance = n > 0 ? m2 / n : 0;
  return { width, height, interiorPixelCount: n, mean, variance };
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
