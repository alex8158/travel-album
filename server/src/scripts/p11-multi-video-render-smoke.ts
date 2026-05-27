// P11.T8 multi-video render acceptance smoke.
//
// Usage: npm run smoke:p11-multi-video-render
//
// Verifies the trip-level multi-video composition end-to-end across
// `generate-edit-plan` (P11.T4) + `render` (P11.T5) using the
// existing endpoints — P11.T8 deliberately does NOT add new routes
// (the trip-level endpoints already iterate over all the trip's
// videos when no explicit `mediaIds` is supplied).
//
// Coverage:
//
//   A) 3-video trip → generate-edit-plan picks all 3 → render
//      → output total duration ≈ sum of clip durations
//      → each source video byte-equal unchanged on disk
//      → media_versions(edited) row written under
//        clips[0].mediaId with the concatenated output
//
//   B) Audio policy across multi-video:
//      * `keep_original`  → output has audio stream (each clip's
//                           audio passes through concat)
//      * `mute`           → output has NO audio stream
//      * `replace_with_library` → output has the BGM track
//
//   C) Single-video trip regression (P11.T7 baseline still works)
//
//   D) Failure surfaced clearly:
//      * a clip's source media is soft-deleted between enqueue
//        and dequeue → job 'failed' with clear error_message
//
//   E) Source bytes integrity:
//      * SHA256 of every input video unchanged after a successful
//        render
//
//   F) Integrity:
//      * PRAGMA foreign_key_check + integrity_check clean
//
// SKIPs the whole pipeline when ffmpeg / ffprobe aren't on PATH.

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
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
  VideoEditPlanService,
  VideoRenderService,
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
// settings
// ---------------------------------------------------------------------------

const SETTINGS: VideoRenderSettings = {
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
  timeoutMs: 120_000,
  fps: 30,
  crf: 23,
  preset: "veryfast", // smoke override (production: medium)
  audioBitrateKbps: 160,
  workerVersion: "1.0",
};

// ---------------------------------------------------------------------------
// ffmpeg fixture helpers (mirror P11.T5 smoke conventions)
// ---------------------------------------------------------------------------

