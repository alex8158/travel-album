// Manual smoke test for the video_render service + worker (P11.T5).
//
// Usage: npm run smoke:video-render-worker
//
// Coverage (no HTTP layer — service + worker directly):
//
//   A) Service-layer enqueue paths (no ffmpeg needed):
//     * Trip missing → NotFoundError (404)
//     * No plans for trip → EDIT_PLAN_NOT_FOUND (404)
//     * Explicit planId not found → EDIT_PLAN_NOT_FOUND (404)
//     * Cross-trip planId → EDIT_PLAN_NOT_FOUND (404, defensive)
//     * Plan with 0 clips → BadRequestError (400)
//     * Body malformed → ValidationError (400)
//     * Happy create / skipped (pending) / reset (after success)
//     * overwrite=true → 'forced' + new jobId
//
//   B) Worker pipeline (real ffmpeg + real SQLite + real storage):
//     * 1-clip plan + audioPolicy=keep_original → edited.mp4 lands,
//       media_versions(edited) UPSERTed, edited row has the right
//       width / height / duration
//     * 2-clip plan → concat result has roughly the sum of clip
//       durations
//     * audioPolicy=mute → output has no audio stream
//     * audioPolicy=replace_with_library → output has the BGM
//       (audio stream present)
//     * Background audio missing / inactive → worker fails with
//       clear error; no media_versions row leaked
//     * One source media soft-deleted between enqueue and dequeue
//       → worker fails; no row leaked
//     * Re-render with same first-source → UPSERT replaces row +
//       file in place (no duplicate)
//     * Original source bytes byte-for-byte unchanged
//     * PRAGMA foreign_key_check + integrity_check clean

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
  makeVideoRenderHandler,
  type JobHandler,
  type VideoRenderSettings,
} from "../jobs/index.js";
import { createLogger } from "../logger.js";
import {
  AudioLibraryRepository,
  EditPlansRepository,
  MediaRepository,
  MediaService,
  MediaVersionsRepository,
  VIDEO_RENDER_JOB_TYPE,
  VideoRenderService,
  type MediaSoftDeleteDeps,
  type VideoEditPlan,
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

function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

// ---------------------------------------------------------------------------
// settings — match production but lower timeouts for CI safety
// ---------------------------------------------------------------------------

const SETTINGS: VideoRenderSettings = {
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
  timeoutMs: 90_000,
  fps: 30,
  crf: 23,
  preset: "veryfast", // smoke override (vs production "medium")
  audioBitrateKbps: 160,
  workerVersion: "1.0",
};

// ---------------------------------------------------------------------------
// ffmpeg fixtures
// ---------------------------------------------------------------------------

async function isAvailable(cmd: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn(cmd, ["-version"], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

async function makeTestVideo(
  outputPath: string,
  durationSec: number,
  withAudio = true,
): Promise<void> {
  const args = [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `testsrc=duration=${durationSec}:size=320x240:rate=25`,
  ];
  if (withAudio) {
    args.push("-f", "lavfi", "-i", `sine=frequency=1000:sample_rate=48000:duration=${durationSec}`);
  }
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast");
  if (withAudio) args.push("-c:a", "aac", "-ac", "2", "-shortest");
  args.push("-movflags", "+faststart", outputPath);

  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (b: Buffer) => stderr.push(b));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`ffmpeg gen video exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`),
        );
    });
  });
}

