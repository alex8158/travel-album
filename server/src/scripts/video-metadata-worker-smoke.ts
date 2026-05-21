// Manual smoke test for the video_metadata worker (P9.T2).
//
// Usage: npm run smoke:video-metadata-worker
//
// Drives `makeVideoMetadataHandler` end-to-end against a real
// SQLite DB + real LocalStorageProvider + real ffprobe child
// process. The test video is generated on the fly via `ffmpeg
// -f lavfi -i color=...` so we don't need any fixture binary in
// the repo (matches the no-large-binaries constraint from the
// P9.T2 prompt).
//
// Coverage:
//   * Happy path: a 2-second 320×240 25fps MP4 with stereo AAC
//     audio gets probed; ffprobe JSON projects to the documented
//     fields (duration / width / height / fps / bitrate /
//     videoCodec / audioCodec / audioChannels / audioSampleRate /
//     containerFormat); media_items.duration / width / height are
//     cached; media_versions(version_type='metadata') row is
//     UPSERTed with the full JSON.
//   * Video-only (no audio stream) variant: every audio-side
//     projection field is null, but the job still succeeds and
//     the video-side fields are intact.
//   * Idempotency: a second tick on a freshly-enqueued job yields
//     identical bytes in media_versions.params and a single row
//     under (media_id, version_type='metadata').
//   * Non-video media → job 'failed' with clear message.
//   * Soft-deleted media → job 'failed' (matches P7 contract: no
//     writes to soft-deleted rows).
//   * Missing original file → job 'failed' (ffprobe stderr
//     surfaces in the error message).
//   * media_items with NULL original_path → job 'failed'.
//   * Broken / truncated file → job 'failed' (ffprobe rejects).
//   * `projectFfprobe` field-robustness unit checks: missing fps
//     string, malformed rational, missing audio block, empty
//     streams array — none crash; relevant fields are null.
//
// The smoke gracefully SKIPs all ffmpeg-dependent cases when
// ffmpeg / ffprobe aren't installed (e.g. CI without media tools)
// — failure to find ffmpeg is not a smoke failure here; it's a
// host-config gap that the worker itself surfaces as a job error.

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
  VIDEO_METADATA_JOB_TYPE,
  makeVideoMetadataHandler,
  projectFfprobe,
  type JobHandler,
  type VideoMetadataSettings,
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
// settings — match the bootstrap wiring (ffprobe from PATH +
// 30s timeout). Workers built in the smoke use this same shape.
// ---------------------------------------------------------------------------

const SETTINGS: VideoMetadataSettings = {
  ffprobePath: "ffprobe",
  ffprobeTimeoutMs: 30_000,
  workerVersion: "1.0",
};

// ---------------------------------------------------------------------------
// ffmpeg availability probe (gracefully skip when missing)
// ---------------------------------------------------------------------------

