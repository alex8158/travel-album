// Video render worker (P11.T5).
//
// Job handler registered as `video_render` on the video-channel
// executor. Consumes a `video_render` row whose payload is a
// `VideoRenderJobPayload` (`{ planId, mode, force }`).
//
// Pipeline (4 stages — each stage emits a structured INFO log so a
// long-running render can be observed via tail-of-logs):
//
//   1. Resolve plan + sanity check media. The Service already
//      checked these at enqueue time, but a soft-delete might have
//      raced between enqueue and dequeue; this re-check is the
//      authoritative one.
//   2. Clip extraction — for each plan.clip:
//        ffmpeg -ss <start> -i <source> -t <duration>
//               -vf scale=W:H:fps=FPS,setsar=1 -c:v libx264 -crf
//               -preset -pix_fmt yuv420p
//               -c:a aac -b:a -ac 2 -ar 48000
//               tmp/clip_NN.mp4
//      Strong normalisation guarantees Stage 3's concat demuxer
//      accepts every clip without re-encoding.
//   3. Concat — ffmpeg concat demuxer with `-c copy` (no re-encode;
//      preserves the Stage-2 spec) into tmp/concat.mp4.
//   4. Audio policy + final output:
//        keep_original         → cp concat.mp4 → final.mp4 (no audio touch)
//        mute                  → stripAudio()  via P11.T2 toolkit
//        replace_with_library  → prepareBackgroundMusic() + replaceVideoAudio()
//      Then storage.putDerived(relPath='edited.mp4', overwrite=true)
//      + UPSERT media_versions(version_type='edited').
//
// Idempotency: the (media_id, 'edited') UNIQUE row + storage
// putDerived(overwrite:true) means re-running on the same first-
// source media replaces the row + file in place. A `force=true`
// re-enqueue inserts a brand-new processing_jobs row but lands in
// the same media_versions slot — by design (R-147 in progress.md
// records the "one edited per first-source" V1 limitation).
//
// Failure modes (all throw → JobQueue marks failed; nothing
// half-written: tmp dir cleaned in finally, no media_versions row
// is written on any failure path because the UPSERT is the LAST
// step):
//   * Plan not found / corrupt / 0 clips
//   * First media missing / soft-deleted / non-video / null path
//   * Any source clip's media missing / soft-deleted / non-video
//   * Audio policy requests replace_with_library but the audio
//     library row is missing / inactive / file missing
//   * ffmpeg spawn fail / exit≠0 / timeout
//   * ffprobe verify fails
//
// Scope (per P11.T5 prompt):
//   * No complex transitions (fade / crossfade) — V1 uses plain
//     concat. Plan transitions are still echoed in params.
//   * Multi-video composition is P11.T8 — V1 outputs one edited
//     file per (first-source media, 'edited') slot.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Logger } from "../logger.js";
import type {
  AudioLibraryRepository,
  EditPlansRepository,
  MediaRepository,
  MediaVersionsRepository,
} from "../media/index.js";
import { resolveUnderRoot, type LocalStorageProvider } from "../storage/index.js";

import type { JobHandler } from "./handlerRegistry.js";
import {
  prepareBackgroundMusic,
  replaceVideoAudio,
  stripAudio,
  type AudioProcessorSettings,
} from "./audioProcessor.js";
import { projectFfprobe } from "./videoMetadataWorker.js";

// NB: the canonical `VIDEO_RENDER_JOB_TYPE` constant lives in
// `media/videoRenderService.ts`. The bootstrap (`server/src/index.ts`)
// imports it from there and registers this handler against the
// matching string. We deliberately do NOT import it here —
// `jobs/` workers value-importing from `media/index.js` triggers
// an ESM TDZ circular-init issue (`videoService.ts` documents the
// same constraint in P9.T8). The handler itself is value-free of
// the job-type name; only its registration uses it.

/** Output filename under `derived/{firstMediaId}/`. Stable so the
 * future P11.T7 UI can reference it by convention. */
