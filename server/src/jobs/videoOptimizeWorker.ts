// VideoWorker.optimize (P11.T1).
//
// Job handler registered as `video_optimize` on the video-channel
// executor. For one media row:
//   1. Resolve the media via `media_items.original_path` (active-only).
//   2. Transcode the original to a browser-friendly H.264 / AAC MP4 via
//      FFmpeg. Output dimensions: width auto-computed, height capped
//      at `settings.targetHeight` (no upscale when source is shorter —
//      `-2:'min(ih,H)'` keeps the source dims for already-small
//      videos). CRF + preset configurable; defaults aim for
//      "browser-friendly playback quality" without ballooning file
//      size (P11.T1 prompt: 码率策略要保守).
//   3. Move the bytes into the project's storage as
//      `derived/{mediaId}/video_optimized.mp4` via
//      `storage.putDerived({ overwrite: true })` (matches design.md
//      §5.2 / §8.3 — the new file lives next to video_cover.jpg /
//      video_proxy.mp4 and is governed by the same "never overwrite
//      originals" rule).
//   4. Run ffprobe on the optimized file ONLY to read back
//      authoritative width / height / duration / size for the
//      `media_versions(version_type='video_optimized')` row. We do
//      NOT re-run the P9.T2 metadata pipeline against this file —
//      that describes the SOURCE; this row describes the optimized
//      output.
//   5. UPSERT `media_versions(version_type='video_optimized')` with
//      `file_path` + `mime_type='video/mp4'` + `width` / `height` /
//      `file_size` + `params` JSON recording every transcode knob
//      (targetHeight, crf, preset, videoCodec, audioCodec,
//      audioBitrateKbps, workerVersion) for audit traceability.
//
// Distinction from `video_proxy` (P9.T4):
//   * Purpose: `video_proxy` is the INTERNAL low-res decode source
//     for downstream analysis (keyframes / segments / quality).
//     `video_optimized` is the USER-FACING browser-friendly version.
//   * Quality: `video_proxy` defaults CRF=28 (compressed thumbnail
//     quality, ~720p). `video_optimized` defaults CRF=23
//     (visually-transparent web playback quality, up to 1080p).
//   * Audio bitrate: proxy 128 kbps vs optimized 160 kbps
//     (perceptual-transparent threshold for AAC-LC on typical
//     content).
//   * Preset: proxy `veryfast` (fast encode, larger file). Optimize
//     defaults `medium` (slower encode, smaller file at same CRF).
//
// Scope per docs/tasks.md P11.T1 — base optimization only.
// Explicitly NOT in scope (P11.T2 onwards):
//   * Audio policy / muting / fade in/out / volume normalization /
//     library audio replacement (those are P11.T2 / P11.T5).
//   * Cut planning / multi-segment concat (P11.T4 / P11.T5).
//   * Multi-video composition (P11.T8).
//   * Touching `media_items.preview_path` / `thumbnail_path` /
//     `status` / `active_version_type` / `user_decision`. The
//     optimized file is discoverable via the media_versions row +
//     the static `/storage/...` route; surfacing it in frontend
//     gallery is a P11.T7 concern.
//
// Job channel: registered on the **video** channel, sharing
// `VIDEO_WORKER_CONCURRENCY=1` budget with `video_metadata` /
// `video_cover` / `video_proxy` / `video_keyframes` / `video_segments`
// / `video_segment_quality`. Optimize transcoding is potentially the
// heaviest video task (4K → 1080p with preset=medium can take
// minutes); serialising via budget=1 keeps the host responsive.
//
// Idempotency: re-running on the same media UPSERTs the same
// `media_versions` row (UNIQUE (media_id, version_type)) and
// over-writes the same `derived/{mediaId}/video_optimized.mp4` file
// (`storage.putDerived({overwrite:true})`). FFmpeg encoding is NOT
// bit-deterministic across runs (x264 internal state has timing
// jitter), but the OUTPUT shape (dims, format, codec, ~CRF) is
// stable on the same source + settings — sufficient for our
// persistence guarantees.
//
// Failure modes (all throw → JobQueue marks failed, original file
// NEVER overwritten, no partial media_versions row left in 'ready'
// state):
//   * Media row missing / soft-deleted → throw. P7 contract: a
//     soft-deleted video should not receive further writes.
//   * media.type !== 'video' → throw (defence-in-depth; the
//     enqueue path already guards at the service layer).
//   * original_path NULL → throw.
//   * ffmpeg spawn fails (binary missing) → throw.
//   * ffmpeg exits non-zero → throw with trimmed stderr.
//   * Timeout → SIGKILL + throw.
//   * Output file 0 bytes → throw.
//   * ffprobe on the optimized file fails / can't determine dims → throw.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Logger } from "../logger.js";
import type { MediaRepository, MediaVersionsRepository } from "../media/index.js";
import type { LocalStorageProvider } from "../storage/index.js";
import { resolveUnderRoot } from "../storage/index.js";

