// VideoWorker.segments (P9.T6).
//
// Job handler registered as `video_segments` on the video-channel
// executor. For one media row:
//   1. Resolve the media (active-only) + type / original_path guards.
//   2. Pick the decode source: prefer the P9.T4 proxy when it
//      exists on disk (cheaper to slice the 720p H.264 proxy than a
//      4K source), fall back to the original. The proxy lookup is
//      best-effort — the segments worker does NOT require the proxy
//      worker to have succeeded first.
//   3. Spawn `ffmpeg -i <src> -c copy -map 0 -f segment
//      -segment_time <durationSec> -reset_timestamps 1
//      -segment_start_number 1 -y <tmpDir>/segment_%06d.mp4`.
//      `-c copy` skips re-encode (segments inherit the source's
//      codecs). Slice boundaries align to the source's keyframes,
//      so segments may be slightly longer/shorter than the
//      requested duration; we use ffprobe to read each segment's
//      actual duration after ffmpeg finishes.
//   4. Read the tmp directory listing; for each emitted file:
//        a. ffprobe its actual duration.
//        b. Compute startTime = sum of prior segments' durations,
//           endTime = startTime + this segment's duration.
//        c. Generate a fresh UUID for the segment's `id` (also
//           the canonical filename stem under `segments/`).
//        d. `storage.putDerived({ relPath: 'segments/{uuid}.mp4',
//           overwrite: true })` to land the segment file under the
//           per-media derived tree.
//   5. Within a single `db.transaction`:
//        a. SELECT existing video_segments rows for this media to
//           know which OLD segment files to remove from disk.
//        b. DELETE FROM video_segments WHERE media_id = ?
//           (handled by repo.replaceAllForMedia).
//        c. INSERT new rows (one per new segment).
//   6. Best-effort `storage.remove` for the OLD segment files
//      OUTSIDE the transaction — file removal can't roll back with
//      SQLite. Files that fail to remove are logged but don't fail
//      the job (the row's gone; the orphaned file is harmless until
//      the per-media derived dir is walked by a future P7.T7
//      permanent-delete handler).
//
// Scope per docs/tasks.md P9.T6 — strictly fixed-duration slicing
// + DB row writes. Explicitly NOT in scope:
//   * Per-segment quality / blackdetect / blur scoring (P9.T7).
//   * Per-segment thumbnails / hover-play preview clips (P9.T7+).
//   * Video API surfacing the segments to the frontend (P9.T8).
//   * Video segments page (P9.T9).
//   * Re-encoding segments (would lose quality + slow the worker
//     dramatically; `-c copy` is the V1 trade).
//   * Modifying P9.T2 / T3 / T4 / T5 workers.
//
// Job channel: registered on the **video** channel, shares the
// `VIDEO_WORKER_CONCURRENCY=1` budget with metadata / cover / proxy /
// keyframes. Segments are mid-weight on this budget — `-c copy`
// avoids the proxy worker's encoder cost, but ffprobe-per-segment
// adds N small spawns.
//
// Idempotency: every (re-)run replaces all segments + their files
// for this media. R-107 (recorded in progress.md): the wipe
// destroys any P9.T7+ scores that earlier ran against the prior
// segments. V1 accepts this; the risk is dormant pre-P9.T7.
//
// Failure modes (all throw → JobQueue marks failed, original
// NEVER overwritten, transaction rolls back so old rows survive):
//   * Media row missing / soft-deleted → throw.
//   * media.type !== 'video' → throw (defense-in-depth).
//   * No usable decode source (original_path null AND no proxy) → throw.
//   * ffmpeg spawn fails / exits non-zero / times out (SIGKILL).
//   * 0 segments produced → throw (something's wrong with the source).
//   * ffprobe on any segment fails → throw (we can't compute the
//     timing without the duration).
//   * storage.putDerived fails → throw (transaction rolls back).
//
// File path convention: each segment lives at
// `trips/{tripId}/derived/{mediaId}/segments/{id}.mp4`. The
// `video_segments` schema deliberately has no `file_path` column;
// the path is reconstructable from `(mediaId, segmentId)`.
// `videoSegmentMp4Path()` in the repo formalises that convention.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Logger } from "../logger.js";
import type {
  MediaRepository,
  MediaVersionsRepository,
  VideoSegmentInsertData,
  VideoSegmentsRepository,
} from "../media/index.js";
import { videoSegmentMp4Path } from "../media/index.js";
import type { LocalStorageProvider } from "../storage/index.js";
import { resolveUnderRoot } from "../storage/index.js";