const EDITED_FILENAME = "edited.mp4";

const EDITED_MIME = "video/mp4";

/** Bounded ffmpeg stderr retention (matches the video / audio
 * workers' convention). */
const MAX_STDERR_BYTES = 4096;

/** Resolution string → numeric dimensions. The plan stores
 * `'720p' | '1080p' | '4k'` — width is derived from the configured
 * aspect ratio (16:9 default; verified for the two non-square
 * aspect ratios below). */
const RESOLUTION_HEIGHTS: Readonly<Record<string, number>> = {
  "720p": 720,
  "1080p": 1080,
  "4k": 2160,
};

/** Aspect ratio string → (w/h) ratio. Used to compute the target
 * width from the resolution's height. Square / portrait aspect
 * ratios produce non-16:9 outputs; the worker emits a pillar /
 * letterbox via `force_original_aspect_ratio=decrease,pad` so the
 * source frame is preserved (not cropped). */
const ASPECT_RATIO_WH: Readonly<Record<string, number>> = {
  "16:9": 16 / 9,
  "9:16": 9 / 16,
  "1:1": 1,
  "4:5": 4 / 5,
};

export interface VideoRenderSettings {
  /** ffmpeg binary path (PATH lookup when 'ffmpeg'). */
  readonly ffmpegPath: string;
  /** ffprobe binary path. */
  readonly ffprobePath: string;
  /** Per-ffmpeg-spawn wall-clock cap. Each stage uses this; with
   * 4 stages a 10-minute cap gives a 40-minute upper bound on a
   * single render. */
  readonly timeoutMs: number;
  /** Output frame rate. */
  readonly fps: number;
  /** libx264 CRF for the per-clip encode + final fallback. */
  readonly crf: number;
  /** libx264 preset. */
  readonly preset: string;
  /** AAC audio bitrate (kbps). */
  readonly audioBitrateKbps: number;
  /** Stamped into media_versions.params. */
  readonly workerVersion: string;
}

export const DEFAULT_VIDEO_RENDER_SETTINGS: VideoRenderSettings = {
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
  timeoutMs: 600_000,
  fps: 30,
  crf: 23,
  preset: "medium",
  audioBitrateKbps: 160,
  workerVersion: "1.0",
};

export interface VideoRenderHandlerDeps {
  readonly storage: LocalStorageProvider;
  readonly mediaRepo: MediaRepository;
  readonly mediaVersionsRepo: MediaVersionsRepository;
  readonly editPlansRepo: EditPlansRepository;
  readonly audioLibraryRepo: AudioLibraryRepository;
  /** P11.T2 audio toolkit settings. Used when audioPolicy.mode is
   * `mute` or `replace_with_library` (NOT used for `keep_original`). */
  readonly audioProcessor: AudioProcessorSettings;
  readonly settings?: VideoRenderSettings;
  readonly logger: Logger;
}

/** Minimal subset of the plan shape the worker uses. We avoid
 * importing the full `VideoEditPlan` type so the worker stays
 * value-free of the planning domain (and avoids any cross-module
 * circular import; the worker is loaded from `jobs/`, the plan
 * type lives under `media/`). */
interface MinimalPlan {
  readonly id?: string;
  readonly tripId: string;
  readonly clips: ReadonlyArray<{
    readonly mediaId: string;
    readonly sourcePath: string;
    readonly startSec: number;
    readonly endSec: number;
    readonly durationSec: number;
    readonly order: number;
  }>;
  readonly resolution: string;
  readonly aspectRatio: string;
  readonly totalDurationSec: number;
  readonly audioPolicy: {
    readonly mode: "keep_original" | "mute" | "replace_with_library";
    readonly backgroundAudioId: string | null;
    readonly loudnorm: boolean;
    readonly fadeInSeconds: number;
    readonly fadeOutSeconds: number;
    readonly loopToFit: boolean;
    readonly targetDurationSec: number;
  };
}

