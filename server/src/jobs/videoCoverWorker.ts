// VideoWorker.cover (P9.T3).
//
// Job handler registered as `video_cover` on the video-channel
// executor. For one media row:
//   1. Resolve the media via `media_items.original_path`.
//   2. Choose a seek time based on `media_items.duration` (written
//      by P9.T2 video_metadata worker if it has already run, NULL
//      otherwise):
//        * duration NULL or ≤ 0       → seek 0.0
//        * 0 < duration < 2 seconds   → seek duration / 2 (midpoint)
//        * duration ≥ 2 seconds       → seek min(duration / 2,
//                                           settings.fallbackSeekSeconds)
//      The midpoint heuristic skips startup glitches (auto-focus,
//      fade-in) without ever falling off the end of the clip; the
//      fallback cap (default 5s) keeps the input-side seek cheap
//      on very long videos.
//   3. Spawn `ffmpeg -ss <seek> -i <absolute> -frames:v 1
//      -vf scale='min(MAX_EDGE,iw)':'min(MAX_EDGE,ih)':force_original_aspect_ratio=decrease
//      -q:v <quality> -f image2 -update 1 -y <tmp output>`.
//      `-ss` BEFORE `-i` selects the input-side seek path (decoder
//      seeks to nearest keyframe, then advances); `-frames:v 1`
//      writes exactly one image; `-q:v` is ffmpeg's JPEG quality
//      scale (2-31, lower = better).
//   4. Read the produced JPEG, run `sharp().metadata()` to get
//      authoritative width/height/byte-size.
//   5. Persist:
//        a. Move the bytes into the project's storage via
//           `storage.putDerived` with `overwrite:true` so retries
//           replace cleanly. Logical path:
//           `trips/{tripId}/derived/{mediaId}/video_cover.jpg`
//           (matches design.md §8.1 exactly).
//        b. Cache the logical path on `media_items.thumbnail_path`
//           so the existing P3.T8 cover_url derivation + P6.T7
//           auto-cover selection both surface video covers without
//           per-type branching. The image worker (P3.T4) does the
//           same thing for image thumbnails.
//        c. UPSERT `media_versions(version_type='video_cover')`
//           with the cover path + sharp metadata + sharp /
//           ffmpeg / workerVersion stamps in `params`.
//
// Scope per docs/tasks.md P9.T3 — strictly cover-frame extraction.
// Explicitly NOT in scope:
//   * Proxy / keyframes / segments / segment quality (P9.T4-T7).
//   * Smart cover-frame selection (P10+ AI work).
//   * Re-running on selection failure (the worker just succeeds with
//     the closest available frame; FFmpeg never errors on a short
//     video — it clamps the seek to the end of the stream).
//
// Idempotency: re-running on the same media UPSERTs the same row
// (UNIQUE (media_id, version_type)) and over-writes the same
// `derived/{mediaId}/video_cover.jpg` file. FFmpeg with `-y` over-
// writes the temp output; `storage.putDerived({overwrite:true})`
// over-writes the final storage path. ffprobe's frame at the seek
// point is deterministic on the same source bytes.
//
// Failure modes:
//   * Media row missing / soft-deleted → throw. P7 contract: a
//     soft-deleted video should not receive further writes.
//   * media.type !== 'video' → throw (defense-in-depth).
//   * original_path NULL → throw.
//   * ffmpeg spawn fails (binary missing) → throw.
//   * ffmpeg exits non-zero → throw with trimmed stderr.
//   * Timeout → SIGKILL + throw.
//   * Output file unreadable / 0 bytes / sharp can't decode → throw.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";

import type { Logger } from "../logger.js";
import type { MediaRepository, MediaVersionsRepository } from "../media/index.js";
import type { LocalStorageProvider } from "../storage/index.js";
import { resolveUnderRoot } from "../storage/index.js";

import type { JobHandler } from "./handlerRegistry.js";

/** Closed job_type token. Workers and triggers (future P9 work)
 * reference this constant rather than the raw string. */
export const VIDEO_COVER_JOB_TYPE = "video_cover";

/** Fixed logical filename under `derived/{mediaId}/`. Matches
 * design.md §8.1 exactly so future code that hard-codes the path
 * (e.g. cleanup tasks, log analyzers) stays correct. */
const COVER_FILENAME = "video_cover.jpg";

/** Output MIME for the cover artefact. Stamped onto
 * `media_versions.mime_type` so the detail / gallery endpoints can
 * render the cover without sniffing the file. */