import type { JobHandler } from "./handlerRegistry.js";

/** Closed job_type token. */
export const VIDEO_SEGMENTS_JOB_TYPE = "video_segments";

/** Subdirectory under `derived/{mediaId}/` for segment files. Matches
 * design.md §6.2 (`segments/{segmentId}.mp4`). */
const SEGMENTS_SUBDIR = "segments";

/** Filename pattern ffmpeg uses for the segment muxer's auto-naming
 * inside the tmp dir. 6-digit padding keeps lexicographic sort
 * aligned with temporal order even for very long videos. */
const FFMPEG_SEGMENT_FILENAME_PREFIX = "segment_";
const FFMPEG_SEGMENT_FILENAME_PADDING = 6;
const FFMPEG_SEGMENT_FILENAME_EXT = "mp4";

/** Max bytes of ffmpeg/ffprobe stderr we keep when reporting failures. */
const MAX_STDERR_BYTES = 4096;

/** Wall-clock cap for the per-segment ffprobe spawn — segments are
 * already on disk; reading their format header should take milliseconds. */
const FFPROBE_PER_SEGMENT_TIMEOUT_MS = 15_000;

/**
 * Runtime tunables. Wired from `config.video.segments.*` +
 * `config.ffmpeg.*`. Defaults are also declared here so the worker
 * can be constructed in isolation (smoke tests) without booting
 * the full config layer.
 */
export interface VideoSegmentsSettings {
  /** Path to the `ffmpeg` binary. */
  readonly ffmpegPath: string;
  /** Path to the `ffprobe` binary (used to read back per-segment
   * durations). */
  readonly ffprobePath: string;
  /** Wall-clock cap for the ffmpeg slicing pass. */
  readonly timeoutMs: number;
  /** Base segment duration in seconds. Last segment may be shorter. */
  readonly durationSec: number;
  /** Stamped into logger output for traceability. */
  readonly workerVersion: string;
}

export const DEFAULT_VIDEO_SEGMENTS_SETTINGS: VideoSegmentsSettings = {
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
  timeoutMs: 300_000,
  durationSec: 10,
  workerVersion: "1.0",
};

export interface VideoSegmentsHandlerDeps {
  readonly storage: LocalStorageProvider;
  readonly mediaRepo: MediaRepository;
  readonly mediaVersionsRepo: MediaVersionsRepository;
  readonly videoSegmentsRepo: VideoSegmentsRepository;
  readonly settings?: VideoSegmentsSettings;
  readonly logger: Logger;
}

/**
 * Build the `video_segments` handler. Register the returned value
 * on the executor's `JobHandlerRegistry` for the **video** channel.
 */
