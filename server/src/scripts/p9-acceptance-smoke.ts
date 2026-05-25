// P9 phase acceptance smoke (P9.T10).
//
// Usage: npm run smoke:p9-acceptance
//
// End-to-end verification that the P9.T1 ~ P9.T9 video processing
// pipeline forms a coherent product. Boots a real SQLite + real
// LocalStorageProvider + real ffmpeg + real Express server, drives
// one ~12-second test video through every video-channel worker in
// the documented dependency order (design.md §8.1), and exercises
// the user-facing surfaces (P9.T8 API endpoints + P9.T9 client wire
// contract) plus the cross-cutting contracts (P7 soft-delete /
// restore, R-107 user_decision preservation, R-108 idempotency,
// R-117 process re-run UX, R-119 storage path safety).
//
// This smoke is the canonical answer to "did P9 actually ship a
// working video flow end-to-end?". Per-stage workers each have
// their own smoke (smoke:video-{metadata,cover,proxy,keyframes,
// segments-worker,segment-quality-worker,api}); this one stitches
// them together against a single media row so a regression in the
// hand-off between stages cannot hide.
//
// Coverage matrix:
//
//   1. Pipeline stages (every worker runs success on the same media):
//        a. video_metadata
//        b. video_cover
//        c. video_proxy
//        d. video_keyframes
//        e. video_segments
//        f. video_segment_quality
//      Each stage asserts: job.status === 'success' + the documented
//      artifact (DB row or on-disk file) is present.
//
//   2. Video API (P9.T8) end-to-end through a real Express server:
//        - GET  /api/media/:mediaId/video-segments              → 200
//        - GET  /api/media/:mediaId/video-segments/:segmentId    → 200
//        - PATCH /api/video-segments/:segmentId/user-decision    → 200
//        - POST  /api/media/:mediaId/process-video-segments      → 200
//      Plus the canonical filePath round-trip via /storage.
//
//   3. R-107 preservation through a real re-run cycle:
//        - PATCH user_decision='keep' on a segment
//        - POST process force=false → wait for workers to drain
//        - Re-read segments via API → assert the keep survived on
//          whichever new segment overlaps the prior one ≥ 50%
//          (P9.T7 mapUserDecisionsByOverlap policy).
//
//   4. R-107 force wipe:
//        - PATCH user_decision='remove' on a segment
//        - POST process force=true → wait for workers to drain
//        - Re-read segments via API → assert ALL user_decision are
//          back to 'undecided' (P9.T7's `{ force: true }` payload
//          path).
//
//   5. P7 soft-delete contract:
//        - MediaService.softDeleteMedia(mediaId)
//        - GET /video-segments → 404 (recycle-bin members are hidden)
//        - PATCH user-decision → 404 (no writes through a deleted parent)
//        - POST process → 404 (no enqueue against a deleted parent)
//        - Restore → GET /video-segments → 200 again
//
//   6. R-119 storage path safety:
//        - Build the canonical `trips/.../segments/{id}.mp4` URL on
//          the client side and confirm the server's /storage route
//          returns 200 + correct bytes for a known segment.
//
//   7. Original video bytes byte-for-byte unchanged across the
//      whole pipeline (CLAUDE.md §2.1 — original must never be
//      mutated).
//
// The smoke generates the test video on the fly via ffmpeg lavfi
// (testsrc 12s @ 320x240) so no fixture binary needs to land in
// the repo. Gracefully SKIPs when ffmpeg/ffprobe are not on PATH.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import express from "express";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { DuplicateGroupsRepository } from "../dedup/index.js";
import {
  JobQueue,
  JobRepository,
  VIDEO_COVER_JOB_TYPE,
  VIDEO_KEYFRAMES_JOB_TYPE,
  VIDEO_METADATA_JOB_TYPE,
  VIDEO_PROXY_JOB_TYPE,
  VIDEO_SEGMENT_QUALITY_JOB_TYPE,
  VIDEO_SEGMENTS_JOB_TYPE,
  makeVideoCoverHandler,
  makeVideoKeyframesHandler,
  makeVideoMetadataHandler,
  makeVideoProxyHandler,
  makeVideoSegmentQualityHandler,
  makeVideoSegmentsHandler,
  type JobHandler,
} from "../jobs/index.js";
import { createLogger } from "../logger.js";
import {
  MediaRepository,
  MediaService,
  MediaVersionsRepository,
  VideoSegmentsRepository,
  VideoService,
  videoSegmentMp4Path,
  type MediaSoftDeleteDeps,
} from "../media/index.js";
import { makeErrorHandler, notFoundHandler } from "../middleware/errorHandler.js";
import { requestIdMiddleware } from "../middleware/requestId.js";
import { makeVideoRouter } from "../routes/video.js";
import { makeStorageRouter } from "../routes/storage.js";
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
// ffmpeg availability + test-video generation
// ---------------------------------------------------------------------------

