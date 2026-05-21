// VideoWorker.metadata (P9.T2).
//
// Job handler registered as `video_metadata` on the video-channel
// executor. For one media row:
//   1. Resolve the media via `media_items.original_path`.
//   2. Spawn `ffprobe -v error -print_format json -show_format
//      -show_streams <absolutePath>` and parse the JSON output.
//   3. Project the technical fields the gallery + detail UI need
//      (duration, width, height, fps, bitrate, video codec, audio
//      codec + channels + sample rate, container format).
//   4. Persist:
//        a. `media_items.duration` / `width` / `height` so the
//           existing detail page renders without joining anywhere
//           (image workers write the same three columns for stills).
//        b. `media_versions(version_type='metadata')` with the full
//           ffprobe JSON in `params` — mirrors the convention from
//           `image_metadata` worker so the metadata bundle is
//           uniformly accessible from the existing detail endpoint.
//
// Scope per docs/tasks.md P9.T2 — strictly ffprobe read + persist.
// Explicitly NOT in scope:
//   * Cover-frame extraction (P9.T3).
//   * Proxy / keyframe extraction (P9.T4 / T5).
//   * Segment creation (P9.T6 fills video_segments).
//   * Segment quality (P9.T7).
//   * Video API / frontend (P9.T8 / T9).
//
// Job channel: the worker is registered on the `video` channel
// (`config.workers.videoConcurrency`, default 1) so a slow ffprobe
// won't starve the image channel. The upload pipeline (P2.T4) already
// enqueues a `video_metadata` job on every video upload — see
// uploadService.ts:68.
//
// Idempotency: re-running the same `video_metadata` job for the
// same media UPSERTs the metadata version row (UNIQUE
// (media_id, version_type)) and re-writes the same three
// `media_items` columns. ffprobe is deterministic on the same file,
// so a re-run yields the same JSON.
//
// Failure modes:
//   * Media row missing / soft-deleted → throw. P7 contract: a
//     soft-deleted video should not receive further writes.
//   * media.type !== 'video' → throw. Defense-in-depth; the upload
//     path only ever enqueues this job for video uploads.
//   * original_path NULL → throw. video uploads always set
//     original_path; NULL would be an upstream bug.
//   * Underlying file missing on disk → ffprobe exits non-zero;
//     we surface its stderr.
//   * ffprobe exits non-zero → throw with the trimmed stderr.
//   * stdout is not parseable JSON → throw with a snippet of the
//     bad output (don't swallow into a silent success).
//   * No video stream in the JSON → throw. The file isn't actually
//     a video; classifier shouldn't have let it through, but if it
//     did, we fail loudly rather than silently writing NULLs.
//   * Per-field absence (audio stream / bitrate / fps) is TOLERATED:
//     fields are null in the JSON payload and `media_items.duration`
//     etc. only update if the field was present.

import { spawn } from "node:child_process";
import path from "node:path";

import type { Logger } from "../logger.js";
import type { MediaRepository, MediaVersionsRepository } from "../media/index.js";
import type { LocalStorageProvider } from "../storage/index.js";
import { resolveUnderRoot } from "../storage/index.js";

import type { JobHandler } from "./handlerRegistry.js";

/** Closed job_type token. Same string the upload pipeline enqueues
 * for video uploads (uploadService.ts:68). */
export const VIDEO_METADATA_JOB_TYPE = "video_metadata";

/** application/json — describes the `params` payload (a JSON blob
 * with the projected ffprobe fields), not a separate JSON file. Same
 * convention as `image_metadata` worker. */
const METADATA_MIME = "application/json";

/**
 * Bounded wait for ffprobe to finish. ffprobe on a typical phone
 * video completes in well under a second; this cap protects against
 * a stuck child process (e.g. a malformed container that triggers
 * a parser loop). Surfaced as a config knob in case slower files
 * or remote storage paths need more headroom.
 */
const DEFAULT_FFPROBE_TIMEOUT_MS = 30_000;

/** Maximum bytes of stderr to retain when reporting an ffprobe
 * failure. Keeps log lines bounded even when ffprobe goes chatty. */
const MAX_STDERR_BYTES = 4096;

/** Maximum bytes of stdout to retain when ffprobe emits unparseable
 * output. Same bound rationale as MAX_STDERR_BYTES. */
const MAX_STDOUT_SNIPPET = 512;

/**
 * Runtime tunables for the worker. Wired from `config.ffmpeg` +
 * an explicit timeout. Stamped into `media_versions.params.workerVersion`
 * so a future re-tune can be diffed against prior runs.
 */
export interface VideoMetadataSettings {
  /** Path to the `ffprobe` binary. Defaults to `'ffprobe'` (PATH lookup). */
  readonly ffprobePath: string;
  /** Max wall-clock time for the ffprobe child process. */
  readonly ffprobeTimeoutMs: number;
  /** Stamped into `media_versions.params` for traceability. */
  readonly workerVersion: string;
}

export const DEFAULT_VIDEO_METADATA_SETTINGS: VideoMetadataSettings = {
  ffprobePath: "ffprobe",
  ffprobeTimeoutMs: DEFAULT_FFPROBE_TIMEOUT_MS,
  workerVersion: "1.0",
};

