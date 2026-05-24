// VideoWorker.segmentQuality (P9.T7).
//
// Job handler registered as `video_segment_quality` on the video-
// channel executor. For one media row:
//   1. Resolve the media row (active-only — P7 contract) and refuse
//      non-video media defensively.
//   2. Read the per-media segment rows (P9.T6 output). 0 rows →
//      throw (the producer must land segments first).
//   3. Read the P9.T5 keyframes manifest from
//      `derived/{mediaId}/frames/manifest.json`. Missing /
//      unparseable → throw (the producer must land keyframes first).
//      The manifest gives us the per-frame timestamps + on-disk
//      paths needed to attribute frames to segments.
//   4. For each keyframe, compute the normalised Laplacian sharpness
//      (reusing `computeLaplacianStats` + `normaliseSharpness`
//      from the image_quality_blur worker). Higher = sharper.
//   5. Run FFmpeg `blackdetect` against the proxy (preferred) or
//      original. Parse the stderr lines of the form
//      `[blackdetect @ 0x…] black_start:NN black_end:NN
//      black_duration:NN` into [start, end) intervals (seconds).
//   6. For each segment row:
//        a. Pull the keyframes whose `timestampSec` ∈
//           [segment.start_time, segment.end_time). Average their
//           normalised sharpness → `blur_score`. NULL when there
//           are no keyframes in the interval.
//        b. Sum the overlap of black intervals with this segment →
//           `blackRatio = overlap_seconds / segment.duration`.
//        c. Decide `waste_type`:
//             - blackRatio ≥ blackRatioThreshold → 'black'
//             - else blur_score is non-null AND ≤ blurWasteThreshold
//               → 'blurry'
//             - else 'none'
//        d. Compose `quality_score` = blur_score × (1 - blackRatio),
//           clamped to [0, 1]. NULL when blur_score is NULL.
//        e. Set `is_recommended = 1` iff waste_type === 'none' AND
//           quality_score ≥ recommendThreshold.
//        f. Build a human-readable `reason` string with the
//           per-axis intermediates so the future P9.T8 / P9.T9
//           surface can explain a recommendation.
//   7. `videoSegmentsRepo.updateQuality(...)` per row. This UPDATE
//      touches blur_score / stability_score (always NULL — V1) /
//      quality_score / waste_type / is_recommended / reason. It
//      does **NOT** touch `user_decision` (CLAUDE.md §3.9). R-107
//      is closed: the producer worker preserves user_decision by
//      time-overlap on re-slice; the scorer here never writes it.
//
// Scope per docs/tasks.md P9.T7 — segment quality scoring. NOT in
// scope:
//   * Per-segment thumbnails / hover-play preview clips.
//   * Video API surfacing the scored segments (P9.T8).
//   * Frontend video segments page (P9.T9).
//   * Frame-difference motion / stability detection — `stability_score`
//     is intentionally left NULL in V1 because the keyframes worker
//     samples coarsely (default 2s) and per-keyframe variance is a
//     poor stability proxy; design.md §8.2 defers `vidstabdetect`
//     to a later phase.
//   * Audio silence detection (`waste_type='silence'` enum value
//     is reserved but not produced — out of scope per the prompt
//     "FFmpeg `blackdetect` 黑场检测" alone).
//   * Modifying P9.T2 / T3 / T4 / T5 workers. P9.T6 producer was
//     touched only to wire the R-107 force flag.
//
// Job channel: registered on the **video** channel, shares the
// VIDEO_WORKER_CONCURRENCY=1 budget with metadata / cover / proxy /
// keyframes / segments. Per-keyframe sharp passes are CPU-bound;
// the ffmpeg blackdetect pass is decode-bound. Both fit the same
// "video channel = heavy serial work" budget.
//
// Failure modes (all throw → JobQueue marks failed; the scorer
// makes NO partial writes, so a half-scored state is impossible):
//   * Media row missing / soft-deleted → throw.
//   * media.type !== 'video' → throw.
//   * 0 segment rows → throw.
//   * keyframes manifest missing / unparseable / empty → throw.
//   * Any keyframe file missing / unreadable → throw.
//   * sharp / Laplacian failure → throw.
//   * No usable decode source for blackdetect → throw.
//   * ffmpeg spawn fails / non-zero / timeout → throw.

import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "../logger.js";
import type {
  MediaRepository,
  MediaVersionsRepository,
  VideoSegment,
  VideoSegmentQualityUpdate,
  VideoSegmentsRepository,
  VideoSegmentWasteType,
} from "../media/index.js";
import type { LocalStorageProvider } from "../storage/index.js";
import { resolveUnderRoot } from "../storage/index.js";

