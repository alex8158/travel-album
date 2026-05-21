// Manual smoke test for the video_keyframes worker (P9.T5).
//
// Usage: npm run smoke:video-keyframes-worker
//
// Drives `makeVideoKeyframesHandler` end-to-end against a real
// SQLite DB + real LocalStorageProvider + real ffmpeg + sharp.
// The test video is generated on the fly via `ffmpeg -f lavfi`
// (deterministic testsrc pattern) so no fixture binary needs to
// land in the repo.
//
// Coverage:
//   * `computeEffectiveInterval` pure-function unit checks:
//       - null / 0 / negative / non-finite duration → configured
//       - estimated ≤ maxFrames → configured
//       - estimated > maxFrames → stretched evenly
//       - degenerate inputs (maxFrames=0, intervalSec=0) safe
//   * Happy path: 6-second testsrc at intervalSec=2 →
//     ~3 frames, manifest.json written, each frame is a real
//     JPEG with positive dims, manifest entries map 1:1 to
//     emitted files.
//   * Decode-source preference: when a `video_proxy` row exists +
//     file is present, the manifest records decodeSource='proxy'.
//   * Decode-source fallback: no proxy row → decodeSource='original'.
//   * Long-source cap: short test video at intervalSec=0.5 with
//     maxFrames=2 → effective interval stretches to keep frames ≤ 2.
//   * Idempotency: a re-tick produces the same frame count + the
//     manifest enumerates the same set of file paths.
//   * Non-video media → 'failed' with clear message.
//   * Soft-deleted media → 'failed' (P7 contract).
//   * Missing original file (and no proxy) → 'failed' (ffmpeg
//     rejects).
//   * Broken / not-a-video file → 'failed' (ffmpeg rejects).
//   * Scope-guard: worker does NOT touch media_items columns or
//     write to media_versions; original bytes byte-for-byte
//     unchanged.
//
// Gracefully SKIPs ffmpeg-dependent cases when ffmpeg isn't on
// PATH (also passes the pure-function unit checks regardless).

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { DuplicateGroupsRepository } from "../dedup/index.js";
import {
  JobQueue,
  JobRepository,
  VIDEO_KEYFRAMES_JOB_TYPE,
  computeEffectiveInterval,
  makeVideoKeyframesHandler,
  type JobHandler,
  type KeyframeManifest,
  type VideoKeyframesSettings,
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
// settings — match production wiring (lower timeout for smoke so a
// stuck encode fails the test instead of hanging CI for 5 min).
// ---------------------------------------------------------------------------

const SETTINGS: VideoKeyframesSettings = {
  ffmpegPath: "ffmpeg",
  timeoutMs: 60_000,
  intervalSec: 2,
  maxFrames: 200,
  jpegQuality: 2,
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
 * 6 seconds, 320×240, 25fps, no audio — long enough to verify
 * multiple keyframes at intervalSec=2 (expects 3 at t=0/2/4).
 */
async function makeTestVideo(
  outputPath: string,
  options: { durationSec: number; width: number; height: number } = {
    durationSec: 6,
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
  const trip = tripService.createTrip({ title: options.title ?? "P9.T5 Smoke Trip" });
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
  const trip = tripService.createTrip({ title: `P9.T5 Smoke ${type}` });
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
  ).run(id, mediaId, VIDEO_KEYFRAMES_JOB_TYPE, now, now);
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

async function readManifest(
  storage: LocalStorageProvider,
  tripId: string,
  mediaId: string,
): Promise<KeyframeManifest> {
  const manifestPath = path.join(
    storage.root,
    `trips/${tripId}/derived/${mediaId}/frames/manifest.json`,
  );
  const raw = await readFile(manifestPath, "utf8");
  return JSON.parse(raw) as KeyframeManifest;
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // ---- computeEffectiveInterval pure-function unit checks ----
  {
    record(
      "computeEffectiveInterval: null duration → configured",
      computeEffectiveInterval(null, 2, 200) === 2,
      `result=${computeEffectiveInterval(null, 2, 200)}`,
    );
    record(
      "computeEffectiveInterval: 0 duration → configured",
      computeEffectiveInterval(0, 2, 200) === 2,
      `result=${computeEffectiveInterval(0, 2, 200)}`,
    );
    record(
      "computeEffectiveInterval: negative duration → configured",
      computeEffectiveInterval(-5, 2, 200) === 2,
      `result=${computeEffectiveInterval(-5, 2, 200)}`,
    );
    record(
      "computeEffectiveInterval: NaN / Infinity → configured",
      computeEffectiveInterval(NaN, 2, 200) === 2 &&
        computeEffectiveInterval(Infinity, 2, 200) === 2,
      `NaN=${computeEffectiveInterval(NaN, 2, 200)} Inf=${computeEffectiveInterval(Infinity, 2, 200)}`,
    );
    record(
      "computeEffectiveInterval: 10s @ interval=2 cap=200 → configured (5 frames ≤ 200)",
      computeEffectiveInterval(10, 2, 200) === 2,
      `result=${computeEffectiveInterval(10, 2, 200)}`,
    );
    record(
      "computeEffectiveInterval: 3600s @ interval=2 cap=200 → stretched to 18s",
      computeEffectiveInterval(3600, 2, 200) === 18,
      `result=${computeEffectiveInterval(3600, 2, 200)}`,
    );
    record(
      "computeEffectiveInterval: 10s @ interval=0.5 cap=2 → stretched to 5s",
      computeEffectiveInterval(10, 0.5, 2) === 5,
      `result=${computeEffectiveInterval(10, 0.5, 2)}`,
    );
    record(
      "computeEffectiveInterval: maxFrames=0 → configured (degenerate)",
      computeEffectiveInterval(10, 2, 0) === 2,
      `result=${computeEffectiveInterval(10, 2, 0)}`,
    );
    record(
      "computeEffectiveInterval: configured=0 → configured (degenerate)",
      computeEffectiveInterval(10, 0, 200) === 0,
      `result=${computeEffectiveInterval(10, 0, 200)}`,
    );
  }

  // ---- ffmpeg availability gate ----
  const ffmpegOk = await isAvailable("ffmpeg");
  if (!ffmpegOk) {
    console.log("[smoke] SKIP: ffmpeg not on PATH; only pure-function unit checks ran.");
    const passed = results.filter((r) => r.ok).length;
    const failed = results.length - passed;
    console.log(`\n[smoke] summary: ${passed}/${results.length} passed (ffmpeg unavailable)`);
    if (failed > 0) process.exit(1);
    return;
  }

  // ---- ffmpeg present: end-to-end cases ----
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-video-keyframes-worker-smoke-"));
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
      VIDEO_KEYFRAMES_JOB_TYPE,
      makeVideoKeyframesHandler({
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
    // CASE 1: happy path — 6s testsrc @ intervalSec=2, no proxy.
    // Expect 3 frames at t=0, 2, 4 with decodeSource='original'.
    // -----------------------------------------------------------------
    const videoPath = path.join(tmpRoot, "happy.mp4");
    await makeTestVideo(videoPath, { durationSec: 6, width: 320, height: 240 });
    const videoBytes = readFileSync(videoPath);
    const seeded = await seedVideoMedia(storage, dbHandle.db, tripService, videoBytes, {
      title: "Case1 happy",
      duration: 6,
    });
    const jobId = insertJob(dbHandle.db, seeded.mediaId);

    const tick = await tickVideo();
    record(
      "happy: tick claimed the seeded video_keyframes job",
      tick.claimed.length === 1 && tick.claimed[0]?.id === jobId,
      JSON.stringify(tick),
    );
    record(
      "happy: job row.status='success'",
      tick.finalStatus === "success",
      `finalStatus=${String(tick.finalStatus)}`,
    );

    // Manifest exists and parses.
    const manifest = await readManifest(storage, seeded.tripId, seeded.mediaId);
    record(
      "happy: manifest.json present + parseable",
      typeof manifest.frameCount === "number" && Array.isArray(manifest.frames),
      `frameCount=${manifest.frameCount}`,
    );
    record(
      "happy: manifest.frameCount === manifest.frames.length",
      manifest.frameCount === manifest.frames.length && manifest.frameCount >= 2,
      `frameCount=${manifest.frameCount} framesLen=${manifest.frames.length}`,
    );
    record(
      "happy: 6s clip @ intervalSec=2 → 3 frames (t=0, 2, 4)",
      manifest.frameCount === 3,
      `frameCount=${manifest.frameCount}`,
    );
    record(
      "happy: manifest records configuredIntervalSec=2 + effective=2 (no cap engaged)",
      manifest.configuredIntervalSec === 2 && manifest.intervalSec === 2,
      `cfg=${manifest.configuredIntervalSec} eff=${manifest.intervalSec}`,
    );
    record(
      "happy: manifest records decodeSource='original' (no proxy seeded)",
      manifest.decodeSource === "original" && manifest.decodeSourcePath === seeded.originalPath,
      `decodeSource=${manifest.decodeSource} path=${manifest.decodeSourcePath}`,
    );
    record(
      "happy: frames timestamps map to (index-1) * interval",
      manifest.frames.every((f, i) => f.timestampSec === i * 2 && f.index === i + 1),
      `timestamps=${manifest.frames.map((f) => f.timestampSec).join(",")}`,
    );

    // Each frame is a real JPEG on disk + matches manifest dims.
    for (const entry of manifest.frames) {
      const abs = path.join(storage.root, entry.filePath);
      const bytes = readFileSync(abs);
      const meta = await sharp(bytes).metadata();
      if (
        meta.format !== "jpeg" ||
        meta.width !== entry.width ||
        meta.height !== entry.height ||
        bytes.length !== entry.fileSize
      ) {
        record(
          `happy: frame ${entry.index} integrity FAIL`,
          false,
          `format=${meta.format} w=${meta.width} h=${meta.height} bytes=${bytes.length} entry=${JSON.stringify(entry)}`,
        );
      }
    }
    record(
      "happy: every manifest frame is a valid JPEG + matches recorded dims/size",
      manifest.frames.every((entry) => {
        const abs = path.join(storage.root, entry.filePath);
        if (!existsSync(abs)) return false;
        const bytes = readFileSync(abs);
        return bytes.length === entry.fileSize;
      }),
      `frames=${manifest.frames.length}`,
    );

    // Filenames follow `frame_NNNNNN.jpg` pattern.
    record(
      "happy: all frame filenames follow frame_NNNNNN.jpg pattern",
      manifest.frames.every((f) => /\/frames\/frame_\d{6}\.jpg$/.test(f.filePath)),
      `paths=${manifest.frames.map((f) => f.filePath).join(", ")}`,
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
    // exist, the worker uses it. We seed a "fake proxy" file (a copy
    // of the original) + manually insert a media_versions row.
    // -----------------------------------------------------------------
    {
      const proxyTrip = tripService.createTrip({ title: "Case3 proxy-preferred" });
      const proxyMediaId = randomUUID();
      const proxyBytes = readFileSync(videoPath);
      const storedOriginal = await storage.putOriginal({
        tripId: proxyTrip.id,
        mediaId: proxyMediaId,
        extension: "mp4",
        data: proxyBytes,
      });
      const nowIso = new Date().toISOString();
      dbHandle.db
        .prepare(
          `INSERT INTO media_items
             (id, trip_id, type, original_path, mime_type, extension, file_size,
              duration, status, user_decision, created_at, updated_at)
           VALUES (?, ?, 'video', ?, 'video/mp4', 'mp4', ?, 6,
                   'processed', 'undecided', ?, ?)`,
        )
        .run(
          proxyMediaId,
          proxyTrip.id,
          storedOriginal.logicalPath,
          proxyBytes.length,
          nowIso,
          nowIso,
        );
      // Seed a fake video_proxy entry — using the SAME bytes as the
      // original (the worker only cares that the file exists + is
      // probeable, not that it's a "real" downscaled proxy).
      const storedProxy = await storage.putDerived({
        tripId: proxyTrip.id,
        mediaId: proxyMediaId,
        relPath: "video_proxy.mp4",
        data: proxyBytes,
        overwrite: true,
      });
      mediaVersionsRepo.upsert({
        mediaId: proxyMediaId,
        versionType: "video_proxy",
        filePath: storedProxy.logicalPath,
        mimeType: "video/mp4",
        width: 320,
        height: 240,
        fileSize: proxyBytes.length,
        params: null,
        now: nowIso,
      });
      insertJob(dbHandle.db, proxyMediaId);
      await tickVideo();
      const proxyManifest = await readManifest(storage, proxyTrip.id, proxyMediaId);
      record(
        "decode-source: manifest records decodeSource='proxy' + path = proxy logical",
        proxyManifest.decodeSource === "proxy" &&
          proxyManifest.decodeSourcePath === storedProxy.logicalPath,
        `decodeSource=${proxyManifest.decodeSource} path=${proxyManifest.decodeSourcePath}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 4: long-source cap. Configure maxFrames=2 against a 6s
    // clip with intervalSec=0.5 (would emit 12 frames without cap).
    // Effective interval should stretch to 3s → 2 frames.
    // -----------------------------------------------------------------
    {
      const capRoot = await mkdtemp(path.join(tmpdir(), "tas-vk-cap-"));
      try {
        const capStorage = LocalStorageProvider.create(path.join(capRoot, "storage"));
        const capDb = openDatabase(path.join(capRoot, "cap.db"));
        try {
          runMigrations(capDb.db);
          const capTripRepo = new TripRepository(capDb.db);
          const capTripService = new TripService(capTripRepo);
          const capMediaRepo = new MediaRepository(capDb.db);
          const capVersionsRepo = new MediaVersionsRepository(capDb.db);
          const capJobRepo = new JobRepository(capDb.db);
          const capHandlers = new Map<string, JobHandler>();
          capHandlers.set(
            VIDEO_KEYFRAMES_JOB_TYPE,
            makeVideoKeyframesHandler({
              storage: capStorage,
              mediaRepo: capMediaRepo,
              mediaVersionsRepo: capVersionsRepo,
              settings: { ...SETTINGS, intervalSec: 0.5, maxFrames: 2 },
              logger,
            }),
          );
          const capQueue = new JobQueue({
            jobRepo: capJobRepo,
            logger,
            channels: [
              { name: "image", concurrency: 1, handlers: new Map(), pollIntervalMs: 60_000 },
              { name: "video", concurrency: 1, handlers: capHandlers, pollIntervalMs: 60_000 },
              { name: "ai", concurrency: 1, handlers: new Map(), pollIntervalMs: 60_000 },
            ],
            zombieTimeoutMs: 0,
          });
          const capSeed = await seedVideoMedia(capStorage, capDb.db, capTripService, videoBytes, {
            title: "Case4 cap",
            duration: 6,
          });
          insertJob(capDb.db, capSeed.mediaId);
          const capTick = await capQueue.tickChannel("video");
          await capQueue.awaitInflight("video");
          record(
            "cap: tick succeeded with maxFrames=2 cap",
            capTick.claimed.length === 1 &&
              (
                capDb.db
                  .prepare(`SELECT status FROM processing_jobs WHERE id = ?`)
                  .get(capTick.claimed[0]!.jobId) as { status: string }
              ).status === "success",
            JSON.stringify(capTick.claimed),
          );
          const capManifest = await readManifest(capStorage, capSeed.tripId, capSeed.mediaId);
          record(
            "cap: effective interval stretched to 3s (6s / 2 frames)",
            capManifest.intervalSec === 3 && capManifest.configuredIntervalSec === 0.5,
            `eff=${capManifest.intervalSec} cfg=${capManifest.configuredIntervalSec}`,
          );
          record(
            "cap: frameCount ≤ maxFrames (2)",
            capManifest.frameCount <= 2 && capManifest.frameCount >= 1,
            `frameCount=${capManifest.frameCount} maxFrames=${capManifest.maxFrames}`,
          );
        } finally {
          closeDatabase(capDb);
        }
      } finally {
        await rm(capRoot, { recursive: true, force: true });
      }
    }

    // -----------------------------------------------------------------
    // CASE 5: idempotency — re-tick produces the same frame count
    // and the manifest enumerates the same set of file paths.
    // -----------------------------------------------------------------
    {
      const beforeCount = manifest.frameCount;
      const beforePaths = manifest.frames.map((f) => f.filePath).sort();
      const jobId2 = insertJob(dbHandle.db, seeded.mediaId);
      const tick2 = await tickVideo();
      record(
        "idempotent: second tick also success",
        tick2.claimed[0]?.id === jobId2 && tick2.finalStatus === "success",
        JSON.stringify(tick2),
      );
      const reManifest = await readManifest(storage, seeded.tripId, seeded.mediaId);
      const afterPaths = reManifest.frames.map((f) => f.filePath).sort();
      record(
        "idempotent: same frameCount + same file paths after re-tick",
        reManifest.frameCount === beforeCount &&
          JSON.stringify(afterPaths) === JSON.stringify(beforePaths),
        `before=${beforeCount} after=${reManifest.frameCount}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 6: non-video media → 'failed' with clear message.
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
    }

    // -----------------------------------------------------------------
    // CASE 7: soft-deleted media → 'failed' (P7 contract).
    // -----------------------------------------------------------------
    {
      const sdBytes = readFileSync(videoPath);
      const sd = await seedVideoMedia(storage, dbHandle.db, tripService, sdBytes, {
        title: "Case7 soft-deleted",
        duration: 6,
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
      const sdFramesDir = path.join(
        storage.root,
        `trips/${sd.tripId}/derived/${sd.mediaId}/frames`,
      );
      record("soft-deleted: no frames dir leaked onto disk", !existsSync(sdFramesDir), sdFramesDir);
    }

    // -----------------------------------------------------------------
    // CASE 8: unknown-type media (NULL original_path) → 'failed'.
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
            /no decode source/.test(job.error_message as string)),
        `error_message=${String(job?.error_message)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 9: original file missing on disk → 'failed' (ffmpeg
    // rejects with "No such file" exit code).
    // -----------------------------------------------------------------
    {
      const ghostTrip = tripService.createTrip({ title: "Case9 ghost file" });
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
          /ffmpeg keyframes exited/.test(job.error_message as string),
        `error_message=${String(job?.error_message)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 10: broken / not-a-video file → 'failed'.
    // -----------------------------------------------------------------
    {
      const brokenPath = path.join(tmpRoot, "broken.mp4");
      await writeFile(brokenPath, Buffer.from("not-a-real-mp4-file"));
      const brokenBytes = readFileSync(brokenPath);
      const broken = await seedVideoMedia(storage, dbHandle.db, tripService, brokenBytes, {
        title: "Case10 broken",
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
        "broken: error_message mentions ffmpeg failure or 0 keyframes",
        typeof job?.error_message === "string" &&
          (/ffmpeg keyframes exited/.test(job.error_message as string) ||
            /0 keyframes/.test(job.error_message as string)),
        `error_message=${String(job?.error_message)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 11: scope-guard — worker does NOT touch media_items
    // columns, does NOT write to media_versions, original bytes
    // byte-for-byte intact.
    // -----------------------------------------------------------------
    {
      const cleanBytes = readFileSync(videoPath);
      const clean = await seedVideoMedia(storage, dbHandle.db, tripService, cleanBytes, {
        title: "Case11 scope-guard",
        duration: 6,
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
        "scope-guard: no media_versions row was written (keyframes are disk-only per R-104)",
        afterVersionCount === beforeVersionCount,
        `before=${beforeVersionCount} after=${afterVersionCount}`,
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