export function makeVideoSegmentsHandler(deps: VideoSegmentsHandlerDeps): JobHandler {
  const settings = deps.settings ?? DEFAULT_VIDEO_SEGMENTS_SETTINGS;
  return async (job) => {
    const correlation = { jobId: job.id, mediaId: job.mediaId };

    // R-107 fix: optional `{ "force": true }` in the job payload
    // opts into a destructive re-slice that wipes user_decision
    // along with the rest. Default (omitted or `{ "force": false }`)
    // preserves any non-`undecided` user_decision by time-overlap
    // mapping inside `replaceAllForMedia`.
    const force = parseForceFlag(job.payload, deps.logger, correlation);

    // ---- 1. Resolve media row -----------------------------------------
    const media = deps.mediaRepo.findById(job.mediaId);
    if (media === null) {
      throw new Error(`media not found or soft-deleted: ${job.mediaId}`);
    }
    if (media.type !== "video") {
      throw new Error(`media is not a video (type='${media.type}'); refusing to segment`);
    }

    // ---- 2. Pick decode source (prefer proxy) ------------------------
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

    // ---- 3. Run ffmpeg into per-call tmp dir + 4. probe durations ----
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-video-segments-"));
    try {
      await runFfmpegSegment({ input: absoluteInput, outputDir: tmpRoot, settings });

      const tmpFiles = (await readdir(tmpRoot))
        .filter(
          (name) =>
            name.startsWith(FFMPEG_SEGMENT_FILENAME_PREFIX) &&
            name.endsWith(`.${FFMPEG_SEGMENT_FILENAME_EXT}`),
        )
        .sort();
      if (tmpFiles.length === 0) {
        throw new Error(
          `ffmpeg produced 0 segments from source (durationSec=${settings.durationSec})`,
        );
      }

      interface TmpSegment {
        readonly tmpAbsolute: string;
        readonly bytes: Buffer;
        readonly durationSec: number;
      }
      const tmpSegments: TmpSegment[] = [];
      for (const filename of tmpFiles) {
        const tmpAbsolute = path.join(tmpRoot, filename);
        const statResult = await stat(tmpAbsolute);
        if (statResult.size === 0) {
          throw new Error(`ffmpeg produced an empty segment file: ${filename}`);
        }
        const duration = await probeSegmentDurationSec(tmpAbsolute, settings.ffprobePath);
        const bytes = await readFile(tmpAbsolute);
        tmpSegments.push({ tmpAbsolute, bytes, durationSec: duration });
      }

      // ---- 5. Persist segments + DB rows ------------------------------
      // Step (a): snapshot existing rows so we can clean up their
      //           files AFTER the transaction commits.
      const oldRows = deps.videoSegmentsRepo.listByMediaId(media.id);

      // Step (b): write each new segment file to durable storage.
      //           Done BEFORE the DB transaction so the transaction
      //           body only contains DB work (storage.putDerived is
      //           async + can't participate in better-sqlite3's
      //           sync transaction helper).
      let cursorSec = 0;
      const newSegmentInserts: VideoSegmentInsertData[] = [];
      const newSegmentLogicalPaths: string[] = [];
      const nowIso = new Date().toISOString();
      for (const tmpSeg of tmpSegments) {
        const segmentId = randomUUID();
        const relPath = `${SEGMENTS_SUBDIR}/${segmentId}.${FFMPEG_SEGMENT_FILENAME_EXT}`;
        const stored = await deps.storage.putDerived({
          tripId: media.tripId,
          mediaId: media.id,
          relPath,
          data: tmpSeg.bytes,
          overwrite: true,
        });
        const startTime = roundToMs(cursorSec);
        const endTime = roundToMs(cursorSec + tmpSeg.durationSec);
        const duration = roundToMs(tmpSeg.durationSec);
        // SQLite CHECK constraints reject duration ≤ 0, end_time ≤
        // start_time. Defensive: drop a segment whose probed
        // duration came back ≤ 0 (shouldn't happen — ffmpeg won't
        // emit such a file — but better than tripping the CHECK
        // and rolling back the whole transaction).
        if (duration <= 0 || endTime <= startTime) {
          deps.logger.warn(
            { ...correlation, tmpFile: path.basename(tmpSeg.tmpAbsolute), duration },
            "video_segments: skipping segment with non-positive probed duration",
          );
          continue;
        }
        newSegmentInserts.push({
          id: segmentId,
          mediaId: media.id,
          startTime,
          endTime,
          duration,
          now: nowIso,
        });
        newSegmentLogicalPaths.push(stored.logicalPath);
        cursorSec += tmpSeg.durationSec;
      }

      if (newSegmentInserts.length === 0) {
        throw new Error(
          "all ffmpeg segments were rejected (probed duration ≤ 0); refusing to wipe + reinsert",
        );
      }

      // Step (c): transactional DELETE-old + INSERT-new. R-107:
      // the repo preserves non-`undecided` user_decision via
      // time-overlap mapping unless we pass `{ force: true }`.
      deps.videoSegmentsRepo.replaceAllForMedia(media.id, newSegmentInserts, { force });

      // Step (d): best-effort removal of OLD segment files. Outside
      // the transaction because (i) storage removal can't roll back
      // anyway, and (ii) we only want to nuke OLD ids that are not
      // also NEW ids — but since our ids are fresh UUIDs every run,
      // there's no overlap by construction.
      const newSegmentIdSet = new Set(newSegmentInserts.map((s) => s.id));
      for (const oldRow of oldRows) {
        if (newSegmentIdSet.has(oldRow.id)) continue;
        const oldLogicalPath = videoSegmentMp4Path({
          tripId: media.tripId,
          mediaId: media.id,
          segmentId: oldRow.id,
        });
        try {
          await deps.storage.remove(oldLogicalPath);
        } catch (err) {
          // Storage's `remove` raises StorageError when the file is
          // already gone; that's harmless on cleanup. Log + carry on.
          deps.logger.warn(
            {
              ...correlation,
              oldSegmentId: oldRow.id,
              oldLogicalPath,
              err: err instanceof Error ? err.message : String(err),
            },
            "video_segments: failed to remove old segment file (already gone? continuing)",
          );
        }
      }

      deps.logger.info(
        {
          ...correlation,
          segmentCount: newSegmentInserts.length,
          oldSegmentCount: oldRows.length,
          durationSec: settings.durationSec,
          decodeSource: decodeSource.kind,
          decodeSourcePath: decodeSource.logicalPath,
          segmentsDir: `trips/${media.tripId}/derived/${media.id}/${SEGMENTS_SUBDIR}/`,
          workerVersion: settings.workerVersion,
          force,
        },
        "video_segments: segments written + video_segments rows replaced",
      );
      void newSegmentLogicalPaths;
    } finally {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => {
        /* best-effort tmp cleanup */
      });
    }
  };
}

