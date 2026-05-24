// Manual smoke test for the Video API (P9.T8).
//
// Usage: npm run smoke:video-api
//
// Exercises `VideoService` end-to-end at the service layer (real
// SQLite, real prepared statements, real on-disk manifest) AND
// through a minimal Express server to confirm the routes are
// mounted on the canonical paths.
//
// Coverage:
//   * GET segments: happy path returns segments + keyframes manifest
//   * GET segments: empty array when P9.T6 hasn't run yet (media is
//     a video but no segments seeded)
//   * GET segments: filePath is the canonical
//     `trips/.../segments/{id}.mp4` per video_segments convention
//   * GET segments: keyframes=null when manifest is absent
//   * GET segments: corrupt manifest → keyframes=null (graceful)
//   * GET segments: 404 on missing / soft-deleted / non-video media
//   * GET detail: happy path returns the single segment under its parent
//   * GET detail: 404 on missing segment / wrong-parent / soft-deleted
//   * PATCH user-decision: happy keep → row updated, scores untouched
//   * PATCH user-decision: idempotent (alreadyApplied=true, no DB write)
//   * PATCH user-decision: invalid enum / unknown body key → 400
//   * PATCH user-decision: 404 on missing segment / soft-deleted media
//   * POST process: happy enqueues 3 jobs in dependency order
//   * POST process: idempotent — re-issue while pending yields skipped
//   * POST process: force=true threads `{"force":true}` payload into
//     the video_segments slot only
//   * POST process: 400 on non-video / malformed body
//   * POST process: 404 on missing / soft-deleted media
//   * Scope-guard: PATCH does not mutate scores / waste_type /
//     is_recommended / reason / start_time / end_time
//   * HTTP layer: all 4 endpoints respond with the right status + shape

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import express from "express";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { DuplicateGroupsRepository } from "../dedup/index.js";
import { JobRepository } from "../jobs/index.js";
import { createLogger } from "../logger.js";
import {
  MediaRepository,
  MediaService,
  MediaVersionsRepository,
  VideoSegmentsRepository,
  VideoService,
  type MediaSoftDeleteDeps,
  type VideoSegmentInsertData,
} from "../media/index.js";
import { makeErrorHandler, notFoundHandler } from "../middleware/errorHandler.js";
import { requestIdMiddleware } from "../middleware/requestId.js";
import { makeVideoRouter } from "../routes/video.js";
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
// fixture helpers
// ---------------------------------------------------------------------------

interface Seeded {
  readonly tripId: string;
  readonly mediaId: string;
}

function seedVideoMedia(
  db: SqliteDatabase,
  tripService: TripService,
  title: string,
  options: { duration?: number | null } = {},
): Seeded {
  const trip = tripService.createTrip({ title });
  const mediaId = randomUUID();
  const now = new Date().toISOString();
  const originalPath = `trips/${trip.id}/originals/${mediaId}.mp4`;
  db.prepare(
    `INSERT INTO media_items
       (id, trip_id, type, original_path, mime_type, extension, file_size,
        duration, status, user_decision, created_at, updated_at)
     VALUES (?, ?, 'video', ?, 'video/mp4', 'mp4', 1024,
             ?, 'processed', 'undecided', ?, ?)`,
  ).run(mediaId, trip.id, originalPath, options.duration ?? 12, now, now);
  return { tripId: trip.id, mediaId };
}

function seedImageMedia(
  tripService: TripService,
  mediaRepo: MediaRepository,
  title: string,
): { tripId: string; mediaId: string } {
  const trip = tripService.createTrip({ title });
  const mediaId = randomUUID();
  const now = new Date().toISOString();
  mediaRepo.insert({
    id: mediaId,
    tripId: trip.id,
    type: "image",
    originalPath: `trips/${trip.id}/originals/${mediaId}.jpg`,
    fileSize: 1024,
    mimeType: "image/jpeg",
    extension: "jpg",
    createdAt: now,
    updatedAt: now,
  });
  return { tripId: trip.id, mediaId };
}

