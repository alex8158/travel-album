// Manual smoke test for the video_cover worker (P9.T3).
//
// Usage: npm run smoke:video-cover-worker
//
// Drives `makeVideoCoverHandler` end-to-end against a real SQLite
// DB + real LocalStorageProvider + real ffmpeg / sharp. The test
// video is generated on the fly via `ffmpeg -f lavfi -i testsrc=...`
// (deterministic ramp pattern) so we don't need any fixture binary
// in the repo (matches the no-large-binaries constraint from the
// P9.T3 prompt).
//
// Coverage:
//   * `chooseCoverSeekSeconds` pure-function unit checks:
//       - null duration / 0 / negative → seek 0
//       - very short (< 2s) → midpoint
//       - longer (≥ 2s) → min(duration/2, fallbackSeekSeconds)
//       - cap engages on a 60s video (returns the cap, not 30s)
//   * Happy path: 3-second 320×240 25fps MP4 → cover JPEG written
//     to `derived/{mediaId}/video_cover.jpg`, media_items.thumbnail_path
//     cached to that logical path, media_versions(version_type=
//     'video_cover') UPSERTed with width/height/file_size/params.
//   * Idempotency: re-tick → same logical path, same file on disk
//     (bit-stable seek + ffmpeg pipeline), single media_versions
//     row (UPSERT, not duplicate).
//   * Cover bytes are a valid JPEG (sharp metadata says so).
//   * Cover dimensions ≤ maxEdge.
//   * Non-video media → job 'failed' with clear message.
//   * Soft-deleted media → job 'failed' (matches P7 contract: no
//     writes to soft-deleted rows, no thumbnail_path mutation).
//   * Missing original file → job 'failed'.
//   * NULL original_path → job 'failed'.
//   * Broken / not-a-video file → job 'failed' (ffmpeg rejects).
//   * Scope-guard: P9.T3 does NOT touch preview_path / status /
//     user_decision / duration / width / height (P9.T2 territory)
//     and the original file stays bit-identical on disk.
//
// SKIPs all ffmpeg-dependent cases when ffmpeg isn't on PATH.
// Failure to find ffmpeg is not a smoke failure here; it's a
// host-config gap that the worker itself surfaces as a job error.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { DuplicateGroupsRepository } from "../dedup/index.js";
import {
  JobQueue,
  JobRepository,
  VIDEO_COVER_JOB_TYPE,
  chooseCoverSeekSeconds,
  makeVideoCoverHandler,
  type JobHandler,
  type VideoCoverSettings,
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
// settings — match the production wiring (ffmpeg from PATH +
// 30s timeout + 1280 maxEdge + q:v 2 + 5s seek cap).
// ---------------------------------------------------------------------------

const SETTINGS: VideoCoverSettings = {
  ffmpegPath: "ffmpeg",
  timeoutMs: 30_000,
  maxEdge: 1280,
  jpegQuality: 2,
  fallbackSeekSeconds: 5,
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
 * Generate a deterministic test MP4 via ffmpeg's `lavfi` testsrc.
 * Frames vary across the timeline (numbered colour bars) so any
 * frame index produces a unique output — useful for spotting bad
 * seeks. Default 3 seconds, 320×240, 25fps, no audio.
 */
async function makeTestVideo(
  outputPath: string,
  options: { durationSec: number; width: number; height: number } = {
    durationSec: 3,
    width: 320,
    height: 240,
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
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "ultrafast",
    "-movflags",
    "+faststart",
    outputPath,
  ];
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
  options: { title?: string; duration?: number | null } = {},
): Promise<Seeded> {
  const trip = tripService.createTrip({ title: options.title ?? "P9.T3 Smoke Trip" });
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
        duration,
        status, user_decision, created_at, updated_at)
     VALUES (?, ?, 'video', ?, 'video/mp4', 'mp4', ?,
             ?,
             'processed', 'undecided', ?, ?)`,
  ).run(
    mediaId,
    trip.id,
    stored.logicalPath,
    videoBytes.length,
    options.duration ?? null,
    now,
    now,
  );
  return { tripId: trip.id, mediaId, originalPath: stored.logicalPath };
}

function seedNonVideoMedia(
  db: SqliteDatabase,
  tripService: TripService,
  mediaRepo: MediaRepository,
  type: "image" | "unknown",
): { tripId: string; mediaId: string } {
  const trip = tripService.createTrip({ title: `P9.T3 Smoke ${type}` });
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
  ).run(id, mediaId, VIDEO_COVER_JOB_TYPE, now, now);
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

function readCoverVersion(
  db: SqliteDatabase,
  mediaId: string,
): Record<string, unknown> | undefined {
  return db
    .prepare(`SELECT * FROM media_versions WHERE media_id = ? AND version_type = 'video_cover'`)
    .get(mediaId) as Record<string, unknown> | undefined;
}

function countCoverRows(db: SqliteDatabase, mediaId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM media_versions WHERE media_id = ? AND version_type = 'video_cover'`,
      )
      .get(mediaId) as { n: number }
  ).n;
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // ---- chooseCoverSeekSeconds pure-function unit checks ----
  {
    record(
      "chooseCoverSeekSeconds: null duration → 0",
      chooseCoverSeekSeconds(null, 5) === 0,
      `result=${chooseCoverSeekSeconds(null, 5)}`,
    );
    record(
      "chooseCoverSeekSeconds: 0 duration → 0",
      chooseCoverSeekSeconds(0, 5) === 0,
      `result=${chooseCoverSeekSeconds(0, 5)}`,
    );
    record(
      "chooseCoverSeekSeconds: negative duration → 0",
      chooseCoverSeekSeconds(-1, 5) === 0,
      `result=${chooseCoverSeekSeconds(-1, 5)}`,
    );
    record(
      "chooseCoverSeekSeconds: 1s clip → midpoint 0.5",
      chooseCoverSeekSeconds(1, 5) === 0.5,
      `result=${chooseCoverSeekSeconds(1, 5)}`,
    );
    record(
      "chooseCoverSeekSeconds: 4s clip → midpoint 2.0 (< cap)",
      chooseCoverSeekSeconds(4, 5) === 2,
      `result=${chooseCoverSeekSeconds(4, 5)}`,
    );
    record(
      "chooseCoverSeekSeconds: 60s clip → cap 5s (midpoint 30 > 5)",
      chooseCoverSeekSeconds(60, 5) === 5,
      `result=${chooseCoverSeekSeconds(60, 5)}`,
    );
    record(
      "chooseCoverSeekSeconds: NaN / Infinity → 0",
      chooseCoverSeekSeconds(NaN, 5) === 0 && chooseCoverSeekSeconds(Infinity, 5) === 0,
      `NaN=${chooseCoverSeekSeconds(NaN, 5)} Inf=${chooseCoverSeekSeconds(Infinity, 5)}`,
    );
  }

  // ---- ffmpeg availability gate ----
  const ffmpegOk = await isAvailable("ffmpeg");
  if (!ffmpegOk) {
    console.log("[smoke] SKIP: ffmpeg not on PATH; only unit-checked chooseCoverSeekSeconds.");
    const passed = results.filter((r) => r.ok).length;
    const failed = results.length - passed;
    console.log(`\n[smoke] summary: ${passed}/${results.length} passed (ffmpeg unavailable)`);
    if (failed > 0) process.exit(1);
    return;
  }

  // ---- ffmpeg present: end-to-end cases ----
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-video-cover-worker-smoke-"));
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
      VIDEO_COVER_JOB_TYPE,
      makeVideoCoverHandler({
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
    // CASE 1: happy path — 3-second testsrc with duration recorded
    // -----------------------------------------------------------------
    const videoPath = path.join(tmpRoot, "happy.mp4");
    await makeTestVideo(videoPath, { durationSec: 3, width: 320, height: 240 });
    const videoBytes = readFileSync(videoPath);
    const seeded = await seedVideoMedia(storage, dbHandle.db, tripService, videoBytes, {
      title: "Case1 happy",
      duration: 3,
    });
    const jobId = insertJob(dbHandle.db, seeded.mediaId);

    const tick = await tickVideo();
    record(
      "happy: tick claimed the seeded video_cover job",
      tick.claimed.length === 1 && tick.claimed[0]?.id === jobId,
      JSON.stringify(tick),
    );
    record(
      "happy: job row.status='success'",
      tick.finalStatus === "success",
      `finalStatus=${String(tick.finalStatus)}`,
    );

    // Logical path matches design.md §8.1 exactly.
    const coverLogical = `trips/${seeded.tripId}/derived/${seeded.mediaId}/video_cover.jpg`;
    const coverAbsolute = path.join(storage.root, coverLogical);
    record(
      "happy: cover JPEG present on disk under derived/{mediaId}/video_cover.jpg",
      existsSync(coverAbsolute),
      coverAbsolute,
    );

    // Cover bytes are a real JPEG with bounded dims.
    const coverBytes = readFileSync(coverAbsolute);
    const coverMeta = await sharp(coverBytes).metadata();
    record(
      "happy: cover bytes are a valid JPEG",
      coverMeta.format === "jpeg",
      `format=${coverMeta.format}`,
    );
    record(
      "happy: cover dimensions ≤ maxEdge and > 0",
      (coverMeta.width ?? 0) <= SETTINGS.maxEdge &&
        (coverMeta.height ?? 0) <= SETTINGS.maxEdge &&
        (coverMeta.width ?? 0) > 0 &&
        (coverMeta.height ?? 0) > 0,
      `dims=${coverMeta.width}×${coverMeta.height}, maxEdge=${SETTINGS.maxEdge}`,
    );

    // media_items.thumbnail_path cached.
    const mediaRow = readMedia(dbHandle.db, seeded.mediaId);
    record(
      "happy: media_items.thumbnail_path = video_cover logical path",
      mediaRow?.thumbnail_path === coverLogical,
      `thumbnail_path=${String(mediaRow?.thumbnail_path)}`,
    );

    // media_versions row UPSERTed.
    const versionRow = readCoverVersion(dbHandle.db, seeded.mediaId);
    record(
      "happy: media_versions row exists with version_type='video_cover'",
      versionRow !== undefined && versionRow.version_type === "video_cover",
      `version_type=${String(versionRow?.version_type)}`,
    );
    record(
      "happy: media_versions.file_path = derived video_cover.jpg logical path",
      versionRow?.file_path === coverLogical,
      `file_path=${String(versionRow?.file_path)}`,
    );
    record(
      "happy: media_versions.mime_type='image/jpeg'",
      versionRow?.mime_type === "image/jpeg",
      `mime=${String(versionRow?.mime_type)}`,
    );
    record(
      "happy: media_versions.width / height / file_size all populated",
      typeof versionRow?.width === "number" &&
        typeof versionRow?.height === "number" &&
        typeof versionRow?.file_size === "number" &&
        (versionRow.width as number) > 0 &&
        (versionRow.height as number) > 0 &&
        (versionRow.file_size as number) > 0,
      `w=${String(versionRow?.width)} h=${String(versionRow?.height)} size=${String(versionRow?.file_size)}`,
    );

    // params.seekSeconds is what chooseCoverSeekSeconds returned for
    // duration=3 (midpoint 1.5).
    const params = JSON.parse(String(versionRow?.params)) as {
      workerVersion: string;
      seekSeconds: number;
      sourceDuration: number | null;
      maxEdge: number;
      jpegQuality: number;
    };
    record(
      "happy: params records the actual seek time (3s clip → 1.5s midpoint) + worker knobs",
      params.workerVersion === "1.0" &&
        params.seekSeconds === 1.5 &&
        params.sourceDuration === 3 &&
        params.maxEdge === SETTINGS.maxEdge &&
        params.jpegQuality === SETTINGS.jpegQuality,
      JSON.stringify(params),
    );

    // -----------------------------------------------------------------
    // CASE 2: original video bytes unchanged (CLAUDE.md §2.2 — 原始视频不得被覆盖或修改).
    // -----------------------------------------------------------------
    {
      const originalAbsolute = path.join(storage.root, seeded.originalPath);
      const onDiskBytes = readFileSync(originalAbsolute);
      record(
        "non-destructive: original video bytes byte-for-byte unchanged",
        onDiskBytes.equals(videoBytes),
        `on-disk=${onDiskBytes.length}B seeded=${videoBytes.length}B`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 3: idempotency — second tick produces a (re-)written cover
    // and one media_versions row, not two.
    // -----------------------------------------------------------------
    {
      const beforeCount = countCoverRows(dbHandle.db, seeded.mediaId);
      const jobId2 = insertJob(dbHandle.db, seeded.mediaId);
      const tick2 = await tickVideo();
      record(
        "idempotent: second tick also success",
        tick2.claimed[0]?.id === jobId2 && tick2.finalStatus === "success",
        JSON.stringify(tick2),
      );
      record(
        "idempotent: still exactly 1 video_cover media_versions row (UPSERT)",
        countCoverRows(dbHandle.db, seeded.mediaId) === beforeCount,
        `count=${countCoverRows(dbHandle.db, seeded.mediaId)}`,
      );
      record(
        "idempotent: cover file still present at the same logical path",
        existsSync(coverAbsolute),
        coverAbsolute,
      );
    }

    // -----------------------------------------------------------------
    // CASE 4: non-video media → 'failed' with clear message.
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
        countCoverRows(dbHandle.db, img.mediaId) === 0,
        `count=${countCoverRows(dbHandle.db, img.mediaId)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 5: soft-deleted media → 'failed' (P7 contract).
    // -----------------------------------------------------------------
    {
      const sdBytes = readFileSync(videoPath);
      const sd = await seedVideoMedia(storage, dbHandle.db, tripService, sdBytes, {
        title: "Case5 soft-deleted",
        duration: 3,
      });
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
      const sdCoverAbsolute = path.join(
        storage.root,
        `trips/${sd.tripId}/derived/${sd.mediaId}/video_cover.jpg`,
      );
      record(
        "soft-deleted: no cover file leaked onto disk",
        !existsSync(sdCoverAbsolute),
        sdCoverAbsolute,
      );
      record(
        "soft-deleted: no media_versions row leaked",
        countCoverRows(dbHandle.db, sd.mediaId) === 0,
        `count=${countCoverRows(dbHandle.db, sd.mediaId)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 6: unknown-type media (NULL original_path) → 'failed'.
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
    // CASE 7: original file missing on disk → 'failed' (ffmpeg rejects).
    // -----------------------------------------------------------------
    {
      const ghostTrip = tripService.createTrip({ title: "Case7 ghost file" });
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
          /ffmpeg cover exited/.test(job.error_message as string),
        `error_message=${String(job?.error_message)}`,
      );
      record(
        "ghost-file: no media_versions row leaked",
        countCoverRows(dbHandle.db, ghostMediaId) === 0,
        `count=${countCoverRows(dbHandle.db, ghostMediaId)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 8: broken / not-a-video file → 'failed'.
    // -----------------------------------------------------------------
    {
      const brokenPath = path.join(tmpRoot, "broken.mp4");
      await writeFile(brokenPath, Buffer.from("not-a-real-mp4-file"));
      const brokenBytes = readFileSync(brokenPath);
      const broken = await seedVideoMedia(storage, dbHandle.db, tripService, brokenBytes, {
        title: "Case8 broken",
        duration: null,
      });
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
          /ffmpeg cover exited/.test(job.error_message as string),
        `error_message=${String(job?.error_message)}`,
      );
      record(
        "broken: no media_versions row leaked",
        countCoverRows(dbHandle.db, broken.mediaId) === 0,
        `count=${countCoverRows(dbHandle.db, broken.mediaId)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 9: scope-guard — worker does NOT touch preview_path,
    // status, user_decision, duration / width / height (those are
    // P9.T2 territory) or the original file's bytes.
    // -----------------------------------------------------------------
    {
      const cleanBytes = readFileSync(videoPath);
      const clean = await seedVideoMedia(storage, dbHandle.db, tripService, cleanBytes, {
        title: "Case9 scope-guard",
        duration: 3,
      });
      const beforeMedia = readMedia(dbHandle.db, clean.mediaId);
      const beforeOriginalBytes = readFileSync(path.join(storage.root, clean.originalPath));
      insertJob(dbHandle.db, clean.mediaId);
      await tickVideo();
      const afterMedia = readMedia(dbHandle.db, clean.mediaId);
      const afterOriginalBytes = readFileSync(path.join(storage.root, clean.originalPath));
      record(
        "scope-guard: thumbnail_path changed (the only allowed write); other columns preserved",
        afterMedia?.thumbnail_path !== beforeMedia?.thumbnail_path &&
          afterMedia?.preview_path === beforeMedia?.preview_path &&
          afterMedia?.status === beforeMedia?.status &&
          afterMedia?.user_decision === beforeMedia?.user_decision &&
          afterMedia?.deleted_at === beforeMedia?.deleted_at &&
          afterMedia?.duration === beforeMedia?.duration &&
          afterMedia?.width === beforeMedia?.width &&
          afterMedia?.height === beforeMedia?.height,
        `thumb-before=${String(beforeMedia?.thumbnail_path)} thumb-after=${String(afterMedia?.thumbnail_path)}`,
      );
      record(
        "scope-guard: original video bytes byte-for-byte unchanged",
        beforeOriginalBytes.equals(afterOriginalBytes),
        `before=${beforeOriginalBytes.length}B after=${afterOriginalBytes.length}B`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 10: NULL-duration video — worker still succeeds with seek=0.
    // Some videos genuinely have ffprobe-unparseable duration (rare);
    // we seek to frame 0 as the safest fallback.
    // -----------------------------------------------------------------
    {
      const nullDurBytes = readFileSync(videoPath);
      const nullDur = await seedVideoMedia(storage, dbHandle.db, tripService, nullDurBytes, {
        title: "Case10 null-duration",
        duration: null,
      });
      const nullDurJobId = insertJob(dbHandle.db, nullDur.mediaId);
      const nullDurTick = await tickVideo();
      record(
        "null-duration: tick succeeds (worker falls back to seek=0)",
        nullDurTick.claimed[0]?.id === nullDurJobId && nullDurTick.finalStatus === "success",
        JSON.stringify(nullDurTick),
      );
      const v = readCoverVersion(dbHandle.db, nullDur.mediaId);
      const p = JSON.parse(String(v?.params)) as {
        seekSeconds: number;
        sourceDuration: number | null;
      };
      record(
        "null-duration: params records seekSeconds=0 + sourceDuration=null",
        p.seekSeconds === 0 && p.sourceDuration === null,
        JSON.stringify(p),
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