const COVER_MIME = "image/jpeg";

/** Max bytes of ffmpeg stderr we retain when reporting failures.
 * Same rationale as the video_metadata worker — keep log lines
 * bounded even when ffmpeg goes chatty on a malformed input. */
const MAX_STDERR_BYTES = 4096;

/**
 * Runtime tunables. Wired from `config.video.cover.*`. Defaults are
 * declared here so the worker can be constructed in isolation
 * (smoke tests, future CLI tools) without booting the full config
 * layer.
 */
export interface VideoCoverSettings {
  /** Path to the `ffmpeg` binary (PATH lookup when set to "ffmpeg"). */
  readonly ffmpegPath: string;
  /** Wall-clock cap for the ffmpeg child process. */
  readonly timeoutMs: number;
  /** Upper bound on the cover's longest edge (px). */
  readonly maxEdge: number;
  /** ffmpeg's `-q:v` (range 2-31, lower = better). */
  readonly jpegQuality: number;
  /**
   * When duration is ≥ 2s the worker seeks
   * `min(duration / 2, fallbackSeekSeconds)`. Caps the seek on long
   * videos so the decoder doesn't have to traverse far past the
   * nearest keyframe.
   */
  readonly fallbackSeekSeconds: number;
  /** Stamped into `media_versions.params` for traceability. */
  readonly workerVersion: string;
}

export const DEFAULT_VIDEO_COVER_SETTINGS: VideoCoverSettings = {
  ffmpegPath: "ffmpeg",
  timeoutMs: 30_000,
  maxEdge: 1280,
  jpegQuality: 2,
  fallbackSeekSeconds: 5,
  workerVersion: "1.0",
};

export interface VideoCoverHandlerDeps {
  readonly storage: LocalStorageProvider;
  readonly mediaRepo: MediaRepository;
  readonly mediaVersionsRepo: MediaVersionsRepository;
  readonly settings?: VideoCoverSettings;
  readonly logger: Logger;
}

/**
 * Compute the seek time (seconds from the start of the source video)
 * for cover-frame extraction. See file header for the policy.
 *
 * Exported for unit-coverage in the smoke; the handler calls it
 * with the live `media.duration` value (which may be null when
 * P9.T2 hasn't run yet) and `settings.fallbackSeekSeconds`.
 */
export function chooseCoverSeekSeconds(
  duration: number | null,
  fallbackSeekSeconds: number,
): number {
  if (duration === null || !Number.isFinite(duration) || duration <= 0) return 0;
  if (duration < 2) return duration / 2;
  return Math.min(duration / 2, fallbackSeekSeconds);
}

/**
 * Build the `video_cover` handler. Register the returned value on
 * the executor's `JobHandlerRegistry` for the **video** channel at
 * boot.
 */