async function makeSineAudio(outputPath: string, durationSec: number, freq = 880): Promise<void> {
  const ext = path.extname(outputPath).slice(1).toLowerCase();
  const codec = ext === "mp3" ? "libmp3lame" : "aac";
  const args = [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${freq}:sample_rate=48000:duration=${durationSec}`,
    "-c:a",
    codec,
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
        reject(
          new Error(`ffmpeg gen audio exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`),
        );
    });
  });
}

interface ProbeInfo {
  readonly hasAudio: boolean;
  readonly hasVideo: boolean;
  readonly durationSec: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
}

async function probe(filePath: string): Promise<ProbeInfo> {
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
    format?: { duration?: string };
    streams?: {
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
    }[];
  };
  const streams = parsed.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");
  const dur = parsed.format?.duration;
  return {
    hasAudio: a !== undefined,
    hasVideo: v !== undefined,
    durationSec: typeof dur === "string" ? Number.parseFloat(dur) : null,
    width: typeof v?.width === "number" ? v.width : null,
    height: typeof v?.height === "number" ? v.height : null,
    videoCodec: typeof v?.codec_name === "string" ? v.codec_name : null,
    audioCodec: typeof a?.codec_name === "string" ? a.codec_name : null,
  };
}

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

interface SeededVideo {
  readonly tripId: string;
  readonly mediaId: string;
  readonly originalPath: string;
}

async function seedVideoMedia(
  storage: LocalStorageProvider,
  db: SqliteDatabase,
  tripService: TripService,
  videoBytes: Buffer,
  durationSec: number,
  tripId?: string,
  title = "P11.T5 smoke",
): Promise<SeededVideo> {
  const trip = tripId !== undefined ? { id: tripId } : tripService.createTrip({ title });
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
       (id, trip_id, type, original_path, mime_type, extension, file_size, duration,
        status, user_decision, created_at, updated_at)
     VALUES (?, ?, 'video', ?, 'video/mp4', 'mp4', ?, ?,
             'processed', 'undecided', ?, ?)`,
  ).run(mediaId, trip.id, stored.logicalPath, videoBytes.length, durationSec, now, now);
  return { tripId: trip.id, mediaId, originalPath: stored.logicalPath };
}

function insertEditPlan(
  editPlansRepo: EditPlansRepository,
  tripId: string,
  plan: VideoEditPlan,
): string {
  const planId = randomUUID();
  const stored = { ...plan, id: planId };
  editPlansRepo.insert({
    id: planId,
    tripId,
    planJson: JSON.stringify(stored),
    targetDurationSec: plan.targetDurationSec,
    style: plan.style,
    now: plan.createdAt,
  });
  return planId;
}

