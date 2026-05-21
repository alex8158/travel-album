// Manual smoke test for the video_proxy worker (P9.T4).
//
// Usage: npm run smoke:video-proxy-worker
//
// Drives `makeVideoProxyHandler` end-to-end against a real SQLite
// DB + real LocalStorageProvider + real ffmpeg + real ffprobe.
// The test video is generated on the fly via `ffmpeg -f lavfi`
// (deterministic testsrc pattern) so no fixture binary needs to
// land in the repo.
//
// Coverage:
//   * Happy path: source video transcoded to a 720p H.264/AAC MP4
//     at `trips/{tripId}/derived/{mediaId}/video_proxy.mp4`;
//     media_versions(version_type='video_proxy') UPSERTed with
//     width / height / file_size / mime / params (recording every
//     transcode knob).
//   * Source height ≤ target height — no upscale (output dims
//     equal source dims; `-2:'min(ih,H)'` policy).
//   * Source height > target height — output capped at target.
//   * Idempotency: re-tick → same logical path, single
//     media_versions row (UPSERT, not duplicate).
//   * Proxy bytes are a valid MP4 with H.264 video stream
//     (ffprobe says so) — readback via the worker's own ffprobe.
//   * Non-video media → job 'failed' with clear message.
//   * Soft-deleted media → job 'failed' (P7 contract).
//   * Missing original file → job 'failed'.
//   * NULL original_path → job 'failed'.
//   * Broken / not-a-video file → job 'failed' (ffmpeg rejects).
//   * Scope-guard: P9.T4 does NOT touch media_items.preview_path
//     / thumbnail_path / status / user_decision / duration /
//     width / height (P9.T4 belongs entirely in media_versions).
//   * Original video bytes byte-for-byte unchanged across happy
//     + scope-guard cases.
//
// SKIPs ffmpeg-dependent cases when ffmpeg / ffprobe aren't on PATH.

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
  VIDEO_PROXY_JOB_TYPE,
  makeVideoProxyHandler,
  type JobHandler,
  type VideoProxySettings,
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

function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

// ---------------------------------------------------------------------------
// settings — match production wiring. Lowered `timeoutMs` to 60s
// so a stuck encode fails the smoke instead of hanging CI.
// ---------------------------------------------------------------------------

const SETTINGS: VideoProxySettings = {
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
  timeoutMs: 60_000,
  targetHeight: 720,
  crf: 28,
  preset: "veryfast",
  videoCodec: "libx264",
  audioCodec: "aac",
  audioBitrateKbps: 128,
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
 * generated file's bytes. Defaults: 2 seconds, 320×240 (≤ target
 * so the proxy can verify no-upscale), no audio. Audio is opt-in;
 * we use a sine wave for the audio variant.
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
 * Tiny ffprobe wrapper used by the smoke for after-the-fact
 * inspection of proxy bytes (e.g. asserting H.264 + height ≤ 720).
 * Not the worker's own ffprobe call — that one runs through
 * runFfprobeOnPath inside the handler.
 */
