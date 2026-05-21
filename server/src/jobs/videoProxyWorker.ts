// VideoWorker.proxy (P9.T4).
//
// Job handler registered as `video_proxy` on the video-channel
// executor. For one media row:
//   1. Resolve the media via `media_items.original_path`.
//   2. Transcode the original to a low-res H.264 / AAC MP4 via
//      FFmpeg. Output dimensions: width auto-computed, height
//      capped at `settings.targetHeight` (no upscale when source
//      is shorter — `-2:'min(ih,H)'` keeps the source dims for
//      already-small videos). CRF 28, preset `veryfast`,
//      faststart for streaming-friendly playback.
//   3. Move the bytes into the project's storage as
//      `derived/{mediaId}/video_proxy.mp4` via
//      `storage.putDerived({ overwrite: true })` (matches
//      design.md §6.2.5 / §8.1 exactly; matches the
//      `media_versions.version_type='video_proxy'` enum value
//      from migration 005 file comment).
//   4. Run ffprobe on the proxy ONLY to read back authoritative
//      width / height / duration / size for the
//      `media_versions(video_proxy)` row. We do NOT re-run the
//      P9.T2 metadata pipeline against the proxy — that
//      describes the SOURCE; this row describes the PROXY.
//   5. UPSERT `media_versions(version_type='video_proxy')` with
//      `file_path` + `mime_type='video/mp4'` + `width` / `height`
//      / `file_size` + `params` JSON recording every transcode
//      knob (targetHeight, crf, preset, videoCodec, audioCodec,
//      audioBitrateKbps, workerVersion) for audit traceability.
//
// Scope per docs/tasks.md P9.T4 — strictly proxy generation +
// persistence. Explicitly NOT in scope:
//   * Touching `media_items.preview_path`. That column is owned
//     by the image-channel preview worker (P3.T4); pointing it at
//     an MP4 for videos would force every preview-path reader to
//     branch on MIME type. The proxy is discoverable via the
//     media_versions row instead; P9.T8 Video API will surface
//     it cleanly. Recorded as R-101 in progress.md.
//   * Keyframe extraction (P9.T5), segments (P9.T6), segment
//     quality (P9.T7), Video API (P9.T8), frontend (P9.T9).
//   * Re-running on transient ffmpeg flakes — JobQueue's existing
//     retry policy handles that; the worker just throws.
//   * Modifying P9.T2 metadata worker / P9.T3 cover worker.
//
// Job channel: registered on the **video** channel, sharing
// `VIDEO_WORKER_CONCURRENCY=1` budget with `video_metadata` +
// `video_cover`. Proxy transcoding is the heaviest video task
// (typically minutes for a 4K source); serialising via budget=1
// keeps the host responsive.
//
// Idempotency: re-running on the same media UPSERTs the same
// `media_versions` row (UNIQUE (media_id, version_type)) and
// over-writes the same `derived/{mediaId}/video_proxy.mp4` file
// (`storage.putDerived({overwrite:true})`). FFmpeg encoding is NOT
// bit-deterministic across runs (x264 internal state has timing
// jitter), but the OUTPUT shape (dims, format, codec, ~CRF) is
// stable on the same source + settings — sufficient for our
// persistence guarantees.
//
// Failure modes (all throw → JobQueue marks failed, original file
// NEVER overwritten):
//   * Media row missing / soft-deleted → throw. P7 contract: a
//     soft-deleted video should not receive further writes.
//   * media.type !== 'video' → throw (defense-in-depth; the
//     upload path only enqueues video jobs for video uploads).
//   * original_path NULL → throw.
//   * ffmpeg spawn fails (binary missing) → throw.
//   * ffmpeg exits non-zero → throw with trimmed stderr.
//   * Timeout → SIGKILL + throw.
//   * Output file 0 bytes → throw.
//   * ffprobe on the proxy fails / can't determine dims → throw.

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

/** Closed job_type token. Future P9.T8 Video API can enqueue this
 * job_type by symbolic reference rather than the raw string. */
export const VIDEO_PROXY_JOB_TYPE = "video_proxy";

/** Fixed logical filename under `derived/{mediaId}/`. Matches
 * design.md §6.2.5 exactly so cleanup tasks / log analyzers can
 * hard-code the path safely. */
const PROXY_FILENAME = "video_proxy.mp4";