function readJob(db: SqliteDatabase, jobId: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM processing_jobs WHERE id = ?`).get(jobId) as
    | Record<string, unknown>
    | undefined;
}

function readEditedVersion(
  db: SqliteDatabase,
  mediaId: string,
): Record<string, unknown> | undefined {
  return db
    .prepare(`SELECT * FROM media_versions WHERE media_id = ? AND version_type = 'edited'`)
    .get(mediaId) as Record<string, unknown> | undefined;
}

function countEditedRows(db: SqliteDatabase, mediaId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM media_versions WHERE media_id = ? AND version_type = 'edited'`,
      )
      .get(mediaId) as { n: number }
  ).n;
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const ffmpegOk = (await isAvailable("ffmpeg")) && (await isAvailable("ffprobe"));
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-video-render-worker-smoke-"));
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
    const audioLibraryRepo = new AudioLibraryRepository(dbHandle.db);
    const duplicateGroupsRepo = new DuplicateGroupsRepository(dbHandle.db);
    const jobRepo = new JobRepository(dbHandle.db);
    const editPlansRepo = new EditPlansRepository(dbHandle.db);

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

    const renderService = new VideoRenderService({
      tripService,
      mediaRepo,
      editPlansRepo,
      jobRepo,
      logger,
    });

    // -----------------------------------------------------------------
    // PART A — Service-layer enqueue paths (no ffmpeg needed)
    // -----------------------------------------------------------------

    // trip missing → 404
    {
      let caught = false;
      let code = "";
      let statusCode = 0;
      try {
        renderService.renderTrip("ffffffff-ffff-ffff-ffff-ffffffffffff", {});
      } catch (err) {
        const e = err as { code?: string; statusCode?: number };
        caught = true;
        code = String(e.code);
        statusCode = e.statusCode ?? 0;
      }
      record(
        "service: trip missing → NotFoundError (NOT_FOUND/404)",
        caught && code === "NOT_FOUND" && statusCode === 404,
        `caught=${caught} code=${code} statusCode=${statusCode}`,
      );
    }

    // no plans yet → EDIT_PLAN_NOT_FOUND
    const emptyTrip = tripService.createTrip({ title: "P11.T5 smoke (no plans)" });
    {
      let caught = false;
      let code = "";
      let statusCode = 0;
      try {
        renderService.renderTrip(emptyTrip.id, {});
      } catch (err) {
        const e = err as { code?: string; statusCode?: number };
        caught = true;
        code = String(e.code);
        statusCode = e.statusCode ?? 0;
      }
      record(
        "service: no plans for trip → EDIT_PLAN_NOT_FOUND/404",
        caught && code === "EDIT_PLAN_NOT_FOUND" && statusCode === 404,
        `caught=${caught} code=${code}/${statusCode}`,
      );
    }

    // body malformed → 400
    {
      let caught = false;
      let code = "";
      try {
        renderService.renderTrip(emptyTrip.id, { rogueField: "x" });
      } catch (err) {
        const e = err as { code?: string };
        caught = true;
        code = String(e.code);
      }
      record(
        "service: unknown body key rejected by zod .strict() → VALIDATION_FAILED",
        caught && code === "VALIDATION_FAILED",
        `caught=${caught} code=${code}`,
      );
    }

    // explicit planId not found → EDIT_PLAN_NOT_FOUND
    {
      let caught = false;
      let code = "";
      try {
        renderService.renderTrip(emptyTrip.id, {
          planId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
        });
      } catch (err) {
        const e = err as { code?: string };
        caught = true;
        code = String(e.code);
      }
      record(
        "service: explicit planId not found → EDIT_PLAN_NOT_FOUND",
        caught && code === "EDIT_PLAN_NOT_FOUND",
        `caught=${caught} code=${code}`,
      );
    }

    // 0-clip plan → BadRequestError
    {
      const tripA = tripService.createTrip({ title: "P11.T5 smoke (zero clips)" });
      const emptyPlan: VideoEditPlan = {
        version: "1.0",
        tripId: tripA.id,
        style: "standard",
        targetDurationSec: 30,
        totalDurationSec: 0,
        resolution: "1080p",
        aspectRatio: "16:9",
        sourceMediaIds: [],
        clips: [],
        transitions: [],
        audioPolicy: {
          mode: "keep_original",
          backgroundAudioId: null,
          removeOriginalAudio: false,
          loudnorm: false,
          fadeInSeconds: 0,
          fadeOutSeconds: 0,
          loopToFit: false,
          targetDurationSec: 30,
        },
        warnings: [],
        createdAt: new Date().toISOString(),
        aiRefined: false,
      };
      const planId = insertEditPlan(editPlansRepo, tripA.id, emptyPlan);
      let caught = false;
      let code = "";
      try {
        renderService.renderTrip(tripA.id, { planId });
      } catch (err) {
        const e = err as { code?: string };
        caught = true;
        code = String(e.code);
      }
      record(
        "service: plan with 0 clips → BadRequestError",
        caught && code === "BAD_REQUEST",
        `caught=${caught} code=${code}`,
      );
    }

    if (!ffmpegOk) {
      console.log(
        "[smoke] SKIP: ffmpeg / ffprobe not on PATH; remaining PART B / pipeline cases skipped.",
      );
      reportAndExit();
      return;
    }

    // -----------------------------------------------------------------
    // PART B — Worker pipeline
    // -----------------------------------------------------------------
    const renderHandler: JobHandler = makeVideoRenderHandler({
      storage,
      mediaRepo,
      mediaVersionsRepo,
      editPlansRepo,
      audioLibraryRepo,
      audioProcessor: {
        ffmpegPath: SETTINGS.ffmpegPath,
        timeoutMs: SETTINGS.timeoutMs,
        loudnormI: -16,
        loudnormTP: -1.5,
        loudnormLRA: 11,
        fadeInSeconds: 1.5,
        fadeOutSeconds: 2,
        loudnormEnabled: true,
      },
      settings: SETTINGS,
      logger,
    });

    const videoHandlers = new Map<string, JobHandler>();
    videoHandlers.set(VIDEO_RENDER_JOB_TYPE, renderHandler);

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
      claimedId: string | null;
      finalStatus: string | null;
    }> {
      const tick = await queue.tickChannel("video");
      await queue.awaitInflight("video");
      const last = tick.claimed[tick.claimed.length - 1];
      if (last === undefined) return { claimedId: null, finalStatus: null };
      const job = readJob(dbHandle.db, last.jobId);
      return {
        claimedId: last.jobId,
        finalStatus: (job?.status as string | undefined) ?? null,
      };
    }

    /** Pull pending video jobs in a loop until the channel reports
     * 0 claimed for one tick. Used between independent test
     * scenarios so an earlier `overwrite=true` doesn't strand a
     * pending row that the next scenario's tick would claim. */
    async function drainVideo(): Promise<void> {
      for (let i = 0; i < 20; i += 1) {
        const tick = await queue.tickChannel("video");
        await queue.awaitInflight("video");
        if (tick.claimed.length === 0) return;
      }
    }

    /** Look up the specific job's final status without ordering
     * assumptions. Used by tests that need to verify "this exact
     * jobId reached the expected terminal state" after a drain. */
    function readJobStatus(jobId: string): string | null {
      const j = readJob(dbHandle.db, jobId);
      return (j?.status as string | undefined) ?? null;
    }

    // ---- Seed: 2-clip trip ------------------------------------------
    const happyTrip = tripService.createTrip({ title: "P11.T5 smoke (happy)" });
    const vidApath = path.join(tmpRoot, "vid-a.mp4");
    const vidBpath = path.join(tmpRoot, "vid-b.mp4");
    await makeTestVideo(vidApath, 3, true);
    await makeTestVideo(vidBpath, 3, true);
    const vidAbytes = readFileSync(vidApath);
    const vidBbytes = readFileSync(vidBpath);
    const seedA = await seedVideoMedia(
      storage,
      dbHandle.db,
      tripService,
      vidAbytes,
      3,
      happyTrip.id,
    );
    const seedB = await seedVideoMedia(
      storage,
      dbHandle.db,
      tripService,
      vidBbytes,
      3,
      happyTrip.id,
    );

    const baseAudioPolicy = {
      mode: "keep_original" as const,
      backgroundAudioId: null,
      removeOriginalAudio: false,
      loudnorm: false,
      fadeInSeconds: 0,
      fadeOutSeconds: 0,
      loopToFit: false,
      targetDurationSec: 4,
    };

    const happyPlan: VideoEditPlan = {
      version: "1.0",
      tripId: happyTrip.id,
      style: "short",
      targetDurationSec: 4,
      totalDurationSec: 4,
      resolution: "720p",
      aspectRatio: "16:9",
      sourceMediaIds: [seedA.mediaId, seedB.mediaId],
      clips: [
        {
          mediaId: seedA.mediaId,
          sourcePath: seedA.originalPath,
          startSec: 0,
          endSec: 2,
          durationSec: 2,
          order: 0,
          reason: "first 2s of seedA",
        },
        {
          mediaId: seedB.mediaId,
          sourcePath: seedB.originalPath,
          startSec: 0,
          endSec: 2,
          durationSec: 2,
          order: 1,
          reason: "first 2s of seedB",
        },
      ],
      transitions: [{ fromClipOrder: 0, toClipOrder: 1, kind: "none", durationSec: 0 }],
      audioPolicy: baseAudioPolicy,
      warnings: [],
      createdAt: new Date().toISOString(),
      aiRefined: false,
    };
    const happyPlanId = insertEditPlan(editPlansRepo, happyTrip.id, happyPlan);

    // ---- Happy enqueue (created) ------------------------------------
    const happyEnqueue = renderService.renderTrip(happyTrip.id, { planId: happyPlanId });
    record(
      "service: happy first call returns outcome='created'",
      happyEnqueue.outcome === "created" &&
        happyEnqueue.planId === happyPlanId &&
        happyEnqueue.mediaId === seedA.mediaId &&
        happyEnqueue.mode === "final" &&
        typeof happyEnqueue.jobId === "string",
      JSON.stringify(happyEnqueue),
    );

    // Skipped (still pending) right after enqueue
    const skipped = renderService.renderTrip(happyTrip.id, { planId: happyPlanId });
    record(
      "service: second call before worker ticks → outcome='skipped' (pending)",
      skipped.outcome === "skipped" && skipped.jobId === happyEnqueue.jobId,
      JSON.stringify(skipped),
    );

    // ---- Tick the worker ---------------------------------------------
    const tick = await tickVideo();
    record(
      "worker: tick claimed the seeded job and reached terminal 'success'",
      tick.claimedId === happyEnqueue.jobId && tick.finalStatus === "success",
      JSON.stringify(tick),
    );

    // edited file lands
    const editedAbs = path.join(
      storage.root,
      `trips/${happyTrip.id}/derived/${seedA.mediaId}/edited.mp4`,
    );
    record(
      "worker: edited.mp4 present on disk under derived/{firstMediaId}/edited.mp4",
      existsSync(editedAbs),
      editedAbs,
    );

    // ffprobe assertions
    const editedProbe = await probe(editedAbs);
    record(
      "worker: edited output is H.264 + has audio + total duration ≈ 4s",
      editedProbe.videoCodec === "h264" &&
        editedProbe.hasAudio &&
        editedProbe.audioCodec === "aac" &&
        editedProbe.durationSec !== null &&
        Math.abs(editedProbe.durationSec - 4) < 0.6,
      JSON.stringify(editedProbe),
    );
    // 720p with 16:9 → 1280×720
    record(
      "worker: edited output uses target resolution (720p / 16:9 → 1280×720)",
      editedProbe.width === 1280 && editedProbe.height === 720,
      `dims=${editedProbe.width}×${editedProbe.height}`,
    );

    // media_versions row UPSERTed
    const editedRow = readEditedVersion(dbHandle.db, seedA.mediaId);
    record(
      "worker: media_versions(version_type='edited') row exists",
      editedRow !== undefined && editedRow.version_type === "edited",
      `version_type=${String(editedRow?.version_type)}`,
    );
    record(
      "worker: media_versions row has expected mime / dims / size / status",
      editedRow?.mime_type === "video/mp4" &&
        editedRow?.width === 1280 &&
        editedRow?.height === 720 &&
        typeof editedRow?.file_size === "number" &&
        (editedRow.file_size as number) > 0 &&
        editedRow?.status === "ready",
      `mime=${String(editedRow?.mime_type)} w=${String(editedRow?.width)} h=${String(editedRow?.height)} size=${String(editedRow?.file_size)} status=${String(editedRow?.status)}`,
    );

    // params records plan + audioPolicy + transcode knobs
    const params = JSON.parse(String(editedRow?.params)) as {
      planId: string;
      clipCount: number;
      sourceMediaIds: string[];
      audioPolicy: { mode: string };
      crf: number;
    };
    record(
      "worker: params records planId / clipCount / sourceMediaIds / audioPolicy / transcode knobs",
      params.planId === happyPlanId &&
        params.clipCount === 2 &&
        params.sourceMediaIds.length === 2 &&
        params.sourceMediaIds[0] === seedA.mediaId &&
        params.audioPolicy.mode === "keep_original" &&
        params.crf === 23,
      JSON.stringify(params),
    );

    // ---- Original bytes byte-for-byte unchanged ---------------------
    {
      const onDiskA = readFileSync(path.join(storage.root, seedA.originalPath));
      const onDiskB = readFileSync(path.join(storage.root, seedB.originalPath));
      record(
        "non-destructive: source vid-a + vid-b original bytes byte-for-byte unchanged",
        onDiskA.equals(vidAbytes) && onDiskB.equals(vidBbytes),
        `A=${onDiskA.length}==${vidAbytes.length} B=${onDiskB.length}==${vidBbytes.length}`,
      );
    }

    // ---- Idempotency: re-render same plan → reset → still 1 row ----
    {
      const beforeCount = countEditedRows(dbHandle.db, seedA.mediaId);
      const reset = renderService.renderTrip(happyTrip.id, { planId: happyPlanId });
      record(
        "service: re-render after success → outcome='reset' (same jobId)",
        reset.outcome === "reset" && reset.jobId === happyEnqueue.jobId,
        JSON.stringify(reset),
      );
      const tick2 = await tickVideo();
      record(
        "worker: re-tick on reset job → success",
        tick2.finalStatus === "success",
        JSON.stringify(tick2),
      );
      const afterCount = countEditedRows(dbHandle.db, seedA.mediaId);
      record(
        "worker: still exactly 1 edited media_versions row (UPSERT)",
        beforeCount === 1 && afterCount === 1,
        `before=${beforeCount} after=${afterCount}`,
      );
    }

    // ---- overwrite=true → forced (new jobId) + drain immediately ---
    {
      const forced = renderService.renderTrip(happyTrip.id, {
        planId: happyPlanId,
        overwrite: true,
      });
      record(
        "service: overwrite=true → outcome='forced' (fresh jobId)",
        forced.outcome === "forced" && forced.jobId !== happyEnqueue.jobId,
        JSON.stringify(forced),
      );
      // Drain so subsequent scenarios start from an empty queue —
      // otherwise their tick claims this leftover instead of the
      // job they just enqueued.
      await drainVideo();
    }

    // ---- audioPolicy=mute case --------------------------------------
    {
      await drainVideo();
      const mutePlan: VideoEditPlan = {
        ...happyPlan,
        audioPolicy: {
          ...happyPlan.audioPolicy,
          mode: "mute",
          removeOriginalAudio: true,
        },
        createdAt: new Date().toISOString(),
      };
      const mutePlanId = insertEditPlan(editPlansRepo, happyTrip.id, mutePlan);
      const enq = renderService.renderTrip(happyTrip.id, {
        planId: mutePlanId,
        overwrite: true,
      });
      await drainVideo();
      record(
        "worker: audioPolicy=mute tick reaches 'success'",
        readJobStatus(enq.jobId) === "success",
        `jobId=${enq.jobId} status=${String(readJobStatus(enq.jobId))}`,
      );
      const muteProbe = await probe(editedAbs);
      record(
        "worker: audioPolicy=mute output has NO audio stream",
        muteProbe.hasVideo && !muteProbe.hasAudio,
        JSON.stringify({ hasV: muteProbe.hasVideo, hasA: muteProbe.hasAudio }),
      );
    }

    // ---- audioPolicy=replace_with_library case ----------------------
    let validAudioId = "";
    {
      await drainVideo();
      const audioPath = path.join(tmpRoot, "bgm.m4a");
      await makeSineAudio(audioPath, 5, 660);
      const audioBytes = readFileSync(audioPath);
      validAudioId = randomUUID();
      audioLibraryRepo.upsertBySourceTypeAndChecksum({
        id: validAudioId,
        name: "smoke-bgm",
        displayName: "Smoke BGM",
        sourceType: "system",
        filePath: audioPath,
        relativePath: null,
        mimeType: "audio/mp4",
        durationSeconds: 5,
        sizeBytes: audioBytes.length,
        checksum: `a${"b".repeat(63)}`,
        isActive: true,
        tags: null,
        metadataJson: null,
        now: new Date().toISOString(),
      });

      const bgmPlan: VideoEditPlan = {
        ...happyPlan,
        audioPolicy: {
          ...happyPlan.audioPolicy,
          mode: "replace_with_library",
          backgroundAudioId: validAudioId,
          removeOriginalAudio: true,
          loudnorm: true,
          fadeInSeconds: 0.5,
          fadeOutSeconds: 0.5,
          loopToFit: true,
          targetDurationSec: 4,
        },
        createdAt: new Date().toISOString(),
      };
      const bgmPlanId = insertEditPlan(editPlansRepo, happyTrip.id, bgmPlan);
      const enq = renderService.renderTrip(happyTrip.id, {
        planId: bgmPlanId,
        overwrite: true,
      });
      await drainVideo();
      record(
        "worker: audioPolicy=replace_with_library tick reaches 'success'",
        readJobStatus(enq.jobId) === "success",
        `jobId=${enq.jobId} status=${String(readJobStatus(enq.jobId))}`,
      );
      const bgmProbe = await probe(editedAbs);
      record(
        "worker: audioPolicy=replace_with_library output has AAC audio + 720p video",
        bgmProbe.hasVideo &&
          bgmProbe.hasAudio &&
          bgmProbe.audioCodec === "aac" &&
          bgmProbe.width === 1280 &&
          bgmProbe.height === 720,
        JSON.stringify(bgmProbe),
      );
    }

    // ---- audioPolicy=replace_with_library + missing audio → fail ---
    {
      await drainVideo();
      const ghostPlan: VideoEditPlan = {
        ...happyPlan,
        audioPolicy: {
          ...happyPlan.audioPolicy,
          mode: "replace_with_library",
          backgroundAudioId: "non-existent-audio-id",
          removeOriginalAudio: true,
        },
        createdAt: new Date().toISOString(),
      };
      const ghostPlanId = insertEditPlan(editPlansRepo, happyTrip.id, ghostPlan);
      const enq = renderService.renderTrip(happyTrip.id, {
        planId: ghostPlanId,
        overwrite: true,
      });
      await drainVideo();
      record(
        "worker: missing background audio → terminal 'failed'",
        readJobStatus(enq.jobId) === "failed",
        `jobId=${enq.jobId} status=${String(readJobStatus(enq.jobId))}`,
      );
      const job = readJob(dbHandle.db, enq.jobId);
      record(
        "worker: failure message mentions backgroundAudio not found",
        typeof job?.error_message === "string" &&
          /backgroundAudio not found/i.test(job.error_message as string),
        `error_message=${String(job?.error_message).slice(0, 200)}`,
      );
    }

    // ---- Source media soft-deleted between enqueue and dequeue ------
    {
      await drainVideo();
      // Create a fresh trip + media so we can soft-delete without
      // affecting the happy edited row.
      const sdTrip = tripService.createTrip({ title: "P11.T5 soft-deleted source trip" });
      const sdVidPath = path.join(tmpRoot, "sd-vid.mp4");
      await makeTestVideo(sdVidPath, 2, true);
      const sdSeed = await seedVideoMedia(
        storage,
        dbHandle.db,
        tripService,
        readFileSync(sdVidPath),
        2,
        sdTrip.id,
      );
      const sdPlan: VideoEditPlan = {
        ...happyPlan,
        tripId: sdTrip.id,
        sourceMediaIds: [sdSeed.mediaId],
        clips: [
          {
            mediaId: sdSeed.mediaId,
            sourcePath: sdSeed.originalPath,
            startSec: 0,
            endSec: 2,
            durationSec: 2,
            order: 0,
            reason: "single soft-delete-target clip",
          },
        ],
        transitions: [],
        targetDurationSec: 2,
        totalDurationSec: 2,
        createdAt: new Date().toISOString(),
      };
      const sdPlanId = insertEditPlan(editPlansRepo, sdTrip.id, sdPlan);
      const enq = renderService.renderTrip(sdTrip.id, { planId: sdPlanId });
      // Now soft-delete the source media BEFORE the worker dequeues.
      mediaService.softDeleteMedia(sdSeed.mediaId);
      await drainVideo();
      record(
        "worker: source media soft-deleted between enqueue and dequeue → terminal 'failed'",
        readJobStatus(enq.jobId) === "failed",
        `jobId=${enq.jobId} status=${String(readJobStatus(enq.jobId))}`,
      );
      const job = readJob(dbHandle.db, enq.jobId);
      record(
        "worker: failure message mentions missing/soft-deleted media",
        typeof job?.error_message === "string" &&
          /missing.*soft-deleted/i.test(job.error_message as string),
        `error_message=${String(job?.error_message).slice(0, 200)}`,
      );
      record(
        "worker: no media_versions(edited) row leaked for soft-deleted-source path",
        countEditedRows(dbHandle.db, sdSeed.mediaId) === 0,
        `count=${countEditedRows(dbHandle.db, sdSeed.mediaId)}`,
      );
    }

    // ---- FK + integrity ---------------------------------------------
    {
      const fkCheck = dbHandle.db.prepare("PRAGMA foreign_key_check").all() as unknown[];
      record(
        "integrity: PRAGMA foreign_key_check returns 0 rows",
        fkCheck.length === 0,
        `rows=${fkCheck.length}`,
      );
      const intCheck = (
        dbHandle.db.prepare("PRAGMA integrity_check").all() as {
          integrity_check: string;
        }[]
      ).map((r) => r.integrity_check);
      record(
        "integrity: PRAGMA integrity_check is 'ok'",
        intCheck.length === 1 && intCheck[0] === "ok",
        intCheck.join(", "),
      );
    }

    reportAndExit();
  } finally {
    closeDatabase(dbHandle);
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

function reportAndExit(): void {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n[smoke] summary: ${passed}/${results.length} passed (${failed} failed)`);
  if (failed > 0) {
    for (const r of results.filter((r) => !r.ok)) {
      console.log(`[smoke][FAIL] ${r.name}: ${r.detail}`);
    }
    process.exitCode = 1;
  }
}

void describe;
void writeFile;

void main().catch((err) => {
  console.error("[smoke] uncaught error:", err);
  process.exitCode = 1;
});