export function makeVideoRenderHandler(deps: VideoRenderHandlerDeps): JobHandler {
  const settings = deps.settings ?? DEFAULT_VIDEO_RENDER_SETTINGS;
  return async (job) => {
    const correlation = { jobId: job.id, mediaId: job.mediaId };

    // ---- 1. Parse payload + resolve plan ------------------------------
    const payload = parsePayload(job.payload);
    const planRow = deps.editPlansRepo.findById(payload.planId);
    if (planRow === null) {
      throw new Error(`edit plan not found: ${payload.planId}`);
    }

    let plan: MinimalPlan;
    try {
      plan = JSON.parse(planRow.planJson) as MinimalPlan;
    } catch (err) {
      throw new Error(
        `edit plan ${payload.planId} has corrupt JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (!Array.isArray(plan.clips) || plan.clips.length === 0) {
      throw new Error(`edit plan ${payload.planId} has no clips to render`);
    }

    // ---- 2. Resolve every source media + validate ---------------------
    const firstClip = plan.clips[0]!;
    if (firstClip.mediaId !== job.mediaId) {
      // Defensive: the Service keys the job on clips[0].mediaId.
      // A mismatch means the payload was tampered with or the plan
      // was edited between enqueue and dequeue.
      throw new Error(
        `plan ${payload.planId} clips[0].mediaId='${firstClip.mediaId}' does not match job.mediaId='${job.mediaId}'`,
      );
    }

    const sourceAbsByMediaId = new Map<string, string>();
    for (const clip of plan.clips) {
      const media = deps.mediaRepo.findById(clip.mediaId);
      if (media === null) {
        throw new Error(
          `plan ${payload.planId} clip order=${clip.order} references missing/soft-deleted media: ${clip.mediaId}`,
        );
      }
      if (media.type !== "video") {
        throw new Error(
          `plan ${payload.planId} clip order=${clip.order} references non-video media (type='${media.type}'): ${clip.mediaId}`,
        );
      }
      if (media.originalPath === null) {
        throw new Error(
          `plan ${payload.planId} clip order=${clip.order} media has no original_path: ${clip.mediaId}`,
        );
      }
      sourceAbsByMediaId.set(clip.mediaId, resolveUnderRoot(deps.storage.root, media.originalPath));
    }

    // First media's tripId is the storage anchor for the edited
    // output (we'll write under derived/{firstMediaId}/edited.mp4
    // in the first clip's trip).
    const firstMedia = deps.mediaRepo.findById(firstClip.mediaId)!;

    // ---- 3. Resolve audio (when replace_with_library) -----------------
    let backgroundAudioAbsolutePath: string | null = null;
    if (plan.audioPolicy.mode === "replace_with_library") {
      if (plan.audioPolicy.backgroundAudioId === null) {
        throw new Error(
          `plan ${payload.planId} audioPolicy.mode='replace_with_library' but backgroundAudioId is null`,
        );
      }
      const audioRow = deps.audioLibraryRepo.findById(plan.audioPolicy.backgroundAudioId);
      if (audioRow === null) {
        throw new Error(
          `plan ${payload.planId} backgroundAudio not found: ${plan.audioPolicy.backgroundAudioId}`,
        );
      }
      if (!audioRow.isActive) {
        throw new Error(
          `plan ${payload.planId} backgroundAudio is inactive: ${plan.audioPolicy.backgroundAudioId}`,
        );
      }
      // The audio_library file_path is an absolute path on disk
      // (stored that way by P11.T3 because bundled assets live
      // outside the storage tree). No resolveUnderRoot here.
      backgroundAudioAbsolutePath = audioRow.filePath;
    }

    // ---- 4. Compute target dimensions --------------------------------
    const targetHeight = RESOLUTION_HEIGHTS[plan.resolution] ?? 1080;
    const aspectWh = ASPECT_RATIO_WH[plan.aspectRatio] ?? 16 / 9;
    // Even-aligned width so yuv420p is happy.
    let targetWidth = Math.round(targetHeight * aspectWh);
    if (targetWidth % 2 !== 0) targetWidth += 1;

    deps.logger.info(
      {
        ...correlation,
        planId: payload.planId,
        mode: payload.mode,
        clipCount: plan.clips.length,
        targetWidth,
        targetHeight,
        fps: settings.fps,
        audioMode: plan.audioPolicy.mode,
      },
      "video_render: stage 1/4 — plan resolved + media validated",
    );

    // ---- 5. Run the pipeline (with finally cleanup) -------------------
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-video-render-"));
    try {
      // ---- Stage 2: per-clip normalisation ---------------------------
      const clipPaths: string[] = [];
      for (let i = 0; i < plan.clips.length; i += 1) {
        const clip = plan.clips[i]!;
        const clipPath = path.join(tmpRoot, `clip_${String(i).padStart(4, "0")}.mp4`);
        await runFfmpegClipExtract({
          ffmpegPath: settings.ffmpegPath,
          inputAbsolute: sourceAbsByMediaId.get(clip.mediaId)!,
          outputPath: clipPath,
          startSec: clip.startSec,
          durationSec: clip.durationSec,
          width: targetWidth,
          height: targetHeight,
          fps: settings.fps,
          crf: settings.crf,
          preset: settings.preset,
          audioBitrateKbps: settings.audioBitrateKbps,
          timeoutMs: settings.timeoutMs,
        });
        clipPaths.push(clipPath);
        deps.logger.info(
          {
            ...correlation,
            planId: payload.planId,
            clipIndex: i,
            clipCount: plan.clips.length,
            durationSec: clip.durationSec,
          },
          "video_render: clip extracted + normalised",
        );
      }

      deps.logger.info(
        {
          ...correlation,
          planId: payload.planId,
          clipCount: clipPaths.length,
        },
        "video_render: stage 2/4 — clips extracted",
      );

      // ---- Stage 3: concat demuxer ----------------------------------
      const concatListPath = path.join(tmpRoot, "concat.txt");
      // ffmpeg concat demuxer format: one "file '<path>'" line per
      // input. Quote the path in single quotes; tmp paths never
      // contain single quotes so no escaping needed.
      const concatListContent = clipPaths.map((p) => `file '${p}'`).join("\n") + "\n";
      await writeFile(concatListPath, concatListContent, "utf8");
      const concatOutputPath = path.join(tmpRoot, "concat.mp4");
      await runFfmpegConcat({
        ffmpegPath: settings.ffmpegPath,
        concatListPath,
        outputPath: concatOutputPath,
        timeoutMs: settings.timeoutMs,
      });
      deps.logger.info(
        { ...correlation, planId: payload.planId },
        "video_render: stage 3/4 — clips concatenated",
      );

      // ---- Stage 4: audio policy + final output ---------------------
      const finalOutputPath = path.join(tmpRoot, "final.mp4");
      if (plan.audioPolicy.mode === "keep_original") {
        // Concat output already preserves each clip's audio; just
        // copy through.
        await runFfmpegPassthrough({
          ffmpegPath: settings.ffmpegPath,
          inputPath: concatOutputPath,
          outputPath: finalOutputPath,
          timeoutMs: settings.timeoutMs,
        });
      } else if (plan.audioPolicy.mode === "mute") {
        await stripAudio(concatOutputPath, finalOutputPath, deps.audioProcessor);
      } else {
        // replace_with_library
        const bgmPreparedPath = path.join(tmpRoot, "bgm-prepared.m4a");
        await prepareBackgroundMusic(
          backgroundAudioAbsolutePath!,
          bgmPreparedPath,
          plan.audioPolicy.targetDurationSec,
          deps.audioProcessor,
          {
            loudnormEnabled: plan.audioPolicy.loudnorm,
            fadeInSeconds: plan.audioPolicy.fadeInSeconds,
            fadeOutSeconds: plan.audioPolicy.fadeOutSeconds,
          },
        );
        await replaceVideoAudio(
          concatOutputPath,
          bgmPreparedPath,
          finalOutputPath,
          deps.audioProcessor,
        );
      }

      const finalStat = await stat(finalOutputPath);
      if (finalStat.size === 0) {
        throw new Error("video_render produced an empty final file");
      }

      // ---- Stage 5: ffprobe + UPSERT media_versions -----------------
      const probeRaw = await runFfprobeOnPath(finalOutputPath, settings);
      const projection = projectFfprobe(probeRaw);
      if (projection.width === null || projection.height === null) {
        throw new Error("ffprobe could not determine final video dimensions after render");
      }

      const finalBytes = await readFile(finalOutputPath);
      const stored = await deps.storage.putDerived({
        tripId: firstMedia.tripId,
        mediaId: firstMedia.id,
        relPath: EDITED_FILENAME,
        data: finalBytes,
        overwrite: true,
      });

      const nowIso = new Date().toISOString();
      const paramsJson = JSON.stringify({
        workerVersion: settings.workerVersion,
        planId: payload.planId,
        mode: payload.mode,
        targetDurationSec: plan.totalDurationSec,
        resolution: plan.resolution,
        aspectRatio: plan.aspectRatio,
        outputWidth: projection.width,
        outputHeight: projection.height,
        outputDurationSec: projection.duration,
        outputVideoCodec: projection.videoCodec,
        outputAudioCodec: projection.audioCodec,
        clipCount: plan.clips.length,
        sourceMediaIds: plan.clips.map((c) => c.mediaId),
        audioPolicy: plan.audioPolicy,
        crf: settings.crf,
        preset: settings.preset,
        fps: settings.fps,
        audioBitrateKbps: settings.audioBitrateKbps,
      });

      deps.mediaVersionsRepo.upsert({
        mediaId: firstMedia.id,
        versionType: "edited",
        filePath: stored.logicalPath,
        mimeType: EDITED_MIME,
        width: projection.width,
        height: projection.height,
        fileSize: finalBytes.length,
        params: paramsJson,
        now: nowIso,
      });

      deps.logger.info(
        {
          ...correlation,
          planId: payload.planId,
          editedPath: stored.logicalPath,
          width: projection.width,
          height: projection.height,
          durationSec: projection.duration,
          fileSize: finalBytes.length,
        },
        "video_render: stage 4/4 — edited.mp4 written + media_versions(edited) upserted",
      );
    } finally {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => {
        /* best-effort */
      });
    }
  };
}

// ---------------------------------------------------------------------------
// payload + ffmpeg helpers
// ---------------------------------------------------------------------------

interface ParsedPayload {
  readonly planId: string;
  readonly mode: "preview" | "final";
  readonly force: boolean;
}

function parsePayload(raw: string | null): ParsedPayload {
  if (raw === null || raw.length === 0) {
    throw new Error("video_render job has no payload");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `video_render payload not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("video_render payload must be an object");
  }
  const obj = parsed as Record<string, unknown>;
  const planId = obj.planId;
  if (typeof planId !== "string" || planId.length === 0) {
    throw new Error("video_render payload.planId must be a non-empty string");
  }
  const mode = obj.mode === "preview" ? "preview" : "final";
  const force = obj.force === true;
  return { planId, mode, force };
}

interface ClipExtractArgs {
  readonly ffmpegPath: string;
  readonly inputAbsolute: string;
  readonly outputPath: string;
  readonly startSec: number;
  readonly durationSec: number;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly crf: number;
  readonly preset: string;
  readonly audioBitrateKbps: number;
  readonly timeoutMs: number;
}

async function runFfmpegClipExtract(args: ClipExtractArgs): Promise<void> {
  // -ss BEFORE -i for fast seek (input-side); reasonable accuracy
  // for keyframe-aligned clips. We also use force_original_aspect_ratio
  // + pad to letterbox / pillarbox rather than crop, so the source
  // frame is preserved end-to-end even when the plan's aspect
  // ratio doesn't match the source.
  const scaleFilter =
    `scale=${args.width}:${args.height}:force_original_aspect_ratio=decrease,` +
    `pad=${args.width}:${args.height}:(ow-iw)/2:(oh-ih)/2,` +
    `fps=${args.fps},setsar=1`;
  // Input audio map made optional via `-map 0:a?` so silent sources
  // produce silent clips rather than failing (matches the audio
  // toolkit's defensive default).
  const ffArgs = [
    "-v",
    "error",
    "-ss",
    args.startSec.toString(),
    "-i",
    args.inputAbsolute,
    "-t",
    args.durationSec.toString(),
    "-map",
    "0:v",
    "-map",
    "0:a?",
    "-vf",
    scaleFilter,
    "-c:v",
    "libx264",
    "-preset",
    args.preset,
    "-crf",
    args.crf.toString(),
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    `${args.audioBitrateKbps}k`,
    "-ac",
    "2",
    "-ar",
    "48000",
    "-movflags",
    "+faststart",
    "-y",
    args.outputPath,
  ];
  await runFfmpeg(args.ffmpegPath, ffArgs, args.timeoutMs, "clipExtract");
}

interface ConcatArgs {
  readonly ffmpegPath: string;
  readonly concatListPath: string;
  readonly outputPath: string;
  readonly timeoutMs: number;
}

async function runFfmpegConcat(args: ConcatArgs): Promise<void> {
  const ffArgs = [
    "-v",
    "error",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    args.concatListPath,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    "-y",
    args.outputPath,
  ];
  await runFfmpeg(args.ffmpegPath, ffArgs, args.timeoutMs, "concat");
}

interface PassthroughArgs {
  readonly ffmpegPath: string;
  readonly inputPath: string;
  readonly outputPath: string;
  readonly timeoutMs: number;
}

async function runFfmpegPassthrough(args: PassthroughArgs): Promise<void> {
  const ffArgs = [
    "-v",
    "error",
    "-i",
    args.inputPath,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    "-y",
    args.outputPath,
  ];
  await runFfmpeg(args.ffmpegPath, ffArgs, args.timeoutMs, "passthrough");
}

async function runFfprobeOnPath(
  absolutePath: string,
  settings: VideoRenderSettings,
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

  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let killed = false;
    const child = spawn(settings.ffprobePath, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timeoutHandle = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, 30_000);
    child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));
    child.once("error", (err) => {
      clearTimeout(timeoutHandle);
      reject(new Error(`ffprobe spawn failed (render verify): ${err.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timeoutHandle);
      if (killed) {
        reject(new Error("ffprobe timed out (render verify)"));
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").slice(0, MAX_STDERR_BYTES);
        reject(
          new Error(`ffprobe exited ${code} (render verify): ${stderr.trim() || "(no stderr)"}`),
        );
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(stdoutChunks).toString("utf8")) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          reject(new Error("ffprobe output is not a JSON object (render verify)"));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch (err) {
        reject(
          new Error(
            `ffprobe output not parseable as JSON (render verify): ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
      }
    });
  });
}

/** Shared spawn helper — same shape as videoOptimizeWorker /
 * videoProxyWorker. Bounded timeout + SIGKILL + 4KB stderr
 * retention. */
async function runFfmpeg(
  ffmpegPath: string,
  args: ReadonlyArray<string>,
  timeoutMs: number,
  opLabel: string,
): Promise<void> {
  const stderrChunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    let killed = false;
    const child = spawn(ffmpegPath, [...args], { stdio: ["ignore", "ignore", "pipe"] });
    const timeoutHandle = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.once("error", (err) => {
      clearTimeout(timeoutHandle);
      reject(new Error(`ffmpeg spawn failed (${opLabel}): ${err.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timeoutHandle);
      if (killed) {
        reject(new Error(`ffmpeg ${opLabel} timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").slice(0, MAX_STDERR_BYTES);
        reject(new Error(`ffmpeg ${opLabel} exited ${code}: ${stderr.trim() || "(no stderr)"}`));
        return;
      }
      resolve();
    });
  });
}