/** Output MIME for the proxy artefact. Hard-coded to `video/mp4`
 * because the worker always emits an MP4 container — the codec
 * settings can change (libx264 vs libx265 etc.) but the container
 * is stable. */
const PROXY_MIME = "video/mp4";

/** Max bytes of ffmpeg stderr we retain when reporting failures.
 * Same rationale as P9.T2 / P9.T3 — bounded log lines even when
 * ffmpeg goes chatty. */
const MAX_STDERR_BYTES = 4096;

/**
 * Runtime tunables. Wired from `config.video.proxy.*`. Defaults are
 * also declared here so the worker can be constructed in isolation
 * (smoke tests, future CLI tools) without booting the full config
 * layer.
 */
export interface VideoProxySettings {
  /** Path to the `ffmpeg` binary (PATH lookup when set to "ffmpeg"). */
  readonly ffmpegPath: string;
  /** Path to the `ffprobe` binary (used to read back proxy dims). */
  readonly ffprobePath: string;
  /** Wall-clock cap for the ffmpeg child process. */
  readonly timeoutMs: number;
  /** Target output height in pixels. Width auto-computed (yuv420p
   * needs even widths; the scale filter uses `-2` for that). */
  readonly targetHeight: number;
  /** libx264 CRF (0..51, lower = better). 28 is the design default. */
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

export const DEFAULT_VIDEO_PROXY_SETTINGS: VideoProxySettings = {
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
  timeoutMs: 300_000,
  targetHeight: 720,
  crf: 28,
  preset: "veryfast",
  videoCodec: "libx264",
  audioCodec: "aac",
  audioBitrateKbps: 128,
  workerVersion: "1.0",
};

export interface VideoProxyHandlerDeps {
  readonly storage: LocalStorageProvider;
  readonly mediaRepo: MediaRepository;
  readonly mediaVersionsRepo: MediaVersionsRepository;
  readonly settings?: VideoProxySettings;
  readonly logger: Logger;
}

/**
 * Build the `video_proxy` handler. Register the returned value on
 * the executor's `JobHandlerRegistry` for the **video** channel at
 * boot.
 */
export function makeVideoProxyHandler(deps: VideoProxyHandlerDeps): JobHandler {
  const settings = deps.settings ?? DEFAULT_VIDEO_PROXY_SETTINGS;
  return async (job) => {
    const correlation = { jobId: job.id, mediaId: job.mediaId };

    // ---- 1. Resolve media row ------------------------------------------
    const media = deps.mediaRepo.findById(job.mediaId);
    if (media === null) {
      throw new Error(`media not found or soft-deleted: ${job.mediaId}`);
    }
    if (media.type !== "video") {
      throw new Error(`media is not a video (type='${media.type}'); refusing to transcode proxy`);
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
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-video-proxy-"));
    const tmpOutput = path.join(tmpRoot, PROXY_FILENAME);
    try {
      // ---- 3. Transcode -------------------------------------------------
      await runFfmpegProxy({ input: absoluteInput, output: tmpOutput, settings });

      // ---- 4. Sanity check + read bytes --------------------------------
      const statResult = await stat(tmpOutput);
      if (statResult.size === 0) {
        throw new Error("ffmpeg produced an empty proxy file");
      }
      const proxyBytes = await readFile(tmpOutput);

      // ---- 5. ffprobe the proxy for authoritative dims/duration -------
      // We re-use the projectFfprobe helper from videoMetadataWorker;
      // it gives us width / height / duration / video codec which
      // mirror the source-side metadata projection. Failures here
      // throw — a proxy whose dims we can't determine is suspect
      // even if its bytes are non-zero.
      const proxyMeta = await runFfprobeOnPath(tmpOutput, settings);
      const projection = projectFfprobe(proxyMeta);
      if (projection.width === null || projection.height === null) {
        throw new Error("ffprobe could not determine proxy dimensions after transcode");
      }

      // ---- 6a. Persist derived bytes ----------------------------------
      const stored = await deps.storage.putDerived({
        tripId: media.tripId,
        mediaId: media.id,
        relPath: PROXY_FILENAME,
        data: proxyBytes,
        overwrite: true,
      });

      // ---- 6b. UPSERT media_versions(version_type='video_proxy') ------
      // params records every transcode knob so a future re-tune can
      // be diffed against historical proxies.
      const now = new Date().toISOString();
      const paramsJson = JSON.stringify({
        workerVersion: settings.workerVersion,
        targetHeight: settings.targetHeight,
        crf: settings.crf,
        preset: settings.preset,
        videoCodec: settings.videoCodec,
        audioCodec: settings.audioCodec,
        audioBitrateKbps: settings.audioBitrateKbps,
        proxyDurationSec: projection.duration,
        proxyVideoCodec: projection.videoCodec,
        proxyAudioCodec: projection.audioCodec,
        proxyBitrate: projection.bitrate,
      });
      deps.mediaVersionsRepo.upsert({
        mediaId: media.id,
        versionType: "video_proxy",
        filePath: stored.logicalPath,
        mimeType: PROXY_MIME,
        width: projection.width,
        height: projection.height,
        fileSize: proxyBytes.length,
        params: paramsJson,
        now,
      });

      deps.logger.info(
        {
          ...correlation,
          proxyPath: stored.logicalPath,
          width: projection.width,
          height: projection.height,
          fileSize: proxyBytes.length,
          duration: projection.duration,
          videoCodec: projection.videoCodec,
          audioCodec: projection.audioCodec,
          workerVersion: settings.workerVersion,
        },
        "video_proxy: derived video_proxy.mp4 written + media_versions upserted",
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

interface FfmpegProxyArgs {
  readonly input: string;
  readonly output: string;
  readonly settings: VideoProxySettings;
}

/**
 * Spawn ffmpeg to transcode the original to the proxy MP4. Bounded
 * timeout + SIGKILL on overrun. Throws on non-zero exit (with
 * trimmed stderr), spawn failure (binary missing), or timeout.
 *
 * Scale filter rationale:
 *   `-vf scale=-2:'min(ih,<target>)'` — height capped at target;
 *   never upscales (when source height ≤ target the filter is a
 *   no-op). `-2` for the width makes ffmpeg pick the largest even
 *   integer that preserves aspect (yuv420p chroma subsampling
 *   requires even dimensions).
 *
 * `-movflags +faststart` writes the MP4 moov atom at the front of
 * the file so the proxy can be streamed without a full download
 * first — essential for a "preview" workflow.
 *
 * `-pix_fmt yuv420p` is the maximum-compatibility chroma layout;
 * older browser decoders + iOS Safari refuse 4:4:4 H.264 inputs.
 */
async function runFfmpegProxy(args: FfmpegProxyArgs): Promise<void> {
  const { input, output, settings } = args;

  const scaleFilter = `scale=-2:'min(ih,${settings.targetHeight})'`;

  const ffmpegArgs = [
    "-v",
    "error",
    "-i",
    input,
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
    "-ac",
    "2",
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
            `ffmpeg proxy timed out after ${settings.timeoutMs}ms (file=${path.basename(input)})`,
          ),
        );
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").slice(0, MAX_STDERR_BYTES);
        reject(new Error(`ffmpeg proxy exited ${code}: ${stderr.trim() || "(no stderr)"}`));
        return;
      }
      resolve();
    });
  });
}

