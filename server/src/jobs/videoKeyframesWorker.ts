// VideoWorker.keyframes (P9.T5).
//
// Job handler registered as `video_keyframes` on the video-channel
// executor. For one media row:
//   1. Resolve the media (active-only) + type / original_path guards.
//   2. Pick the decode source: prefer the P9.T4 proxy when it
//      exists on disk (cheaper to decode the 720p H.264 proxy than
//      a 4K source), fall back to the original. The proxy lookup
//      is best-effort — the keyframes worker does NOT require the
//      proxy worker to have succeeded first.
//   3. Compute the effective sampling interval. The configured
//      `intervalSec` is a base value; if it would produce more than
//      `maxFrames` frames for this video's duration, the interval
//      stretches to spread the frames evenly across the runtime.
//      This caps disk usage on long archives (1-hour 4K video at
//      2s would otherwise emit 1800 frames).
//   4. Spawn `ffmpeg -i <src> -vf fps=1/<effective> -q:v <quality>
//      -f image2 -y <tmpDir>/frame_%06d.jpg`. The `fps` filter
//      handles frame selection deterministically: it emits one
//      frame at t=0 and then every `effective` seconds thereafter,
//      auto-numbered via the `%06d` pattern.
//   5. Read the tmp directory listing; for each emitted frame:
//        a. `sharp(buf).metadata()` to get authoritative width /
//           height (ffmpeg may scale via the proxy's own dims;
//           we don't want to trust filename position alone).
//        b. `storage.putDerived({ relPath: 'frames/<name>',
//           overwrite: true })` to land the frame under the
//           per-media derived tree.
//        c. Append to an in-memory manifest entry list.
//   6. Write `derived/{mediaId}/frames/manifest.json` summarising
//      the run (frameCount, intervalSec used, decodeSource,
//      workerVersion, frames[]). Downstream consumers (P9.T7
//      segment quality, P9.T8 Video API) read THIS file to
//      discover what frames exist — no DB persistence.
//
// Scope per docs/tasks.md P9.T5 — strictly fixed-interval frame
// extraction. Explicitly NOT in scope:
//   * Per-frame quality scoring (P9.T7 blur + blackdetect).
//   * Segment creation (P9.T6 fixed-duration slicing).
//   * Video API / frontend (P9.T8 / T9).
//   * Re-running on transient flakes — JobQueue retry policy
//     handles that.
//   * Modifying P9.T2 metadata / P9.T3 cover / P9.T4 proxy workers.
//   * DB persistence — see R-104 in progress.md. `video_keyframes`
//     is not in the `media_versions.version_type` enum; adding it
//     would require a migration. The manifest.json file on disk
//     serves as the discoverable record; if a future task needs
//     SQL-level visibility, add migration 012 then.
//
// Channel: registered on the **video** channel, shares
// `VIDEO_WORKER_CONCURRENCY=1` budget with metadata / cover / proxy.
//
// Idempotency: re-running on the same media replaces every frame
// + the manifest in place (`storage.putDerived({overwrite:true})`).
// FFmpeg encoding isn't bit-deterministic at the JPEG level
// (R-103), so smoke assertions check counts + manifest shape, not
// byte-equality of frame files.
//
// Failure modes (all throw → JobQueue marks failed, original
// NEVER overwritten):
//   * Media row missing / soft-deleted → throw.
//   * media.type !== 'video' → throw (defense-in-depth).
//   * No usable decode source (original_path null AND no proxy) → throw.
//   * ffmpeg spawn fails / exits non-zero / times out (SIGKILL).
//   * 0 frames produced (no output files in tmp) → throw.
//   * Storage write fails → throw.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";

import type { Logger } from "../logger.js";
import type { MediaRepository, MediaVersionsRepository } from "../media/index.js";
import type { LocalStorageProvider } from "../storage/index.js";
import { resolveUnderRoot } from "../storage/index.js";

import type { JobHandler } from "./handlerRegistry.js";

