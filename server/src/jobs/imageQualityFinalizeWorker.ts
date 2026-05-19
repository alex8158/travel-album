// ImageWorker.quality.finalize (P6.T5).
//
// Job handler registered as `image_quality_finalize`. Reads the
// `media_analysis` row populated by the per-dimension workers
// (P6.T2 blur, P6.T3 exposure, P6.T4 colour) and writes the
// composite `quality_score` + composite `reason` +
// `raw_result.$.final_quality`.
//
// Score formula:
//
//     used_dimensions = { d ∈ {blur, exposure, color} | d_score ≠ NULL }
//
//     effective_blur     = sharpness_score             (∈ [0, 1])
//     effective_exposure = exposure_score              (∈ [0, 1])
//     effective_color    = floor + (1 - floor) × color_score
//                                                       (∈ [floor, 1])
//
//     quality_score = Σ_{d ∈ used} (w_d / Σ_{d ∈ used} w_d) × effective_d
//
// Notes:
//   * `sharpness_score` (not `blur_score`) is the right input: it's
//     the [0, 1]-normalised confidence the blur worker writes; raw
//     `blur_score` is the unbounded Laplacian variance.
//   * `color_floor` caps how far colour can drag the composite down.
//     With default floor=0.5, even a worst-case colour run
//     (color_score=0) contributes 0.5 × w_color to the weighted sum.
//     This satisfies the P6.T5 prompt's "color shouldn't dominate"
//     constraint without using `min`-style aggregation.
//   * Missing dimensions are excluded entirely AND their weight is
//     redistributed across present ones (renormalisation). When all
//     three are NULL the handler throws — there is no aggregate to
//     write.
//
// Idempotency:
//   * Inputs come from the same DB row; re-running on unchanged
//     inputs writes the same quality_score and reason.
//   * `MediaAnalysisRepository.upsertFinalQuality` uses ON CONFLICT
//     and only touches `quality_score`, `reason`, and
//     `raw_result.$.final_quality` — the per-dimension columns and
//     sub-trees survive untouched.
//
// Scope per docs/tasks.md P6.T5 (this iteration):
//   * Aggregate the three per-dimension scores into the composite
//     `quality_score` + reason + final_quality JSON.
// Explicitly NOT in scope here:
//   * Intra-`duplicate_groups` ranking + writing
//     `recommended_media_id` / `duplicate_group_items.recommendation`.
//     That's the second half of P6.T5 and rides on this score; it
//     lands in a follow-up.
//   * Triggering this job from upload — today the row is created by
//     reprocess / manual seed and picked up by JobQueue.
//   * Frontend badges (P6.T6).
//   * Resolution sub-score (no `resolution_score` column yet; left
//     for P6.T7 / P9 to add).
//
// Failure modes (mirroring the other quality workers):
//   * Media row missing / soft-deleted → throw.
//   * `media_analysis` row missing entirely → throw `no analysis row
//     yet …` (no dimensions = nothing to aggregate).
//   * All three dimension scores are NULL → throw `no dimensions
//     available …`.

import { randomUUID } from "node:crypto";

import type { Logger } from "../logger.js";
import type { MediaAnalysisRepository, MediaAnalysisRow, MediaRepository } from "../media/index.js";

import type { JobHandler } from "./handlerRegistry.js";

/** Closed job_type token. Registered by `server/src/index.ts` boot. */
export const IMAGE_QUALITY_FINALIZE_JOB_TYPE = "image_quality_finalize";

/** Operational knobs the worker pulls from `Config.quality.finalize.*`. */
export interface FinalizeQualitySettings {
  readonly blurWeight: number;
  readonly exposureWeight: number;
  readonly colorWeight: number;
  /**
   * Lower bound on the colour dimension's effective contribution.
   * `effective_color = floor + (1 - floor) × color_score`. Default
   * 0.5 keeps colour from dominating the composite.
   */
  readonly colorFloor: number;
  readonly workerVersion: string;
}

export interface ImageQualityFinalizeHandlerDeps {
  readonly mediaRepo: MediaRepository;
  readonly mediaAnalysisRepo: MediaAnalysisRepository;
  readonly settings: FinalizeQualitySettings;
  readonly logger: Logger;
}

export type FinalizeDimensionName = "blur" | "exposure" | "color";

/** One dimension's contribution to the aggregate — exported for smoke. */
export interface FinalizeUsedDimension {
  readonly name: FinalizeDimensionName;
  /** Raw score column value (sharpness_score / exposure_score / color_score). */
  readonly rawScore: number;
  /**
   * Score after the per-dimension transform. For blur / exposure
   * this equals `rawScore`; for colour it is
   * `floor + (1 - floor) × rawScore`.
   */
  readonly effectiveScore: number;
  /** Weight as configured (before renormalisation). */
  readonly configuredWeight: number;
  /** Weight after renormalisation across present dimensions. */
  readonly normalisedWeight: number;
}