/**
 * Run ffprobe against the produced proxy file and return the raw
 * JSON. The handler then feeds it to `projectFfprobe` from
 * videoMetadataWorker to extract dims / codec / duration.
 *
 * This is a tiny duplicate of videoMetadataWorker's `runFfprobe`
 * — we deliberately don't import that one because exporting it
 * would broaden the surface area of the metadata worker. The
 * proxy-side probe is also semantically different: it's a sanity
 * check on the freshly-encoded artefact, not the
 * persistence-grade probe the metadata worker does.
 */
async function runFfprobeOnPath(
  absolutePath: string,
  settings: VideoProxySettings,
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
      reject(new Error(`ffprobe spawn failed (proxy verify): ${err.message}`));
    });

    child.once("close", (code) => {
      clearTimeout(timeoutHandle);
      if (killed) {
        reject(new Error("ffprobe timed out (proxy verify)"));
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").slice(0, MAX_STDERR_BYTES);
        reject(
          new Error(`ffprobe exited ${code} (proxy verify): ${stderr.trim() || "(no stderr)"}`),
        );
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(stdoutChunks).toString("utf8")) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          reject(new Error("ffprobe output is not a JSON object (proxy verify)"));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reject(new Error(`ffprobe output not parseable as JSON (proxy verify): ${message}`));
      }
    });
  });
}