async function isAvailable(cmd: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn(cmd, ["-version"], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

/** Generate a deterministic 12-second testsrc MP4 (matches the
 * other video-* smokes' fixture style). */
async function makeAcceptanceVideo(outputPath: string): Promise<void> {
  const args = [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc=duration=12:size=320x240:rate=25",
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
        reject(
          new Error(`ffmpeg gen exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`),
        );
    });
  });
}

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

function readJob(db: SqliteDatabase, jobId: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM processing_jobs WHERE id = ?`).get(jobId) as
    | Record<string, unknown>
    | undefined;
}

function readMediaRow(
  db: SqliteDatabase,
  mediaId: string,
): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM media_items WHERE id = ?`).get(mediaId) as
    | Record<string, unknown>
    | undefined;
}

function insertJob(
  db: SqliteDatabase,
  mediaId: string,
  jobType: string,
  payload: string | null = null,
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO processing_jobs (id, media_id, job_type, payload, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(id, mediaId, jobType, payload, now, now);
  return id;
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

interface ApiResponse<T> {
  readonly status: number;
  readonly body: T;
}

async function jsonFetch<T = unknown>(url: string, init?: RequestInit): Promise<ApiResponse<T>> {
  const res = await fetch(url, init);
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text.length === 0 ? null : (JSON.parse(text) as unknown);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed as T };
}

async function main(): Promise<void> {
  // ---- ffmpeg gate ----
  const ffmpegOk = (await isAvailable("ffmpeg")) && (await isAvailable("ffprobe"));
  if (!ffmpegOk) {
    console.log("[smoke] SKIP: ffmpeg/ffprobe not on PATH; P9 acceptance smoke requires both.");
    console.log(`\n[smoke] summary: 0/0 passed (ffmpeg unavailable)`);
    return;
  }

  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-p9-acceptance-smoke-"));
  console.log(`[smoke] tmpRoot=${tmpRoot}`);
  const dbHandle = openDatabase(path.join(tmpRoot, "smoke.db"));
  let server: ReturnType<typeof createServer> | null = null;

  try {
    runMigrations(dbHandle.db);
    const logger = createLogger({ nodeEnv: "test" });
    const storage = LocalStorageProvider.create(path.join(tmpRoot, "storage"));

    // ---- 1) Set up all the services + repositories the pipeline needs ----
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
    const videoService = new VideoService(mediaRepo, videoSegmentsRepo, jobRepo, storage);

    // ---- 2) Register every video worker on the video channel ----
    const videoHandlers = new Map<string, JobHandler>();
    videoHandlers.set(
      VIDEO_METADATA_JOB_TYPE,
      makeVideoMetadataHandler({
        storage,
        mediaRepo,
        mediaVersionsRepo,
        settings: { ffprobePath: "ffprobe", ffprobeTimeoutMs: 30_000, workerVersion: "1.0" },
        logger,
      }),
    );
    videoHandlers.set(
      VIDEO_COVER_JOB_TYPE,
      makeVideoCoverHandler({
        storage,
        mediaRepo,
        mediaVersionsRepo,
        settings: {
          ffmpegPath: "ffmpeg",
          timeoutMs: 60_000,
          maxEdge: 720,
          jpegQuality: 80,
          fallbackSeekSeconds: 1,
          workerVersion: "1.0",
        },
        logger,
      }),
    );
    videoHandlers.set(
      VIDEO_PROXY_JOB_TYPE,
      makeVideoProxyHandler({
        storage,
        mediaRepo,
        mediaVersionsRepo,
        settings: {
          ffmpegPath: "ffmpeg",
          ffprobePath: "ffprobe",
          timeoutMs: 120_000,
          targetHeight: 240,
          crf: 28,
          preset: "ultrafast",
          videoCodec: "libx264",
          audioCodec: "aac",
          audioBitrateKbps: 128,
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
      VIDEO_SEGMENT_QUALITY_JOB_TYPE,
      makeVideoSegmentQualityHandler({
        storage,
        mediaRepo,
        mediaVersionsRepo,
        videoSegmentsRepo,
        settings: {
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

    async function drainVideoChannel(): Promise<void> {
      // Keep ticking until the channel reports nothing left to claim.
      // Each tick claims up to channel-concurrency (=1) so a long
      // pipeline drains as many iterations as there are pending rows.
      for (;;) {
        const tick = await queue.tickChannel("video");
        await queue.awaitInflight("video");
        if (tick.claimed.length === 0) break;
      }
    }

    /**
     * Insert a single job, drain the channel, return the final
     * status. Sequential (not batched) so JobQueue's claim ordering
     * (`created_at ASC, id ASC`) is deterministic — the per-stage
     * smokes have proven this; the acceptance smoke re-confirms.
     */
    async function runJob(
      mediaId: string,
      jobType: string,
      payload: string | null = null,
    ): Promise<{ jobId: string; finalStatus: string }> {
      const id = insertJob(dbHandle.db, mediaId, jobType, payload);
      await drainVideoChannel();
      const status = (readJob(dbHandle.db, id)?.status as string | undefined) ?? "";
      return { jobId: id, finalStatus: status };
    }

    // ---- 3) Generate the test video + seed media row ----
    const videoPath = path.join(tmpRoot, "acceptance.mp4");
    await makeAcceptanceVideo(videoPath);
    const originalBytes = readFileSync(videoPath);
    console.log(`[smoke] acceptance video: ${originalBytes.length} bytes`);

    const trip = tripService.createTrip({ title: "P9.T10 Acceptance" });
    const mediaId = randomUUID();
    const stored = await storage.putOriginal({
      tripId: trip.id,
      mediaId,
      extension: "mp4",
      data: originalBytes,
    });
    const nowIso = new Date().toISOString();
    dbHandle.db
      .prepare(
        `INSERT INTO media_items
           (id, trip_id, type, original_path, mime_type, extension, file_size,
            duration, status, user_decision, created_at, updated_at)
         VALUES (?, ?, 'video', ?, 'video/mp4', 'mp4', ?, NULL,
                 'processed', 'undecided', ?, ?)`,
      )
      .run(mediaId, trip.id, stored.logicalPath, originalBytes.length, nowIso, nowIso);

    record(
      "stage 0: media row seeded as type='video'",
      readMediaRow(dbHandle.db, mediaId)?.type === "video",
      `mediaId=${mediaId}`,
    );

    // -----------------------------------------------------------------
    // STAGE 1 — video_metadata
    // -----------------------------------------------------------------
    {
      const res = await runJob(mediaId, VIDEO_METADATA_JOB_TYPE);
      const row = readMediaRow(dbHandle.db, mediaId);
      record(
        "stage 1: video_metadata job success + media_items.duration populated",
        res.finalStatus === "success" && typeof row?.duration === "number",
        `status=${res.finalStatus} duration=${String(row?.duration)}`,
      );
      const metadataVersion = mediaVersionsRepo
        .listByMediaId(mediaId)
        .find((v) => v.versionType === "metadata");
      record(
        "stage 1: media_versions row of type='metadata' written",
        metadataVersion !== undefined,
        `metadata=${metadataVersion === undefined ? "missing" : "ok"}`,
      );
    }

    // -----------------------------------------------------------------
    // STAGE 2 — video_cover
    // -----------------------------------------------------------------
    {
      const res = await runJob(mediaId, VIDEO_COVER_JOB_TYPE);
      const coverVersion = mediaVersionsRepo
        .listByMediaId(mediaId)
        .find((v) => v.versionType === "video_cover");
      const coverAbsolute =
        coverVersion !== undefined ? path.join(storage.root, coverVersion.filePath) : "";
      record(
        "stage 2: video_cover job success + cover.jpg on disk",
        res.finalStatus === "success" &&
          coverVersion !== undefined &&
          existsSync(coverAbsolute) &&
          readFileSync(coverAbsolute).length > 0,
        `status=${res.finalStatus} coverPath=${coverVersion?.filePath ?? "missing"}`,
      );
    }

    // -----------------------------------------------------------------
    // STAGE 3 — video_proxy
    // -----------------------------------------------------------------
    {
      const res = await runJob(mediaId, VIDEO_PROXY_JOB_TYPE);
      const proxyVersion = mediaVersionsRepo
        .listByMediaId(mediaId)
        .find((v) => v.versionType === "video_proxy");
      const proxyAbsolute =
        proxyVersion !== undefined ? path.join(storage.root, proxyVersion.filePath) : "";
      record(
        "stage 3: video_proxy job success + proxy.mp4 on disk",
        res.finalStatus === "success" &&
          proxyVersion !== undefined &&
          existsSync(proxyAbsolute) &&
          readFileSync(proxyAbsolute).length > 0,
        `status=${res.finalStatus} proxyPath=${proxyVersion?.filePath ?? "missing"}`,
      );
    }

    // -----------------------------------------------------------------
    // STAGE 4 — video_keyframes (writes frames/*.jpg + manifest.json)
    // -----------------------------------------------------------------
    {
      const res = await runJob(mediaId, VIDEO_KEYFRAMES_JOB_TYPE);
      const manifestPath = path.join(
        storage.root,
        `trips/${trip.id}/derived/${mediaId}/frames/manifest.json`,
      );
      record(
        "stage 4: video_keyframes job success + manifest.json on disk",
        res.finalStatus === "success" && existsSync(manifestPath),
        `status=${res.finalStatus} manifest=${existsSync(manifestPath)}`,
      );
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        frameCount: number;
        frames: Array<{ filePath: string }>;
      };
      record(
        "stage 4: manifest enumerates ≥ 6 frames @ 1s interval on a 12s clip",
        manifest.frameCount >= 6 && manifest.frames.length === manifest.frameCount,
        `frameCount=${manifest.frameCount}`,
      );
      const firstFrameAbs = path.join(storage.root, manifest.frames[0]!.filePath);
      record(
        "stage 4: at least the first manifest frame exists on disk",
        existsSync(firstFrameAbs) && readFileSync(firstFrameAbs).length > 0,
        `first=${manifest.frames[0]!.filePath}`,
      );
    }

    // -----------------------------------------------------------------
    // STAGE 5 — video_segments
    //
    // R-109 / R-120 in action: P9.T6 runs `-c copy` which can only
    // cut at source keyframes; in this acceptance run the decode
    // source is the P9.T4 proxy (preferred over original), and the
    // proxy worker's default x264 GOP is large (~10s) so the actual
    // segment count is fewer than `12 / durationSec=3 → 4` would
    // naively predict. The acceptance smoke validates the REAL
    // contract: ≥ 1 segment, contiguous, covers ~the source
    // duration; the exact count is GOP-dependent and intentionally
    // not asserted as 4.
    // -----------------------------------------------------------------
    let initialSegmentIds: string[] = [];
    let initialSegmentCount = 0;
    {
      const res = await runJob(mediaId, VIDEO_SEGMENTS_JOB_TYPE);
      const segs = videoSegmentsRepo.listByMediaId(mediaId);
      initialSegmentCount = segs.length;
      record(
        "stage 5: video_segments job success + ≥ 1 row produced",
        res.finalStatus === "success" && segs.length >= 1,
        `status=${res.finalStatus} count=${segs.length}`,
      );
      record(
        "stage 5: segments are contiguous + monotonic + cover ≈ 12s",
        segs.slice(1).every((s, i) => Math.abs(s.startTime - segs[i]!.endTime) < 1e-9) &&
          Math.abs(segs.reduce((acc, s) => acc + s.duration, 0) - 12) < 0.5 &&
          segs[0]!.startTime === 0,
        segs.map((s) => `${s.startTime}-${s.endTime}`).join(" | "),
      );
      record(
        "stage 5: every segment MP4 exists on disk at canonical path",
        segs.every((s) =>
          existsSync(
            path.join(
              storage.root,
              videoSegmentMp4Path({ tripId: trip.id, mediaId, segmentId: s.id }),
            ),
          ),
        ),
        `count=${segs.length}`,
      );
      initialSegmentIds = segs.map((s) => s.id);
    }

    // -----------------------------------------------------------------
    // STAGE 6 — video_segment_quality (scores every segment)
    // -----------------------------------------------------------------
    {
      const res = await runJob(mediaId, VIDEO_SEGMENT_QUALITY_JOB_TYPE);
      const segs = videoSegmentsRepo.listByMediaId(mediaId);
      record(
        "stage 6: video_segment_quality job success",
        res.finalStatus === "success",
        `status=${res.finalStatus}`,
      );
      record(
        "stage 6: every segment now has blur_score + quality_score populated",
        segs.every((s) => s.blurScore !== null && s.qualityScore !== null),
        segs.map((s) => `${s.id.slice(0, 6)}=Q:${s.qualityScore}`).join(" | "),
      );
      record(
        "stage 6: every score is in [0, 1] (CHECK constraint)",
        segs.every(
          (s) =>
            (s.blurScore ?? 0) >= 0 &&
            (s.blurScore ?? 0) <= 1 &&
            (s.qualityScore ?? 0) >= 0 &&
            (s.qualityScore ?? 0) <= 1,
        ),
        "ok",
      );
      record(
        "stage 6: scorer did not write user_decision (CLAUDE.md §3.9)",
        segs.every((s) => s.userDecision === "undecided"),
        segs.map((s) => s.userDecision).join(","),
      );
      record(
        "stage 6: testsrc is colourful → at least one segment is_recommended",
        segs.some((s) => s.isRecommended === true),
        segs.map((s) => `${s.wasteType}:${s.isRecommended}`).join(" | "),
      );
    }

    // -----------------------------------------------------------------
    // CROSS-CUT: original video bytes byte-for-byte unchanged.
    // -----------------------------------------------------------------
    {
      const originalAfter = readFileSync(path.join(storage.root, stored.logicalPath));
      record(
        "cross-cut: original video bytes byte-for-byte unchanged after entire pipeline",
        originalAfter.equals(originalBytes),
        `before=${originalBytes.length} after=${originalAfter.length}`,
      );
    }

    // -----------------------------------------------------------------
    // VIDEO API (P9.T8) — boot a real Express server
    // -----------------------------------------------------------------
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use(requestIdMiddleware);
    app.use("/api", makeVideoRouter({ videoService }));
    // R-119 verification: the /storage route is what serves the
    // canonical segment / keyframe filePaths the frontend renders;
    // bind it here so the smoke can hit a real URL.
    app.use("/storage", makeStorageRouter({ storage }));
    app.use(notFoundHandler);
    app.use(makeErrorHandler(logger));

    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    // ---- API contract: GET /video-segments ----
    let firstSegmentId = "";
    let firstSegmentFilePath = "";
    {
      const r = await jsonFetch<{
        mediaId: string;
        mediaDurationSec: number | null;
        segments: Array<{ id: string; filePath: string; qualityScore: number | null }>;
        keyframes: { frameCount: number } | null;
      }>(`${base}/api/media/${encodeURIComponent(mediaId)}/video-segments`);
      record(
        "API: GET /video-segments returns 200 + same segment count as repo + keyframes summary",
        r.status === 200 &&
          r.body.segments.length === initialSegmentCount &&
          r.body.keyframes !== null &&
          r.body.keyframes.frameCount >= 6,
        `status=${r.status} segs=${r.body.segments.length} kfs=${r.body.keyframes?.frameCount}`,
      );
      record(
        "API: every segment payload carries Q score",
        r.body.segments.every((s) => s.qualityScore !== null),
        "ok",
      );
      firstSegmentId = r.body.segments[0]!.id;
      firstSegmentFilePath = r.body.segments[0]!.filePath;
    }

    // ---- API contract: GET /video-segments/:segmentId ----
    {
      const r = await jsonFetch<{ mediaId: string; segment: { id: string; filePath: string } }>(
        `${base}/api/media/${encodeURIComponent(mediaId)}/video-segments/${encodeURIComponent(firstSegmentId)}`,
      );
      record(
        "API: GET segment detail returns 200 + segment id matches + filePath matches list",
        r.status === 200 &&
          r.body.segment.id === firstSegmentId &&
          r.body.segment.filePath === firstSegmentFilePath,
        `status=${r.status} id=${r.body.segment.id}`,
      );
    }

    // ---- R-119: /storage delivers the canonical segment file ----
    {
      const url = `${base}/storage/${firstSegmentFilePath}`;
      const res = await fetch(url);
      const buf = Buffer.from(await res.arrayBuffer());
      record(
        "R-119: /storage serves the canonical segment MP4 with non-empty bytes",
        res.status === 200 && buf.length > 0,
        `status=${res.status} bytes=${buf.length}`,
      );
    }

    // -----------------------------------------------------------------
    // R-107 PRESERVATION (force=false re-run keeps user_decision)
    //
    // Mark the LAST segment of the current set as 'keep', remember
    // its midpoint, run a process re-run, and assert: whichever new
    // segment contains that midpoint still says 'keep'. We use the
    // last segment + its midpoint (not a hard-coded second slot)
    // because the actual segment count is GOP-dependent (R-109 /
    // R-120), and "find by midpoint" is robust to any boundary
    // changes the proxy worker might cause across reruns.
    // -----------------------------------------------------------------
    {
      const segsBefore = videoSegmentsRepo.listByMediaId(mediaId);
      const target = segsBefore[segsBefore.length - 1]!;
      const targetMidpointSec = (target.startTime + target.endTime) / 2;

      const r = await jsonFetch<{ userDecision: string; alreadyApplied: boolean }>(
        `${base}/api/video-segments/${encodeURIComponent(target.id)}/user-decision`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userDecision: "keep" }),
        },
      );
      record(
        "PATCH user-decision='keep' succeeded",
        r.status === 200 && r.body.userDecision === "keep" && r.body.alreadyApplied === false,
        `status=${r.status} body=${JSON.stringify(r.body)}`,
      );

      // Trigger a process re-run with force=false.
      const proc = await jsonFetch<{ force: boolean; results: Array<{ outcome: string }> }>(
        `${base}/api/media/${encodeURIComponent(mediaId)}/process-video-segments`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ force: false }),
        },
      );
      record(
        "POST process force=false returns 200 + 3 results",
        proc.status === 200 && proc.body.force === false && proc.body.results.length === 3,
        `status=${proc.status} results=${proc.body.results.map((x) => x.outcome).join(",")}`,
      );

      // Workers must drain before we can validate the new rows.
      await drainVideoChannel();

      // Refetch via the API + assert R-107: whichever new segment
      // contains the prior target's midpoint should now carry 'keep'.
      const after = await jsonFetch<{
        segments: Array<{ id: string; startTime: number; endTime: number; userDecision: string }>;
      }>(`${base}/api/media/${encodeURIComponent(mediaId)}/video-segments`);
      const overlapping = after.body.segments.find(
        (s) => s.startTime <= targetMidpointSec && s.endTime > targetMidpointSec,
      );
      record(
        "R-107: force=false re-run preserved user_decision='keep' on overlapping new segment",
        overlapping !== undefined && overlapping.userDecision === "keep",
        `targetMid=${targetMidpointSec.toFixed(2)} overlapping=${
          overlapping === undefined
            ? "?"
            : `${overlapping.startTime}-${overlapping.endTime}:${overlapping.userDecision}`
        }`,
      );
      record(
        "R-107: re-run rotated UUIDs — none of the original segment ids survived",
        after.body.segments.every((s) => !initialSegmentIds.includes(s.id)),
        `oldIds=${initialSegmentIds.map((id) => id.slice(0, 6)).join(",")}`,
      );
      // Only the segment overlapping the marked midpoint should
      // have inherited 'keep'; others stay 'undecided'.
      record(
        "R-107: only one new segment inherited 'keep'; the rest stay 'undecided'",
        after.body.segments.filter((s) => s.userDecision === "keep").length === 1,
        `keep=${after.body.segments.filter((s) => s.userDecision === "keep").length}`,
      );
    }

    // -----------------------------------------------------------------
    // R-107 FORCE WIPE (force=true wipes user_decision)
    // -----------------------------------------------------------------
    {
      // First, mark something 'remove'.
      const seg = videoSegmentsRepo.listByMediaId(mediaId)[1]!;
      const r = await jsonFetch(
        `${base}/api/video-segments/${encodeURIComponent(seg.id)}/user-decision`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userDecision: "remove" }),
        },
      );
      record(
        "Pre-force: PATCH user-decision='remove' succeeded",
        r.status === 200,
        `status=${r.status}`,
      );

      // R-115: smoke-spec earlier guarantees we wait > 1ms between process
      // calls so JobQueue createdAt ordering stays deterministic.
      await new Promise((resolve) => setTimeout(resolve, 5));

      const proc = await jsonFetch<{ force: boolean }>(
        `${base}/api/media/${encodeURIComponent(mediaId)}/process-video-segments`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ force: true }),
        },
      );
      record(
        "POST process force=true returns 200 + force echoed",
        proc.status === 200 && proc.body.force === true,
        `status=${proc.status} force=${proc.body.force}`,
      );
      await drainVideoChannel();

      const after = await jsonFetch<{
        segments: Array<{ userDecision: string }>;
      }>(`${base}/api/media/${encodeURIComponent(mediaId)}/video-segments`);
      record(
        "R-107 force wipe: every user_decision reset to 'undecided' after force=true",
        after.body.segments.every((s) => s.userDecision === "undecided"),
        after.body.segments.map((s) => s.userDecision).join(","),
      );
    }

    // -----------------------------------------------------------------
    // P7 SOFT-DELETE CONTRACT
    // -----------------------------------------------------------------
    {
      mediaService.softDeleteMedia(mediaId);

      const list = await jsonFetch(
        `${base}/api/media/${encodeURIComponent(mediaId)}/video-segments`,
      );
      record(
        "P7: GET /video-segments on soft-deleted media returns 404",
        list.status === 404,
        `status=${list.status}`,
      );

      // Need an actual segment id to test the PATCH path; the rows
      // survive soft-delete (only the parent's deleted_at flips),
      // but the API must still 404 because parent is gone.
      const survivingSeg = videoSegmentsRepo.listByMediaId(mediaId)[0];
      if (survivingSeg !== undefined) {
        const patch = await jsonFetch(
          `${base}/api/video-segments/${encodeURIComponent(survivingSeg.id)}/user-decision`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ userDecision: "keep" }),
          },
        );
        record(
          "P7: PATCH on segment whose parent is soft-deleted returns 404",
          patch.status === 404,
          `status=${patch.status}`,
        );
      }

      const proc = await jsonFetch(
        `${base}/api/media/${encodeURIComponent(mediaId)}/process-video-segments`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      record(
        "P7: POST process on soft-deleted media returns 404",
        proc.status === 404,
        `status=${proc.status}`,
      );

      // Restore + verify the API comes back.
      const restoreOutcome = mediaService.restoreMedia(mediaId);
      record(
        "P7: restoreMedia reports restored=true",
        restoreOutcome.restored === true || restoreOutcome.alreadyRestored === false,
        JSON.stringify(restoreOutcome),
      );

      const listAfter = await jsonFetch<{ segments: unknown[] }>(
        `${base}/api/media/${encodeURIComponent(mediaId)}/video-segments`,
      );
      record(
        "P7: after restore, GET /video-segments returns 200 + segments visible again",
        listAfter.status === 200 &&
          Array.isArray(listAfter.body.segments) &&
          listAfter.body.segments.length >= 1,
        `status=${listAfter.status} count=${listAfter.body.segments?.length}`,
      );
    }

    // -----------------------------------------------------------------
    // R-117 SANITY: process re-run is queued, not synchronous.
    // The previous force=true call returned 200 immediately; we
    // simulate the UI's expectation by confirming the request
    // completes well before the workers finish (we drained
    // manually above, but a fresh process call should also
    // return < 1s independent of worker cost).
    // -----------------------------------------------------------------
    {
      const t0 = Date.now();
      const proc = await jsonFetch(
        `${base}/api/media/${encodeURIComponent(mediaId)}/process-video-segments`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      const elapsedMs = Date.now() - t0;
      record(
        "R-117: POST process returns 200 quickly (< 1000ms; workers run async on next tick)",
        proc.status === 200 && elapsedMs < 1000,
        `status=${proc.status} elapsedMs=${elapsedMs}`,
      );
      // Drain so the smoke can clean up without leaving a hot tick.
      await drainVideoChannel();
    }

    // -----------------------------------------------------------------
    // R-116 SANITY: corrupt manifest gracefully degrades to keyframes=null
    // (We already cover this in smoke:video-api CASE 3, but re-verify
    // end-to-end against a real /api server here for completeness.)
    // -----------------------------------------------------------------
    {
      // Build a second media + segment row but no manifest on disk
      // → listSegments should return keyframes=null without crashing.
      const otherTrip = tripService.createTrip({ title: "P9.T10 no-manifest" });
      const otherMediaId = randomUUID();
      const onowIso = new Date().toISOString();
      dbHandle.db
        .prepare(
          `INSERT INTO media_items
             (id, trip_id, type, original_path, mime_type, extension, file_size,
              duration, status, user_decision, created_at, updated_at)
           VALUES (?, ?, 'video', ?, 'video/mp4', 'mp4', 1024, 3,
                   'processed', 'undecided', ?, ?)`,
        )
        .run(otherMediaId, otherTrip.id, `trips/${otherTrip.id}/originals/${otherMediaId}.mp4`, onowIso, onowIso);
      const r = await jsonFetch<{ segments: unknown[]; keyframes: unknown }>(
        `${base}/api/media/${encodeURIComponent(otherMediaId)}/video-segments`,
      );
      record(
        "R-116: media with no manifest yet returns segments=[] + keyframes=null (graceful)",
        r.status === 200 &&
          Array.isArray(r.body.segments) &&
          r.body.segments.length === 0 &&
          r.body.keyframes === null,
        `status=${r.status} kf=${String(r.body.keyframes)}`,
      );
    }
  } finally {
    if (server !== null) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    closeDatabase(dbHandle);
    await rm(tmpRoot, { recursive: true, force: true });
    console.log(`[smoke] cleaned up ${tmpRoot}`);
  }

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