// ---------------------------------------------------------------------------
// decode-source selection
//
// Duplicated from videoKeyframesWorker (P9.T5) per the P9.T6 prompt
// rule "不改 P9.T5 keyframes worker，除非 P9.T6 必须复用少量工具".
// The 15-line helper is small enough that duplicating is cheaper
// than the refactor risk; a future P9.T7 could extract a shared
// module if a third caller arrives.
// ---------------------------------------------------------------------------

async function pickDecodeSource(args: {
  readonly deps: VideoSegmentsHandlerDeps;
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
// ffmpeg invocation
// ---------------------------------------------------------------------------

interface RunFfmpegSegmentArgs {
  readonly input: string;
  readonly outputDir: string;
  readonly settings: VideoSegmentsSettings;
}

/**
 * Spawn ffmpeg with the `segment` muxer to slice the source into
 * fixed-duration MP4 chunks. Bounded timeout + SIGKILL + truncated
 * stderr on failure.
 *
 * Argument notes:
 *   * `-c copy -map 0` — copy every input stream (video + audio
 *     when present) without re-encoding. Slice boundaries align to
 *     the source's keyframes, so segments may be slightly off the
 *     requested `-segment_time`. ffprobe-per-segment after this
 *     pass gives the actual durations.
 *   * `-segment_time` — requested slice length (seconds).
 *   * `-reset_timestamps 1` — each segment's PTS starts at 0 so
 *     segments are independently playable.
 *   * `-segment_start_number 1` — 1-based filename numbering
 *     matches the P9.T5 keyframes convention (1-based 6-digit).
 *   * `-f segment` activates the segment muxer; the output pattern
 *     `%06d` is interpreted by ffmpeg, not our code.
 */
async function runFfmpegSegment(args: RunFfmpegSegmentArgs): Promise<void> {
  const { input, outputDir, settings } = args;
  const outputPattern = path.join(
    outputDir,
    `${FFMPEG_SEGMENT_FILENAME_PREFIX}%0${FFMPEG_SEGMENT_FILENAME_PADDING}d.${FFMPEG_SEGMENT_FILENAME_EXT}`,
  );

  const ffmpegArgs = [
    "-v",
    "error",
    "-i",
    input,
    "-c",
    "copy",
    "-map",
    "0",
    "-f",
    "segment",
    "-segment_time",
    settings.durationSec.toString(),
    "-reset_timestamps",
    "1",
    "-segment_start_number",
    "1",
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
            `ffmpeg segments timed out after ${settings.timeoutMs}ms (file=${path.basename(input)})`,
          ),
        );
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").slice(0, MAX_STDERR_BYTES);
        reject(new Error(`ffmpeg segments exited ${code}: ${stderr.trim() || "(no stderr)"}`));
        return;
      }
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// ffprobe per-segment duration probe
// ---------------------------------------------------------------------------

/**
 * Run ffprobe against one segment file and return its `format.duration`
 * in seconds. Throws on spawn failure, non-zero exit, timeout, or
 * unparseable JSON. Tiny helper duplicated from videoProxyWorker
 * because the proxy worker exports its `runFfprobeOnPath` only as a
 * file-private function; that's fine — keeping each video worker
 * self-contained makes the surface easier to reason about.
 */
async function probeSegmentDurationSec(absolutePath: string, ffprobePath: string): Promise<number> {
  const args = [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    absolutePath,
  ];

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  const parsed = await new Promise<Record<string, unknown>>((resolve, reject) => {
    let killed = false;
    const child = spawn(ffprobePath, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timeoutHandle = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, FFPROBE_PER_SEGMENT_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.once("error", (err) => {
      clearTimeout(timeoutHandle);
      reject(new Error(`ffprobe spawn failed (per-segment duration): ${err.message}`));
    });

    child.once("close", (code) => {
      clearTimeout(timeoutHandle);
      if (killed) {
        reject(new Error("ffprobe timed out (per-segment duration)"));
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").slice(0, MAX_STDERR_BYTES);
        reject(
          new Error(
            `ffprobe exited ${code} (per-segment duration): ${stderr.trim() || "(no stderr)"}`,
          ),
        );
        return;
      }
      try {
        const json = JSON.parse(Buffer.concat(stdoutChunks).toString("utf8")) as unknown;
        if (typeof json !== "object" || json === null || Array.isArray(json)) {
          reject(new Error("ffprobe output is not a JSON object (per-segment duration)"));
          return;
        }
        resolve(json as Record<string, unknown>);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reject(
          new Error(`ffprobe output not parseable as JSON (per-segment duration): ${message}`),
        );
      }
    });
  });

  const format = parsed.format;
  if (typeof format !== "object" || format === null) {
    throw new Error("ffprobe output missing `format` object (per-segment duration)");
  }
  const rawDuration = (format as { duration?: unknown }).duration;
  if (typeof rawDuration !== "string") {
    throw new Error(
      `ffprobe output missing format.duration string (got ${typeof rawDuration})`,
    );
  }
  const parsedDuration = Number.parseFloat(rawDuration);
  if (!Number.isFinite(parsedDuration) || parsedDuration <= 0) {
    throw new Error(
      `ffprobe returned non-positive duration: ${rawDuration} (per-segment duration)`,
    );
  }
  return parsedDuration;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Round a seconds value to millisecond precision. Keeps DB-side
 * `start_time` / `end_time` / `duration` from acquiring float
 * artefacts from accumulated additions (e.g. `0.1 + 0.2 = 0.30000…04`).
 * REAL columns in SQLite STRICT tables hold the IEEE-754 value,
 * but ms precision is well-defined for typical video lengths.
 */
function roundToMs(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/**
 * Parse `{ "force": true|false }` out of the job's `payload` TEXT
 * column. Anything else (null payload, non-JSON, JSON with no
 * `force` key, malformed JSON) silently falls back to `false`. We
 * log-warn on malformed JSON so a typo doesn't quietly skip the
 * caller's intent, but we don't fail the job — the safe interpretation
 * is "no force, preserve user_decision".
 *
 * Exported as a regular function (not the public surface) so the
 * smoke can exercise the edge cases without spinning up a JobQueue.
 */
function parseForceFlag(
  payload: string | null,
  logger: Logger,
  correlation: Record<string, unknown>,
): boolean {
  if (payload === null || payload.length === 0) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (err) {
    logger.warn(
      { ...correlation, err: err instanceof Error ? err.message : String(err) },
      "video_segments: payload is not parseable JSON; treating as force=false",
    );
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const flag = (parsed as { force?: unknown }).force;
  return flag === true;
}