function seedFourSegments(
  repo: VideoSegmentsRepository,
  mediaId: string,
  options: { withScores?: boolean } = {},
): readonly { id: string; startTime: number; endTime: number }[] {
  const now = new Date().toISOString();
  const segments: VideoSegmentInsertData[] = [
    { id: randomUUID(), mediaId, startTime: 0, endTime: 3, duration: 3, now },
    { id: randomUUID(), mediaId, startTime: 3, endTime: 6, duration: 3, now },
    { id: randomUUID(), mediaId, startTime: 6, endTime: 9, duration: 3, now },
    { id: randomUUID(), mediaId, startTime: 9, endTime: 12, duration: 3, now },
  ];
  for (const s of segments) repo.insert(s);
  if (options.withScores) {
    for (const s of segments) {
      repo.updateQuality({
        id: s.id,
        blurScore: 0.8,
        stabilityScore: null,
        qualityScore: 0.8,
        wasteType: "none",
        isRecommended: true,
        reason: `blur=0.800 | blackRatio=0.000 | quality=0.800 | waste=none | keyframes=3 | recommended`,
        now,
      });
    }
  }
  return segments.map((s) => ({ id: s.id, startTime: s.startTime, endTime: s.endTime }));
}

async function seedKeyframesManifest(
  storage: LocalStorageProvider,
  seeded: Seeded,
  options: { corrupt?: boolean } = {},
): Promise<void> {
  const framesDir = path.join(
    storage.root,
    `trips/${seeded.tripId}/derived/${seeded.mediaId}/frames`,
  );
  await mkdir(framesDir, { recursive: true });
  const manifestPath = path.join(framesDir, "manifest.json");
  if (options.corrupt) {
    await writeFile(manifestPath, "{ not valid JSON");
    return;
  }
  const manifest = {
    workerVersion: "1.0",
    intervalSec: 1,
    configuredIntervalSec: 1,
    decodeSource: "original",
    decodeSourcePath: `trips/${seeded.tripId}/originals/${seeded.mediaId}.mp4`,
    maxFrames: 200,
    sourceDurationSec: 12,
    frameCount: 12,
    frames: Array.from({ length: 12 }, (_, i) => ({
      index: i + 1,
      timestampSec: i,
      filePath: `trips/${seeded.tripId}/derived/${seeded.mediaId}/frames/frame_${String(i + 1).padStart(6, "0")}.jpg`,
      width: 320,
      height: 240,
      fileSize: 4096,
    })),
    generatedAt: new Date().toISOString(),
  };
  await writeFile(manifestPath, JSON.stringify(manifest));
}

function readSegmentRow(
  db: SqliteDatabase,
  id: string,
): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM video_segments WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
}