export interface VideoMetadataHandlerDeps {
  readonly storage: LocalStorageProvider;
  readonly mediaRepo: MediaRepository;
  readonly mediaVersionsRepo: MediaVersionsRepository;
  readonly settings?: VideoMetadataSettings;
  readonly logger: Logger;
}

/**
 * Projected, UI-relevant ffprobe fields. Every field is independently
 * nullable so a partial probe (e.g. a video-only MP4 with no audio
 * stream) still produces a complete payload. The raw ffprobe JSON is
 * also persisted under `raw` so future fields can be extracted
 * without re-running ffprobe.
 */
export interface VideoMetadataProjection {
  readonly duration: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly frameRate: number | null;
  readonly bitrate: number | null;
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
  readonly audioChannels: number | null;
  readonly audioSampleRate: number | null;
  readonly containerFormat: string | null;
}

/**
 * Build the `video_metadata` handler. Register the returned value
 * on the executor's `JobHandlerRegistry` for the **video** channel
 * at boot.
 */
export function makeVideoMetadataHandler(deps: VideoMetadataHandlerDeps): JobHandler {
  const settings = deps.settings ?? DEFAULT_VIDEO_METADATA_SETTINGS;
  return async (job) => {
    const correlation = { jobId: job.id, mediaId: job.mediaId };

    // ---- 1. Resolve media row ------------------------------------------
    const media = deps.mediaRepo.findById(job.mediaId);
    if (media === null) {
      throw new Error(`media not found or soft-deleted: ${job.mediaId}`);
    }
    if (media.type !== "video") {
      throw new Error(`media is not a video (type='${media.type}'); refusing to read metadata`);
    }
    if (media.originalPath === null) {
      throw new Error("media has no original_path; cannot run ffprobe");
    }

    // ---- 2. Resolve absolute path + run ffprobe -----------------------
    const absolutePath = resolveUnderRoot(deps.storage.root, media.originalPath);
    const probe = await runFfprobe(absolutePath, settings);

    // ---- 3. Project the technical fields ------------------------------
    const projection = projectFfprobe(probe);
    if (projection.width === null || projection.height === null || projection.videoCodec === null) {
      // No video stream found — classifier shouldn't have let this
      // through. Fail loudly with the parsed JSON so the executor
      // logs make the diagnosis obvious.
      throw new Error(
        `ffprobe output has no usable video stream (videoCodec=${String(
          projection.videoCodec,
        )} dims=${String(projection.width)}x${String(projection.height)})`,
      );
    }

    // ---- 4. Persist ---------------------------------------------------
    const now = new Date().toISOString();

    // 4a. Cache the cardinal fields on media_items so the existing
    //     detail / gallery endpoints don't need a media_versions join.
    //     Three fields total: duration (the video-specific column),
    //     width, height (shared with the image workers).
    const changed = deps.mediaRepo.updateVideoMetadata({
      mediaId: media.id,
      duration: projection.duration,
      width: projection.width,
      height: projection.height,
      updatedAt: now,
    });
    if (changed === 0) {
      // The row was soft-deleted between the read and the write —
      // worker-level race that we let through; the metadata version
      // row still lands in case the user restores the media later.
      deps.logger.warn(
        correlation,
        "video_metadata: media row not updated (likely soft-deleted mid-job); metadata version row still written",
      );
    }

    // 4b. UPSERT the metadata version row. file_path points at the
    //     original file (no separate metadata.json on disk) — same
    //     convention as image_metadata worker.
    const paramsJson = JSON.stringify({
      workerVersion: settings.workerVersion,
      ffprobe: projection,
      raw: probe,
    });
    deps.mediaVersionsRepo.upsert({
      mediaId: media.id,
      versionType: "metadata",
      filePath: media.originalPath,
      mimeType: METADATA_MIME,
      width: projection.width,
      height: projection.height,
      fileSize: null,
      params: paramsJson,
      now,
    });

    deps.logger.info(
      {
        ...correlation,
        originalPath: media.originalPath,
        duration: projection.duration,
        width: projection.width,
        height: projection.height,
        frameRate: projection.frameRate,
        bitrate: projection.bitrate,
        videoCodec: projection.videoCodec,
        audioCodec: projection.audioCodec,
        containerFormat: projection.containerFormat,
        workerVersion: settings.workerVersion,
      },
      "video_metadata: ffprobe + media_versions(metadata) upserted",
    );
  };
}

// ---------------------------------------------------------------------------
// ffprobe spawn + JSON parse
// ---------------------------------------------------------------------------

/**
 * Raw shape we use from ffprobe's `-show_format -show_streams`
 * output. ffprobe writes much more than this — `projectFfprobe`
 * only reads the fields we care about, everything else passes
 * through into `raw` for later use without re-probing.
 */
interface FfprobeFormat {
  readonly format_name?: string;
  readonly duration?: string;
  readonly bit_rate?: string;
}

interface FfprobeStream {
  readonly codec_type?: string;
  readonly codec_name?: string;
  readonly width?: number;
  readonly height?: number;
  readonly r_frame_rate?: string;
  readonly avg_frame_rate?: string;
  readonly bit_rate?: string;
  readonly channels?: number;
  readonly sample_rate?: string;
  readonly duration?: string;
}