import type { JobHandler } from "./handlerRegistry.js";
import {
  computeLaplacianStats,
  normaliseSharpness,
} from "./imageQualityBlurWorker.js";
import type { KeyframeManifest } from "./videoKeyframesWorker.js";

/** Closed job_type token. */
export const VIDEO_SEGMENT_QUALITY_JOB_TYPE = "video_segment_quality";

/** Max bytes of ffmpeg/ffprobe stderr we keep when reporting failures. */
const MAX_STDERR_BYTES = 4096;

/** Limit of stderr we KEEP in memory during a successful blackdetect
 * run; blackdetect emits one line per detected interval and the
 * filter chatter is small, but we cap it defensively. */
const MAX_BLACKDETECT_STDERR_BYTES = 1_048_576; // 1 MB

/**
 * Runtime tunables. Wired from `config.video.segmentQuality.*` +
 * `config.ffmpeg.*`. Defaults are also declared here so the worker
 * can be constructed in isolation for smokes without the config layer.
 */
export interface VideoSegmentQualitySettings {
  readonly ffmpegPath: string;
  /** Wall-clock cap on the ffmpeg blackdetect spawn. */
  readonly timeoutMs: number;
  /** Sharp resize cap for the per-keyframe Laplacian pass. */
  readonly blurMaxEdge: number;
  /** Normalised-sharpness denominator (the maybe-blurry image
   * threshold) — feeds into `normaliseSharpness` so a single
   * Laplacian variance maps to a [0, 1] sharpness. Re-uses the
   * existing image config so video + image are comparable. */
  readonly normaliseSharpnessMaybeThreshold: number;
  /** Below this normalised sharpness, a segment is labelled 'blurry'. */
  readonly blurWasteThreshold: number;
  /** A segment is labelled 'black' when its overlap with detected
   * black intervals exceeds this fraction of its duration. */
  readonly blackRatioThreshold: number;
  /** FFmpeg blackdetect `d=` parameter (min black interval seconds). */
  readonly blackdetectMinDurationSec: number;
  readonly blackdetectPicTh: number;
  readonly blackdetectPixTh: number;
  /** quality_score above which is_recommended = 1 (when not waste). */
  readonly recommendThreshold: number;
  /** Stamped into logger output for traceability. */
  readonly workerVersion: string;
}

export const DEFAULT_VIDEO_SEGMENT_QUALITY_SETTINGS: VideoSegmentQualitySettings = {
  ffmpegPath: "ffmpeg",
  timeoutMs: 300_000,
  blurMaxEdge: 512,
  normaliseSharpnessMaybeThreshold: 100,
  blurWasteThreshold: 0.25,
  blackRatioThreshold: 0.5,
  blackdetectMinDurationSec: 0.5,
  blackdetectPicTh: 0.98,
  blackdetectPixTh: 0.1,
  recommendThreshold: 0.5,
  workerVersion: "1.0",
};

export interface VideoSegmentQualityHandlerDeps {
  readonly storage: LocalStorageProvider;
  readonly mediaRepo: MediaRepository;
  readonly mediaVersionsRepo: MediaVersionsRepository;
  readonly videoSegmentsRepo: VideoSegmentsRepository;
  readonly settings?: VideoSegmentQualitySettings;
  readonly logger: Logger;
}

/** Half-open interval [start, end) in seconds. */
interface TimeRange {
  readonly start: number;
  readonly end: number;
}

/** Per-frame intermediate read by the scorer. */
interface KeyframeSharpness {
  readonly timestampSec: number;
  readonly sharpness: number;
}

/** Per-segment scoring intermediate before we hand it to the writer. */
export interface SegmentScore {
  readonly id: string;
  readonly blurScore: number | null;
  readonly stabilityScore: number | null;
  readonly qualityScore: number | null;
  readonly wasteType: VideoSegmentWasteType;
  readonly isRecommended: boolean;
  readonly reason: string;
  readonly keyframeCount: number;
  readonly blackRatio: number;
}

/**
 * Build the `video_segment_quality` handler. Register the returned
 * value on the executor's `JobHandlerRegistry` for the **video**
 * channel.
 */
