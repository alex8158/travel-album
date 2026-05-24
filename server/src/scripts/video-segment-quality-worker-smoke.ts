// Manual smoke test for the video_segment_quality worker (P9.T7).
//
// Usage: npm run smoke:video-segment-quality-worker
//
// Drives `makeVideoSegmentQualityHandler` end-to-end against a real
// SQLite DB + real LocalStorageProvider + real ffmpeg / sharp. Also
// exercises the pure scoring helpers (`scoreOneSegment`,
// `parseBlackdetectStderr`, `mapUserDecisionsByOverlap`) directly so
// the heart of the algorithm has unit coverage independent of
// ffmpeg's per-host quirks.
//
// Coverage:
//   * `parseBlackdetectStderr` unit cases: 0 / 1 / many intervals,
//     malformed lines, decimal/int formats, inverted ranges dropped.
//   * `scoreOneSegment` unit cases: no keyframes (NULL blur) /
//     all-black segment → waste='black' / all-blurry → 'blurry' /
//     clean segment → 'none' + is_recommended=1.
//   * `mapUserDecisionsByOverlap` (R-107 closure): preserves keep
//     under ≥ 50% overlap; drops decision under < 50%; ignores
//     'undecided'.
//   * Happy path end-to-end: 12s testsrc + P9.T6 producer + P9.T5
//     keyframes producer + P9.T7 scorer → every segment gets
//     blur_score / quality_score / waste_type / is_recommended /
//     reason populated; user_decision stays 'undecided'.
//   * Black-clip scoring: synthetic 4s black testsrc → segments
//     classified waste_type='black' with blackRatio ≈ 1.
//   * R-107 preservation: set user_decision='keep' on a row, re-run
//     P9.T6 (no force) → user_decision survives.
//   * R-107 force wipe: set user_decision='keep', re-run P9.T6 with
//     `{"force":true}` payload → user_decision wiped to 'undecided'.
//   * Scope-guard: scorer does NOT touch media_items, media_versions
//     (count unchanged), original bytes intact, segment files intact.
//   * Failure paths: 0 segments, missing manifest, non-video, soft-
//     deleted media, no decode source.
//   * P7 soft-delete contract preserved.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { DuplicateGroupsRepository } from "../dedup/index.js";
import {
  JobQueue,
  JobRepository,
  VIDEO_KEYFRAMES_JOB_TYPE,
  VIDEO_SEGMENT_QUALITY_JOB_TYPE,
  VIDEO_SEGMENTS_JOB_TYPE,
  makeVideoKeyframesHandler,
  makeVideoSegmentQualityHandler,
  makeVideoSegmentsHandler,
  parseBlackdetectStderr,
  scoreOneSegment,
  type JobHandler,
  type VideoSegmentQualitySettings,
} from "../jobs/index.js";
import { createLogger } from "../logger.js";
import {
  MediaRepository,
  MediaService,
  MediaVersionsRepository,
  VideoSegmentsRepository,
  mapUserDecisionsByOverlap,
  videoSegmentMp4Path,
  type MediaSoftDeleteDeps,
  type VideoSegment,
  type VideoSegmentInsertData,
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
// settings
// ---------------------------------------------------------------------------

const SETTINGS: VideoSegmentQualitySettings = {
  ffmpegPath: "ffmpeg",
  timeoutMs: 60_000,
  blurMaxEdge: 512,
  normaliseSharpnessMaybeThreshold: 100,
  blurWasteThreshold: 0.25,
  blackRatioThreshold: 0.5,
  blackdetectMinDurationSec: 0.5,
  blackdetectPicTh: 0.98,
  blackdetectPixTh: 0.1,
  recommendThreshold: 0.5,
  workerVersion: "1.0",
};

// ---------------------------------------------------------------------------
// ffmpeg availability + test-video generation
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
  source: "testsrc" | "black",
  durationSec: number,
): Promise<void> {
  const lavfi =
    source === "testsrc"
      ? `testsrc=duration=${durationSec}:size=320x240:rate=25`
      : `color=c=black:size=320x240:rate=25:duration=${durationSec}`;
  const args = [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    lavfi,
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
  const trip = tripService.createTrip({ title: options.title ?? "P9.T7 Smoke Trip" });
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
        duration, status, user_decision, created_at, updated_at)
     VALUES (?, ?, 'video', ?, 'video/mp4', 'mp4', ?, ?,
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

function insertJob(db: SqliteDatabase, mediaId: string, jobType: string, payload: string | null = null): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO processing_jobs (id, media_id, job_type, payload, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(id, mediaId, jobType, payload, now, now);
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
// pure-function unit checks
// ---------------------------------------------------------------------------

function runPureUnitChecks(): void {
  // parseBlackdetectStderr -------------------------------------------
  {
    const empty = parseBlackdetectStderr("");
    record("parseBlackdetectStderr: empty input → []", empty.length === 0, `len=${empty.length}`);

    const oneInterval = parseBlackdetectStderr(
      "[blackdetect @ 0x1234] black_start:1.5 black_end:3.0 black_duration:1.5\n",
    );
    record(
      "parseBlackdetectStderr: one interval parsed",
      oneInterval.length === 1 &&
        oneInterval[0]!.start === 1.5 &&
        oneInterval[0]!.end === 3.0,
      JSON.stringify(oneInterval),
    );

    const manyIntervals = parseBlackdetectStderr(
      [
        "frame=  100 fps= 50",
        "[blackdetect @ 0xa] black_start:0 black_end:1.0 black_duration:1.0",
        "irrelevant log line",
        "[blackdetect @ 0xb] black_start:5.5 black_end:7.25 black_duration:1.75",
        "[blackdetect @ 0xc] black_start:10 black_end:9 black_duration:-1", // inverted dropped
      ].join("\n"),
    );
    record(
      "parseBlackdetectStderr: multi-interval parse drops inverted ranges + sorts by start",
      manyIntervals.length === 2 &&
        manyIntervals[0]!.start === 0 &&
        manyIntervals[1]!.start === 5.5,
      JSON.stringify(manyIntervals),
    );
  }

  // scoreOneSegment --------------------------------------------------
  {
    const fakeSeg = (start: number, end: number): VideoSegment => ({
      id: `seg-${start}-${end}`,
      mediaId: "mediaA",
      startTime: start,
      endTime: end,
      duration: end - start,
      thumbnailPath: null,
      previewPath: null,
      blurScore: null,
      stabilityScore: null,
      qualityScore: null,
      wasteType: "none",
      isRecommended: false,
      userDecision: "undecided",
      reason: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });
    const settings = {
      blackRatioThreshold: 0.5,
      blurWasteThreshold: 0.25,
      recommendThreshold: 0.5,
    };

    // No keyframes in interval → blur NULL, quality NULL.
    const noKf = scoreOneSegment({
      segment: fakeSeg(0, 3),
      sharpnessByKeyframe: [{ timestampSec: 10, sharpness: 1 }],
      blackIntervals: [],
      settings,
    });
    record(
      "scoreOneSegment: no keyframes in interval → blur NULL, quality NULL, waste='none'",
      noKf.blurScore === null &&
        noKf.qualityScore === null &&
        noKf.wasteType === "none" &&
        noKf.isRecommended === false,
      `score=${JSON.stringify(noKf)}`,
    );

    // Clean: high sharpness, no black → recommended.
    const clean = scoreOneSegment({
      segment: fakeSeg(0, 3),
      sharpnessByKeyframe: [
        { timestampSec: 0.5, sharpness: 0.9 },
        { timestampSec: 1.5, sharpness: 0.8 },
        { timestampSec: 2.5, sharpness: 0.85 },
      ],
      blackIntervals: [],
      settings,
    });
    record(
      "scoreOneSegment: clean + sharp + no black → waste='none', is_recommended=true",
      clean.wasteType === "none" &&
        clean.isRecommended === true &&
        clean.blurScore !== null &&
        clean.qualityScore !== null &&
        clean.blackRatio === 0,
      JSON.stringify(clean),
    );

    // All-black: 100% overlap with black interval.
    const allBlack = scoreOneSegment({
      segment: fakeSeg(0, 3),
      sharpnessByKeyframe: [{ timestampSec: 1.5, sharpness: 0.1 }],
      blackIntervals: [{ start: 0, end: 3 }],
      settings,
    });
    record(
      "scoreOneSegment: all-black segment → waste='black', is_recommended=false, blackRatio=1",
      allBlack.wasteType === "black" &&
        allBlack.isRecommended === false &&
        Math.abs(allBlack.blackRatio - 1) < 1e-9,
      JSON.stringify(allBlack),
    );

    // Low sharpness, no black → blurry.
    const blurry = scoreOneSegment({
      segment: fakeSeg(0, 3),
      sharpnessByKeyframe: [
        { timestampSec: 0.5, sharpness: 0.1 },
        { timestampSec: 1.5, sharpness: 0.15 },
      ],
      blackIntervals: [],
      settings,
    });
    record(
      "scoreOneSegment: low sharpness + no black → waste='blurry', is_recommended=false",
      blurry.wasteType === "blurry" && blurry.isRecommended === false,
      JSON.stringify(blurry),
    );

    // Partial black (40%) — below threshold → waste='none' (or 'blurry' if blur too low).
    const partialBlack = scoreOneSegment({
      segment: fakeSeg(0, 5),
      sharpnessByKeyframe: [
        { timestampSec: 1, sharpness: 0.9 },
        { timestampSec: 3, sharpness: 0.85 },
      ],
      blackIntervals: [{ start: 0, end: 2 }], // 2s / 5s = 0.4 < 0.5
      settings,
    });
    record(
      "scoreOneSegment: 40% black overlap stays below 0.5 threshold → not 'black'",
      partialBlack.wasteType !== "black" &&
        Math.abs(partialBlack.blackRatio - 0.4) < 1e-9,
      JSON.stringify(partialBlack),
    );
  }

  // mapUserDecisionsByOverlap (R-107) --------------------------------
  {
    const oldRows: VideoSegment[] = [
      {
        id: "old-a",
        mediaId: "mediaA",
        startTime: 0,
        endTime: 5,
        duration: 5,
        thumbnailPath: null,
        previewPath: null,
        blurScore: null,
        stabilityScore: null,
        qualityScore: null,
        wasteType: "none",
        isRecommended: false,
        userDecision: "keep",
        reason: null,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
      {
        id: "old-b",
        mediaId: "mediaA",
        startTime: 5,
        endTime: 10,
        duration: 5,
        thumbnailPath: null,
        previewPath: null,
        blurScore: null,
        stabilityScore: null,
        qualityScore: null,
        wasteType: "none",
        isRecommended: false,
        userDecision: "undecided", // should NOT propagate
        reason: null,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
      {
        id: "old-c",
        mediaId: "mediaA",
        startTime: 10,
        endTime: 15,
        duration: 5,
        thumbnailPath: null,
        previewPath: null,
        blurScore: null,
        stabilityScore: null,
        qualityScore: null,
        wasteType: "none",
        isRecommended: false,
        userDecision: "remove",
        reason: null,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    ];
    const newSegs: VideoSegmentInsertData[] = [
      // New[0] overlaps old-a by 4/4 = 100% → inherit 'keep'.
      { id: "new-0", mediaId: "mediaA", startTime: 0, endTime: 4, duration: 4, now: "now" },
      // New[1] overlaps old-b (1s / 4s = 25%, < 50%) → no inherit.
      { id: "new-1", mediaId: "mediaA", startTime: 4, endTime: 8, duration: 4, now: "now" },
      // New[2] overlaps old-c by 4/4 = 100% → inherit 'remove'.
      { id: "new-2", mediaId: "mediaA", startTime: 10, endTime: 14, duration: 4, now: "now" },
    ];
    const plan = mapUserDecisionsByOverlap(oldRows, newSegs);
    record(
      "mapUserDecisionsByOverlap: preserves 'keep' under ≥50% overlap, drops 'undecided', drops <50% match",
      plan.length === 2 &&
        plan[0]!.newSegmentId === "new-0" &&
        plan[0]!.userDecision === "keep" &&
        plan[1]!.newSegmentId === "new-2" &&
        plan[1]!.userDecision === "remove",
      JSON.stringify(plan),
    );
  }
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  runPureUnitChecks();

  // ffmpeg gate
  const ffmpegOk = (await isAvailable("ffmpeg")) && (await isAvailable("ffprobe"));
  if (!ffmpegOk) {
    console.log("[smoke] SKIP: ffmpeg/ffprobe not on PATH; only pure-function checks ran.");
    const passed = results.filter((r) => r.ok).length;
    const failed = results.length - passed;
    console.log(`\n[smoke] summary: ${passed}/${results.length} passed (ffmpeg unavailable)`);
    if (failed > 0) process.exit(1);
    return;
  }

  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-vsq-smoke-"));
  console.log(`[smoke] tmpRoot=${tmpRoot}`);
  const dbHandle = openDatabase(path.join(tmpRoot, "smoke.db"));
  try {
    runMigrations(dbHandle.db);
    const logger = createLogger({ nodeEnv: "test" });
    const storage = LocalStorageProvider.create(path.join(tmpRoot, "storage"));
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
      VIDEO_SEGMENT_QUALITY_JOB_TYPE,
      makeVideoSegmentQualityHandler({
        storage,
        mediaRepo,
        mediaVersionsRepo,
        videoSegmentsRepo,
        settings: SETTINGS,
        logger,
      }),
    );
    videoHandlers.set(
      VIDEO_SEGMENTS_JOB_TYPE,
      makeVideoSegmentsHandler({
        storage,
        mediaRepo,
        mediaVersionsRepo,
        videoSegmentsRepo,
        settings: {
          ffmpegPath: "ffmpeg",
          ffprobePath: "ffprobe",
          timeoutMs: 60_000,
          durationSec: 3,
          workerVersion: "1.0",
        },
        logger,
      }),
    );
    videoHandlers.set(
      VIDEO_KEYFRAMES_JOB_TYPE,
      makeVideoKeyframesHandler({
        storage,
        mediaRepo,
        mediaVersionsRepo,
        settings: {
          ffmpegPath: "ffmpeg",
          timeoutMs: 60_000,
          intervalSec: 1,
          maxFrames: 200,
          jpegQuality: 2,
          workerVersion: "1.0",
        },
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

    async function tickVideoUntilEmpty(): Promise<readonly { jobId: string; finalStatus: string }[]> {
      const drained: { jobId: string; finalStatus: string }[] = [];
      // Single tick claims up to channel-concurrency jobs (1 here).
      // We loop until nothing more is claimed.
      for (;;) {
        const tick = await queue.tickChannel("video");
        await queue.awaitInflight("video");
        if (tick.claimed.length === 0) break;
        for (const claim of tick.claimed) {
          const status = (readJob(dbHandle.db, claim.jobId)?.status as string | undefined) ?? "";
          drained.push({ jobId: claim.jobId, finalStatus: status });
        }
      }
      return drained;
    }

    /**
     * Insert a job + drain the video channel until quiet. The
     * JobQueue's claim SQL is `ORDER BY created_at ASC, id ASC` and
     * UUIDs are random — so back-to-back inserts that share the
     * same millisecond timestamp can be claimed in arbitrary order.
     * For tasks that depend on each other (segments → keyframes →
     * quality), we drive them sequentially.
     */
    async function runJob(
      mediaId: string,
      jobType: string,
      payload: string | null = null,
    ): Promise<{ jobId: string; finalStatus: string }> {
      const id = insertJob(dbHandle.db, mediaId, jobType, payload);
      await tickVideoUntilEmpty();
      const status = (readJob(dbHandle.db, id)?.status as string | undefined) ?? "";
      return { jobId: id, finalStatus: status };
    }

    // -----------------------------------------------------------------
    // CASE 1: happy path — 12s testsrc → P9.T6 (4 segments) → P9.T5
    // (12 keyframes @ 1s) → P9.T7 scorer fills every row.
    // Run sequentially: P9.T7 depends on P9.T6 + P9.T5 having
    // landed their outputs first.
    // -----------------------------------------------------------------
    const goodVideoPath = path.join(tmpRoot, "good.mp4");
    await makeTestVideo(goodVideoPath, "testsrc", 12);
    const goodBytes = readFileSync(goodVideoPath);
    const good = await seedVideoMedia(storage, dbHandle.db, tripService, goodBytes, {
      title: "Case1 happy",
      duration: 12,
    });
    const segJobResult = await runJob(good.mediaId, VIDEO_SEGMENTS_JOB_TYPE);
    const kfJobResult = await runJob(good.mediaId, VIDEO_KEYFRAMES_JOB_TYPE);
    const qualityJobResult = await runJob(good.mediaId, VIDEO_SEGMENT_QUALITY_JOB_TYPE);
    record(
      "happy: video_segments producer succeeded",
      segJobResult.finalStatus === "success",
      `status=${segJobResult.finalStatus}`,
    );
    record(
      "happy: video_keyframes producer succeeded",
      kfJobResult.finalStatus === "success",
      `status=${kfJobResult.finalStatus}`,
    );
    record(
      "happy: video_segment_quality job ended 'success'",
      qualityJobResult.finalStatus === "success",
      `status=${qualityJobResult.finalStatus}`,
    );

    const goodSegs = videoSegmentsRepo.listByMediaId(good.mediaId);
    record(
      "happy: produced 4 segments",
      goodSegs.length === 4,
      `count=${goodSegs.length}`,
    );
    record(
      "happy: every segment got blur_score / quality_score populated",
      goodSegs.every((s) => s.blurScore !== null && s.qualityScore !== null),
      goodSegs.map((s) => `${s.id.slice(0, 6)}=blur:${s.blurScore} q:${s.qualityScore}`).join(" | "),
    );
    record(
      "happy: every segment's scores are in [0, 1]",
      goodSegs.every(
        (s) =>
          (s.blurScore ?? 0) >= 0 &&
          (s.blurScore ?? 0) <= 1 &&
          (s.qualityScore ?? 0) >= 0 &&
          (s.qualityScore ?? 0) <= 1,
      ),
      `OK`,
    );
    record(
      "happy: no segment is classified 'black' (testsrc is colourful)",
      goodSegs.every((s) => s.wasteType !== "black"),
      goodSegs.map((s) => s.wasteType).join(","),
    );
    record(
      "happy: testsrc is sharp enough → at least one segment is_recommended",
      goodSegs.some((s) => s.isRecommended === true),
      goodSegs.map((s) => `${s.wasteType}:${s.isRecommended}`).join(" | "),
    );
    record(
      "happy: stability_score remains NULL (V1 documented)",
      goodSegs.every((s) => s.stabilityScore === null),
      `OK`,
    );
    record(
      "happy: user_decision stays 'undecided' (scorer never writes it)",
      goodSegs.every((s) => s.userDecision === "undecided"),
      goodSegs.map((s) => s.userDecision).join(","),
    );
    record(
      "happy: every segment row has a non-empty reason string",
      goodSegs.every((s) => typeof s.reason === "string" && s.reason!.length > 0),
      `OK`,
    );

    // -----------------------------------------------------------------
    // CASE 2: scope-guard — media_items / media_versions / original
    // bytes / segment files all intact across the scorer run.
    // -----------------------------------------------------------------
    {
      const mediaBefore = readMedia(dbHandle.db, good.mediaId);
      const versionsBefore = countVersions(dbHandle.db, good.mediaId);
      const originalBefore = readFileSync(path.join(storage.root, good.originalPath));
      const segmentFilesBefore = (
        await readdir(path.join(storage.root, `trips/${good.tripId}/derived/${good.mediaId}/segments`))
      )
        .filter((n) => n.endsWith(".mp4"))
        .sort();

      // Re-run JUST the scorer on the same seed.
      await runJob(good.mediaId, VIDEO_SEGMENT_QUALITY_JOB_TYPE);

      const mediaAfter = readMedia(dbHandle.db, good.mediaId);
      const versionsAfter = countVersions(dbHandle.db, good.mediaId);
      const originalAfter = readFileSync(path.join(storage.root, good.originalPath));
      const segmentFilesAfter = (
        await readdir(path.join(storage.root, `trips/${good.tripId}/derived/${good.mediaId}/segments`))
      )
        .filter((n) => n.endsWith(".mp4"))
        .sort();

      record(
        "scope-guard: scorer did not mutate media_items columns",
        mediaAfter?.status === mediaBefore?.status &&
          mediaAfter?.user_decision === mediaBefore?.user_decision &&
          mediaAfter?.deleted_at === mediaBefore?.deleted_at &&
          mediaAfter?.original_path === mediaBefore?.original_path,
        `before/after unchanged`,
      );
      record(
        "scope-guard: scorer did not add or remove media_versions rows",
        versionsBefore === versionsAfter,
        `before=${versionsBefore} after=${versionsAfter}`,
      );
      record(
        "scope-guard: original video bytes intact",
        originalBefore.equals(originalAfter),
        `before=${originalBefore.length}B after=${originalAfter.length}B`,
      );
      record(
        "scope-guard: scorer did not touch on-disk segment files",
        JSON.stringify(segmentFilesBefore) === JSON.stringify(segmentFilesAfter),
        `before=${segmentFilesBefore.length} after=${segmentFilesAfter.length}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 3: black-clip → waste_type='black'.
    // -----------------------------------------------------------------
    {
      const blackVideoPath = path.join(tmpRoot, "black.mp4");
      await makeTestVideo(blackVideoPath, "black", 6);
      const blackBytes = readFileSync(blackVideoPath);
      const black = await seedVideoMedia(storage, dbHandle.db, tripService, blackBytes, {
        title: "Case3 all-black",
        duration: 6,
      });
      await runJob(black.mediaId, VIDEO_SEGMENTS_JOB_TYPE);
      await runJob(black.mediaId, VIDEO_KEYFRAMES_JOB_TYPE);
      await runJob(black.mediaId, VIDEO_SEGMENT_QUALITY_JOB_TYPE);
      const blackSegs = videoSegmentsRepo.listByMediaId(black.mediaId);
      record(
        "black-clip: produced segments",
        blackSegs.length > 0,
        `count=${blackSegs.length}`,
      );
      record(
        "black-clip: at least one segment classified waste_type='black'",
        blackSegs.some((s) => s.wasteType === "black"),
        blackSegs.map((s) => `${s.id.slice(0, 6)}:${s.wasteType}`).join(" | "),
      );
      record(
        "black-clip: black segments not recommended",
        blackSegs.filter((s) => s.wasteType === "black").every((s) => s.isRecommended === false),
        `OK`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 4: R-107 preservation — set user_decision='keep' on a row,
    // re-run P9.T6 (no force) → user_decision survives the wipe.
    // -----------------------------------------------------------------
    {
      const r107Path = path.join(tmpRoot, "r107.mp4");
      await makeTestVideo(r107Path, "testsrc", 12);
      const r107Bytes = readFileSync(r107Path);
      const r107 = await seedVideoMedia(storage, dbHandle.db, tripService, r107Bytes, {
        title: "Case4 R-107 preservation",
        duration: 12,
      });
      await runJob(r107.mediaId, VIDEO_SEGMENTS_JOB_TYPE);
      const segsBefore = videoSegmentsRepo.listByMediaId(r107.mediaId);
      // Mark the second segment (3-6s) as 'keep'.
      const target = segsBefore[1]!;
      videoSegmentsRepo.updateUserDecision({
        id: target.id,
        userDecision: "keep",
        now: new Date().toISOString(),
      });

      // Re-run producer (no force).
      await runJob(r107.mediaId, VIDEO_SEGMENTS_JOB_TYPE);
      const segsAfter = videoSegmentsRepo.listByMediaId(r107.mediaId);

      // Find the new segment overlapping 3-6s.
      const newOverlap = segsAfter.find(
        (s) => s.startTime <= 4.5 && s.endTime > 4.5,
      );
      record(
        "R-107: re-slice preserved user_decision='keep' on the new segment overlapping the old one",
        newOverlap !== undefined && newOverlap.userDecision === "keep",
        `newOverlap=${
          newOverlap === undefined ? "undefined" : `${newOverlap.startTime}-${newOverlap.endTime}:${newOverlap.userDecision}`
        }`,
      );
      record(
        "R-107: only the overlapping new segment inherited 'keep'; others stay 'undecided'",
        segsAfter.filter((s) => s.userDecision === "keep").length === 1,
        `kept=${segsAfter.filter((s) => s.userDecision === "keep").length}`,
      );
      record(
        "R-107: re-slice still rotated UUIDs (segment ids freshly generated)",
        segsAfter.every((s) => !segsBefore.some((before) => before.id === s.id)),
        `OK`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 5: R-107 force wipe — payload={"force":true} clears
    // user_decision even when an overlap would otherwise preserve it.
    // -----------------------------------------------------------------
    {
      const forcePath = path.join(tmpRoot, "force.mp4");
      await makeTestVideo(forcePath, "testsrc", 12);
      const forceBytes = readFileSync(forcePath);
      const forceFx = await seedVideoMedia(storage, dbHandle.db, tripService, forceBytes, {
        title: "Case5 R-107 force",
        duration: 12,
      });
      await runJob(forceFx.mediaId, VIDEO_SEGMENTS_JOB_TYPE);
      const before = videoSegmentsRepo.listByMediaId(forceFx.mediaId);
      videoSegmentsRepo.updateUserDecision({
        id: before[1]!.id,
        userDecision: "remove",
        now: new Date().toISOString(),
      });

      await runJob(forceFx.mediaId, VIDEO_SEGMENTS_JOB_TYPE, JSON.stringify({ force: true }));
      const after = videoSegmentsRepo.listByMediaId(forceFx.mediaId);
      record(
        "R-107 force: all user_decision reset to 'undecided' after force=true re-slice",
        after.every((s) => s.userDecision === "undecided"),
        after.map((s) => s.userDecision).join(","),
      );
    }

    // -----------------------------------------------------------------
    // CASE 6: failure — 0 segments → scorer fails clearly.
    // -----------------------------------------------------------------
    {
      const noSegPath = path.join(tmpRoot, "noseg.mp4");
      await makeTestVideo(noSegPath, "testsrc", 6);
      const noSegBytes = readFileSync(noSegPath);
      const noSeg = await seedVideoMedia(storage, dbHandle.db, tripService, noSegBytes, {
        title: "Case6 no-segments",
        duration: 6,
      });
      const qJobResult = await runJob(noSeg.mediaId, VIDEO_SEGMENT_QUALITY_JOB_TYPE);
      const job = readJob(dbHandle.db, qJobResult.jobId);
      record(
        "no-segments: scorer fails clearly",
        job?.status === "failed" &&
          typeof job?.error_message === "string" &&
          /no segments to score/.test(job.error_message as string),
        `status=${String(job?.status)} msg=${String(job?.error_message)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 7: failure — missing keyframes manifest → scorer fails.
    // -----------------------------------------------------------------
    {
      const noKfPath = path.join(tmpRoot, "nokf.mp4");
      await makeTestVideo(noKfPath, "testsrc", 6);
      const noKfBytes = readFileSync(noKfPath);
      const noKf = await seedVideoMedia(storage, dbHandle.db, tripService, noKfBytes, {
        title: "Case7 no-keyframes",
        duration: 6,
      });
      await runJob(noKf.mediaId, VIDEO_SEGMENTS_JOB_TYPE);
      const qJobResult = await runJob(noKf.mediaId, VIDEO_SEGMENT_QUALITY_JOB_TYPE);
      const job = readJob(dbHandle.db, qJobResult.jobId);
      record(
        "no-keyframes: scorer fails clearly",
        job?.status === "failed" &&
          typeof job?.error_message === "string" &&
          /keyframes manifest/.test(job.error_message as string),
        `status=${String(job?.status)} msg=${String(job?.error_message).slice(0, 100)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 8: failure — non-video media → 'failed' with clear message.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case8 image" });
      const imgId = randomUUID();
      const now = new Date().toISOString();
      mediaRepo.insert({
        id: imgId,
        tripId: trip.id,
        type: "image",
        originalPath: `trips/${trip.id}/originals/${imgId}.jpg`,
        fileSize: 1024,
        mimeType: "image/jpeg",
        extension: "jpg",
        createdAt: now,
        updatedAt: now,
      });
      const qJobResult = await runJob(imgId, VIDEO_SEGMENT_QUALITY_JOB_TYPE);
      const job = readJob(dbHandle.db, qJobResult.jobId);
      record(
        "non-video: scorer fails with 'not a video'",
        job?.status === "failed" &&
          typeof job?.error_message === "string" &&
          /not a video/.test(job.error_message as string),
        `status=${String(job?.status)} msg=${String(job?.error_message)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 9: failure — soft-deleted media (P7 contract).
    // -----------------------------------------------------------------
    {
      const sdPath = path.join(tmpRoot, "sd.mp4");
      await makeTestVideo(sdPath, "testsrc", 6);
      const sdBytes = readFileSync(sdPath);
      const sd = await seedVideoMedia(storage, dbHandle.db, tripService, sdBytes, {
        title: "Case9 soft-deleted",
        duration: 6,
      });
      await runJob(sd.mediaId, VIDEO_SEGMENTS_JOB_TYPE);
      await runJob(sd.mediaId, VIDEO_KEYFRAMES_JOB_TYPE);
      mediaService.softDeleteMedia(sd.mediaId);
      const qJobResult = await runJob(sd.mediaId, VIDEO_SEGMENT_QUALITY_JOB_TYPE);
      const job = readJob(dbHandle.db, qJobResult.jobId);
      record(
        "soft-deleted: scorer fails with 'not found or soft-deleted'",
        job?.status === "failed" &&
          typeof job?.error_message === "string" &&
          /not found or soft-deleted/.test(job.error_message as string),
        `status=${String(job?.status)} msg=${String(job?.error_message)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 10: failure — no decode source (original_path NULL + no
    // proxy) → scorer fails with clear message.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case10 no-decode" });
      const noSrcId = randomUUID();
      const now = new Date().toISOString();
      // Insert video media without an original_path or proxy.
      mediaRepo.insert({
        id: noSrcId,
        tripId: trip.id,
        type: "video",
        originalPath: null,
        fileSize: null,
        mimeType: null,
        extension: null,
        createdAt: now,
        updatedAt: now,
      });
      // Seed at least one segment row so the "0 segments" guard
      // doesn't fire first (we want the decode-source guard).
      videoSegmentsRepo.insert({
        id: randomUUID(),
        mediaId: noSrcId,
        startTime: 0,
        endTime: 3,
        duration: 3,
        now,
      });
      // Seed a minimal keyframes manifest so we get to the
      // blackdetect step.
      const framesDir = path.join(
        storage.root,
        `trips/${trip.id}/derived/${noSrcId}/frames`,
      );
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(framesDir, { recursive: true });
      await writeFile(
        path.join(framesDir, "manifest.json"),
        JSON.stringify({
          workerVersion: "1.0",
          intervalSec: 1,
          configuredIntervalSec: 1,
          decodeSource: "original",
          decodeSourcePath: "nope",
          maxFrames: 200,
          sourceDurationSec: 3,
          frameCount: 0,
          frames: [],
          generatedAt: now,
        }),
      );
      const qJobResult = await runJob(noSrcId, VIDEO_SEGMENT_QUALITY_JOB_TYPE);
      const job = readJob(dbHandle.db, qJobResult.jobId);
      record(
        "no-decode-source: scorer fails clearly (empty manifest OR no decode source)",
        job?.status === "failed" &&
          typeof job?.error_message === "string" &&
          (/no decode source/.test(job.error_message as string) ||
            /has no frames/.test(job.error_message as string)),
        `status=${String(job?.status)} msg=${String(job?.error_message)}`,
      );
    }
  } finally {
    closeDatabase(dbHandle);
    await rm(tmpRoot, { recursive: true, force: true });
    console.log(`[smoke] cleaned up ${tmpRoot}`);
  }

  void existsSync;
  void videoSegmentMp4Path;

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n[smoke] summary: ${passed}/${results.length} passed`);
  if (failed > 0) {
    console.log(
      `[smoke] failures: ${results.filter((r) => !r.ok).map((r) => r.name).join(", ")}`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[smoke] uncaught error: ${describeError(err)}`);
  process.exit(1);
});