/** Closed job_type token. */
export const VIDEO_KEYFRAMES_JOB_TYPE = "video_keyframes";

/** Subdirectory (under `derived/{mediaId}/`) for keyframe files and
 * manifest. Matches design.md §6.2 (`frames/{ts}.jpg`). */
const FRAMES_SUBDIR = "frames";

/** Logical filename for the manifest enumerating every emitted
 * frame. Downstream consumers (P9.T7 segment quality, P9.T8 Video
 * API) read this file to discover the keyframe set. */
const MANIFEST_FILENAME = "manifest.json";

/** Frame filename pattern. Zero-padded 6-digit index keeps the
 * lexicographic file ordering aligned with the temporal ordering
 * even for very long videos at fine intervals. */
const FRAME_FILENAME_PREFIX = "frame_";
const FRAME_FILENAME_PADDING = 6;
const FRAME_FILENAME_EXT = "jpg";

/** Max bytes of ffmpeg stderr we keep when reporting failures. */
const MAX_STDERR_BYTES = 4096;

/**
 * Runtime tunables. Wired from `config.video.keyframes.*`. Defaults
 * are also declared here so the worker can be constructed in
 * isolation (smoke tests) without booting the full config layer.
 */
export interface VideoKeyframesSettings {
  /** Path to the `ffmpeg` binary (PATH lookup when set to "ffmpeg"). */
  readonly ffmpegPath: string;
  /** Wall-clock cap for the ffmpeg child process. */
  readonly timeoutMs: number;
  /** Base interval between emitted frames (seconds). Can stretch
   * upward when MAX_FRAMES would otherwise be exceeded. */
  readonly intervalSec: number;
  /** Hard cap on emitted frames per video. */
  readonly maxFrames: number;
  /** ffmpeg `-q:v` (range 2-31, lower = better). */
  readonly jpegQuality: number;
  /** Stamped into the manifest for traceability. */
  readonly workerVersion: string;
}

export const DEFAULT_VIDEO_KEYFRAMES_SETTINGS: VideoKeyframesSettings = {
  ffmpegPath: "ffmpeg",
  timeoutMs: 300_000,
  intervalSec: 2,
  maxFrames: 200,
  jpegQuality: 2,
  workerVersion: "1.0",
};

export interface VideoKeyframesHandlerDeps {
  readonly storage: LocalStorageProvider;
  readonly mediaRepo: MediaRepository;
  readonly mediaVersionsRepo: MediaVersionsRepository;
  readonly settings?: VideoKeyframesSettings;
  readonly logger: Logger;
}

/** Per-frame manifest entry. */
export interface KeyframeManifestEntry {
  /** 1-based index matching the `frame_NNNNNN.jpg` filename suffix. */
  readonly index: number;
  /** Seconds from the start of the source video. */
  readonly timestampSec: number;
  /** Logical path inside storage (`trips/.../frames/...`). */
  readonly filePath: string;
  /** Frame dimensions read back via sharp. */
  readonly width: number;
  readonly height: number;
  /** Bytes-on-disk size (from the buffer length we wrote). */
  readonly fileSize: number;
}

/** Manifest persisted at `derived/{mediaId}/frames/manifest.json`. */
export interface KeyframeManifest {
  readonly workerVersion: string;
  /** Effective interval the worker actually used (may differ from
   * the configured `intervalSec` when MAX_FRAMES forced a stretch). */
  readonly intervalSec: number;
  /** Configured interval before MAX_FRAMES adjustment. Recorded so
   * a future re-run can detect whether the cap was hit. */
  readonly configuredIntervalSec: number;
  /** `'proxy'` or `'original'` — which file we actually decoded
   * from. Useful for diagnosing why a long video has frames at
   * different effective resolutions across reruns. */
  readonly decodeSource: "proxy" | "original";
  /** Logical path of the decode source. */
  readonly decodeSourcePath: string;
  /** Hard cap that was configured for this run. */
  readonly maxFrames: number;
  /** `media_items.duration` at the time of the run. NULL when the
   * P9.T2 metadata worker hasn't run yet. */
  readonly sourceDurationSec: number | null;
  readonly frameCount: number;
  readonly frames: readonly KeyframeManifestEntry[];
  /** ISO-8601 timestamp of when the worker wrote the manifest. */
  readonly generatedAt: string;
}