export function makeVideoSegmentQualityHandler(
  deps: VideoSegmentQualityHandlerDeps,
): JobHandler {
  const settings = deps.settings ?? DEFAULT_VIDEO_SEGMENT_QUALITY_SETTINGS;
  return async (job) => {
    const correlation = { jobId: job.id, mediaId: job.mediaId };

    // ---- 1. Resolve media row -----------------------------------------
    const media = deps.mediaRepo.findById(job.mediaId);
    if (media === null) {
      throw new Error(`media not found or soft-deleted: ${job.mediaId}`);
    }
    if (media.type !== "video") {
      throw new Error(
        `media is not a video (type='${media.type}'); refusing to score segments`,
      );
    }

    // ---- 2. Pull existing segment rows --------------------------------
    const segments = deps.videoSegmentsRepo.listByMediaId(media.id);
    if (segments.length === 0) {
      throw new Error(
        "video_segment_quality: no segments to score — run video_segments worker first",
      );
    }

    // ---- 3. Read keyframes manifest -----------------------------------
    const manifestRelPath = `frames/manifest.json`;
    const manifestAbsolute = resolveUnderRoot(
      deps.storage.root,
      `trips/${media.tripId}/derived/${media.id}/${manifestRelPath}`,
    );
    let manifest: KeyframeManifest;
    try {
      const raw = await readFile(manifestAbsolute, "utf8");
      manifest = JSON.parse(raw) as KeyframeManifest;
    } catch (err) {
      throw new Error(
        `video_segment_quality: cannot read keyframes manifest at ${manifestAbsolute} — run video_keyframes worker first (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }
    if (!Array.isArray(manifest.frames) || manifest.frames.length === 0) {
      throw new Error(
        "video_segment_quality: keyframes manifest has no frames",
      );
    }

    // ---- 4. Per-keyframe Laplacian sharpness --------------------------
    const sharpnessByKeyframe: KeyframeSharpness[] = [];
    for (const frame of manifest.frames) {
      const frameAbsolute = resolveUnderRoot(deps.storage.root, frame.filePath);
      let frameBytes: Buffer;
      try {
        frameBytes = await readFile(frameAbsolute);
      } catch (err) {
        throw new Error(
          `video_segment_quality: keyframe file unreadable at ${frame.filePath} (${
            err instanceof Error ? err.message : String(err)
          })`,
        );
      }
      if (frameBytes.length === 0) {
        throw new Error(`video_segment_quality: keyframe file is empty: ${frame.filePath}`);
      }
      const stats = await computeLaplacianStats(frameBytes, settings.blurMaxEdge);
      const sharpness = normaliseSharpness(
        stats.variance,
        settings.normaliseSharpnessMaybeThreshold,
      );
      sharpnessByKeyframe.push({ timestampSec: frame.timestampSec, sharpness });
    }

    // ---- 5. ffmpeg blackdetect ---------------------------------------
    const decodeSource = await pickDecodeSource({
      deps,
      mediaId: media.id,
      originalPath: media.originalPath,
    });
    if (decodeSource === null) {
      throw new Error(
        "no decode source available for blackdetect (media has no original_path and no usable proxy)",
      );
    }
    const blackIntervals = await runBlackdetect({
      input: resolveUnderRoot(deps.storage.root, decodeSource.logicalPath),
      settings,
    });

    // ---- 6. Score each segment ---------------------------------------
    const scoredAt = new Date().toISOString();
    const perSegment: SegmentScore[] = segments.map((segment) =>
      scoreOneSegment({
        segment,
        sharpnessByKeyframe,
        blackIntervals,
        settings,
      }),
    );

    // ---- 7. Persist (per-row UPDATE; no transaction needed since
    //                   user_decision is untouched and quality cols
    //                   are independent across segments).
    let updated = 0;
    for (const score of perSegment) {
      const data: VideoSegmentQualityUpdate = {
        id: score.id,
        blurScore: score.blurScore,
        stabilityScore: score.stabilityScore,
        qualityScore: score.qualityScore,
        wasteType: score.wasteType,
        isRecommended: score.isRecommended,
        reason: score.reason,
        now: scoredAt,
      };
      const changes = deps.videoSegmentsRepo.updateQuality(data);
      if (changes === 1) updated += 1;
    }

    deps.logger.info(
      {
        ...correlation,
        segmentCount: segments.length,
        updatedRows: updated,
        keyframeCount: manifest.frames.length,
        blackIntervalCount: blackIntervals.length,
        decodeSource: decodeSource.kind,
        decodeSourcePath: decodeSource.logicalPath,
        wasteTypeHistogram: histogramByWasteType(perSegment),
        recommendedCount: perSegment.filter((s) => s.isRecommended).length,
        workerVersion: settings.workerVersion,
      },
      "video_segment_quality: per-segment scores written",
    );
  };
}

// ---------------------------------------------------------------------------
// per-segment scoring (pure function, exported for the smoke)
// ---------------------------------------------------------------------------

/**
 * Score one segment given its time bounds, the full keyframe
 * sharpness vector, and the parsed blackdetect intervals.
 *
 * Decision rules:
 *   * blackRatio = sum of overlap with blackIntervals / segment.duration
 *   * blur_score = average of `sharpness_byKeyframe[t]` for t ∈
 *     [segment.start_time, segment.end_time). NULL when no
 *     keyframes fall in the interval (degraded case — we still
 *     emit waste_type / quality_score based on blackness, but mark
 *     the row's `reason` so the diagnostic surface is honest).
 *   * waste_type:
 *       - blackRatio ≥ blackRatioThreshold → 'black'
 *       - blur_score is non-null AND ≤ blurWasteThreshold → 'blurry'
 *       - else 'none'
 *   * quality_score = blur_score × (1 - blackRatio), or NULL when
 *     blur_score is NULL. Clamped to [0, 1].
 *   * is_recommended = waste_type === 'none' AND quality_score is
 *     non-null AND quality_score ≥ recommendThreshold.
 */
export function scoreOneSegment(args: {
  readonly segment: VideoSegment;
  readonly sharpnessByKeyframe: readonly KeyframeSharpness[];
  readonly blackIntervals: readonly TimeRange[];
  readonly settings: Pick<
    VideoSegmentQualitySettings,
    "blackRatioThreshold" | "blurWasteThreshold" | "recommendThreshold"
  >;
}): SegmentScore {
  const { segment, sharpnessByKeyframe, blackIntervals, settings } = args;
  const segRange: TimeRange = { start: segment.startTime, end: segment.endTime };

  // ---- keyframe attribution (half-open [start, end))
  const inSegmentSharpness: number[] = [];
  for (const kf of sharpnessByKeyframe) {
    if (kf.timestampSec >= segRange.start && kf.timestampSec < segRange.end) {
      inSegmentSharpness.push(kf.sharpness);
    }
  }
  const blurScore: number | null =
    inSegmentSharpness.length === 0
      ? null
      : clamp01(
          inSegmentSharpness.reduce((acc, v) => acc + v, 0) / inSegmentSharpness.length,
        );

  // ---- black overlap
  let blackOverlapSec = 0;
  for (const interval of blackIntervals) {
    const overlap = intervalOverlap(segRange, interval);
    blackOverlapSec += overlap;
  }
  const blackRatio = segment.duration > 0 ? clamp01(blackOverlapSec / segment.duration) : 0;

  // ---- waste classification
  let wasteType: VideoSegmentWasteType;
  if (blackRatio >= settings.blackRatioThreshold) {
    wasteType = "black";
  } else if (blurScore !== null && blurScore <= settings.blurWasteThreshold) {
    wasteType = "blurry";
  } else {
    wasteType = "none";
  }

  // ---- composite quality
  const qualityScore: number | null =
    blurScore === null ? null : clamp01(blurScore * (1 - blackRatio));

  // ---- recommendation
  const isRecommended =
    wasteType === "none" &&
    qualityScore !== null &&
    qualityScore >= settings.recommendThreshold;

  // ---- reason
  const reasonParts: string[] = [];
  reasonParts.push(`blur=${formatScalar(blurScore)}`);
  reasonParts.push(`blackRatio=${formatScalar(blackRatio)}`);
  reasonParts.push(`quality=${formatScalar(qualityScore)}`);
  reasonParts.push(`waste=${wasteType}`);
  reasonParts.push(`keyframes=${inSegmentSharpness.length}`);
  if (inSegmentSharpness.length === 0) {
    reasonParts.push("(no keyframes in interval; blur degraded to NULL)");
  }
  if (isRecommended) reasonParts.push("recommended");

  return {
    id: segment.id,
    blurScore: blurScore === null ? null : roundTo(blurScore, 6),
    // V1: stability is intentionally NULL (see file header).
    stabilityScore: null,
    qualityScore: qualityScore === null ? null : roundTo(qualityScore, 6),
    wasteType,
    isRecommended,
    reason: reasonParts.join(" | "),
    keyframeCount: inSegmentSharpness.length,
    blackRatio: roundTo(blackRatio, 6),
  };
}

// ---------------------------------------------------------------------------
// decode-source selection (mirrors P9.T6 / P9.T5)
// ---------------------------------------------------------------------------

async function pickDecodeSource(args: {
  readonly deps: VideoSegmentQualityHandlerDeps;
  readonly mediaId: string;
  readonly originalPath: string | null;
}): Promise<{ kind: "proxy" | "original"; logicalPath: string } | null> {
  const { deps, mediaId, originalPath } = args;
  const versions = deps.mediaVersionsRepo.listByMediaId(mediaId);
  const proxyRow = versions.find((v) => v.versionType === "video_proxy");
  if (proxyRow !== undefined) {
    const absolute = resolveUnderRoot(deps.storage.root, proxyRow.filePath);
    try {
      const s = await stat(absolute);
      if (s.isFile() && s.size > 0) {
        return { kind: "proxy", logicalPath: proxyRow.filePath };
      }
    } catch {
      // proxy row exists but file missing → fall through to original
    }
  }
  if (originalPath !== null && originalPath.length > 0) {
    return { kind: "original", logicalPath: originalPath };
  }
  return null;
}

// ---------------------------------------------------------------------------
// ffmpeg blackdetect
// ---------------------------------------------------------------------------

interface RunBlackdetectArgs {
  readonly input: string;
  readonly settings: VideoSegmentQualitySettings;
}

/**
 * Spawn ffmpeg with the `blackdetect` filter, parse the stderr
 * channel for `black_start` / `black_end` / `black_duration`
 * tuples, and return them as half-open [start, end) intervals
 * sorted by start time.
 *
 * blackdetect writes one log line per detected interval to stderr
 * in the shape:
 *   [blackdetect @ 0x123abc] black_start:1.23 black_end:4.56 black_duration:3.33
 * We use a tolerant regex (numbers can be ints, decimals, or
 * negative-zero) so a minor ffmpeg log format tweak won't break
 * parsing.
 */
export async function runBlackdetect(
  args: RunBlackdetectArgs,
): Promise<readonly TimeRange[]> {
  const { input, settings } = args;
  const filter =
    `blackdetect=d=${settings.blackdetectMinDurationSec}` +
    `:pic_th=${settings.blackdetectPicTh}` +
    `:pix_th=${settings.blackdetectPixTh}`;

  const ffmpegArgs = [
    "-hide_banner",
    "-nostats",
    "-v",
    "info",
    "-i",
    input,
    "-vf",
    filter,
    "-an",
    "-f",
    "null",
    "-",
  ];

  const stderrChunks: Buffer[] = [];
  let stderrBytes = 0;

  await new Promise<void>((resolve, reject) => {
    let killed = false;
    const child = spawn(settings.ffmpegPath, ffmpegArgs, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const timeoutHandle = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, settings.timeoutMs);

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_BLACKDETECT_STDERR_BYTES) {
        stderrChunks.push(chunk);
      }
    });
    child.once("error", (err) => {
      clearTimeout(timeoutHandle);
      reject(new Error(`ffmpeg spawn failed (blackdetect): ${err.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timeoutHandle);
      if (killed) {
        reject(
          new Error(
            `ffmpeg blackdetect timed out after ${settings.timeoutMs}ms (file=${path.basename(
              input,
            )})`,
          ),
        );
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").slice(0, MAX_STDERR_BYTES);
        reject(
          new Error(`ffmpeg blackdetect exited ${code}: ${stderr.trim() || "(no stderr)"}`),
        );
        return;
      }
      resolve();
    });
  });

  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  return parseBlackdetectStderr(stderr);
}

