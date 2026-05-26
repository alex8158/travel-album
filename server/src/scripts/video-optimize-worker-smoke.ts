// Manual smoke test for the video_optimize worker (P11.T1).
//
// Usage: npm run smoke:video-optimize-worker
//
// Drives `makeVideoOptimizeHandler` end-to-end against a real SQLite
// DB + real LocalStorageProvider + real ffmpeg + real ffprobe. The
// test video is generated on the fly via `ffmpeg -f lavfi` so no
// fixture binary needs to land in the repo.
//
// Mirrors the structure of `video-proxy-worker-smoke.ts` (P9.T4)
// closely — the two workers share the "transcode + UPSERT
// media_versions" shape, only the version_type / defaults differ.
//
// Coverage:
//   * Happy path: source video transcoded to a H.264/AAC MP4 at
//     `trips/{tripId}/derived/{mediaId}/video_optimized.mp4`;
//     media_versions(version_type='video_optimized') UPSERTed with
//     width / height / file_size / mime / params (recording every
//     transcode knob).
//   * Source height ≤ target height — no upscale (output dims equal
//     source dims; `-2:'min(ih,H)'` policy).
//   * Source height > target height — output capped at target.
//   * Idempotency: re-tick → same logical path, single
//     media_versions row (UPSERT, not duplicate).
//   * Optimized bytes are a valid MP4 with H.264 video stream.
//   * Audio-less source: handler still succeeds, output may have no
//     audio stream (`-map 0:a?` makes the audio map optional).
//   * Non-video media (image / unknown) → job 'failed' with clear
//     "not a video" message; no derived file leaks; no
//     media_versions row leaks.
//   * Soft-deleted media → job 'failed' (P7 contract).
//   * Missing original file → job 'failed'.
//   * NULL original_path → job 'failed'.
//   * Broken / not-a-video file → job 'failed' (ffmpeg rejects).
//   * Original video bytes byte-for-byte unchanged across happy +
//     scope-guard cases (CLAUDE.md §2.2).
//   * Scope-guard: P11.T1 does NOT touch media_items.preview_path /
//     thumbnail_path / status / user_decision / duration / width /
//     height / active_version_type. The optimized file is
//     discoverable via media_versions row only.
//   * Scope-guard: other media_versions rows (e.g. video_proxy,
//     video_cover) are not touched — only the (mediaId,
//     'video_optimized') row is upserted.
//
// SKIPs ffmpeg-dependent cases when ffmpeg / ffprobe aren't on PATH
// (matches the existing convention from other video smokes).

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { DuplicateGroupsRepository } from "../dedup/index.js";
import {
  JobQueue,
  JobRepository,
  VIDEO_OPTIMIZE_JOB_TYPE,
  makeVideoOptimizeHandler,
  type JobHandler,
  type VideoOptimizeSettings,
} from "../jobs/index.js";
import { createLogger } from "../logger.js";
import {
  MediaRepository,
  MediaService,
  MediaVersionsRepository,
  type MediaSoftDeleteDeps,
} from "../media/index.js";
import { LocalStorageProvider } from "../storage/index.js";
import { TripRepository, TripService } from "../trips/index.js";

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const results: CheckResult[] = [];

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`[smoke][${ok ? "PASS" : "FAIL"}] ${name}: ${detail}`);
}

// ---------------------------------------------------------------------------
// settings — match production wiring but with lowered `timeoutMs` so
// stuck encodes fail the smoke quickly. Faster preset to keep the
// smoke run < 30s on CI.
// ---------------------------------------------------------------------------

const SETTINGS: VideoOptimizeSettings = {
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
  timeoutMs: 60_000,
  targetHeight: 1080,
  crf: 23,
  preset: "veryfast", // smoke override — production default is "medium"
  videoCodec: "libx264",
  audioCodec: "aac",
  audioBitrateKbps: 160,
  workerVersion: "1.0",
};

// ---------------------------------------------------------------------------
// ffmpeg availability + on-the-fly test-video generation
// ---------------------------------------------------------------------------