/** Aggregate result — exported for smoke + future Quality_Selector. */
export interface FinalizeAggregateResult {
  readonly qualityScore: number;
  readonly used: readonly FinalizeUsedDimension[];
  readonly skipped: readonly FinalizeDimensionName[];
  readonly configuredWeights: {
    readonly blur: number;
    readonly exposure: number;
    readonly color: number;
  };
  readonly colorFloor: number;
}

/**
 * Build the `image_quality_finalize` handler. Register the returned
 * value on the JobQueue's image-channel handler Map at boot.
 */
export function makeImageQualityFinalizeHandler(deps: ImageQualityFinalizeHandlerDeps): JobHandler {
  return async (job) => {
    const correlation = { jobId: job.id, mediaId: job.mediaId };

    // ---- 1. Resolve media row ------------------------------------------
    const media = deps.mediaRepo.findById(job.mediaId);
    if (media === null) {
      throw new Error(`media not found or soft-deleted: ${job.mediaId}`);
    }
    if (media.type !== "image") {
      throw new Error(`media is not an image (type='${media.type}'); refusing to finalize quality`);
    }

    // ---- 2. Read existing analysis row ---------------------------------
    const analysis = deps.mediaAnalysisRepo.findByMediaId(media.id);
    if (analysis === null) {
      throw new Error(
        `no media_analysis row yet for ${media.id}; run blur / exposure / color workers first`,
      );
    }

    // ---- 3. Aggregate the present dimensions ---------------------------
    const aggregate = aggregateQuality(analysis, deps.settings);
    if (aggregate === null) {
      throw new Error(
        "no dimensions available to aggregate (all of sharpness_score / exposure_score / color_score are NULL)",
      );
    }

    // ---- 4. Build reason + raw_result payload --------------------------
    const now = new Date().toISOString();
    const dimensionSnippets = aggregate.used.map((d) => describeDimension(d, analysis));
    const weightSnippet = aggregate.used
      .map((d) => `${d.name}=${roundTo(d.configuredWeight, 3)}→${roundTo(d.normalisedWeight, 3)}`)
      .join(" ");
    const skippedSnippet =
      aggregate.skipped.length === 0 ? "" : ` (skipped: ${aggregate.skipped.join(", ")})`;
    const finalReason = `final quality ${roundTo(aggregate.qualityScore, 3)} — ${dimensionSnippets.join(" | ")} | weights ${weightSnippet}${skippedSnippet}`;

    const rawFinalJson = JSON.stringify({
      algorithm: "weighted-mean-with-color-floor",
      version: deps.settings.workerVersion,
      qualityScore: roundTo(aggregate.qualityScore, 6),
      usedDimensions: aggregate.used.map((d) => ({
        name: d.name,
        rawScore: roundTo(d.rawScore, 6),
        effectiveScore: roundTo(d.effectiveScore, 6),
        configuredWeight: roundTo(d.configuredWeight, 6),
        normalisedWeight: roundTo(d.normalisedWeight, 6),
      })),
      skippedDimensions: aggregate.skipped,
      configuredWeights: aggregate.configuredWeights,
      colorFloor: aggregate.colorFloor,
      reason: finalReason,
      computedAt: now,
    });

    const changed = deps.mediaAnalysisRepo.upsertFinalQuality({
      id: randomUUID(),
      mediaId: media.id,
      qualityScore: aggregate.qualityScore,
      reason: finalReason,
      rawFinalJson,
      updatedAt: now,
    });
    if (changed === 0) {
      deps.logger.warn(
        { ...correlation, mediaId: media.id },
        "image_quality_finalize: upsert reported 0 changes",
      );
    }

    deps.logger.info(
      {
        ...correlation,
        qualityScore: roundTo(aggregate.qualityScore, 3),
        used: aggregate.used.map((d) => ({
          name: d.name,
          rawScore: roundTo(d.rawScore, 3),
          effectiveScore: roundTo(d.effectiveScore, 3),
          normalisedWeight: roundTo(d.normalisedWeight, 3),
        })),
        skipped: aggregate.skipped,
      },
      "image_quality_finalize: composite quality_score persisted",
    );
  };
}

// ---------------------------------------------------------------------------
// pure helpers (exported for the smoke)
// ---------------------------------------------------------------------------

/**
 * Compute the composite quality from one `media_analysis` row + the
 * configured weights. Returns `null` when EVERY dimension score is
 * NULL — callers (the worker) translate that into a thrown error so
 * the job lands `failed` rather than silently writing `quality_score
 * = NULL`.
 *
 * Note: uses `sharpness_score` for the blur dimension (already
 * [0, 1]-normalised by the blur worker), not the raw `blur_score`
 * (which is the unbounded Laplacian variance).
 */