import type { JobHandler } from "./handlerRegistry.js";
import { projectFfprobe } from "./videoMetadataWorker.js";

/**
 * Closed job_type token. The future P11.T7 frontend / any operator
 * tooling should enqueue this job_type by symbolic reference rather
 * than the raw string.
 */
export const VIDEO_OPTIMIZE_JOB_TYPE = "video_optimize";

/**
 * Fixed logical filename under `derived/{mediaId}/`. Stable so cleanup
 * tasks / log analyzers / the future P11.T7 frontend can hard-code
 * the path safely. Distinct from `video_proxy.mp4` (P9.T4) and
 * `video_cover.jpg` (P9.T3).
 */
const OPTIMIZED_FILENAME = "video_optimized.mp4";

/**
 * Output MIME for the optimized artefact. Hard-coded to `video/mp4`
 * because the worker always emits an MP4 container — the codec
 * settings can change (libx264 vs libx265 etc.) but the container
 * is stable.
 */
const OPTIMIZED_MIME = "video/mp4";

/**
 * Max bytes of ffmpeg stderr we retain when reporting failures.
 * Same rationale as P9.T2 / P9.T3 / P9.T4 — bounded log lines even
 * when ffmpeg goes chatty.
 */
const MAX_STDERR_BYTES = 4096;

/**
 * Runtime tunables. Wired from `config.video.optimize.*`. Defaults
 * are also declared here so the worker can be constructed in
 * isolation (smoke tests, future CLI tools) without booting the
 * full config layer.
 */
export interface VideoOptimizeSettings {
  /** Path to the `ffmpeg` binary (PATH lookup when set to "ffmpeg"). */
  readonly ffmpegPath: string;
  /** Path to the `ffprobe` binary (used to read back optimized dims). */
  readonly ffprobePath: string;
  /** Wall-clock cap for the ffmpeg child process. */
  readonly timeoutMs: number;
  /**
   * Target output height in pixels. Width auto-computed (yuv420p
   * needs even widths; the scale filter uses `-2` for that). Sources
   * shorter than this are NOT upscaled.
   */
  readonly targetHeight: number;
  /** libx264 CRF (0..51, lower = better). Default 23 = visually transparent web. */
  readonly crf: number;
  /** libx264 preset (ultrafast..placebo). Config layer validates. */
  readonly preset: string;
  /** Video codec name passed to ffmpeg's `-c:v`. */
  readonly videoCodec: string;
  /** Audio codec name passed to ffmpeg's `-c:a`. */
  readonly audioCodec: string;
  /** Audio bitrate in kbps (`-b:a <N>k`). */
  readonly audioBitrateKbps: number;
  /** Stamped into `media_versions.params` for traceability. */
  readonly workerVersion: string;
}

/**
 * Conservative defaults. Tuned for "browser-friendly playback
 * quality": visually-transparent web video, capped at 1080p, with a
 * preset that compresses better than `veryfast` without burning
 * pathological encode time.
 */
export const DEFAULT_VIDEO_OPTIMIZE_SETTINGS: VideoOptimizeSettings = {
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
  timeoutMs: 600_000,
  targetHeight: 1080,
  crf: 23,
  preset: "medium",
  videoCodec: "libx264",
  audioCodec: "aac",
  audioBitrateKbps: 160,
  workerVersion: "1.0",
};

export interface VideoOptimizeHandlerDeps {
  readonly storage: LocalStorageProvider;
  readonly mediaRepo: MediaRepository;
  readonly mediaVersionsRepo: MediaVersionsRepository;
  readonly settings?: VideoOptimizeSettings;
  readonly logger: Logger;
}

/**
 * Build the `video_optimize` handler. Register the returned value
 * on the executor's `JobHandlerRegistry` for the **video** channel
 * at boot.
 */