interface FfprobeJson {
  readonly format?: FfprobeFormat;
  readonly streams?: readonly FfprobeStream[];
}

/**
 * Spawn ffprobe with a bounded timeout, capture stdout / stderr,
 * and parse stdout as JSON.
 *
 * Throws on:
 *   * non-zero exit code (includes trimmed stderr in the message);
 *   * timeout (kills the child + throws);
 *   * unparseable stdout (includes a stdout snippet).
 */
async function runFfprobe(
  absolutePath: string,
  settings: VideoMetadataSettings,
): Promise<FfprobeJson> {
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

  return await new Promise<FfprobeJson>((resolve, reject) => {
    let killed = false;
    const child = spawn(settings.ffprobePath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeoutHandle = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, settings.ffprobeTimeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.once("error", (err) => {
      clearTimeout(timeoutHandle);
      // Spawn-level failures (e.g. ffprobe binary not on PATH) land
      // here. Surface a deterministic message so the executor's
      // failed-job row makes the diagnosis easy.
      reject(new Error(`ffprobe spawn failed: ${err.message}`));
    });

    child.once("close", (code) => {
      clearTimeout(timeoutHandle);
      if (killed) {
        reject(
          new Error(
            `ffprobe timed out after ${settings.ffprobeTimeoutMs}ms (file=${path.basename(absolutePath)})`,
          ),
        );
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").slice(0, MAX_STDERR_BYTES);
        reject(new Error(`ffprobe exited ${code}: ${stderr.trim() || "(no stderr)"}`));
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      try {
        const parsed = JSON.parse(stdout) as unknown;
        if (!isPlainObject(parsed)) {
          reject(
            new Error(
              `ffprobe output is not a JSON object: ${stdout.slice(0, MAX_STDOUT_SNIPPET)}`,
            ),
          );
          return;
        }
        resolve(parsed as FfprobeJson);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reject(
          new Error(
            `ffprobe output not parseable as JSON (${message}); stdout="${stdout.slice(0, MAX_STDOUT_SNIPPET)}"`,
          ),
        );
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * Project the raw ffprobe JSON onto the UI-relevant fields.
 *
 * Per-field robustness: each field is independently nullable. A
 * video-only MP4 with no audio stream yields
 * `audioCodec / audioChannels / audioSampleRate = null` (and the
 * worker still succeeds). A container without a usable bitrate
 * yields `bitrate = null`. Missing fps strings yield
 * `frameRate = null` rather than NaN.
 *
 * The video-stream fields (width / height / videoCodec) MUST be
 * present for the job to succeed; the caller (`makeVideoMetadataHandler`)
 * throws when any of them is null.
 */
export function projectFfprobe(probe: FfprobeJson): VideoMetadataProjection {
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const videoStream = streams.find((s) => s.codec_type === "video");
  const audioStream = streams.find((s) => s.codec_type === "audio");

  // Duration: prefer the container-level value (format.duration),
  // fall back to the video stream's own duration if the container
  // doesn't report one (some MKVs do this). Both are decimal strings
  // in ffprobe output.
  const duration =
    parseFloatOrNull(probe.format?.duration) ?? parseFloatOrNull(videoStream?.duration) ?? null;

  // Bitrate: same fallback chain. ffprobe reports integer-string
  // bytes-per-second; we keep it as a number for downstream
  // formatting / comparisons.
  const bitrate =
    parseIntOrNull(probe.format?.bit_rate) ?? parseIntOrNull(videoStream?.bit_rate) ?? null;

  // Frame rate: prefer `r_frame_rate` (the stream's "real" rate, an
  // exact ratio like "30000/1001"); fall back to `avg_frame_rate`.
  const frameRate =
    parseRationalOrNull(videoStream?.r_frame_rate) ??
    parseRationalOrNull(videoStream?.avg_frame_rate) ??
    null;

  return {
    duration,
    width: typeof videoStream?.width === "number" ? videoStream.width : null,
    height: typeof videoStream?.height === "number" ? videoStream.height : null,
    frameRate,
    bitrate,
    videoCodec: typeof videoStream?.codec_name === "string" ? videoStream.codec_name : null,
    audioCodec: typeof audioStream?.codec_name === "string" ? audioStream.codec_name : null,
    audioChannels: typeof audioStream?.channels === "number" ? audioStream.channels : null,
    audioSampleRate: parseIntOrNull(audioStream?.sample_rate),
    containerFormat:
      typeof probe.format?.format_name === "string" ? probe.format.format_name : null,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function parseFloatOrNull(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function parseIntOrNull(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a "num/den" ffprobe rational into a float. Returns null on
 * malformed input or a zero denominator. "0/0" (which ffprobe emits
 * for streams with no measurable rate) intentionally returns null.
 */
function parseRationalOrNull(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parts = value.split("/");
  if (parts.length !== 2) return null;
  const num = Number.parseFloat(parts[0] ?? "");
  const den = Number.parseFloat(parts[1] ?? "");
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  return num / den;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
