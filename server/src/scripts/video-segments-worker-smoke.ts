// Manual smoke test for the video_segments worker (P9.T6).
//
// Usage: npm run smoke:video-segments-worker
//
// Drives `makeVideoSegmentsHandler` end-to-end against a real
// SQLite DB + real LocalStorageProvider + real ffmpeg / ffprobe.
// Test video is generated on the fly via `ffmpeg -f lavfi` so no
// fixture binary needs to land in the repo.
//
// Coverage:
//   * Happy path: 12-second testsrc @ durationSec=3 → 4 segments,
//     each segment file present on disk + a matching video_segments
//     row, with positive duration and matching file count.
//   * Start/end/duration sanity: rows sorted by start_time form a
//     contiguous non-overlapping cover of the source's duration,
//     each duration positive, total ≈ source length.
//   * Decode-source preference: when a `video_proxy` row + file
//     exist, the worker uses it (we verify by removing the original
//     and confirming success).
//   * Idempotency: a second tick produces the same segment count
//     (re-run is a wipe+reinsert) and old segment files are removed.
//   * Original bytes byte-for-byte unchanged.
//   * Non-video media (image / unknown) → 'failed'.
//   * Soft-deleted media → 'failed' (P7 contract).
//   * Missing original file (and no proxy) → 'failed' (ffmpeg
//     rejects).
//   * Broken / not-a-video file → 'failed'.
//   * Scope-guard: worker does NOT touch media_items columns or
//     write to media_versions; original bytes intact.
//
// Gracefully SKIPs ffmpeg-dependent cases when ffmpeg isn't on PATH.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { DuplicateGroupsRepository } from "../dedup/index.js";
import {
  JobQueue,
  JobRepository,
  VIDEO_SEGMENTS_JOB_TYPE,
  makeVideoSegmentsHandler,
  type JobHandler,
  type VideoSegmentsSettings,
} from "../jobs/index.js";
import { createLogger } from "../logger.js";
import {
  MediaRepository,
  MediaService,
  MediaVersionsRepository,
  VideoSegmentsRepository,
  videoSegmentMp4Path,
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
// settings — match production wiring (lower timeout for smoke so a
// stuck encode fails the test instead of hanging CI for 5 min).
// ---------------------------------------------------------------------------

const SETTINGS: VideoSegmentsSettings = {
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
  timeoutMs: 60_000,
  durationSec: 3,
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
 * Generate a deterministic test MP4 via ffmpeg `lavfi`. Defaults:
 * 12 seconds, 320×240, 25fps, GOP=15 so segments can split at
 * keyframes near the requested 3-second boundary.
 */
async function makeTestVideo(
  outputPath: string,
  options: { durationSec: number; width: number; height: number } = {
    durationSec: 12,
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
    "-g",
    "25",
    "-keyint_min",
    "25",
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
  const trip = tripService.createTrip({ title: options.title ?? "P9.T6 Smoke Trip" });
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
  void db;
  const trip = tripService.createTrip({ title: `P9.T6 Smoke ${type}` });
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
  ).run(id, mediaId, VIDEO_SEGMENTS_JOB_TYPE, now, now);
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

function countVersions(db: SqliteDatabase, mediaId: string): number {
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
  // ---- ffmpeg availability gate ----
  const ffmpegOk = (await isAvailable("ffmpeg")) && (await isAvailable("ffprobe"));
  if (!ffmpegOk) {
    console.log("[smoke] SKIP: ffmpeg/ffprobe not on PATH; no end-to-end checks ran.");
    console.log(`\n[smoke] summary: 0/0 passed (ffmpeg unavailable)`);
    return;
  }

  // ---- ffmpeg present: end-to-end cases ----
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-video-segments-worker-smoke-"));
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
    const videoSegmentsRepo = new VideoSegmentsRepository(dbHandle.db);

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
      VIDEO_SEGMENTS_JOB_TYPE,
      makeVideoSegmentsHandler({
        storage,
        mediaRepo,
        mediaVersionsRepo,
        videoSegmentsRepo,
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
    // CASE 1: happy path — 12s testsrc @ durationSec=3.
    // Expect 4 segments, contiguous, total ≈ 12s.
    // -----------------------------------------------------------------
    const videoPath = path.join(tmpRoot, "happy.mp4");
    await makeTestVideo(videoPath, { durationSec: 12, width: 320, height: 240 });
    const videoBytes = readFileSync(videoPath);
    const seeded = await seedVideoMedia(storage, dbHandle.db, tripService, videoBytes, {
      title: "Case1 happy",
      duration: 12,
    });
    const jobId = insertJob(dbHandle.db, seeded.mediaId);

    const tick = await tickVideo();
    record(
      "happy: tick claimed the seeded video_segments job",
      tick.claimed.length === 1 && tick.claimed[0]?.id === jobId,
      JSON.stringify(tick),
    );
    record(
      "happy: job row.status='success'",
      tick.finalStatus === "success",
      `finalStatus=${String(tick.finalStatus)}`,
    );

    const segs = videoSegmentsRepo.listByMediaId(seeded.mediaId);
    record(
      "happy: 12s clip @ durationSec=3 → 4 video_segments rows",
      segs.length === 4,
      `segs.length=${segs.length}`,
    );
    record(
      "happy: every row has positive duration and end > start",
      segs.every((s) => s.duration > 0 && s.endTime > s.startTime),
      segs.map((s) => `${s.startTime}-${s.endTime}(${s.duration})`).join(","),
    );
    record(
      "happy: segments are contiguous + monotonic (start_i+1 === end_i)",
      segs.slice(1).every((s, i) => Math.abs(s.startTime - segs[i]!.endTime) < 1e-9),
      segs.map((s) => `${s.startTime}->${s.endTime}`).join(" | "),
    );
    record(
      "happy: total duration ≈ source length (within ±0.5s)",
      Math.abs(segs.reduce((acc, s) => acc + s.duration, 0) - 12) < 0.5,
      `sum=${segs.reduce((acc, s) => acc + s.duration, 0)}`,
    );
    record(
      "happy: first segment startTime is 0",
      segs[0]?.startTime === 0,
      `first.startTime=${segs[0]?.startTime}`,
    );

    // Each segment MP4 file is present + non-empty + path matches helper.
    let allFilesOk = true;
    for (const s of segs) {
      const logicalPath = videoSegmentMp4Path({
        tripId: seeded.tripId,
        mediaId: seeded.mediaId,
        segmentId: s.id,
      });
      const abs = path.join(storage.root, logicalPath);
      if (!existsSync(abs) || readFileSync(abs).length === 0) {
        allFilesOk = false;
        break;
      }
    }
    record(
      "happy: every segment file present at canonical derived path + non-empty",
      allFilesOk,
      `count=${segs.length}`,
    );

    // The on-disk segments dir contains exactly the expected files
    // (no leftovers / no extras).
    const segmentsDir = path.join(
      storage.root,
      `trips/${seeded.tripId}/derived/${seeded.mediaId}/segments`,
    );
    const onDiskSegmentFiles = (await readdir(segmentsDir)).filter((n) => n.endsWith(".mp4"));
    record(
      "happy: on-disk segments dir file count === DB row count (no orphans)",
      onDiskSegmentFiles.length === segs.length,
      `onDisk=${onDiskSegmentFiles.length} db=${segs.length}`,
    );
    record(
      "happy: on-disk segment basenames === '{rowId}.mp4'",
      segs.every((s) => onDiskSegmentFiles.includes(`${s.id}.mp4`)),
      `disk=${onDiskSegmentFiles.join(",")}`,
    );

    record(
      "happy: per-segment audit columns default — waste_type='none', is_recommended=false, user_decision='undecided'",
      segs.every(
        (s) =>
          s.wasteType === "none" &&
          s.isRecommended === false &&
          s.userDecision === "undecided" &&
          s.blurScore === null &&
          s.stabilityScore === null &&
          s.qualityScore === null &&
          s.reason === null &&
          s.thumbnailPath === null &&
          s.previewPath === null,
      ),
      `defaults intact (P9.T7 not yet wired)`,
    );

    // -----------------------------------------------------------------
    // CASE 2: original video bytes byte-for-byte unchanged.
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
    // CASE 3: decode-source preference — when a proxy row + file
    // exist, the worker uses it. We seed a proxy + delete the
    // original from disk: the worker should still succeed (proves
    // ffmpeg consumed the proxy, not the missing original).
    // -----------------------------------------------------------------
    {
      const proxyTrip = tripService.createTrip({ title: "Case3 proxy-preferred" });
      const proxyMediaId = randomUUID();
      const originalPath = `trips/${proxyTrip.id}/originals/${proxyMediaId}.mp4`;
      const nowIso = new Date().toISOString();
      dbHandle.db
        .prepare(
          `INSERT INTO media_items
             (id, trip_id, type, original_path, mime_type, extension, file_size,
              duration, status, user_decision, created_at, updated_at)
           VALUES (?, ?, 'video', ?, 'video/mp4', 'mp4', ?, 12,
                   'processed', 'undecided', ?, ?)`,
        )
        .run(proxyMediaId, proxyTrip.id, originalPath, videoBytes.length, nowIso, nowIso);
      // No original file on disk. Seed a proxy with the real bytes.
      const storedProxy = await storage.putDerived({
        tripId: proxyTrip.id,
        mediaId: proxyMediaId,
        relPath: "video_proxy.mp4",
        data: videoBytes,
        overwrite: true,
      });
      mediaVersionsRepo.upsert({
        mediaId: proxyMediaId,
        versionType: "video_proxy",
        filePath: storedProxy.logicalPath,
        mimeType: "video/mp4",
        width: 320,
        height: 240,
        fileSize: videoBytes.length,
        params: null,
        now: nowIso,
      });
      insertJob(dbHandle.db, proxyMediaId);
      const proxyTick = await tickVideo();
      record(
        "decode-source: proxy-only seed succeeds (no original on disk)",
        proxyTick.finalStatus === "success",
        `finalStatus=${String(proxyTick.finalStatus)}`,
      );
      const proxySegs = videoSegmentsRepo.listByMediaId(proxyMediaId);
      record(
        "decode-source: proxy-only seed produced segments",
        proxySegs.length === 4,
        `proxySegs.length=${proxySegs.length}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 4: idempotency — re-tick produces same segment count, but
    // the OLD per-row UUIDs are gone (replaceAllForMedia uses fresh
    // ids). Old segment files removed from disk.
    // -----------------------------------------------------------------
    {
      const beforeIds = new Set(segs.map((s) => s.id));
      const beforeFilenames = (await readdir(segmentsDir))
        .filter((n) => n.endsWith(".mp4"))
        .sort();
      const jobId2 = insertJob(dbHandle.db, seeded.mediaId);
      const tick2 = await tickVideo();
      record(
        "idempotent: second tick also success",
        tick2.claimed[0]?.id === jobId2 && tick2.finalStatus === "success",
        JSON.stringify(tick2),
      );
      const afterSegs = videoSegmentsRepo.listByMediaId(seeded.mediaId);
      record(
        "idempotent: same segment count after re-tick (no row growth)",
        afterSegs.length === segs.length,
        `before=${segs.length} after=${afterSegs.length}`,
      );
      record(
        "idempotent: every row got a fresh UUID (none of the old ids survive)",
        afterSegs.every((s) => !beforeIds.has(s.id)),
        `afterIds=${afterSegs.map((s) => s.id.slice(0, 8)).join(",")}`,
      );
      const afterFilenames = (await readdir(segmentsDir))
        .filter((n) => n.endsWith(".mp4"))
        .sort();
      record(
        "idempotent: on-disk segment files === new DB rows (old files cleaned up)",
        afterFilenames.length === afterSegs.length &&
          afterSegs.every((s) => afterFilenames.includes(`${s.id}.mp4`)) &&
          // No overlap with previous filenames — old files cleaned up.
          !afterFilenames.some((n) => beforeFilenames.includes(n)),
        `before=${beforeFilenames.join(",")} after=${afterFilenames.join(",")}`,
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
        "image: error_message mentions 'not a video'",
        typeof job?.error_message === "string" &&
          /not a video/.test(job.error_message as string),
        `error_message=${String(job?.error_message)}`,
      );
      record(
        "image: no segments dir leaked onto disk",
        !existsSync(
          path.join(storage.root, `trips/${img.tripId}/derived/${img.mediaId}/segments`),
        ),
        `mediaId=${img.mediaId}`,
      );
      record(
        "image: no video_segments rows written for the non-video media",
        videoSegmentsRepo.listByMediaId(img.mediaId).length === 0,
        `rows=${videoSegmentsRepo.listByMediaId(img.mediaId).length}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 6: soft-deleted media → 'failed' (P7 contract).
    // -----------------------------------------------------------------
    {
      const sdBytes = readFileSync(videoPath);
      const sd = await seedVideoMedia(storage, dbHandle.db, tripService, sdBytes, {
        title: "Case6 soft-deleted",
        duration: 12,
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
      const sdSegmentsDir = path.join(
        storage.root,
        `trips/${sd.tripId}/derived/${sd.mediaId}/segments`,
      );
      record(
        "soft-deleted: no segments dir leaked onto disk",
        !existsSync(sdSegmentsDir),
        sdSegmentsDir,
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
        "unknown: error_message explains rejection (type or no decode source)",
        typeof job?.error_message === "string" &&
          (/not a video/.test(job.error_message as string) ||
            /no decode source/.test(job.error_message as string)),
        `error_message=${String(job?.error_message)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 8: original file missing on disk + no proxy → 'failed'
    // (ffmpeg rejects with "No such file" exit code).
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
          /ffmpeg segments exited/.test(job.error_message as string),
        `error_message=${String(job?.error_message)}`,
      );
      record(
        "ghost-file: no segments rows written",
        videoSegmentsRepo.listByMediaId(ghostMediaId).length === 0,
        `rows=${videoSegmentsRepo.listByMediaId(ghostMediaId).length}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 9: broken / not-a-video file → 'failed'.
    // -----------------------------------------------------------------
    {
      const brokenPath = path.join(tmpRoot, "broken.mp4");
      await writeFile(brokenPath, Buffer.from("not-a-real-mp4-file"));
      const brokenBytes = readFileSync(brokenPath);
      const broken = await seedVideoMedia(storage, dbHandle.db, tripService, brokenBytes, {
        title: "Case9 broken",
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
        "broken: error_message mentions ffmpeg failure or 0 segments",
        typeof job?.error_message === "string" &&
          (/ffmpeg segments exited/.test(job.error_message as string) ||
            /0 segments/.test(job.error_message as string)),
        `error_message=${String(job?.error_message)}`,
      );
      record(
        "broken: no segments rows written",
        videoSegmentsRepo.listByMediaId(broken.mediaId).length === 0,
        `rows=${videoSegmentsRepo.listByMediaId(broken.mediaId).length}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 10: scope-guard — worker does NOT touch media_items
    // columns, does NOT write to media_versions, original bytes intact.
    // -----------------------------------------------------------------
    {
      const cleanBytes = readFileSync(videoPath);
      const clean = await seedVideoMedia(storage, dbHandle.db, tripService, cleanBytes, {
        title: "Case10 scope-guard",
        duration: 12,
      });
      const beforeMedia = readMedia(dbHandle.db, clean.mediaId);
      const beforeOriginalBytes = readFileSync(path.join(storage.root, clean.originalPath));
      const beforeVersionCount = countVersions(dbHandle.db, clean.mediaId);
      insertJob(dbHandle.db, clean.mediaId);
      await tickVideo();
      const afterMedia = readMedia(dbHandle.db, clean.mediaId);
      const afterOriginalBytes = readFileSync(path.join(storage.root, clean.originalPath));
      const afterVersionCount = countVersions(dbHandle.db, clean.mediaId);
      record(
        "scope-guard: media_items columns unchanged (no preview_path / thumbnail_path / status / user_decision / duration / width / height / deleted_at mutations)",
        afterMedia?.preview_path === beforeMedia?.preview_path &&
          afterMedia?.thumbnail_path === beforeMedia?.thumbnail_path &&
          afterMedia?.status === beforeMedia?.status &&
          afterMedia?.user_decision === beforeMedia?.user_decision &&
          afterMedia?.deleted_at === beforeMedia?.deleted_at &&
          afterMedia?.duration === beforeMedia?.duration &&
          afterMedia?.width === beforeMedia?.width &&
          afterMedia?.height === beforeMedia?.height,
        `unchanged columns`,
      );
      record(
        "scope-guard: original video bytes byte-for-byte unchanged",
        beforeOriginalBytes.equals(afterOriginalBytes),
        `before=${beforeOriginalBytes.length}B after=${afterOriginalBytes.length}B`,
      );
      record(
        "scope-guard: no media_versions row was written (segments are in dedicated table)",
        afterVersionCount === beforeVersionCount,
        `before=${beforeVersionCount} after=${afterVersionCount}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 11: per-row CASCADE — hard-deleting the media row removes
    // its video_segments rows automatically (FK ON DELETE CASCADE).
    // -----------------------------------------------------------------
    {
      const fkBytes = readFileSync(videoPath);
      const fk = await seedVideoMedia(storage, dbHandle.db, tripService, fkBytes, {
        title: "Case11 fk-cascade",
        duration: 12,
      });
      insertJob(dbHandle.db, fk.mediaId);
      await tickVideo();
      const before = videoSegmentsRepo.listByMediaId(fk.mediaId).length;
      record("fk-cascade: segments seeded for delete test", before > 0, `count=${before}`);
      dbHandle.db.prepare(`DELETE FROM media_items WHERE id = ?`).run(fk.mediaId);
      const after = videoSegmentsRepo.listByMediaId(fk.mediaId).length;
      record(
        "fk-cascade: hard delete of media_items removed video_segments rows",
        after === 0,
        `before=${before} after=${after}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 12: removing old segments outside the transaction is
    // best-effort — if a file is already gone, the worker logs but
    // does not fail. Emulate by deleting one prior segment file
    // before re-tick.
    // -----------------------------------------------------------------
    {
      const cleanupBytes = readFileSync(videoPath);
      const cleanup = await seedVideoMedia(storage, dbHandle.db, tripService, cleanupBytes, {
        title: "Case12 cleanup-tolerance",
        duration: 12,
      });
      insertJob(dbHandle.db, cleanup.mediaId);
      await tickVideo();
      const firstRows = videoSegmentsRepo.listByMediaId(cleanup.mediaId);
      record(
        "cleanup-tolerance: first run produced rows",
        firstRows.length > 0,
        `count=${firstRows.length}`,
      );
      // Manually delete one of the segment files BEFORE the re-tick.
      const victim = firstRows[0]!;
      const victimAbs = path.join(
        storage.root,
        videoSegmentMp4Path({
          tripId: cleanup.tripId,
          mediaId: cleanup.mediaId,
          segmentId: victim.id,
        }),
      );
      await unlink(victimAbs);
      insertJob(dbHandle.db, cleanup.mediaId);
      const reTick = await tickVideo();
      record(
        "cleanup-tolerance: re-tick succeeds even when one old segment file is already missing",
        reTick.finalStatus === "success",
        `finalStatus=${String(reTick.finalStatus)}`,
      );
      const afterRows = videoSegmentsRepo.listByMediaId(cleanup.mediaId);
      record(
        "cleanup-tolerance: re-tick still produced fresh rows + files",
        afterRows.length === firstRows.length &&
          afterRows.every((s) => !firstRows.some((f) => f.id === s.id)),
        `before=${firstRows.length} after=${afterRows.length}`,
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