/**
 * Pure function — compute the effective sampling interval given the
 * configured base, the source duration, and the hard frame cap.
 *
 * Policy (matches the file header):
 *   * null / 0 / negative / non-finite duration → return the
 *     configured interval as-is. ffmpeg will emit whatever frames
 *     the source contains; the cap is unenforceable without
 *     duration. The handler relies on its 0-frames guard to fail
 *     gracefully if ffmpeg produces nothing.
 *   * estimated frames (ceil(duration / configured)) ≤ maxFrames →
 *     use the configured interval as-is. This is the common case
 *     for short / medium phone clips at intervalSec=2.
 *   * Otherwise → stretch to spread evenly: `duration / maxFrames`.
 *     A 1-hour video at intervalSec=2 with maxFrames=200 lands at
 *     effective=18s, emitting ~200 frames evenly spread across
 *     the timeline instead of ~1800 frames densely packed.
 *
 * Exported for unit-coverage in the smoke; the handler calls it
 * with the live `media.duration` value.
 */
export function computeEffectiveInterval(
  durationSec: number | null,
  configuredIntervalSec: number,
  maxFrames: number,
): number {
  if (
    durationSec === null ||
    !Number.isFinite(durationSec) ||
    durationSec <= 0 ||
    maxFrames <= 0 ||
    configuredIntervalSec <= 0
  ) {
    return configuredIntervalSec;
  }
  const estimatedFrames = Math.ceil(durationSec / configuredIntervalSec);
  if (estimatedFrames <= maxFrames) return configuredIntervalSec;
  return durationSec / maxFrames;
}

/**
 * Build the `video_keyframes` handler. Register the returned value
 * on the executor's `JobHandlerRegistry` for the **video** channel.
 */