async function isAvailable(cmd: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn(cmd, ["-version"], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

interface TestVideoOpts {
  readonly durationSec: number;
  readonly width: number;
  readonly height: number;
  readonly withAudio?: boolean;
  readonly testpattern?: string;
}

async function makeTestVideo(outputPath: string, opts: TestVideoOpts): Promise<void> {
  const pattern = opts.testpattern ?? "testsrc";
  const args = [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `${pattern}=duration=${opts.durationSec}:size=${opts.width}x${opts.height}:rate=25`,
  ];
  if (opts.withAudio !== false) {
    args.push(
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=1000:sample_rate=48000:duration=${opts.durationSec}`,
    );
  }
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast");
  if (opts.withAudio !== false) args.push("-c:a", "aac", "-ac", "2", "-shortest");
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
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
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
      else reject(new Error(`ffprobe exited ${code}`));
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
  const v = (parsed.streams ?? []).find((s) => s.codec_type === "video");
  const a = (parsed.streams ?? []).find((s) => s.codec_type === "audio");
  const dur = parsed.format?.duration;
  return {
    hasVideo: v !== undefined,
    hasAudio: a !== undefined,
    durationSec: typeof dur === "string" ? Number.parseFloat(dur) : null,
    width: typeof v?.width === "number" ? v.width : null,
    height: typeof v?.height === "number" ? v.height : null,
    videoCodec: typeof v?.codec_name === "string" ? v.codec_name : null,
    audioCodec: typeof a?.codec_name === "string" ? a.codec_name : null,
  };
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

// ---------------------------------------------------------------------------
// fixture seeding
// ---------------------------------------------------------------------------

interface SeededVideo {
  readonly mediaId: string;
  readonly originalPath: string;
  readonly bytes: Buffer;
  readonly sha: string;
  readonly durationSec: number;
}

async function seedVideoMedia(
  storage: LocalStorageProvider,
  db: SqliteDatabase,
  tripId: string,
  videoPath: string,
  durationSec: number,
): Promise<SeededVideo> {
  const mediaId = randomUUID();
  const bytes = readFileSync(videoPath);
  const stored = await storage.putOriginal({
    tripId,
    mediaId,
    extension: "mp4",
    data: bytes,
  });
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO media_items
       (id, trip_id, type, original_path, mime_type, extension, file_size, duration,
        status, user_decision, created_at, updated_at)
     VALUES (?, ?, 'video', ?, 'video/mp4', 'mp4', ?, ?,
             'processed', 'undecided', ?, ?)`,
  ).run(mediaId, tripId, stored.logicalPath, bytes.length, durationSec, now, now);
  return {
    mediaId,
    originalPath: stored.logicalPath,
    bytes,
    sha: sha256(bytes),
    durationSec,
  };
}

function readJob(db: SqliteDatabase, jobId: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM processing_jobs WHERE id = ?`).get(jobId) as
    | Record<string, unknown>
    | undefined;
}

function readEditedRow(db: SqliteDatabase, mediaId: string): Record<string, unknown> | undefined {
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
  if (!ffmpegOk) {
    console.log("[smoke] SKIP: ffmpeg / ffprobe not on PATH; multi-video render needs both.");
    console.log("\n[smoke] summary: 0/0 passed (ffmpeg unavailable)");
    return;
  }

  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-p11-multi-video-smoke-"));
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
    const editPlansRepo = new EditPlansRepository(dbHandle.db);
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

    const planService = new VideoEditPlanService({
      tripService,
      mediaRepo,
      audioLibraryRepo,
      editPlansRepo,
      audioDefaults: {
        loudnormEnabled: true,
        fadeInSeconds: 1.5,
        fadeOutSeconds: 2,
      },
      aiEnabled: false,
      logger,
    });

    const renderService = new VideoRenderService({
      tripService,
      mediaRepo,
      editPlansRepo,
      jobRepo,
      logger,
    });

    // ---- Worker (registered on the video channel) ------------------
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
        fadeInSeconds: 0.5,
        fadeOutSeconds: 0.5,
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

    /** Run video-channel ticks until the queue is empty or a max
     * iteration budget is hit. Returns once nothing was claimed. */
    async function drainVideo(maxIters = 20): Promise<void> {
      for (let i = 0; i < maxIters; i += 1) {
        const tick = await queue.tickChannel("video");
        await queue.awaitInflight("video");
        if (tick.claimed.length === 0) return;
      }
    }

    // -----------------------------------------------------------------
    // PART A — 3-video trip happy path
    // -----------------------------------------------------------------
    const tripA = tripService.createTrip({ title: "P11.T8 multi-video trip A" });

    // Generate 3 different short videos at different "test patterns"
    // (testsrc vs testsrc2 — visually distinct so a future visual
    // inspection of the smoke output can tell them apart).
    const vid1Path = path.join(tmpRoot, "vid1.mp4");
    const vid2Path = path.join(tmpRoot, "vid2.mp4");
    const vid3Path = path.join(tmpRoot, "vid3.mp4");
    await makeTestVideo(vid1Path, { durationSec: 2, width: 320, height: 240 });
    await makeTestVideo(vid2Path, {
      durationSec: 2,
      width: 320,
      height: 240,
      testpattern: "testsrc2",
    });
    await makeTestVideo(vid3Path, { durationSec: 2, width: 320, height: 240 });

    const seedA1 = await seedVideoMedia(storage, dbHandle.db, tripA.id, vid1Path, 2);
    const seedA2 = await seedVideoMedia(storage, dbHandle.db, tripA.id, vid2Path, 2);
    const seedA3 = await seedVideoMedia(storage, dbHandle.db, tripA.id, vid3Path, 2);

    // Generate edit plan WITHOUT explicit mediaIds → service pulls
    // all the trip's active videos.
    const planA = await planService.generatePlan(tripA.id, { style: "short" });

    record(
      "multi-video: plan has 3 clips (one per video in the trip)",
      planA.clips.length === 3,
      `clipCount=${planA.clips.length}`,
    );
    record(
      "multi-video: plan.sourceMediaIds matches the 3 seeded videos",
      planA.sourceMediaIds.length === 3 &&
        new Set(planA.sourceMediaIds).size === 3 &&
        [seedA1.mediaId, seedA2.mediaId, seedA3.mediaId].every((id) =>
          planA.sourceMediaIds.includes(id),
        ),
      `sourceMediaIds=${planA.sourceMediaIds.join(",")}`,
    );
    record(
      "multi-video: plan.totalDurationSec > 0 and ≤ target (clips truncated to fit if needed)",
      planA.totalDurationSec > 0 && planA.totalDurationSec <= planA.targetDurationSec + 0.5,
      `total=${planA.totalDurationSec} target=${planA.targetDurationSec}`,
    );
    record(
      "multi-video: plan has 2 transitions for 3 clips (N-1)",
      planA.transitions.length === 2 && planA.transitions.every((t) => t.kind === "none"),
      `transitions=${JSON.stringify(planA.transitions)}`,
    );

    // Render and drain
    const renderA = renderService.renderTrip(tripA.id, { planId: planA.id });
    record(
      "multi-video: render enqueue outcome=created + jobId returned",
      renderA.outcome === "created" && typeof renderA.jobId === "string",
      JSON.stringify(renderA),
    );
    await drainVideo();
    const jobA = readJob(dbHandle.db, renderA.jobId);
    record(
      "multi-video: render job reaches terminal 'success'",
      jobA?.status === "success",
      `status=${String(jobA?.status)} err=${String(jobA?.error_message).slice(0, 200)}`,
    );

    const editedAbs = path.join(
      storage.root,
      `trips/${tripA.id}/derived/${planA.clips[0]!.mediaId}/edited.mp4`,
    );
    record(
      "multi-video: edited.mp4 written under derived/{firstClipMediaId}/",
      existsSync(editedAbs),
      editedAbs,
    );

    const editedProbe = await probe(editedAbs);
    record(
      "multi-video: edited output is H.264 video with valid ffprobe metadata",
      editedProbe.videoCodec === "h264" &&
        editedProbe.width !== null &&
        editedProbe.height !== null,
      JSON.stringify(editedProbe),
    );
    record(
      "multi-video: edited duration ≈ sum of plan clip durations",
      editedProbe.durationSec !== null &&
        Math.abs(editedProbe.durationSec - planA.totalDurationSec) < 1,
      `editedDur=${editedProbe.durationSec} planTotal=${planA.totalDurationSec}`,
    );
    record(
      "multi-video: edited has AAC audio stream (keep_original default)",
      editedProbe.hasAudio && editedProbe.audioCodec === "aac",
      `audio=${editedProbe.audioCodec}`,
    );

    // params.sourceMediaIds records ALL 3 source ids in the
    // media_versions row → traceability for R-147 disposition.
    const editedRow = readEditedRow(dbHandle.db, planA.clips[0]!.mediaId);
    const params = JSON.parse(String(editedRow?.params)) as {
      clipCount: number;
      sourceMediaIds: string[];
      planId: string;
    };
    record(
      "multi-video: media_versions params records all 3 sourceMediaIds + planId + clipCount",
      params.clipCount === 3 && params.sourceMediaIds.length === 3 && params.planId === planA.id,
      JSON.stringify(params),
    );

    // PART E (inline with A) — source bytes integrity
    {
      const onDisk1 = readFileSync(path.join(storage.root, seedA1.originalPath));
      const onDisk2 = readFileSync(path.join(storage.root, seedA2.originalPath));
      const onDisk3 = readFileSync(path.join(storage.root, seedA3.originalPath));
      record(
        "multi-video: all 3 source video bytes byte-for-byte unchanged after render",
        sha256(onDisk1) === seedA1.sha &&
          sha256(onDisk2) === seedA2.sha &&
          sha256(onDisk3) === seedA3.sha,
        `sha1=${sha256(onDisk1) === seedA1.sha} sha2=${sha256(onDisk2) === seedA2.sha} sha3=${sha256(onDisk3) === seedA3.sha}`,
      );
    }

    // -----------------------------------------------------------------
    // PART B — audio policy across multi-video
    // -----------------------------------------------------------------

    // B.1 mute mode
    await drainVideo();
    const mutePlanA = await planService.generatePlan(tripA.id, {
      style: "short",
      audioMode: "mute",
    });
    const muteRender = renderService.renderTrip(tripA.id, {
      planId: mutePlanA.id,
      overwrite: true,
    });
    await drainVideo();
    record(
      "multi-video: mute mode render reaches 'success'",
      readJob(dbHandle.db, muteRender.jobId)?.status === "success",
      `status=${String(readJob(dbHandle.db, muteRender.jobId)?.status)}`,
    );
    const muteProbe = await probe(editedAbs);
    record(
      "multi-video: mute mode output has NO audio stream",
      muteProbe.hasVideo && !muteProbe.hasAudio,
      JSON.stringify({ hasVideo: muteProbe.hasVideo, hasAudio: muteProbe.hasAudio }),
    );

    // B.2 replace_with_library mode
    const bgmPath = path.join(tmpRoot, "bgm.m4a");
    await makeSineAudio(bgmPath, 8, 440);
    const bgmBytes = readFileSync(bgmPath);
    const bgmId = randomUUID();
    audioLibraryRepo.upsertBySourceTypeAndChecksum({
      id: bgmId,
      name: "smoke-bgm",
      displayName: "Smoke Trip BGM",
      sourceType: "system",
      filePath: bgmPath,
      relativePath: null,
      mimeType: "audio/mp4",
      durationSeconds: 8,
      sizeBytes: bgmBytes.length,
      checksum: sha256(bgmBytes),
      isActive: true,
      tags: null,
      metadataJson: null,
      now: new Date().toISOString(),
    });

    await drainVideo();
    const bgmPlanA = await planService.generatePlan(tripA.id, {
      style: "short",
      audioMode: "replace_with_library",
      backgroundAudioId: bgmId,
    });
    record(
      "multi-video: BGM plan resolved with backgroundAudioId set",
      bgmPlanA.audioPolicy.mode === "replace_with_library" &&
        bgmPlanA.audioPolicy.backgroundAudioId === bgmId,
      JSON.stringify(bgmPlanA.audioPolicy),
    );
    const bgmRender = renderService.renderTrip(tripA.id, {
      planId: bgmPlanA.id,
      overwrite: true,
    });
    await drainVideo();
    record(
      "multi-video: BGM mode render reaches 'success'",
      readJob(dbHandle.db, bgmRender.jobId)?.status === "success",
      `status=${String(readJob(dbHandle.db, bgmRender.jobId)?.status)}`,
    );
    const bgmProbe = await probe(editedAbs);
    record(
      "multi-video: BGM mode output has AAC audio + video",
      bgmProbe.hasVideo && bgmProbe.hasAudio && bgmProbe.audioCodec === "aac",
      JSON.stringify(bgmProbe),
    );

    // -----------------------------------------------------------------
    // PART C — single-video trip regression (P11.T7 baseline)
    // -----------------------------------------------------------------
    const tripC = tripService.createTrip({ title: "single-video trip" });
    const vidCPath = path.join(tmpRoot, "vidC.mp4");
    await makeTestVideo(vidCPath, { durationSec: 3, width: 320, height: 240 });
    const seedC = await seedVideoMedia(storage, dbHandle.db, tripC.id, vidCPath, 3);

    const planC = await planService.generatePlan(tripC.id, { style: "short" });
    record(
      "single-video regression: plan has exactly 1 clip",
      planC.clips.length === 1 && planC.clips[0]!.mediaId === seedC.mediaId,
      `clips=${planC.clips.length}`,
    );
    record(
      "single-video regression: plan emits 0 transitions for 1 clip",
      planC.transitions.length === 0,
      `transitions=${planC.transitions.length}`,
    );
    await drainVideo();
    const renderC = renderService.renderTrip(tripC.id, { planId: planC.id });
    await drainVideo();
    record(
      "single-video regression: render still succeeds with 1-clip plan",
      readJob(dbHandle.db, renderC.jobId)?.status === "success",
      `status=${String(readJob(dbHandle.db, renderC.jobId)?.status)}`,
    );
    const cEditedAbs = path.join(
      storage.root,
      `trips/${tripC.id}/derived/${seedC.mediaId}/edited.mp4`,
    );
    record(
      "single-video regression: edited.mp4 written + media_versions row exists",
      existsSync(cEditedAbs) && countEditedRows(dbHandle.db, seedC.mediaId) === 1,
      `exists=${existsSync(cEditedAbs)} rows=${countEditedRows(dbHandle.db, seedC.mediaId)}`,
    );

    // -----------------------------------------------------------------
    // PART D — failure path: source media soft-deleted between
    // enqueue and dequeue
    // -----------------------------------------------------------------
    const tripD = tripService.createTrip({ title: "soft-deleted source trip" });
    const vd1 = path.join(tmpRoot, "vd1.mp4");
    const vd2 = path.join(tmpRoot, "vd2.mp4");
    await makeTestVideo(vd1, { durationSec: 2, width: 320, height: 240 });
    await makeTestVideo(vd2, { durationSec: 2, width: 320, height: 240 });
    const seedD1 = await seedVideoMedia(storage, dbHandle.db, tripD.id, vd1, 2);
    const seedD2 = await seedVideoMedia(storage, dbHandle.db, tripD.id, vd2, 2);

    const planD = await planService.generatePlan(tripD.id, { style: "short" });
    record(
      "failure path: 2-video plan generated",
      planD.clips.length === 2 &&
        [seedD1.mediaId, seedD2.mediaId].every((id) => planD.sourceMediaIds.includes(id)),
      `clips=${planD.clips.length}`,
    );
    const renderD = renderService.renderTrip(tripD.id, { planId: planD.id });

    // Soft-delete the SECOND clip's source BEFORE the worker dequeues.
    // (First clip is the keyed mediaId; the worker validates EVERY clip's
    // source, so the second's softdelete will trip the validation.)
    const secondClipMediaId = planD.clips[1]!.mediaId;
    mediaService.softDeleteMedia(secondClipMediaId);

    await drainVideo();
    const jobD = readJob(dbHandle.db, renderD.jobId);
    record(
      "failure path: render job reaches terminal 'failed' when source soft-deleted mid-flight",
      jobD?.status === "failed",
      `status=${String(jobD?.status)}`,
    );
    record(
      "failure path: error_message mentions the missing/soft-deleted media id",
      typeof jobD?.error_message === "string" &&
        /missing.*soft-deleted/i.test(jobD.error_message as string) &&
        (jobD.error_message as string).includes(secondClipMediaId),
      `err=${String(jobD?.error_message).slice(0, 200)}`,
    );
    // No edited row should be present for the first clip (worker
    // fails BEFORE the UPSERT step).
    const dFirstMediaId = planD.clips[0]!.mediaId;
    record(
      "failure path: NO media_versions(edited) row leaked for the first-clip media",
      countEditedRows(dbHandle.db, dFirstMediaId) === 0,
      `rows=${countEditedRows(dbHandle.db, dFirstMediaId)}`,
    );

    // -----------------------------------------------------------------
    // PART F — integrity
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

void main().catch((err) => {
  console.error("[smoke] uncaught error:", err);
  process.exitCode = 1;
});