export function makeVideoCoverHandler(deps: VideoCoverHandlerDeps): JobHandler {
  const settings = deps.settings ?? DEFAULT_VIDEO_COVER_SETTINGS;
  return async (job) => {
    const correlation = { jobId: job.id, mediaId: job.mediaId };

    // ---- 1. Resolve media row ------------------------------------------
    const media = deps.mediaRepo.findById(job.mediaId);
    if (media === null) {
      throw new Error(`media not found or soft-deleted: ${job.mediaId}`);
    }
    if (media.type !== "video") {
      throw new Error(`media is not a video (type='${media.type}'); refusing to extract cover`);
    }
    if (media.originalPath === null) {
      throw new Error("media has no original_path; cannot run ffmpeg");
    }

    // ---- 2. Choose seek time + run ffmpeg ------------------------------
    const seekSeconds = chooseCoverSeekSeconds(media.duration, settings.fallbackSeekSeconds);
    const absoluteInput = resolveUnderRoot(deps.storage.root, media.originalPath);

    // We write into a per-call temp dir, then `storage.putDerived`
    // moves the bytes into the project's storage tree. The temp dir
    // is always cleaned up in `finally`.
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-video-cover-"));
    const tmpOutput = path.join(tmpRoot, COVER_FILENAME);
    try {
      await runFfmpegCover({
        input: absoluteInput,
        output: tmpOutput,
        seekSeconds,
        settings,
      });

      // ---- 3. Read output + sharp metadata ---------------------------
      const coverBytes = await readFile(tmpOutput);
      if (coverBytes.length === 0) {
        throw new Error("ffmpeg produced an empty cover file");
      }
      const meta = await sharp(coverBytes).metadata();
      const width = typeof meta.width === "number" ? meta.width : null;
      const height = typeof meta.height === "number" ? meta.height : null;
      if (width === null || height === null) {
        throw new Error(
          `sharp could not read cover dimensions (format=${meta.format ?? "unknown"})`,
        );
      }

      // ---- 4a. Persist derived bytes --------------------------------
      // overwrite:true makes a retry replace the file cleanly.
      const stored = await deps.storage.putDerived({
        tripId: media.tripId,
        mediaId: media.id,
        relPath: COVER_FILENAME,
        data: coverBytes,
        overwrite: true,
      });

      // ---- 4b. Cache thumbnail_path on media_items ------------------
      const now = new Date().toISOString();
      const changed = deps.mediaRepo.updateVideoCoverPaths({
        mediaId: media.id,
        thumbnailPath: stored.logicalPath,
        updatedAt: now,
      });
      if (changed === 0) {
        // Row was soft-deleted between the read and the write. We
        // still wrote the file + will still UPSERT the version row;
        // the user gets back their cover if they later restore the
        // media (P7.T2). Mirrors the image-channel worker pattern.
        deps.logger.warn(
          correlation,
          "video_cover: media row not updated (likely soft-deleted mid-job); derived file + version row still written",
        );
      }

      // ---- 4c. UPSERT media_versions(version_type='video_cover') ----
      // params records the knobs + sharp version + the seek time we
      // actually used so a future regenerate can detect parameter
      // drift. fileSize comes from the buffer length (authoritative).
      const paramsJson = JSON.stringify({
        sharpVersion: sharp.versions?.vips ?? null,
        workerVersion: settings.workerVersion,
        seekSeconds,
        sourceDuration: media.duration,
        maxEdge: settings.maxEdge,
        jpegQuality: settings.jpegQuality,
      });
      deps.mediaVersionsRepo.upsert({
        mediaId: media.id,
        versionType: "video_cover",
        filePath: stored.logicalPath,
        mimeType: COVER_MIME,
        width,
        height,
        fileSize: coverBytes.length,
        params: paramsJson,
        now,
      });

      deps.logger.info(
        {
          ...correlation,
          coverPath: stored.logicalPath,
          width,
          height,
          fileSize: coverBytes.length,
          seekSeconds,
          sourceDuration: media.duration,
          workerVersion: settings.workerVersion,
        },
        "video_cover: derived video_cover.jpg written + media_versions upserted",
      );
    } finally {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => {
        /* best-effort tmp cleanup */
      });
    }
  };
}

// ---------------------------------------------------------------------------
// ffmpeg spawn helpers
// ---------------------------------------------------------------------------

interface FfmpegCoverArgs {
  readonly input: string;
  readonly output: string;
  readonly seekSeconds: number;
  readonly settings: VideoCoverSettings;
}

/**
 * Spawn ffmpeg to write a single cover JPEG. Bounded timeout +
 * SIGKILL on overrun. Throws on non-zero exit with trimmed stderr,
 * on spawn failure (binary missing), or on timeout.
 *
 * Argument order matters: `-ss` before `-i` selects the input-side
 * fast seek (decoder seeks to nearest keyframe, then advances).
 * Putting `-ss` after `-i` would force per-frame decode from the
 * start, which is wrong for long videos.
 */
async function runFfmpegCover(args: FfmpegCoverArgs): Promise<void> {
  const { input, output, seekSeconds, settings } = args;

  // The scale filter caps the cover at maxEdge × maxEdge while
  // preserving aspect ratio. `force_original_aspect_ratio=decrease`
  // shrinks (never enlarges) the source toward the box.
  const scaleFilter = `scale='min(${settings.maxEdge},iw)':'min(${settings.maxEdge},ih)':force_original_aspect_ratio=decrease`;

  const ffmpegArgs = [
    "-v",
    "error",
    "-ss",
    seekSeconds.toFixed(3),
    "-i",
    input,
    "-frames:v",
    "1",
    "-vf",
    scaleFilter,
    "-q:v",
    settings.jpegQuality.toString(),
    "-f",
    "image2",
    "-update",
    "1",
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
            `ffmpeg cover timed out after ${settings.timeoutMs}ms (file=${path.basename(input)})`,
          ),
        );
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").slice(0, MAX_STDERR_BYTES);
        reject(new Error(`ffmpeg cover exited ${code}: ${stderr.trim() || "(no stderr)"}`));
        return;
      }
      resolve();
    });
  });
}