export function makeVideoKeyframesHandler(deps: VideoKeyframesHandlerDeps): JobHandler {
  const settings = deps.settings ?? DEFAULT_VIDEO_KEYFRAMES_SETTINGS;
  return async (job) => {
    const correlation = { jobId: job.id, mediaId: job.mediaId };

    // ---- 1. Resolve media row ------------------------------------------
    const media = deps.mediaRepo.findById(job.mediaId);
    if (media === null) {
      throw new Error(`media not found or soft-deleted: ${job.mediaId}`);
    }
    if (media.type !== "video") {
      throw new Error(`media is not a video (type='${media.type}'); refusing to extract keyframes`);
    }

    // ---- 2. Pick decode source (prefer proxy) -------------------------
    // Best-effort proxy lookup — P9.T4 may not have run, or its file
    // may have been pruned; either way fall back to the original.
    const decodeSource = await pickDecodeSource({
      deps,
      mediaId: media.id,
      originalPath: media.originalPath,
    });
    if (decodeSource === null) {
      throw new Error(
        "no decode source available (media has no original_path and no usable proxy)",
      );
    }
    const absoluteInput = resolveUnderRoot(deps.storage.root, decodeSource.logicalPath);

    // ---- 3. Compute effective sampling interval -----------------------
    const effectiveInterval = computeEffectiveInterval(
      media.duration,
      settings.intervalSec,
      settings.maxFrames,
    );

    // ---- 4. Run ffmpeg into a per-call tmp dir ------------------------
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-video-keyframes-"));
    const tmpFramesDir = path.join(tmpRoot, FRAMES_SUBDIR);
    // ffmpeg writes the frames; the dir must exist already. Use
    // `recursive:true` (a no-op when present) so the smoke can also
    // pre-create it for tests.
    await mkdirIfMissing(tmpFramesDir);
    try {
      await runFfmpegKeyframes({
        input: absoluteInput,
        outputDir: tmpFramesDir,
        effectiveInterval,
        settings,
      });

      // ---- 5. Enumerate emitted frames, sharp-metadata each ---------
      const tmpFrameFiles = (await readdir(tmpFramesDir))
        .filter(
          (name) =>
            name.startsWith(FRAME_FILENAME_PREFIX) && name.endsWith(`.${FRAME_FILENAME_EXT}`),
        )
        .sort();
      if (tmpFrameFiles.length === 0) {
        throw new Error(
          `ffmpeg produced 0 keyframes from source (interval=${effectiveInterval}s, duration=${String(media.duration)}s)`,
        );
      }

      const entries: KeyframeManifestEntry[] = [];
      for (const filename of tmpFrameFiles) {
        const index = parseFrameIndex(filename);
        if (index === null) {
          // ffmpeg shouldn't emit anything that doesn't match its
          // own pattern, but defense-in-depth.
          deps.logger.warn(
            { ...correlation, filename },
            "video_keyframes: skipping unexpected file in output dir",
          );
          continue;
        }
        const tmpAbsolute = path.join(tmpFramesDir, filename);
        const frameBytes = await readFile(tmpAbsolute);
        const meta = await sharp(frameBytes).metadata();
        const width = typeof meta.width === "number" ? meta.width : null;
        const height = typeof meta.height === "number" ? meta.height : null;
        if (width === null || height === null) {
          throw new Error(
            `sharp could not read keyframe ${filename} (format=${meta.format ?? "unknown"})`,
          );
        }
        const stored = await deps.storage.putDerived({
          tripId: media.tripId,
          mediaId: media.id,
          relPath: `${FRAMES_SUBDIR}/${filename}`,
          data: frameBytes,
          overwrite: true,
        });
        // ffmpeg `fps=1/N` emits frames at t = 0, N, 2N, ... so the
        // 1-based filename index N maps to timestampSec = (N-1) × interval.
        entries.push({
          index,
          timestampSec: (index - 1) * effectiveInterval,
          filePath: stored.logicalPath,
          width,
          height,
          fileSize: frameBytes.length,
        });
      }

      // ---- 6. Write manifest.json ----------------------------------------
      const manifest: KeyframeManifest = {
        workerVersion: settings.workerVersion,
        intervalSec: effectiveInterval,
        configuredIntervalSec: settings.intervalSec,
        decodeSource: decodeSource.kind,
        decodeSourcePath: decodeSource.logicalPath,
        maxFrames: settings.maxFrames,
        sourceDurationSec: media.duration,
        frameCount: entries.length,
        frames: entries,
        generatedAt: new Date().toISOString(),
      };
      const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await deps.storage.putDerived({
        tripId: media.tripId,
        mediaId: media.id,
        relPath: `${FRAMES_SUBDIR}/${MANIFEST_FILENAME}`,
        data: manifestBytes,
        overwrite: true,
      });

      deps.logger.info(
        {
          ...correlation,
          frameCount: entries.length,
          effectiveIntervalSec: effectiveInterval,
          configuredIntervalSec: settings.intervalSec,
          decodeSource: decodeSource.kind,
          decodeSourcePath: decodeSource.logicalPath,
          framesDir: `trips/${media.tripId}/derived/${media.id}/${FRAMES_SUBDIR}/`,
          workerVersion: settings.workerVersion,
        },
        "video_keyframes: keyframes + manifest.json written",
      );
    } finally {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => {
        /* best-effort cleanup */
      });
    }
  };
}

// ---------------------------------------------------------------------------
// decode-source selection
// ---------------------------------------------------------------------------

/**
 * Pick the decode source for the keyframes pass:
 *   * `'proxy'` when a `media_versions(version_type='video_proxy')` row
 *     exists AND its file is present on disk.
 *   * `'original'` when the media row has a non-null `original_path`.
 *   * `null` when neither is usable.
 *
 * Lookup is silent on failures — if the proxy row is missing or its
 * file is gone, we just fall back to the original. The whole point
 * of "prefer proxy" is to be cheaper when the proxy is available,
 * not to require it.
 */