async function probeMetadata(filePath: string): Promise<{
  format: string | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
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
  return {
    format: parsed.format?.format_name ?? null,
    width: typeof v?.width === "number" ? v.width : null,
    height: typeof v?.height === "number" ? v.height : null,
    videoCodec: typeof v?.codec_name === "string" ? v.codec_name : null,
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
  title = "P9.T4 Smoke Trip",
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
  db: SqliteDatabase,
  tripService: TripService,
  mediaRepo: MediaRepository,
  type: "image" | "unknown",
): { tripId: string; mediaId: string } {
  const trip = tripService.createTrip({ title: `P9.T4 Smoke ${type}` });
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
  ).run(id, mediaId, VIDEO_PROXY_JOB_TYPE, now, now);
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

function readProxyVersion(
  db: SqliteDatabase,
  mediaId: string,
): Record<string, unknown> | undefined {
  return db
    .prepare(`SELECT * FROM media_versions WHERE media_id = ? AND version_type = 'video_proxy'`)
    .get(mediaId) as Record<string, unknown> | undefined;
}

function countProxyRows(db: SqliteDatabase, mediaId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM media_versions WHERE media_id = ? AND version_type = 'video_proxy'`,
      )
      .get(mediaId) as { n: number }
  ).n;
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const ffmpegOk = (await isAvailable("ffmpeg")) && (await isAvailable("ffprobe"));
  if (!ffmpegOk) {
    console.log("[smoke] SKIP: ffmpeg / ffprobe not on PATH; video_proxy is fully ffmpeg-driven.");
    console.log("\n[smoke] summary: 0/0 passed (ffmpeg unavailable)");
    return;
  }

  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-video-proxy-worker-smoke-"));
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
      VIDEO_PROXY_JOB_TYPE,
      makeVideoProxyHandler({
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
    // CASE 1: happy path — 320×240 source (≤ target=720), no upscale.
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
      "happy: tick claimed the seeded video_proxy job",
      tick.claimed.length === 1 && tick.claimed[0]?.id === jobId,
      JSON.stringify(tick),
    );
    record(
      "happy: job row.status='success'",
      tick.finalStatus === "success",
      `finalStatus=${String(tick.finalStatus)}`,
    );

    const proxyLogical = `trips/${seeded.tripId}/derived/${seeded.mediaId}/video_proxy.mp4`;
    const proxyAbsolute = path.join(storage.root, proxyLogical);
    record(
      "happy: proxy MP4 present on disk under derived/{mediaId}/video_proxy.mp4",
      existsSync(proxyAbsolute),
      proxyAbsolute,
    );

    // ffprobe assertions on the produced proxy.
    const proxyMeta = await probeMetadata(proxyAbsolute);
    record(
      "happy: proxy is H.264 + MP4 container",
      proxyMeta.videoCodec === "h264" &&
        typeof proxyMeta.format === "string" &&
        proxyMeta.format.includes("mp4"),
      JSON.stringify(proxyMeta),
    );
    record(
      "happy: no upscale — source 240p stays 240p (height ≤ target=720)",
      proxyMeta.height === 240 && proxyMeta.width === 320,
      `dims=${proxyMeta.width}×${proxyMeta.height}`,
    );

    // media_versions row UPSERTed with the right shape.
    const versionRow = readProxyVersion(dbHandle.db, seeded.mediaId);
    record(
      "happy: media_versions row exists with version_type='video_proxy'",
      versionRow !== undefined && versionRow.version_type === "video_proxy",
      `version_type=${String(versionRow?.version_type)}`,
    );
    record(
      "happy: media_versions.file_path = derived video_proxy.mp4 logical path",
      versionRow?.file_path === proxyLogical,
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
        params.targetHeight === 720 &&
        params.crf === 28 &&
        params.preset === "veryfast" &&
        params.videoCodec === "libx264" &&
        params.audioCodec === "aac" &&
        params.audioBitrateKbps === 128,
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
    // CASE 3: source > target — proxy capped at 720p.
    // -----------------------------------------------------------------
    {
      const bigPath = path.join(tmpRoot, "big.mp4");
      await makeTestVideo(bigPath, {
        durationSec: 2,
        width: 1920,
        height: 1080,
        audio: false,
      });
      const bigBytes = readFileSync(bigPath);
      const big = await seedVideoMedia(
        storage,
        dbHandle.db,
        tripService,
        bigBytes,
        "Case3 big-source",
      );
      const bigJobId = insertJob(dbHandle.db, big.mediaId);
      const bigTick = await tickVideo();
      record(
        "downscale: tick succeeds",
        bigTick.claimed[0]?.id === bigJobId && bigTick.finalStatus === "success",
        JSON.stringify(bigTick),
      );
      const bigProxyAbs = path.join(
        storage.root,
        `trips/${big.tripId}/derived/${big.mediaId}/video_proxy.mp4`,
      );
      const bigProxyMeta = await probeMetadata(bigProxyAbs);
      record(
        "downscale: proxy height = target (720), width even and proportional (1280)",
        bigProxyMeta.height === 720 && bigProxyMeta.width === 1280,
        `dims=${bigProxyMeta.width}×${bigProxyMeta.height}`,
      );
      const bigRow = readProxyVersion(dbHandle.db, big.mediaId);
      record(
        "downscale: media_versions row has 1280×720 + bytes < original",
        bigRow?.width === 1280 &&
          bigRow?.height === 720 &&
          typeof bigRow?.file_size === "number" &&
          (bigRow.file_size as number) < bigBytes.length,
        `proxy=${String(bigRow?.file_size)}B orig=${bigBytes.length}B`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 4: idempotency — second tick keeps a single row + same file.
    // -----------------------------------------------------------------
    {
      const beforeCount = countProxyRows(dbHandle.db, seeded.mediaId);
      const jobId2 = insertJob(dbHandle.db, seeded.mediaId);
      const tick2 = await tickVideo();
      record(
        "idempotent: second tick also success",
        tick2.claimed[0]?.id === jobId2 && tick2.finalStatus === "success",
        JSON.stringify(tick2),
      );
      record(
        "idempotent: still exactly 1 video_proxy media_versions row (UPSERT)",
        countProxyRows(dbHandle.db, seeded.mediaId) === beforeCount,
        `count=${countProxyRows(dbHandle.db, seeded.mediaId)}`,
      );
      record(
        "idempotent: proxy file still present at the same logical path",
        existsSync(proxyAbsolute),
        proxyAbsolute,
      );
    }

    // -----------------------------------------------------------------
    // CASE 5: non-video media → 'failed' with clear message.
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
        countProxyRows(dbHandle.db, img.mediaId) === 0,
        `count=${countProxyRows(dbHandle.db, img.mediaId)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 6: soft-deleted media → 'failed' (P7 contract).
    // -----------------------------------------------------------------
    {
      const sdBytes = readFileSync(smallPath);
      const sd = await seedVideoMedia(
        storage,
        dbHandle.db,
        tripService,
        sdBytes,
        "Case6 soft-deleted",
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
      const sdProxyAbs = path.join(
        storage.root,
        `trips/${sd.tripId}/derived/${sd.mediaId}/video_proxy.mp4`,
      );
      record("soft-deleted: no proxy file leaked onto disk", !existsSync(sdProxyAbs), sdProxyAbs);
      record(
        "soft-deleted: no media_versions row leaked",
        countProxyRows(dbHandle.db, sd.mediaId) === 0,
        `count=${countProxyRows(dbHandle.db, sd.mediaId)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 7: unknown-type media (NULL original_path) → 'failed'.
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
    // CASE 8: original file missing on disk → 'failed' (ffmpeg rejects).
    // -----------------------------------------------------------------
    {
      const ghostTrip = tripService.createTrip({ title: "Case8 ghost file" });
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
          /ffmpeg proxy exited/.test(job.error_message as string),
        `error_message=${String(job?.error_message)}`,
      );
      record(
        "ghost-file: no media_versions row leaked",
        countProxyRows(dbHandle.db, ghostMediaId) === 0,
        `count=${countProxyRows(dbHandle.db, ghostMediaId)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 9: broken / not-a-video file → 'failed'.
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
        "Case9 broken",
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
        "broken: error_message mentions ffmpeg failure",
        typeof job?.error_message === "string" &&
          /ffmpeg proxy exited/.test(job.error_message as string),
        `error_message=${String(job?.error_message)}`,
      );
      record(
        "broken: no media_versions row leaked",
        countProxyRows(dbHandle.db, broken.mediaId) === 0,
        `count=${countProxyRows(dbHandle.db, broken.mediaId)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 10: scope-guard — worker does NOT touch media_items columns;
    // original bytes intact; only media_versions(video_proxy) is added.
    // -----------------------------------------------------------------
    {
      const cleanBytes = readFileSync(smallPath);
      const clean = await seedVideoMedia(
        storage,
        dbHandle.db,
        tripService,
        cleanBytes,
        "Case10 scope-guard",
      );
      const beforeMedia = readMedia(dbHandle.db, clean.mediaId);
      const beforeOriginalBytes = readFileSync(path.join(storage.root, clean.originalPath));
      insertJob(dbHandle.db, clean.mediaId);
      await tickVideo();
      const afterMedia = readMedia(dbHandle.db, clean.mediaId);
      const afterOriginalBytes = readFileSync(path.join(storage.root, clean.originalPath));
      record(
        "scope-guard: media_items columns unchanged (preview_path / thumbnail_path / status / user_decision / duration / width / height / deleted_at)",
        afterMedia?.preview_path === beforeMedia?.preview_path &&
          afterMedia?.thumbnail_path === beforeMedia?.thumbnail_path &&
          afterMedia?.status === beforeMedia?.status &&
          afterMedia?.user_decision === beforeMedia?.user_decision &&
          afterMedia?.deleted_at === beforeMedia?.deleted_at &&
          afterMedia?.duration === beforeMedia?.duration &&
          afterMedia?.width === beforeMedia?.width &&
          afterMedia?.height === beforeMedia?.height,
        `preview=${String(afterMedia?.preview_path)} thumb=${String(afterMedia?.thumbnail_path)} status=${String(afterMedia?.status)}`,
      );
      record(
        "scope-guard: original video bytes byte-for-byte unchanged",
        beforeOriginalBytes.equals(afterOriginalBytes),
        `before=${beforeOriginalBytes.length}B after=${afterOriginalBytes.length}B`,
      );
      record(
        "scope-guard: exactly 1 media_versions(video_proxy) row was added",
        countProxyRows(dbHandle.db, clean.mediaId) === 1,
        `count=${countProxyRows(dbHandle.db, clean.mediaId)}`,
      );
    }
  } finally {
    closeDatabase(dbHandle);
    await rm(tmpRoot, { recursive: true, force: true });
    console.log(`[smoke] cleaned up ${tmpRoot}`);
  }

  // -------------------------------------------------------------------
  // summary
  // -------------------------------------------------------------------
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n[smoke] summary: ${passed}/${results.length} passed`);
  if (failed > 0) {
    console.log(
      `[smoke] failures: ${results
        .filter((r) => !r.ok)
        .map((r) => r.name)
        .join(", ")}`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[smoke] uncaught error: ${describeError(err)}`);
  process.exit(1);
});