/**
 * Parse the stderr output of ffmpeg's `blackdetect` filter into a
 * sorted list of half-open `[start, end)` intervals. Exported so
 * the smoke can exercise the parser without spawning ffmpeg.
 */
export function parseBlackdetectStderr(stderr: string): readonly TimeRange[] {
  const intervalRegex =
    /black_start:\s*([+-]?\d+(?:\.\d+)?)\s+black_end:\s*([+-]?\d+(?:\.\d+)?)/g;
  const out: TimeRange[] = [];
  let match: RegExpExecArray | null;
  while ((match = intervalRegex.exec(stderr)) !== null) {
    const start = Number.parseFloat(match[1]!);
    const end = Number.parseFloat(match[2]!);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (end <= start) continue;
    out.push({ start, end });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Half-open interval overlap in seconds (returns 0 when disjoint). */
function intervalOverlap(a: TimeRange, b: TimeRange): number {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return Math.max(0, end - start);
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function formatScalar(value: number | null): string {
  if (value === null) return "NULL";
  return roundTo(value, 3).toFixed(3);
}

function histogramByWasteType(scores: readonly SegmentScore[]): Record<VideoSegmentWasteType, number> {
  const out: Record<VideoSegmentWasteType, number> = {
    black: 0,
    blurry: 0,
    unstable: 0,
    silence: 0,
    none: 0,
  };
  for (const s of scores) out[s.wasteType] += 1;
  return out;
}