async function pickDecodeSource(args: {
  readonly deps: VideoKeyframesHandlerDeps;
  readonly mediaId: string;
  readonly originalPath: string | null;
}): Promise<{ kind: "proxy" | "original"; logicalPath: string } | null> {
  const { deps, mediaId, originalPath } = args;

  // Prefer the proxy if its row + file are both present.
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
      // Proxy row exists but file missing on disk — fall through.
    }
  }

  // Fall back to the original.
  if (originalPath !== null && originalPath.length > 0) {
    return { kind: "original", logicalPath: originalPath };
  }
  return null;
}

// ---------------------------------------------------------------------------
// ffmpeg invocation
// ---------------------------------------------------------------------------

interface RunFfmpegKeyframesArgs {
  readonly input: string;
  readonly outputDir: string;
  readonly effectiveInterval: number;
  readonly settings: VideoKeyframesSettings;
}

/**
 * Spawn ffmpeg with the `fps=1/<interval>` filter to emit one frame
 * every `effectiveInterval` seconds. Frames are auto-numbered
 * `frame_000001.jpg`, `frame_000002.jpg`, ... using ffmpeg's own
 * `%06d` pattern syntax. Bounded timeout + SIGKILL + truncated
 * stderr.
 */
async function runFfmpegKeyframes(args: RunFfmpegKeyframesArgs): Promise<void> {
  const { input, outputDir, effectiveInterval, settings } = args;
  // ffmpeg's `%06d` pattern stays inside the filename — combined
  // with the outputDir prefix, ffmpeg writes
  // `<outputDir>/frame_000001.jpg`, `<outputDir>/frame_000002.jpg`, ...
  const outputPattern = path.join(
    outputDir,
    `${FRAME_FILENAME_PREFIX}%0${FRAME_FILENAME_PADDING}d.${FRAME_FILENAME_EXT}`,
  );

  // Cap the frame count at the ffmpeg side too via `-frames:v`,
  // which makes the worker's MAX_FRAMES enforcement double-tight.
  // Even if the effective-interval math under-estimates (because
  // ffprobe reported an uneven duration), the file count stays
  // bounded.
  const ffmpegArgs = [
    "-v",
    "error",
    "-i",
    input,
    "-vf",
    `fps=1/${effectiveInterval}`,
    "-q:v",
    settings.jpegQuality.toString(),
    "-frames:v",
    settings.maxFrames.toString(),
    "-f",
    "image2",
    "-y",
    outputPattern,
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
            `ffmpeg keyframes timed out after ${settings.timeoutMs}ms (file=${path.basename(input)})`,
          ),
        );
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").slice(0, MAX_STDERR_BYTES);
        reject(new Error(`ffmpeg keyframes exited ${code}: ${stderr.trim() || "(no stderr)"}`));
        return;
      }
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Best-effort `mkdir -p` for the temp frames dir. We don't reject on
 * "already exists" — `mkdtemp` already gave us the parent unique
 * dir, and the smoke may pre-create the subdir for setup.
 */
async function mkdirIfMissing(dir: string): Promise<void> {
  await import("node:fs/promises").then((m) => m.mkdir(dir, { recursive: true }));
}

/**
 * Parse the 1-based numeric index out of a `frame_NNNNNN.jpg`
 * filename. Returns null when the filename doesn't match the
 * pattern.
 */
function parseFrameIndex(filename: string): number | null {
  if (!filename.startsWith(FRAME_FILENAME_PREFIX)) return null;
  if (!filename.endsWith(`.${FRAME_FILENAME_EXT}`)) return null;
  const digits = filename.slice(
    FRAME_FILENAME_PREFIX.length,
    filename.length - (FRAME_FILENAME_EXT.length + 1),
  );
  if (!/^\d+$/.test(digits)) return null;
  const n = Number.parseInt(digits, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