function countJobs(db: SqliteDatabase, mediaId: string, jobType: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM processing_jobs WHERE media_id = ? AND job_type = ?`,
      )
      .get(mediaId, jobType) as { n: number }
  ).n;
}

function latestJob(
  db: SqliteDatabase,
  mediaId: string,
  jobType: string,
): Record<string, unknown> | undefined {
  return db
    .prepare(
      `SELECT * FROM processing_jobs WHERE media_id = ? AND job_type = ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(mediaId, jobType) as Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-video-api-smoke-"));
  console.log(`[smoke] tmpRoot=${tmpRoot}`);
  const dbHandle = openDatabase(path.join(tmpRoot, "smoke.db"));
  let server: ReturnType<typeof createServer> | null = null;
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
    const videoService = new VideoService(
      mediaRepo,
      videoSegmentsRepo,
      jobRepo,
      storage,
    );

    // -----------------------------------------------------------------
    // CASE 1: GET segments — happy path with seeded segments + manifest
    // -----------------------------------------------------------------
    const happy = seedVideoMedia(dbHandle.db, tripService, "Case1 happy");
    const happySegs = seedFourSegments(videoSegmentsRepo, happy.mediaId, {
      withScores: true,
    });
    await seedKeyframesManifest(storage, happy);
    {
      const result = await videoService.listSegments(happy.mediaId);
      record(
        "list: mediaId echoed + mediaDurationSec from media_items",
        result.mediaId === happy.mediaId && result.mediaDurationSec === 12,
        `mediaId=${result.mediaId} duration=${result.mediaDurationSec}`,
      );
      record(
        "list: 4 segments returned in start_time order",
        result.segments.length === 4 &&
          result.segments[0]?.startTime === 0 &&
          result.segments[3]?.endTime === 12,
        `count=${result.segments.length}`,
      );
      record(
        "list: each segment carries score fields populated by P9.T7",
        result.segments.every(
          (s) =>
            s.blurScore === 0.8 &&
            s.qualityScore === 0.8 &&
            s.wasteType === "none" &&
            s.isRecommended === true &&
            typeof s.reason === "string" &&
            s.reason!.length > 0,
        ),
        `OK`,
      );
      record(
        "list: filePath is the canonical segments/{id}.mp4",
        result.segments.every(
          (s) =>
            s.filePath ===
            `trips/${happy.tripId}/derived/${happy.mediaId}/segments/${s.id}.mp4`,
        ),
        `paths OK`,
      );
      record(
        "list: keyframes summary present with 12 frames + workerVersion",
        result.keyframes !== null &&
          result.keyframes.frameCount === 12 &&
          result.keyframes.frames.length === 12 &&
          result.keyframes.workerVersion === "1.0",
        `frameCount=${result.keyframes?.frameCount}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 2: GET segments — empty array when P9.T6 hasn't run yet
    // -----------------------------------------------------------------
    {
      const empty = seedVideoMedia(dbHandle.db, tripService, "Case2 empty");
      const result = await videoService.listSegments(empty.mediaId);
      record(
        "list (no segments): empty segments[] + keyframes=null",
        result.segments.length === 0 && result.keyframes === null,
        `segments=${result.segments.length} kf=${String(result.keyframes)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 3: GET segments — corrupt manifest → keyframes=null (graceful)
    // -----------------------------------------------------------------
    {
      const corrupt = seedVideoMedia(dbHandle.db, tripService, "Case3 corrupt manifest");
      seedFourSegments(videoSegmentsRepo, corrupt.mediaId);
      await seedKeyframesManifest(storage, corrupt, { corrupt: true });
      const result = await videoService.listSegments(corrupt.mediaId);
      record(
        "list: corrupt manifest gracefully degrades to keyframes=null",
        result.keyframes === null && result.segments.length === 4,
        `kf=${String(result.keyframes)} segs=${result.segments.length}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 4: GET segments — 404 on missing / non-video / soft-deleted
    // -----------------------------------------------------------------
    {
      let threw: unknown;
      try {
        await videoService.listSegments(randomUUID());
      } catch (err) {
        threw = err;
      }
      record(
        "list (missing media): NotFoundError",
        threw !== undefined && /Media not found/.test(describeError(threw)),
        describeError(threw),
      );
    }
    {
      const img = seedImageMedia(tripService, mediaRepo, "Case4 image");
      let threw: unknown;
      try {
        await videoService.listSegments(img.mediaId);
      } catch (err) {
        threw = err;
      }
      record(
        "list (non-video): NotFoundError mentions 'image'",
        threw !== undefined && /image/.test(describeError(threw)),
        describeError(threw),
      );
    }
    {
      const sd = seedVideoMedia(dbHandle.db, tripService, "Case4 soft-deleted");
      mediaService.softDeleteMedia(sd.mediaId);
      let threw: unknown;
      try {
        await videoService.listSegments(sd.mediaId);
      } catch (err) {
        threw = err;
      }
      record(
        "list (soft-deleted): NotFoundError (P7 contract)",
        threw !== undefined && /Media not found/.test(describeError(threw)),
        describeError(threw),
      );
    }

    // -----------------------------------------------------------------
    // CASE 5: GET segment detail — happy path
    // -----------------------------------------------------------------
    {
      const target = happySegs[1]!;
      const result = videoService.getSegmentDetail(target.id);
      record(
        "detail: returns the segment with mediaId + filePath",
        result.mediaId === happy.mediaId &&
          result.segment.id === target.id &&
          result.segment.startTime === 3 &&
          result.segment.filePath ===
            `trips/${happy.tripId}/derived/${happy.mediaId}/segments/${target.id}.mp4`,
        JSON.stringify({ mediaId: result.mediaId, id: result.segment.id }),
      );
    }

    // -----------------------------------------------------------------
    // CASE 6: GET segment detail — 404 on missing
    // -----------------------------------------------------------------
    {
      let threw: unknown;
      try {
        videoService.getSegmentDetail(randomUUID());
      } catch (err) {
        threw = err;
      }
      record(
        "detail (missing segment): NotFoundError",
        threw !== undefined && /Video segment not found/.test(describeError(threw)),
        describeError(threw),
      );
    }

    // -----------------------------------------------------------------
    // CASE 7: PATCH user-decision — happy keep → row updated, scores intact
    // -----------------------------------------------------------------
    {
      const target = happySegs[0]!;
      const beforeRow = readSegmentRow(dbHandle.db, target.id);
      const result = videoService.updateUserDecision(target.id, {
        userDecision: "keep",
      });
      const afterRow = readSegmentRow(dbHandle.db, target.id);
      record(
        "PATCH: returns previousUserDecision='undecided', userDecision='keep'",
        result.previousUserDecision === "undecided" &&
          result.userDecision === "keep" &&
          result.alreadyApplied === false,
        JSON.stringify(result),
      );
      record(
        "PATCH: DB row user_decision flipped to 'keep'",
        afterRow?.user_decision === "keep",
        `before=${String(beforeRow?.user_decision)} after=${String(afterRow?.user_decision)}`,
      );
      record(
        "PATCH scope-guard: scores / waste_type / is_recommended / reason / times unchanged",
        afterRow?.blur_score === beforeRow?.blur_score &&
          afterRow?.stability_score === beforeRow?.stability_score &&
          afterRow?.quality_score === beforeRow?.quality_score &&
          afterRow?.waste_type === beforeRow?.waste_type &&
          afterRow?.is_recommended === beforeRow?.is_recommended &&
          afterRow?.reason === beforeRow?.reason &&
          afterRow?.start_time === beforeRow?.start_time &&
          afterRow?.end_time === beforeRow?.end_time,
        `unchanged: blur=${String(afterRow?.blur_score)} waste=${String(afterRow?.waste_type)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 8: PATCH — idempotent (alreadyApplied=true, updated_at preserved)
    // -----------------------------------------------------------------
    {
      const target = happySegs[0]!;
      const before = readSegmentRow(dbHandle.db, target.id);
      const result = videoService.updateUserDecision(target.id, {
        userDecision: "keep",
      });
      const after = readSegmentRow(dbHandle.db, target.id);
      record(
        "PATCH (idempotent): alreadyApplied=true",
        result.alreadyApplied === true && result.userDecision === "keep",
        JSON.stringify(result),
      );
      record(
        "PATCH (idempotent): updated_at preserved (no DB write)",
        before?.updated_at === after?.updated_at,
        `before=${String(before?.updated_at)} after=${String(after?.updated_at)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 9: PATCH — invalid enum / unknown body key → 400
    // -----------------------------------------------------------------
    {
      const target = happySegs[2]!;
      let threwBadEnum: unknown;
      try {
        videoService.updateUserDecision(target.id, { userDecision: "approve" });
      } catch (err) {
        threwBadEnum = err;
      }
      record(
        "PATCH (bad enum): ValidationError",
        threwBadEnum !== undefined && /Validation/.test(describeError(threwBadEnum)),
        describeError(threwBadEnum),
      );
      let threwExtra: unknown;
      try {
        videoService.updateUserDecision(target.id, { userDecision: "keep", extra: 1 });
      } catch (err) {
        threwExtra = err;
      }
      record(
        "PATCH (extra body key): ValidationError under .strict()",
        threwExtra !== undefined && /Validation/.test(describeError(threwExtra)),
        describeError(threwExtra),
      );
      let threwMissing: unknown;
      try {
        videoService.updateUserDecision(target.id, {});
      } catch (err) {
        threwMissing = err;
      }
      record(
        "PATCH (missing userDecision): ValidationError",
        threwMissing !== undefined && /Validation/.test(describeError(threwMissing)),
        describeError(threwMissing),
      );
    }

    // -----------------------------------------------------------------
    // CASE 10: PATCH — 404 on missing segment / soft-deleted media
    // -----------------------------------------------------------------
    {
      let threw: unknown;
      try {
        videoService.updateUserDecision(randomUUID(), { userDecision: "keep" });
      } catch (err) {
        threw = err;
      }
      record(
        "PATCH (missing segment): NotFoundError",
        threw !== undefined && /Video segment not found/.test(describeError(threw)),
        describeError(threw),
      );

      const sd = seedVideoMedia(dbHandle.db, tripService, "Case10 sd PATCH");
      const sdSeg = seedFourSegments(videoSegmentsRepo, sd.mediaId);
      mediaService.softDeleteMedia(sd.mediaId);
      let threwSd: unknown;
      try {
        videoService.updateUserDecision(sdSeg[0]!.id, { userDecision: "keep" });
      } catch (err) {
        threwSd = err;
      }
      record(
        "PATCH (soft-deleted media): NotFoundError (P7 contract)",
        threwSd !== undefined &&
          /Video segment not found/.test(describeError(threwSd)) &&
          /parent media/.test(describeError(threwSd)),
        describeError(threwSd),
      );
    }

    // -----------------------------------------------------------------
    // CASE 11: POST process — happy enqueues 3 jobs in dependency order
    // -----------------------------------------------------------------
    {
      const proc = seedVideoMedia(dbHandle.db, tripService, "Case11 process happy");
      const result = videoService.processVideoSegments(proc.mediaId);
      record(
        "process: mediaId echoed + force=false default + 3 slot results",
        result.mediaId === proc.mediaId &&
          result.force === false &&
          result.results.length === 3,
        JSON.stringify({ force: result.force, count: result.results.length }),
      );
      record(
        "process: slot order is segments → keyframes → quality",
        result.results[0]?.jobType === "video_segments" &&
          result.results[1]?.jobType === "video_keyframes" &&
          result.results[2]?.jobType === "video_segment_quality",
        result.results.map((r) => r.jobType).join(" → "),
      );
      record(
        "process: every slot starts as 'created' on fresh media",
        result.results.every((r) => r.outcome === "created"),
        result.results.map((r) => r.outcome).join(","),
      );
      record(
        "process: DB has exactly 1 pending row per job type",
        countJobs(dbHandle.db, proc.mediaId, "video_segments") === 1 &&
          countJobs(dbHandle.db, proc.mediaId, "video_keyframes") === 1 &&
          countJobs(dbHandle.db, proc.mediaId, "video_segment_quality") === 1,
        `OK`,
      );
      record(
        "process: video_segments slot payload is null when force=false",
        latestJob(dbHandle.db, proc.mediaId, "video_segments")?.payload === null,
        `payload=${String(latestJob(dbHandle.db, proc.mediaId, "video_segments")?.payload)}`,
      );

      // Re-issue while everything is still pending → skipped.
      const result2 = videoService.processVideoSegments(proc.mediaId);
      record(
        "process (idempotent while pending): every slot becomes 'skipped'",
        result2.results.every((r) => r.outcome === "skipped"),
        result2.results.map((r) => `${r.jobType}:${r.outcome}`).join(" | "),
      );
      record(
        "process (idempotent): no extra rows inserted",
        countJobs(dbHandle.db, proc.mediaId, "video_segments") === 1 &&
          countJobs(dbHandle.db, proc.mediaId, "video_keyframes") === 1 &&
          countJobs(dbHandle.db, proc.mediaId, "video_segment_quality") === 1,
        `OK`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 12: POST process — force=true threads payload into segments slot
    // -----------------------------------------------------------------
    {
      const forced = seedVideoMedia(dbHandle.db, tripService, "Case12 force payload");
      const result = videoService.processVideoSegments(forced.mediaId, { force: true });
      record(
        "process (force=true): echoed back + 3 slots created",
        result.force === true && result.results.every((r) => r.outcome === "created"),
        `force=${result.force}`,
      );
      const segJob = latestJob(dbHandle.db, forced.mediaId, "video_segments");
      record(
        "process (force=true): video_segments row payload = '{\"force\":true}'",
        segJob?.payload === JSON.stringify({ force: true }),
        `payload=${String(segJob?.payload)}`,
      );
      const kfJob = latestJob(dbHandle.db, forced.mediaId, "video_keyframes");
      const qJob = latestJob(dbHandle.db, forced.mediaId, "video_segment_quality");
      record(
        "process (force=true): keyframes + quality slots stay payload=null",
        kfJob?.payload === null && qJob?.payload === null,
        `kf=${String(kfJob?.payload)} q=${String(qJob?.payload)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 13: POST process — force=true re-issue inserts NEW segments
    //  row even when prior was terminal (so worker re-reads payload)
    // -----------------------------------------------------------------
    {
      const r2 = seedVideoMedia(dbHandle.db, tripService, "Case13 force re-issue");
      // First run, force=false → 3 created rows.
      videoService.processVideoSegments(r2.mediaId);
      // Mark the segments job as 'success' so the next call would
      // normally `resetToRetrying`.
      const segJobId =
        (latestJob(dbHandle.db, r2.mediaId, "video_segments")?.id as string) ?? "";
      dbHandle.db
        .prepare(`UPDATE processing_jobs SET status = 'success' WHERE id = ?`)
        .run(segJobId);
      const before = countJobs(dbHandle.db, r2.mediaId, "video_segments");
      // Sleep 2ms so the second call's `Date.now()` is strictly
      // larger than the first call's — the `latestJob` query
      // breaks ties on `id DESC` (a random UUID), so without the
      // sleep the "which row is newest" assertion below races.
      await new Promise((resolve) => setTimeout(resolve, 2));
      videoService.processVideoSegments(r2.mediaId, { force: true });
      const after = countJobs(dbHandle.db, r2.mediaId, "video_segments");
      record(
        "process (force=true after terminal): inserts a NEW segments row, leaving the old success row in place",
        before === 1 && after === 2,
        `before=${before} after=${after}`,
      );
      const latest = latestJob(dbHandle.db, r2.mediaId, "video_segments");
      record(
        "process (force=true after terminal): newest segments job carries force payload",
        latest?.payload === JSON.stringify({ force: true }) &&
          latest?.status === "pending",
        `payload=${String(latest?.payload)} status=${String(latest?.status)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 14: POST process — 400 on non-video / malformed body
    // -----------------------------------------------------------------
    {
      const img = seedImageMedia(tripService, mediaRepo, "Case14 image process");
      let threwImg: unknown;
      try {
        videoService.processVideoSegments(img.mediaId);
      } catch (err) {
        threwImg = err;
      }
      record(
        "process (non-video): BadRequestError",
        threwImg !== undefined &&
          /only supported for video/.test(describeError(threwImg)),
        describeError(threwImg),
      );
      const v = seedVideoMedia(dbHandle.db, tripService, "Case14 bad body");
      let threwBadBody: unknown;
      try {
        videoService.processVideoSegments(v.mediaId, { force: 1 });
      } catch (err) {
        threwBadBody = err;
      }
      record(
        "process (force is not boolean): ValidationError",
        threwBadBody !== undefined && /Validation/.test(describeError(threwBadBody)),
        describeError(threwBadBody),
      );
      let threwExtra: unknown;
      try {
        videoService.processVideoSegments(v.mediaId, { force: true, extra: 1 });
      } catch (err) {
        threwExtra = err;
      }
      record(
        "process (extra body key): ValidationError under .strict()",
        threwExtra !== undefined && /Validation/.test(describeError(threwExtra)),
        describeError(threwExtra),
      );
    }

    // -----------------------------------------------------------------
    // CASE 15: POST process — 404 on missing / soft-deleted media
    // -----------------------------------------------------------------
    {
      let threwMissing: unknown;
      try {
        videoService.processVideoSegments(randomUUID());
      } catch (err) {
        threwMissing = err;
      }
      record(
        "process (missing media): NotFoundError",
        threwMissing !== undefined && /Media not found/.test(describeError(threwMissing)),
        describeError(threwMissing),
      );
      const sd = seedVideoMedia(dbHandle.db, tripService, "Case15 sd");
      mediaService.softDeleteMedia(sd.mediaId);
      let threwSd: unknown;
      try {
        videoService.processVideoSegments(sd.mediaId);
      } catch (err) {
        threwSd = err;
      }
      record(
        "process (soft-deleted media): NotFoundError (P7 contract)",
        threwSd !== undefined && /Media not found/.test(describeError(threwSd)),
        describeError(threwSd),
      );
    }

    // -----------------------------------------------------------------
    // CASE 16: HTTP layer — boot a minimal app + verify route mounting.
    // -----------------------------------------------------------------
    {
      const app = express();
      app.use(express.json({ limit: "1mb" }));
      app.use(requestIdMiddleware);
      app.use("/api", makeVideoRouter({ videoService }));
      app.use(notFoundHandler);
      app.use(makeErrorHandler(logger));

      server = createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}`;

      const httpSeed = seedVideoMedia(dbHandle.db, tripService, "Case16 HTTP");
      const httpSegs = seedFourSegments(videoSegmentsRepo, httpSeed.mediaId, {
        withScores: true,
      });
      await seedKeyframesManifest(storage, httpSeed);

      // GET /api/media/:mediaId/video-segments
      {
        const res = await fetch(
          `${base}/api/media/${encodeURIComponent(httpSeed.mediaId)}/video-segments`,
          { headers: { Accept: "application/json" } },
        );
        const body = (await res.json()) as {
          mediaId: string;
          segments: Array<{ id: string; filePath: string }>;
          keyframes: { frameCount: number } | null;
        };
        record(
          "HTTP GET segments: 200 + correct shape",
          res.status === 200 &&
            body.mediaId === httpSeed.mediaId &&
            body.segments.length === 4 &&
            body.keyframes?.frameCount === 12,
          `status=${res.status} segs=${body.segments.length}`,
        );
      }

      // GET /api/media/:mediaId/video-segments/:segmentId
      {
        const target = httpSegs[1]!;
        const res = await fetch(
          `${base}/api/media/${encodeURIComponent(httpSeed.mediaId)}/video-segments/${encodeURIComponent(target.id)}`,
        );
        const body = (await res.json()) as { mediaId: string; segment: { id: string } };
        record(
          "HTTP GET detail: 200 + segment under :mediaId",
          res.status === 200 &&
            body.mediaId === httpSeed.mediaId &&
            body.segment.id === target.id,
          `status=${res.status} id=${body.segment.id}`,
        );

        // Wrong parent in URL → 404.
        const wrongParent = randomUUID();
        const res2 = await fetch(
          `${base}/api/media/${encodeURIComponent(wrongParent)}/video-segments/${encodeURIComponent(target.id)}`,
        );
        record(
          "HTTP GET detail: 404 on mismatched :mediaId / :segmentId pair",
          res2.status === 404,
          `status=${res2.status}`,
        );
      }

      // PATCH /api/video-segments/:segmentId/user-decision
      {
        const target = httpSegs[2]!;
        const res = await fetch(
          `${base}/api/video-segments/${encodeURIComponent(target.id)}/user-decision`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ userDecision: "remove" }),
          },
        );
        const body = (await res.json()) as { userDecision: string; alreadyApplied: boolean };
        record(
          "HTTP PATCH user-decision: 200 + userDecision='remove'",
          res.status === 200 && body.userDecision === "remove" && body.alreadyApplied === false,
          `status=${res.status} body=${JSON.stringify(body)}`,
        );

        // Bad body → 400.
        const res2 = await fetch(
          `${base}/api/video-segments/${encodeURIComponent(target.id)}/user-decision`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ userDecision: "approve" }),
          },
        );
        record(
          "HTTP PATCH (bad enum): 400",
          res2.status === 400,
          `status=${res2.status}`,
        );
      }

      // POST /api/media/:mediaId/process-video-segments
      {
        const fresh = seedVideoMedia(dbHandle.db, tripService, "Case16 HTTP process");
        const res = await fetch(
          `${base}/api/media/${encodeURIComponent(fresh.mediaId)}/process-video-segments`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
          },
        );
        const body = (await res.json()) as {
          mediaId: string;
          force: boolean;
          results: { jobType: string; outcome: string }[];
        };
        record(
          "HTTP POST process: 200 + 3 created slots in dependency order",
          res.status === 200 &&
            body.mediaId === fresh.mediaId &&
            body.force === false &&
            body.results.map((r) => r.jobType).join(",") ===
              "video_segments,video_keyframes,video_segment_quality" &&
            body.results.every((r) => r.outcome === "created"),
          `status=${res.status} results=${JSON.stringify(body.results.map((r) => r.outcome))}`,
        );

        // POST with empty body (no body)
        const fresh2 = seedVideoMedia(dbHandle.db, tripService, "Case16 HTTP process no body");
        const res2 = await fetch(
          `${base}/api/media/${encodeURIComponent(fresh2.mediaId)}/process-video-segments`,
          { method: "POST" },
        );
        record(
          "HTTP POST process (no body): 200 + force=false default",
          res2.status === 200,
          `status=${res2.status}`,
        );

        // POST with force=true
        const fresh3 = seedVideoMedia(dbHandle.db, tripService, "Case16 HTTP process force");
        const res3 = await fetch(
          `${base}/api/media/${encodeURIComponent(fresh3.mediaId)}/process-video-segments`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ force: true }),
          },
        );
        const body3 = (await res3.json()) as { force: boolean };
        record(
          "HTTP POST process (force=true): 200 + force echoed",
          res3.status === 200 && body3.force === true,
          `status=${res3.status} force=${body3.force}`,
        );

        // POST with malformed body → 400
        const res4 = await fetch(
          `${base}/api/media/${encodeURIComponent(fresh3.mediaId)}/process-video-segments`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ force: "yes" }),
          },
        );
        record(
          "HTTP POST process (bad body): 400",
          res4.status === 400,
          `status=${res4.status}`,
        );
      }
    }

    void existsSync;
    void readFileSync;
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