export function aggregateQuality(
  row: MediaAnalysisRow,
  settings: FinalizeQualitySettings,
): FinalizeAggregateResult | null {
  const dims: { name: FinalizeDimensionName; rawScore: number | null; configuredWeight: number }[] =
    [
      { name: "blur", rawScore: row.sharpnessScore, configuredWeight: settings.blurWeight },
      { name: "exposure", rawScore: row.exposureScore, configuredWeight: settings.exposureWeight },
      { name: "color", rawScore: row.colorScore, configuredWeight: settings.colorWeight },
    ];

  const present = dims.filter(
    (d) => d.rawScore !== null && Number.isFinite(d.rawScore) && d.configuredWeight > 0,
  );
  if (present.length === 0) return null;

  const sumConfigured = present.reduce((s, d) => s + d.configuredWeight, 0);
  if (sumConfigured <= 0) return null;

  const used: FinalizeUsedDimension[] = present.map((d) => {
    const raw = d.rawScore as number;
    const effective = d.name === "color" ? temperColor(raw, settings.colorFloor) : raw;
    return {
      name: d.name,
      rawScore: raw,
      effectiveScore: effective,
      configuredWeight: d.configuredWeight,
      normalisedWeight: d.configuredWeight / sumConfigured,
    };
  });

  const composite = used.reduce((acc, d) => acc + d.normalisedWeight * d.effectiveScore, 0);

  const skipped: FinalizeDimensionName[] = dims
    .filter((d) => !present.includes(d))
    .map((d) => d.name);

  return {
    qualityScore: clamp01(composite),
    used,
    skipped,
    configuredWeights: {
      blur: settings.blurWeight,
      exposure: settings.exposureWeight,
      color: settings.colorWeight,
    },
    colorFloor: settings.colorFloor,
  };
}

/**
 * Map a raw colour score in [0, 1] onto the tempered range
 * `[floor, 1]`:
 *
 *   effective = floor + (1 - floor) × raw
 *
 * With the default `floor = 0.5` even the worst raw colour score
 * (0) contributes 0.5 to the weighted sum. This satisfies the
 * P6.T5 design constraint that colour should be a soft penalty —
 * not a dominating axis like blur or exposure.
 */
export function temperColor(rawScore: number, floor: number): number {
  if (!Number.isFinite(rawScore)) return floor;
  const clamped = clamp01(rawScore);
  const safeFloor = clamp01(floor);
  return safeFloor + (1 - safeFloor) * clamped;
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function describeDimension(d: FinalizeUsedDimension, analysis: MediaAnalysisRow): string {
  // Pull the per-dimension human-readable label from
  // `raw_result.$.<dim>` so the final reason reflects what each
  // worker decided, not just the numeric score. Defensive parse: if
  // the JSON is malformed for any reason we still produce a reason
  // with the score.
  const raw = parseRawResult(analysis.rawResult);
  if (d.name === "blur") {
    const node = raw?.blur as { classification?: string; laplacianVariance?: number } | undefined;
    const cls = typeof node?.classification === "string" ? node.classification : "?";
    const variance = typeof node?.laplacianVariance === "number" ? node.laplacianVariance : null;
    const tail = variance !== null ? `, variance=${roundTo(variance, 2)}` : "";
    return `blur=${roundTo(d.rawScore, 3)} [${cls}${tail}]`;
  }
  if (d.name === "exposure") {
    const node = raw?.exposure as { exposureLabel?: string; meanBrightness?: number } | undefined;
    const lbl = typeof node?.exposureLabel === "string" ? node.exposureLabel : "?";
    const mean =
      typeof node?.meanBrightness === "number" ? `, mean=${roundTo(node.meanBrightness, 2)}` : "";
    return `exposure=${roundTo(d.rawScore, 3)} [${lbl}${mean}]`;
  }
  // colour
  const node = raw?.color as { colorCast?: string; labels?: unknown } | undefined;
  const cast = typeof node?.colorCast === "string" ? node.colorCast : "?";
  const labels =
    Array.isArray(node?.labels) && node.labels.every((l) => typeof l === "string")
      ? (node.labels as string[]).join(",")
      : "";
  const labelTail = labels === "" ? "" : `, labels=${labels}`;
  return `color=${roundTo(d.rawScore, 3)} (eff ${roundTo(d.effectiveScore, 3)}) [${cast}${labelTail}]`;
}

function parseRawResult(json: string | null): Record<string, unknown> | null {
  if (json === null) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
  } catch {
    /* malformed */
  }
  return null;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

function roundTo(value: number, digits: number): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