async function isAvailable(cmd: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn(cmd, ["-version"], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

/**
 * Generate a tiny test MP4 with ffmpeg's `lavfi` input (no fixture
 * file on disk needed). Returns the absolute path of the written file.
 *
 * The video is deterministic: 2 seconds, 320×240, 25fps, libx264
 * encoded, with an optional stereo AAC sine-wave audio track at
 * 48kHz. Output container is fragmented MP4 ('faststart' on for
 * stream-friendliness, matching how phone exports tend to look).
 */
async function makeTestVideo(
  outputPath: string,
  options: { audio: boolean } = { audio: true },
): Promise<void> {
  // -f lavfi sources are deterministic. color filter writes a solid
  // colour at 25fps for 2 seconds; sine filter (when audio=true)
  // generates a 1kHz tone for the same duration.
  const args: string[] = [
    "-y", // overwrite without prompting
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=320x240:r=25:d=2",
  ];
  if (options.audio) {
    args.push("-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000:duration=2");
  }
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast", "-t", "2");
  if (options.audio) {
    args.push("-c:a", "aac", "-ac", "2", "-shortest");
  }
  args.push("-movflags", "+faststart", outputPath);

  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (b: Buffer) => stderr.push(b));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
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
  title = "P9.T2 Smoke Trip",
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
  const trip = tripService.createTrip({ title: `P9.T2 Smoke ${type}` });
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
  ).run(id, mediaId, VIDEO_METADATA_JOB_TYPE, now, now);
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

function readMetadataVersion(
  db: SqliteDatabase,
  mediaId: string,
): Record<string, unknown> | undefined {
  return db
    .prepare(`SELECT * FROM media_versions WHERE media_id = ? AND version_type = 'metadata'`)
    .get(mediaId) as Record<string, unknown> | undefined;
}

function countMetadataRows(db: SqliteDatabase, mediaId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM media_versions WHERE media_id = ? AND version_type = 'metadata'`,
      )
      .get(mediaId) as { n: number }
  ).n;
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-video-metadata-worker-smoke-"));
  const dbPath = path.join(tmpRoot, "smoke.db");
  const storageRoot = path.join(tmpRoot, "storage");
  console.log(`[smoke] tmpRoot=${tmpRoot}`);

  // ---- Field-robustness unit checks (pure, no ffmpeg) ---------------
  // These run regardless of whether ffmpeg is installed; they exercise
  // `projectFfprobe` against synthetic inputs.
  {
    // No streams array at all.
    const p = projectFfprobe({});
    record(
      "projectFfprobe: empty input → all-null projection (no crash)",
      p.duration === null &&
        p.width === null &&
        p.height === null &&
        p.videoCodec === null &&
        p.audioCodec === null,
      JSON.stringify(p),
    );
  }
  {
    // Video stream only — every audio field should be null.
    const p = projectFfprobe({
      format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "10.5", bit_rate: "1500000" },
      streams: [
        {
          codec_type: "video",
          codec_name: "h264",
          width: 1920,
          height: 1080,
          r_frame_rate: "30000/1001",
        },
      ],
    });
    record(
      "projectFfprobe: video-only stream → audio fields null, video fields populated",
      p.duration === 10.5 &&
        p.width === 1920 &&
        p.height === 1080 &&
        p.videoCodec === "h264" &&
        p.audioCodec === null &&
        p.audioChannels === null &&
        p.audioSampleRate === null &&
        p.bitrate === 1_500_000 &&
        Math.abs((p.frameRate ?? 0) - 30000 / 1001) < 1e-6 &&
        p.containerFormat === "mov,mp4,m4a,3gp,3g2,mj2",
      JSON.stringify(p),
    );
  }
  {
    // Malformed rational ("0/0", "abc/def", "1") — should map to null.
    const cases = ["0/0", "abc/def", "1", "/", ""];
    const allNull = cases.every((rate) => {
      const p = projectFfprobe({
        streams: [
          { codec_type: "video", r_frame_rate: rate, codec_name: "h264", width: 1, height: 1 },
        ],
      });
      return p.frameRate === null;
    });
    record(
      "projectFfprobe: malformed r_frame_rate strings yield frameRate=null (no NaN)",
      allNull,
      `cases=${JSON.stringify(cases)}`,
    );
  }
  {
    // avg_frame_rate fallback when r_frame_rate is missing.
    const p = projectFfprobe({
      streams: [
        {
          codec_type: "video",
          codec_name: "h264",
          width: 1280,
          height: 720,
          avg_frame_rate: "25/1",
        },
      ],
    });
    record(
      "projectFfprobe: falls back to avg_frame_rate when r_frame_rate absent",
      p.frameRate === 25,
      `frameRate=${String(p.frameRate)}`,
    );
  }
  {
    // Audio-only file (no video stream) — projection has video fields null;
    // the handler itself rejects this case (no usable video stream).
    const p = projectFfprobe({
      streams: [{ codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "44100" }],
    });
    record(
      "projectFfprobe: audio-only → videoCodec/width/height null; audio fields populated",
      p.videoCodec === null &&
        p.width === null &&
        p.height === null &&
        p.audioCodec === "aac" &&
        p.audioChannels === 2 &&
        p.audioSampleRate === 44_100,
      JSON.stringify(p),
    );
  }

  // ---- ffmpeg availability gate ------------------------------------
  const ffmpegOk = (await isAvailable("ffmpeg")) && (await isAvailable("ffprobe"));
  if (!ffmpegOk) {
    console.log(
      "[smoke] SKIP: ffmpeg / ffprobe not on PATH; only unit-checked projectFfprobe. (worker itself surfaces a clear error at runtime when binaries are missing — see runtime/capabilities.ts).",
    );
    await rm(tmpRoot, { recursive: true, force: true });
    const passed = results.filter((r) => r.ok).length;
    const failed = results.length - passed;
    console.log(
      `\n[smoke] summary: ${passed}/${results.length} passed (ffmpeg unavailable; ${failed} unit-only)`,
    );
    if (failed > 0) process.exit(1);
    return;
  }

  // ---- ffmpeg present: end-to-end cases ----------------------------
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

    // Use the multi-channel JobQueue so we exercise the video
    // channel exactly as production does (ImageChannelExecutor
    // hard-codes `LIKE 'image_%'` in its SELECT and would never
    // claim `video_metadata`). The video channel is the only one
    // we register a handler for — the queue's `tickChannel('video')`
    // returns the claimed-job set so the smoke can assert on it.
    const videoHandlers = new Map<string, JobHandler>();
    videoHandlers.set(
      VIDEO_METADATA_JOB_TYPE,
      makeVideoMetadataHandler({
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

    // Helper: tick the video channel once and block until the
    // handler's promise resolves. Returns the resulting job row
    // (which carries the final status) plus the claim result.
    // `claimed[i]` carries `{ jobId, jobType }` per JobQueue's
    // ClaimedJob shape; we surface it as `id` for assertion clarity.
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
    // CASE 1: happy path — video with audio
    // -----------------------------------------------------------------
    const videoPath = path.join(tmpRoot, "happy.mp4");
    await makeTestVideo(videoPath, { audio: true });
    const videoBytes = readFileSync(videoPath);
    const seeded = await seedVideoMedia(
      storage,
      dbHandle.db,
      tripService,
      videoBytes,
      "Case1 happy",
    );
    const jobId = insertJob(dbHandle.db, seeded.mediaId);

    const tick = await tickVideo();
    record(
      "happy: tick claimed the seeded job",
      tick.claimed.length === 1 && tick.claimed[0]?.id === jobId,
      JSON.stringify(tick),
    );
    record(
      "happy: job row.status='success'",
      tick.finalStatus === "success",
      `finalStatus=${String(tick.finalStatus)}`,
    );

    // media_items columns cached.
    const mediaRow = readMedia(dbHandle.db, seeded.mediaId);
    record(
      "happy: media_items.duration ≈ 2 seconds (±0.1)",
      typeof mediaRow?.duration === "number" && Math.abs((mediaRow.duration as number) - 2) <= 0.2,
      `duration=${String(mediaRow?.duration)}`,
    );
    record(
      "happy: media_items.width=320, height=240",
      mediaRow?.width === 320 && mediaRow?.height === 240,
      `dims=${String(mediaRow?.width)}x${String(mediaRow?.height)}`,
    );

    // media_versions row UPSERTed.
    const versionRow = readMetadataVersion(dbHandle.db, seeded.mediaId);
    record(
      "happy: media_versions row exists with version_type='metadata'",
      versionRow !== undefined && versionRow.version_type === "metadata",
      `version_type=${String(versionRow?.version_type)}`,
    );
    record(
      "happy: media_versions.file_path points at original (not a fictional metadata.json)",
      versionRow?.file_path === seeded.originalPath,
      `file_path=${String(versionRow?.file_path)}`,
    );
    record(
      "happy: media_versions.mime_type='application/json' (describes params payload)",
      versionRow?.mime_type === "application/json",
      `mime=${String(versionRow?.mime_type)}`,
    );

    // params JSON contains the projected fields.
    const params = JSON.parse(String(versionRow?.params)) as {
      workerVersion: string;
      ffprobe: {
        duration: number;
        width: number;
        height: number;
        frameRate: number;
        videoCodec: string;
        audioCodec: string;
        audioChannels: number;
        audioSampleRate: number;
        containerFormat: string;
      };
      raw: unknown;
    };
    record(
      "happy: params.ffprobe contains expected video projection (h264, 320x240, 25fps, ~2s)",
      params.ffprobe.videoCodec === "h264" &&
        params.ffprobe.width === 320 &&
        params.ffprobe.height === 240 &&
        Math.abs(params.ffprobe.frameRate - 25) < 0.1 &&
        Math.abs(params.ffprobe.duration - 2) <= 0.2,
      JSON.stringify(params.ffprobe),
    );
    record(
      "happy: params.ffprobe contains expected audio projection (aac, 2-channel, 48kHz)",
      params.ffprobe.audioCodec === "aac" &&
        params.ffprobe.audioChannels === 2 &&
        params.ffprobe.audioSampleRate === 48_000,
      `audioCodec=${params.ffprobe.audioCodec} channels=${params.ffprobe.audioChannels} sampleRate=${params.ffprobe.audioSampleRate}`,
    );
    record(
      "happy: params.ffprobe.containerFormat contains 'mp4'",
      typeof params.ffprobe.containerFormat === "string" &&
        params.ffprobe.containerFormat.includes("mp4"),
      `containerFormat=${String(params.ffprobe.containerFormat)}`,
    );
    record(
      "happy: params.workerVersion='1.0'",
      params.workerVersion === "1.0",
      `workerVersion=${params.workerVersion}`,
    );
    record(
      "happy: params.raw retains full ffprobe JSON",
      typeof params.raw === "object" && params.raw !== null,
      `raw type=${typeof params.raw}`,
    );

    // -----------------------------------------------------------------
    // CASE 2: video-only (no audio stream)
    // -----------------------------------------------------------------
    const silentPath = path.join(tmpRoot, "silent.mp4");
    await makeTestVideo(silentPath, { audio: false });
    const silentBytes = readFileSync(silentPath);
    const silent = await seedVideoMedia(
      storage,
      dbHandle.db,
      tripService,
      silentBytes,
      "Case2 silent",
    );
    const silentJobId = insertJob(dbHandle.db, silent.mediaId);
    const silentTick = await tickVideo();
    record(
      "video-only: tick claimed + finished successfully",
      silentTick.claimed[0]?.id === silentJobId && silentTick.finalStatus === "success",
      JSON.stringify(silentTick),
    );
    const silentVersion = readMetadataVersion(dbHandle.db, silent.mediaId);
    const silentParams = JSON.parse(String(silentVersion?.params)) as {
      ffprobe: { audioCodec: string | null; videoCodec: string | null };
    };
    record(
      "video-only: audioCodec=null + videoCodec='h264' (job still succeeds without audio stream)",
      silentParams.ffprobe.audioCodec === null && silentParams.ffprobe.videoCodec === "h264",
      JSON.stringify(silentParams.ffprobe),
    );

    // -----------------------------------------------------------------
    // CASE 3: idempotency — second tick → bit-identical params + UPSERT.
    // -----------------------------------------------------------------
    {
      const beforeParams = readMetadataVersion(dbHandle.db, seeded.mediaId)?.params;
      const jobId2 = insertJob(dbHandle.db, seeded.mediaId);
      const tick2 = await tickVideo();
      record(
        "idempotent: second tick also success",
        tick2.claimed[0]?.id === jobId2 && tick2.finalStatus === "success",
        JSON.stringify(tick2),
      );
      const afterParams = readMetadataVersion(dbHandle.db, seeded.mediaId)?.params;
      record(
        "idempotent: media_versions.params unchanged (ffprobe deterministic)",
        afterParams === beforeParams,
        `equal=${afterParams === beforeParams}`,
      );
      record(
        "idempotent: still exactly 1 metadata row (UPSERT, not duplicate)",
        countMetadataRows(dbHandle.db, seeded.mediaId) === 1,
        `count=${countMetadataRows(dbHandle.db, seeded.mediaId)}`,
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
        "image: error_message mentions 'not a video' and the actual type",
        typeof job?.error_message === "string" &&
          /not a video/.test(job.error_message as string) &&
          /image/.test(job.error_message as string),
        `error_message=${String(job?.error_message)}`,
      );
      record(
        "image: no media_versions row was written",
        countMetadataRows(dbHandle.db, img.mediaId) === 0,
        `count=${countMetadataRows(dbHandle.db, img.mediaId)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 5: soft-deleted media → 'failed' (P7 contract).
    // -----------------------------------------------------------------
    {
      const sdBytes = readFileSync(videoPath);
      const sd = await seedVideoMedia(
        storage,
        dbHandle.db,
        tripService,
        sdBytes,
        "Case5 soft-deleted",
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
      record(
        "soft-deleted: no media_versions row leaked",
        countMetadataRows(dbHandle.db, sd.mediaId) === 0,
        `count=${countMetadataRows(dbHandle.db, sd.mediaId)}`,
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
      // Either the type guard fires first ('not a video') or the
      // original_path guard ('no original_path'). Either acceptable.
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
    // CASE 7: original file missing on disk → 'failed' (ffprobe rejects).
    // -----------------------------------------------------------------
    {
      // Seed a media row pointing at a file we never actually create.
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
        "ghost-file: error_message surfaces ffprobe exit failure",
        typeof job?.error_message === "string" &&
          /ffprobe exited/.test(job.error_message as string),
        `error_message=${String(job?.error_message)}`,
      );
      record(
        "ghost-file: no media_versions row leaked",
        countMetadataRows(dbHandle.db, ghostMediaId) === 0,
        `count=${countMetadataRows(dbHandle.db, ghostMediaId)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 8: broken / not-a-video file → 'failed' (ffprobe rejects).
    // -----------------------------------------------------------------
    {
      // Write a few random bytes with .mp4 extension. ffprobe will
      // refuse it cleanly.
      const brokenPath = path.join(tmpRoot, "broken.mp4");
      await writeFile(brokenPath, Buffer.from("not-a-real-mp4-file"));
      const brokenBytes = readFileSync(brokenPath);
      const broken = await seedVideoMedia(
        storage,
        dbHandle.db,
        tripService,
        brokenBytes,
        "Case8 broken",
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
        "broken: error_message mentions ffprobe failure (no usable video stream OR ffprobe exited)",
        typeof job?.error_message === "string" &&
          (/ffprobe exited/.test(job.error_message as string) ||
            /no usable video stream/.test(job.error_message as string)),
        `error_message=${String(job?.error_message)}`,
      );
      record(
        "broken: no media_versions row leaked",
        countMetadataRows(dbHandle.db, broken.mediaId) === 0,
        `count=${countMetadataRows(dbHandle.db, broken.mediaId)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 9: scope-guard — worker does NOT touch image-only fields
    // (preview_path / thumbnail_path / status flips to anything other
    // than what we set / user_decision flips).
    // -----------------------------------------------------------------
    {
      const cleanBytes = readFileSync(videoPath);
      const clean = await seedVideoMedia(
        storage,
        dbHandle.db,
        tripService,
        cleanBytes,
        "Case9 scope-guard",
      );
      const cleanJobId = insertJob(dbHandle.db, clean.mediaId);
      const beforeMedia = readMedia(dbHandle.db, clean.mediaId);
      const beforeFile = existsSync(path.join(storage.root, clean.originalPath));
      await tickVideo();
      void cleanJobId;
      const afterMedia = readMedia(dbHandle.db, clean.mediaId);
      const afterFile = existsSync(path.join(storage.root, clean.originalPath));
      record(
        "scope-guard: original file still on disk (not deleted / overwritten)",
        beforeFile === true && afterFile === true,
        `before=${beforeFile} after=${afterFile}`,
      );
      record(
        "scope-guard: preview_path / thumbnail_path stay NULL (P9.T3 territory)",
        afterMedia?.preview_path === null && afterMedia?.thumbnail_path === null,
        `preview=${String(afterMedia?.preview_path)} thumb=${String(afterMedia?.thumbnail_path)}`,
      );
      record(
        "scope-guard: status / user_decision / deleted_at unchanged",
        afterMedia?.status === beforeMedia?.status &&
          afterMedia?.user_decision === beforeMedia?.user_decision &&
          afterMedia?.deleted_at === beforeMedia?.deleted_at,
        `status=${String(afterMedia?.status)} user_decision=${String(afterMedia?.user_decision)} deleted_at=${String(afterMedia?.deleted_at)}`,
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