async function isAvailable(cmd: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn(cmd, ["-version"], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

/**
 * Generate a deterministic test MP4 via ffmpeg `lavfi`. Returns the
 * generated file's bytes. Audio is opt-in via the `audio` flag; when
 * true we mux a 1kHz sine tone for the same duration.
 */
async function makeTestVideo(
  outputPath: string,
  options: { durationSec: number; width: number; height: number; audio: boolean } = {
    durationSec: 2,
    width: 320,
    height: 240,
    audio: false,
  },
): Promise<void> {
  const args = [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `testsrc=duration=${options.durationSec}:size=${options.width}x${options.height}:rate=25`,
  ];
  if (options.audio) {
    args.push(
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=1000:sample_rate=48000:duration=${options.durationSec}`,
    );
  }
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast");
  if (options.audio) args.push("-c:a", "aac", "-ac", "2", "-shortest");
  args.push("-movflags", "+faststart", outputPath);

  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (b: Buffer) => stderr.push(b));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else
        reject(new Error(`ffmpeg gen exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
    });
  });
}

/**
 * Tiny ffprobe wrapper used by the smoke for after-the-fact inspection
 * (e.g. asserting H.264 + height ≤ 1080). Not the worker's own
 * ffprobe call.
 */
async function probeMetadata(filePath: string): Promise<{
  format: string | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
}> {
  const args = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath];
  const stdoutChunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.on("data", (b: Buffer) => stdoutChunks.push(b));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffprobe smoke helper exited ${code}`));
    });
  });
  const parsed = JSON.parse(Buffer.concat(stdoutChunks).toString("utf8")) as {
    format?: { format_name?: string };
    streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number }[];
  };
  const v = (parsed.streams ?? []).find((s) => s.codec_type === "video");
  const a = (parsed.streams ?? []).find((s) => s.codec_type === "audio");
  return {
    format: parsed.format?.format_name ?? null,
    width: typeof v?.width === "number" ? v.width : null,
    height: typeof v?.height === "number" ? v.height : null,
    videoCodec: typeof v?.codec_name === "string" ? v.codec_name : null,
    audioCodec: typeof a?.codec_name === "string" ? a.codec_name : null,
  };
}

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

interface Seeded {
  readonly tripId: string;
  readonly mediaId: string;
  readonly originalPath: string;
}

async function seedVideoMedia(
  storage: LocalStorageProvider,
  db: SqliteDatabase,
  tripService: TripService,
  videoBytes: Buffer,
  title = "P11.T1 Smoke Trip",
): Promise<Seeded> {
  const trip = tripService.createTrip({ title });
  const mediaId = randomUUID();
  const stored = await storage.putOriginal({
    tripId: trip.id,
    mediaId,
    extension: "mp4",
    data: videoBytes,
  });
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO media_items
       (id, trip_id, type, original_path, mime_type, extension, file_size,
        status, user_decision, created_at, updated_at)
     VALUES (?, ?, 'video', ?, 'video/mp4', 'mp4', ?,
             'processed', 'undecided', ?, ?)`,
  ).run(mediaId, trip.id, stored.logicalPath, videoBytes.length, now, now);
  return { tripId: trip.id, mediaId, originalPath: stored.logicalPath };
}

function seedNonVideoMedia(
  _db: SqliteDatabase,
  tripService: TripService,
  mediaRepo: MediaRepository,
  type: "image" | "unknown",
): { tripId: string; mediaId: string } {
  const trip = tripService.createTrip({ title: `P11.T1 Smoke ${type}` });
  const mediaId = randomUUID();
  const now = new Date().toISOString();
  mediaRepo.insert({
    id: mediaId,
    tripId: trip.id,
    type,
    originalPath: type === "image" ? `trips/${trip.id}/originals/${mediaId}.jpg` : null,
    fileSize: type === "image" ? 1024 : null,
    mimeType: type === "image" ? "image/jpeg" : null,
    extension: type === "image" ? "jpg" : null,
    createdAt: now,
    updatedAt: now,
  });
  return { tripId: trip.id, mediaId };
}

function insertJob(db: SqliteDatabase, mediaId: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO processing_jobs (id, media_id, job_type, status, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, ?)`,
  ).run(id, mediaId, VIDEO_OPTIMIZE_JOB_TYPE, now, now);
  return id;
}

function readJob(db: SqliteDatabase, jobId: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM processing_jobs WHERE id = ?`).get(jobId) as
    | Record<string, unknown>
    | undefined;
}