export function makeVideoOptimizeHandler(deps: VideoOptimizeHandlerDeps): JobHandler {
  const settings = deps.settings ?? DEFAULT_VIDEO_OPTIMIZE_SETTINGS;
  return async (job) => {
    const correlation = { jobId: job.id, mediaId: job.mediaId };

    // ---- 1. Resolve media row ------------------------------------------
    const media = deps.mediaRepo.findById(job.mediaId);
    if (media === null) {
      throw new Error(`media not found or soft-deleted: ${job.mediaId}`);
    }
    if (media.type !== "video") {
      throw new Error(`media is not a video (type='${media.type}'); refusing to optimize`);
    }
    if (media.originalPath === null) {
      throw new Error("media has no original_path; cannot run ffmpeg");
    }

    const absoluteInput = resolveUnderRoot(deps.storage.root, media.originalPath);

    // ---- 2. Per-call temp dir for ffmpeg output -----------------------
    // Always cleaned up in `finally`. Writing into a temp dir first
    // (then handing off to `storage.putDerived`) lets us atomically
    // replace the final file via the storage provider's rename
    // semantics and keeps a half-written `.mp4` out of the storage
    // tree if ffmpeg crashes mid-encode.
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-video-optimize-"));
    const tmpOutput = path.join(tmpRoot, OPTIMIZED_FILENAME);
    try {
      // ---- 3. Transcode -------------------------------------------------
      await runFfmpegOptimize({ input: absoluteInput, output: tmpOutput, settings });

      // ---- 4. Sanity check + read bytes --------------------------------
      const statResult = await stat(tmpOutput);
      if (statResult.size === 0) {
        throw new Error("ffmpeg produced an empty optimized file");
      }
      const optimizedBytes = await readFile(tmpOutput);

      // ---- 5. ffprobe the optimized file for authoritative dims/duration
      // Re-uses the projectFfprobe helper from videoMetadataWorker —
      // same projection shape we used for video_proxy (P9.T4).
      // Failures here throw: an optimized file whose dims we can't
      // determine is suspect even if its bytes are non-zero.
      const optimizedMeta = await runFfprobeOnPath(tmpOutput, settings);
      const projection = projectFfprobe(optimizedMeta);
      if (projection.width === null || projection.height === null) {
        throw new Error("ffprobe could not determine optimized file dimensions after transcode");
      }

      // ---- 6a. Persist derived bytes ----------------------------------
      const stored = await deps.storage.putDerived({
        tripId: media.tripId,
        mediaId: media.id,
        relPath: OPTIMIZED_FILENAME,
        data: optimizedBytes,
        overwrite: true,
      });

      // ---- 6b. UPSERT media_versions(version_type='video_optimized') --
      // params records every transcode knob so a future re-tune can
      // be diffed against historical optimized outputs. Also records
      // the source codec / dims read off the optimized file (which
      // equals the source dims when no downscale happened).
      const now = new Date().toISOString();
      const paramsJson = JSON.stringify({
        workerVersion: settings.workerVersion,
        targetHeight: settings.targetHeight,
        crf: settings.crf,
        preset: settings.preset,
        videoCodec: settings.videoCodec,
        audioCodec: settings.audioCodec,
        audioBitrateKbps: settings.audioBitrateKbps,
        optimizedDurationSec: projection.duration,
        optimizedVideoCodec: projection.videoCodec,
        optimizedAudioCodec: projection.audioCodec,
        optimizedBitrate: projection.bitrate,
      });
      deps.mediaVersionsRepo.upsert({
        mediaId: media.id,
        versionType: "video_optimized",
        filePath: stored.logicalPath,
        mimeType: OPTIMIZED_MIME,
        width: projection.width,
        height: projection.height,
        fileSize: optimizedBytes.length,
        params: paramsJson,
        now,
      });

      deps.logger.info(
        {
          ...correlation,
          optimizedPath: stored.logicalPath,
          width: projection.width,
          height: projection.height,
          fileSize: optimizedBytes.length,
          duration: projection.duration,
          videoCodec: projection.videoCodec,
          audioCodec: projection.audioCodec,
          workerVersion: settings.workerVersion,
        },
        "video_optimize: derived video_optimized.mp4 written + media_versions upserted",
      );
    } finally {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => {
        /* best-effort tmp cleanup */
      });
    }
  };
}

// ---------------------------------------------------------------------------
// ffmpeg + ffprobe helpers
// ---------------------------------------------------------------------------

interface FfmpegOptimizeArgs {
  readonly input: string;
  readonly output: string;
  readonly settings: VideoOptimizeSettings;
}