function readMedia(db: SqliteDatabase, mediaId: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM media_items WHERE id = ?`).get(mediaId) as
    | Record<string, unknown>
    | undefined;
}

function readOptimizedVersion(
  db: SqliteDatabase,
  mediaId: string,
): Record<string, unknown> | undefined {
  return db
    .prepare(`SELECT * FROM media_versions WHERE media_id = ? AND version_type = 'video_optimized'`)
    .get(mediaId) as Record<string, unknown> | undefined;
}

function countOptimizedRows(db: SqliteDatabase, mediaId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM media_versions WHERE media_id = ? AND version_type = 'video_optimized'`,
      )
      .get(mediaId) as { n: number }
  ).n;
}

function countAllVersionRows(db: SqliteDatabase, mediaId: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM media_versions WHERE media_id = ?`).get(mediaId) as {
      n: number;
    }
  ).n;
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const ffmpegOk = (await isAvailable("ffmpeg")) && (await isAvailable("ffprobe"));
  if (!ffmpegOk) {
    console.log(
      "[smoke] SKIP: ffmpeg / ffprobe not on PATH; video_optimize is fully ffmpeg-driven.",
    );
    console.log("\n[smoke] summary: 0/0 passed (ffmpeg unavailable)");
    return;
  }

  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-video-optimize-worker-smoke-"));
  const dbPath = path.join(tmpRoot, "smoke.db");
  const storageRoot = path.join(tmpRoot, "storage");
  console.log(`[smoke] tmpRoot=${tmpRoot}`);

  const dbHandle = openDatabase(dbPath);
  try {
    runMigrations(dbHandle.db);

    const logger = createLogger({ nodeEnv: "test" });
    const storage = LocalStorageProvider.create(storageRoot);
    const tripRepo = new TripRepository(dbHandle.db);
    const tripService = new TripService(tripRepo);
    const mediaRepo = new MediaRepository(dbHandle.db);
    const mediaVersionsRepo = new MediaVersionsRepository(dbHandle.db);
    const duplicateGroupsRepo = new DuplicateGroupsRepository(dbHandle.db);
    const jobRepo = new JobRepository(dbHandle.db);

    const softDeleteDeps: MediaSoftDeleteDeps = {
      db: dbHandle.db,
      tripRepo,
      duplicateGroupsRepo,
      logger,
    };
    const mediaService = new MediaService(
      mediaRepo,
      tripService,
      mediaVersionsRepo,
      jobRepo,
      softDeleteDeps,
    );

    const videoHandlers = new Map<string, JobHandler>();
    videoHandlers.set(
      VIDEO_OPTIMIZE_JOB_TYPE,
      makeVideoOptimizeHandler({
        storage,
        mediaRepo,
        mediaVersionsRepo,
        settings: SETTINGS,
        logger,
      }),
    );
    const queue = new JobQueue({
      jobRepo,
      logger,
      channels: [
        { name: "image", concurrency: 1, handlers: new Map(), pollIntervalMs: 60_000 },
        { name: "video", concurrency: 1, handlers: videoHandlers, pollIntervalMs: 60_000 },
        { name: "ai", concurrency: 1, handlers: new Map(), pollIntervalMs: 60_000 },
      ],
      zombieTimeoutMs: 0,
    });

    async function tickVideo(): Promise<{
      claimed: readonly { id: string; jobType: string }[];
      finalStatus: string | null;
    }> {
      const tick = await queue.tickChannel("video");
      await queue.awaitInflight("video");
      const lastClaim = tick.claimed[tick.claimed.length - 1];
      const finalStatus =
        lastClaim !== undefined
          ? ((readJob(dbHandle.db, lastClaim.jobId)?.status as string | undefined) ?? null)
          : null;
      return {
        claimed: tick.claimed.map((c) => ({ id: c.jobId, jobType: c.jobType })),
        finalStatus,
      };
    }

    // -----------------------------------------------------------------
    // CASE 1: happy path — 320×240 source (≤ target=1080), no upscale,
    //         WITH audio.
    // -----------------------------------------------------------------
    const smallPath = path.join(tmpRoot, "small.mp4");
    await makeTestVideo(smallPath, {
      durationSec: 2,
      width: 320,
      height: 240,
      audio: true,
    });
    const smallBytes = readFileSync(smallPath);
    const seeded = await seedVideoMedia(
      storage,
      dbHandle.db,
      tripService,
      smallBytes,
      "Case1 happy",
    );
    const jobId = insertJob(dbHandle.db, seeded.mediaId);

    const tick = await tickVideo();
    record(
      "happy: tick claimed the seeded video_optimize job",
      tick.claimed.length === 1 && tick.claimed[0]?.id === jobId,
      JSON.stringify(tick),
    );
    record(
      "happy: job row.status='success'",
      tick.finalStatus === "success",
      `finalStatus=${String(tick.finalStatus)}`,
    );

    const optimizedLogical = `trips/${seeded.tripId}/derived/${seeded.mediaId}/video_optimized.mp4`;
    const optimizedAbsolute = path.join(storage.root, optimizedLogical);
    record(
      "happy: optimized MP4 present on disk under derived/{mediaId}/video_optimized.mp4",
      existsSync(optimizedAbsolute),
      optimizedAbsolute,
    );

    // ffprobe assertions on the produced optimized file.
    const optimizedMeta = await probeMetadata(optimizedAbsolute);
    record(
      "happy: optimized output is H.264 + MP4 container",
      optimizedMeta.videoCodec === "h264" &&
        typeof optimizedMeta.format === "string" &&
        optimizedMeta.format.includes("mp4"),
      JSON.stringify(optimizedMeta),
    );
    record(
      "happy: no upscale — source 240p stays 240p (height ≤ target=1080)",
      optimizedMeta.height === 240 && optimizedMeta.width === 320,
      `dims=${optimizedMeta.width}×${optimizedMeta.height}`,
    );
    record(
      "happy: audio track preserved (AAC)",
      optimizedMeta.audioCodec === "aac",
      `audioCodec=${String(optimizedMeta.audioCodec)}`,
    );

    // media_versions row UPSERTed with the right shape.
    const versionRow = readOptimizedVersion(dbHandle.db, seeded.mediaId);
    record(
      "happy: media_versions row exists with version_type='video_optimized'",
      versionRow !== undefined && versionRow.version_type === "video_optimized",
      `version_type=${String(versionRow?.version_type)}`,
    );
    record(
      "happy: media_versions.file_path = derived video_optimized.mp4 logical path",
      versionRow?.file_path === optimizedLogical,
      `file_path=${String(versionRow?.file_path)}`,
    );
    record(
      "happy: media_versions.mime_type='video/mp4'",
      versionRow?.mime_type === "video/mp4",
      `mime=${String(versionRow?.mime_type)}`,
    );
    record(
      "happy: media_versions.width / height / file_size populated",
      typeof versionRow?.width === "number" &&
        typeof versionRow?.height === "number" &&
        typeof versionRow?.file_size === "number" &&
        (versionRow.width as number) === 320 &&
        (versionRow.height as number) === 240 &&
        (versionRow.file_size as number) > 0,
      `w=${String(versionRow?.width)} h=${String(versionRow?.height)} size=${String(versionRow?.file_size)}`,
    );
    record(
      "happy: media_versions.status='ready'",
      versionRow?.status === "ready",
      `status=${String(versionRow?.status)}`,
    );

    // params records every transcode knob.
    const params = JSON.parse(String(versionRow?.params)) as {
      workerVersion: string;
      targetHeight: number;
      crf: number;
      preset: string;
      videoCodec: string;
      audioCodec: string;
      audioBitrateKbps: number;
    };
    record(
      "happy: params records every transcode knob",
      params.workerVersion === "1.0" &&
        params.targetHeight === 1080 &&
        params.crf === 23 &&
        params.preset === "veryfast" &&
        params.videoCodec === "libx264" &&
        params.audioCodec === "aac" &&
        params.audioBitrateKbps === 160,
      JSON.stringify(params),
    );

    // -----------------------------------------------------------------
    // CASE 2: original video bytes byte-for-byte unchanged (CLAUDE.md §2.2).
    // -----------------------------------------------------------------
    {
      const originalAbsolute = path.join(storage.root, seeded.originalPath);
      const onDiskBytes = readFileSync(originalAbsolute);
      record(
        "non-destructive: original video bytes byte-for-byte unchanged",
        onDiskBytes.equals(smallBytes),
        `on-disk=${onDiskBytes.length}B seeded=${smallBytes.length}B`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 3: scope-guard — media_items columns not touched, no
    //         active_version_type / preview_path / thumbnail_path
    //         / duration / width / height / user_decision drift.
    // -----------------------------------------------------------------
    {
      const mediaRow = readMedia(dbHandle.db, seeded.mediaId);
      record(
        "scope-guard: media_items.preview_path remains NULL",
        mediaRow?.preview_path === null,
        `preview_path=${String(mediaRow?.preview_path)}`,
      );
      record(
        "scope-guard: media_items.thumbnail_path remains NULL",
        mediaRow?.thumbnail_path === null,
        `thumbnail_path=${String(mediaRow?.thumbnail_path)}`,
      );
      record(
        "scope-guard: media_items.user_decision remains 'undecided'",
        mediaRow?.user_decision === "undecided",
        `user_decision=${String(mediaRow?.user_decision)}`,
      );
      record(
        "scope-guard: media_items.active_version_type remains 'original'",
        mediaRow?.active_version_type === "original",
        `active_version_type=${String(mediaRow?.active_version_type)}`,
      );
      record(
        "scope-guard: media_items.status remains 'processed' (unchanged by optimize)",
        mediaRow?.status === "processed",
        `status=${String(mediaRow?.status)}`,
      );
      record(
        "scope-guard: media_items.duration remains NULL (video_metadata is separate)",
        mediaRow?.duration === null,
        `duration=${String(mediaRow?.duration)}`,
      );
      record(
        "scope-guard: media_items.width / height remain NULL",
        mediaRow?.width === null && mediaRow?.height === null,
        `w=${String(mediaRow?.width)} h=${String(mediaRow?.height)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 4: scope-guard — only the (mediaId, 'video_optimized') row
    //         appears in media_versions; no spillage to other types.
    // -----------------------------------------------------------------
    {
      const allRows = countAllVersionRows(dbHandle.db, seeded.mediaId);
      const optimizedRows = countOptimizedRows(dbHandle.db, seeded.mediaId);
      record(
        "scope-guard: only the video_optimized row was written for this media",
        allRows === 1 && optimizedRows === 1,
        `all=${allRows} optimized=${optimizedRows}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 5: source > target — optimized capped at 1080p.
    // -----------------------------------------------------------------
    {
      const bigPath = path.join(tmpRoot, "big.mp4");
      await makeTestVideo(bigPath, {
        durationSec: 2,
        width: 3840,
        height: 2160,
        audio: false,
      });
      const bigBytes = readFileSync(bigPath);
      const big = await seedVideoMedia(
        storage,
        dbHandle.db,
        tripService,
        bigBytes,
        "Case5 big-source",
      );
      const bigJobId = insertJob(dbHandle.db, big.mediaId);
      const bigTick = await tickVideo();
      record(
        "downscale: tick succeeds",
        bigTick.claimed[0]?.id === bigJobId && bigTick.finalStatus === "success",
        JSON.stringify(bigTick),
      );
      const bigOptimizedAbs = path.join(
        storage.root,
        `trips/${big.tripId}/derived/${big.mediaId}/video_optimized.mp4`,
      );
      const bigMeta = await probeMetadata(bigOptimizedAbs);
      record(
        "downscale: optimized height = target (1080), width even and proportional (1920)",
        bigMeta.height === 1080 && bigMeta.width === 1920,
        `dims=${bigMeta.width}×${bigMeta.height}`,
      );
      const bigRow = readOptimizedVersion(dbHandle.db, big.mediaId);
      record(
        "downscale: media_versions row has 1920×1080",
        bigRow?.width === 1920 && bigRow?.height === 1080,
        `w=${String(bigRow?.width)} h=${String(bigRow?.height)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 6: audio-less source still succeeds (`-map 0:a?`).
    // -----------------------------------------------------------------
    {
      const noAudioPath = path.join(tmpRoot, "noaudio.mp4");
      await makeTestVideo(noAudioPath, {
        durationSec: 2,
        width: 320,
        height: 240,
        audio: false,
      });
      const noAudioBytes = readFileSync(noAudioPath);
      const noAudio = await seedVideoMedia(
        storage,
        dbHandle.db,
        tripService,
        noAudioBytes,
        "Case6 audio-less source",
      );
      const noAudioJobId = insertJob(dbHandle.db, noAudio.mediaId);
      const noAudioTick = await tickVideo();
      record(
        "audio-less: tick succeeds",
        noAudioTick.claimed[0]?.id === noAudioJobId && noAudioTick.finalStatus === "success",
        JSON.stringify(noAudioTick),
      );
      const noAudioOptimizedAbs = path.join(
        storage.root,
        `trips/${noAudio.tripId}/derived/${noAudio.mediaId}/video_optimized.mp4`,
      );
      const noAudioMeta = await probeMetadata(noAudioOptimizedAbs);
      record(
        "audio-less: optimized output exists and is H.264",
        existsSync(noAudioOptimizedAbs) && noAudioMeta.videoCodec === "h264",
        JSON.stringify(noAudioMeta),
      );
    }

    // -----------------------------------------------------------------
    // CASE 7: idempotency — second tick keeps a single row + same file.
    // -----------------------------------------------------------------
    {
      const beforeCount = countOptimizedRows(dbHandle.db, seeded.mediaId);
      const jobId2 = insertJob(dbHandle.db, seeded.mediaId);
      const tick2 = await tickVideo();
      record(
        "idempotent: second tick also success",
        tick2.claimed[0]?.id === jobId2 && tick2.finalStatus === "success",
        JSON.stringify(tick2),
      );
      record(
        "idempotent: still exactly 1 video_optimized media_versions row (UPSERT)",
        countOptimizedRows(dbHandle.db, seeded.mediaId) === beforeCount,
        `count=${countOptimizedRows(dbHandle.db, seeded.mediaId)}`,
      );
      record(
        "idempotent: optimized file still present at the same logical path",
        existsSync(optimizedAbsolute),
        optimizedAbsolute,
      );
      // Verify original still byte-equal after a SECOND run.
      const originalAbsolute = path.join(storage.root, seeded.originalPath);
      const onDiskBytes = readFileSync(originalAbsolute);
      record(
        "idempotent: original video bytes still byte-for-byte unchanged after re-run",
        onDiskBytes.equals(smallBytes),
        `on-disk=${onDiskBytes.length}B seeded=${smallBytes.length}B`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 8: non-video media (image) → 'failed' with clear message.
    // -----------------------------------------------------------------
    {
      const img = seedNonVideoMedia(dbHandle.db, tripService, mediaRepo, "image");
      const imgJobId = insertJob(dbHandle.db, img.mediaId);
      const imgTick = await tickVideo();
      record(
        "image: tick claimed but handler failed",
        imgTick.claimed[0]?.id === imgJobId && imgTick.finalStatus === "failed",
        JSON.stringify(imgTick),
      );
      const job = readJob(dbHandle.db, imgJobId);
      record(
        "image: error_message mentions 'not a video' + actual type",
        typeof job?.error_message === "string" &&
          /not a video/.test(job.error_message as string) &&
          /image/.test(job.error_message as string),
        `error_message=${String(job?.error_message)}`,
      );
      record(
        "image: no media_versions row was written",
        countOptimizedRows(dbHandle.db, img.mediaId) === 0,
        `count=${countOptimizedRows(dbHandle.db, img.mediaId)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 9: soft-deleted media → 'failed' (P7 contract).
    // -----------------------------------------------------------------
    {
      const sdBytes = readFileSync(smallPath);
      const sd = await seedVideoMedia(
        storage,
        dbHandle.db,
        tripService,
        sdBytes,
        "Case9 soft-deleted",
      );
      const sdJobId = insertJob(dbHandle.db, sd.mediaId);
      mediaService.softDeleteMedia(sd.mediaId);
      const sdTick = await tickVideo();
      record(
        "soft-deleted: tick claimed but handler failed",
        sdTick.claimed[0]?.id === sdJobId && sdTick.finalStatus === "failed",
        JSON.stringify(sdTick),
      );
      const job = readJob(dbHandle.db, sdJobId);
      record(
        "soft-deleted: error_message mentions 'not found or soft-deleted'",
        typeof job?.error_message === "string" &&
          /not found or soft-deleted/.test(job.error_message as string),
        `error_message=${String(job?.error_message)}`,
      );
      const sdOptimizedAbs = path.join(
        storage.root,
        `trips/${sd.tripId}/derived/${sd.mediaId}/video_optimized.mp4`,
      );
      record(
        "soft-deleted: no optimized file leaked onto disk",
        !existsSync(sdOptimizedAbs),
        sdOptimizedAbs,
      );
      record(
        "soft-deleted: no media_versions row leaked",
        countOptimizedRows(dbHandle.db, sd.mediaId) === 0,
        `count=${countOptimizedRows(dbHandle.db, sd.mediaId)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 10: unknown-type media (NULL original_path) → 'failed'.
    // -----------------------------------------------------------------
    {
      const unk = seedNonVideoMedia(dbHandle.db, tripService, mediaRepo, "unknown");
      const unkJobId = insertJob(dbHandle.db, unk.mediaId);
      const unkTick = await tickVideo();
      record(
        "unknown: tick claimed but handler failed",
        unkTick.claimed[0]?.id === unkJobId && unkTick.finalStatus === "failed",
        JSON.stringify(unkTick),
      );
      const job = readJob(dbHandle.db, unkJobId);
      record(
        "unknown: error_message explains rejection (type or original_path)",
        typeof job?.error_message === "string" &&
          (/not a video/.test(job.error_message as string) ||
            /no original_path/.test(job.error_message as string)),
        `error_message=${String(job?.error_message)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 11: original file missing on disk → 'failed' (ffmpeg rejects).
    // -----------------------------------------------------------------
    {
      const ghostTrip = tripService.createTrip({ title: "Case11 ghost file" });
      const ghostMediaId = randomUUID();
      const now = new Date().toISOString();
      const ghostPath = `trips/${ghostTrip.id}/originals/${ghostMediaId}.mp4`;
      dbHandle.db
        .prepare(
          `INSERT INTO media_items
             (id, trip_id, type, original_path, mime_type, extension, file_size,
              status, user_decision, created_at, updated_at)
           VALUES (?, ?, 'video', ?, 'video/mp4', 'mp4', 1024,
                   'processed', 'undecided', ?, ?)`,
        )
        .run(ghostMediaId, ghostTrip.id, ghostPath, now, now);
      const ghostJobId = insertJob(dbHandle.db, ghostMediaId);
      const ghostTick = await tickVideo();
      record(
        "ghost-file: tick claimed but handler failed",
        ghostTick.claimed[0]?.id === ghostJobId && ghostTick.finalStatus === "failed",
        JSON.stringify(ghostTick),
      );
      const job = readJob(dbHandle.db, ghostJobId);
      record(
        "ghost-file: error_message surfaces ffmpeg failure",
        typeof job?.error_message === "string" &&
          /ffmpeg optimize exited/.test(job.error_message as string),
        `error_message=${String(job?.error_message)}`,
      );
      record(
        "ghost-file: no media_versions row leaked",
        countOptimizedRows(dbHandle.db, ghostMediaId) === 0,
        `count=${countOptimizedRows(dbHandle.db, ghostMediaId)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 12: broken / not-a-video file → 'failed'.
    // -----------------------------------------------------------------
    {
      const brokenPath = path.join(tmpRoot, "broken.mp4");
      await writeFile(brokenPath, Buffer.from("not-a-real-mp4-file"));
      const brokenBytes = readFileSync(brokenPath);
      const broken = await seedVideoMedia(
        storage,
        dbHandle.db,
        tripService,
        brokenBytes,
        "Case12 broken",
      );
      const brokenJobId = insertJob(dbHandle.db, broken.mediaId);
      const brokenTick = await tickVideo();
      record(
        "broken: tick claimed but handler failed",
        brokenTick.claimed[0]?.id === brokenJobId && brokenTick.finalStatus === "failed",
        JSON.stringify(brokenTick),
      );
      const job = readJob(dbHandle.db, brokenJobId);
      record(
        "broken: error_message surfaces ffmpeg failure",
        typeof job?.error_message === "string" &&
          /ffmpeg optimize exited/.test(job.error_message as string),
        `error_message=${String(job?.error_message)}`,
      );
      record(
        "broken: no media_versions row leaked",
        countOptimizedRows(dbHandle.db, broken.mediaId) === 0,
        `count=${countOptimizedRows(dbHandle.db, broken.mediaId)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 13: MediaService.optimizeVideoMedia integration —
    //          enqueue path covers 404 / 400 / created / skipped /
    //          reset (mirrors enhance / ai-refine semantics).
    // -----------------------------------------------------------------
    {
      // 404: missing media id. NotFoundError extends AppError; detect by
      // (code === 'NOT_FOUND' && statusCode === 404) since AppError
      // subclasses inherit `name = 'AppError'` (see errors/AppError.ts).
      let svc404 = false;
      let svc404Detail = "no throw";
      try {
        mediaService.optimizeVideoMedia(randomUUID());
      } catch (err) {
        if (err !== null && typeof err === "object") {
          const e = err as { code?: string; statusCode?: number };
          svc404 = e.code === "NOT_FOUND" && e.statusCode === 404;
          svc404Detail = `code=${String(e.code)} statusCode=${String(e.statusCode)}`;
        }
      }
      record(
        "service: missing media → NotFoundError (404 mapping)",
        svc404,
        svc404Detail,
      );

      // 400: image media.
      const imgFor400 = seedNonVideoMedia(dbHandle.db, tripService, mediaRepo, "image");
      let svc400 = false;
      let svc400Detail = "no throw";
      try {
        mediaService.optimizeVideoMedia(imgFor400.mediaId);
      } catch (err) {
        if (err !== null && typeof err === "object") {
          const e = err as { code?: string; statusCode?: number };
          svc400 = e.code === "BAD_REQUEST" && e.statusCode === 400;
          svc400Detail = `code=${String(e.code)} statusCode=${String(e.statusCode)}`;
        }
      }
      record(
        "service: image media → BadRequestError (400 mapping)",
        svc400,
        svc400Detail,
      );

      // created → success path.
      const svcVideoBytes = readFileSync(smallPath);
      const svcVideo = await seedVideoMedia(
        storage,
        dbHandle.db,
        tripService,
        svcVideoBytes,
        "Case13 service-created",
      );
      const created = mediaService.optimizeVideoMedia(svcVideo.mediaId);
      record(
        "service: first call returns outcome='created'",
        created.outcome === "created" &&
          created.jobType === "video_optimize" &&
          typeof created.jobId === "string" &&
          created.jobId.length > 0,
        JSON.stringify(created),
      );

      // skipped (pending row exists).
      const skipped = mediaService.optimizeVideoMedia(svcVideo.mediaId);
      record(
        "service: second call before worker runs → outcome='skipped' (idempotent)",
        skipped.outcome === "skipped" && skipped.jobId === created.jobId,
        JSON.stringify(skipped),
      );

      // Drain the pending job → success → next call returns reset.
      await tickVideo();
      const reset = mediaService.optimizeVideoMedia(svcVideo.mediaId);
      record(
        "service: third call after success → outcome='reset' (re-enter retrying)",
        reset.outcome === "reset" && reset.jobId === created.jobId,
        JSON.stringify(reset),
      );
    }

    // -----------------------------------------------------------------
    // CASE 14: foreign-key + integrity check after all the moves.
    // -----------------------------------------------------------------
    {
      const fkCheck = dbHandle.db.prepare("PRAGMA foreign_key_check").all() as unknown[];
      record(
        "integrity: PRAGMA foreign_key_check returns 0 rows",
        fkCheck.length === 0,
        `rows=${fkCheck.length}`,
      );
      const intCheck = (
        dbHandle.db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[]
      ).map((r) => r.integrity_check);
      record(
        "integrity: PRAGMA integrity_check is 'ok'",
        intCheck.length === 1 && intCheck[0] === "ok",
        intCheck.join(", "),
      );
    }

    // -----------------------------------------------------------------
    // summary
    // -----------------------------------------------------------------
    const passed = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n[smoke] summary: ${passed}/${results.length} passed (${failed} failed)`);
    if (failed > 0) {
      for (const r of results.filter((r) => !r.ok)) {
        console.log(`[smoke][FAIL] ${r.name}: ${r.detail}`);
      }
      process.exitCode = 1;
    }
  } finally {
    closeDatabase(dbHandle);
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {
      /* best-effort */
    });
  }
}

void main().catch((err) => {
  console.error("[smoke] uncaught error:", err);
  process.exitCode = 1;
});