/**
 * Spawn ffmpeg to transcode the original to the optimized MP4.
 * Bounded timeout + SIGKILL on overrun. Throws on non-zero exit
 * (with trimmed stderr), spawn failure (binary missing), or timeout.
 *
 * Scale filter rationale (same as videoProxyWorker — keeps semantics
 * comparable):
 *   `-vf scale=-2:'min(ih,<target>)'` — height capped at target;
 *   never upscales (when source height ≤ target the filter is a
 *   no-op). `-2` for the width makes ffmpeg pick the largest even
 *   integer that preserves aspect (yuv420p chroma subsampling
 *   requires even dimensions).
 *
 * `-movflags +faststart` writes the MP4 moov atom at the front of
 * the file so the optimized file can be streamed without a full
 * download first — essential for browser <video> playback.
 *
 * `-pix_fmt yuv420p` is the maximum-compatibility chroma layout;
 * older browser decoders + iOS Safari refuse 4:4:4 H.264 inputs.
 *
 * Audio: passthrough transcode to AAC at the configured bitrate.
 * No filter chain (no normalization / no fade / no loop / no mute)
 * — P11.T1 is base optimization, audio policy is P11.T2.
 *
 * Sources without an audio stream are handled gracefully via
 * `-map 0:v -map 0:a?` (the `?` makes the audio map optional). For
 * silent sources the output has no audio stream rather than failing.
 */
async function runFfmpegOptimize(args: FfmpegOptimizeArgs): Promise<void> {
  const { input, output, settings } = args;

  const scaleFilter = `scale=-2:'min(ih,${settings.targetHeight})'`;

  const ffmpegArgs = [
    "-v",
    "error",
    "-i",
    input,
    "-map",
    "0:v",
    "-map",
    "0:a?",
    "-vf",
    scaleFilter,
    "-c:v",
    settings.videoCodec,
    "-preset",
    settings.preset,
    "-crf",
    settings.crf.toString(),
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    settings.audioCodec,
    "-b:a",
    `${settings.audioBitrateKbps}k`,
    "-movflags",
    "+faststart",
    "-y",
    output,
  ];

  const stderrChunks: Buffer[] = [];

  await new Promise<void>((resolve, reject) => {
    let killed = false;
    const child = spawn(settings.ffmpegPath, ffmpegArgs, {
      stdio: ["ignore", "ignore", "pipe"],
    });

    const timeoutHandle = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, settings.timeoutMs);

    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.once("error", (err) => {
      clearTimeout(timeoutHandle);
      reject(new Error(`ffmpeg spawn failed: ${err.message}`));
    });

    child.once("close", (code) => {
      clearTimeout(timeoutHandle);
      if (killed) {
        reject(
          new Error(
            `ffmpeg optimize timed out after ${settings.timeoutMs}ms (file=${path.basename(input)})`,
          ),
        );
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").slice(0, MAX_STDERR_BYTES);
        reject(new Error(`ffmpeg optimize exited ${code}: ${stderr.trim() || "(no stderr)"}`));
        return;
      }
      resolve();
    });
  });
}

/**
 * Run ffprobe against the produced optimized file and return the raw
 * JSON. The handler then feeds it to `projectFfprobe` from
 * videoMetadataWorker to extract dims / codec / duration.
 *
 * This is a tiny duplicate of videoMetadataWorker's `runFfprobe`
 * — same rationale as videoProxyWorker carries its own copy:
 * exporting the metadata worker's internal helper would broaden the
 * surface area of an otherwise-self-contained module. The optimize
 * post-encode probe is also semantically different: it's a sanity
 * check on the freshly-encoded artefact, not the persistence-grade
 * probe the metadata worker does.
 */
async function runFfprobeOnPath(
  absolutePath: string,
  settings: VideoOptimizeSettings,
): Promise<Record<string, unknown>> {
  const args = [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    absolutePath,
  ];

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    let killed = false;
    const child = spawn(settings.ffprobePath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeoutHandle = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, 30_000);

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.once("error", (err) => {
      clearTimeout(timeoutHandle);
      reject(new Error(`ffprobe spawn failed (optimize verify): ${err.message}`));
    });

    child.once("close", (code) => {
      clearTimeout(timeoutHandle);
      if (killed) {
        reject(new Error("ffprobe timed out (optimize verify)"));
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").slice(0, MAX_STDERR_BYTES);
        reject(
          new Error(`ffprobe exited ${code} (optimize verify): ${stderr.trim() || "(no stderr)"}`),
        );
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(stdoutChunks).toString("utf8")) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          reject(new Error("ffprobe output is not a JSON object (optimize verify)"));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reject(new Error(`ffprobe output not parseable as JSON (optimize verify): ${message}`));
      }
    });
  });
}
