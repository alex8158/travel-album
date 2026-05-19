// Manual smoke test for the Quality_Selector auto-trigger chain
// (P6.T5 follow-up).
//
// Usage: npm run smoke:quality-selector-trigger
//
// Uses `JobQueue.tickChannel("image")` (not the legacy
// `ImageChannelExecutor`) because the selector's job_type is
// `quality_selector_run` — not `image_*`-prefixed — so the legacy
// executor's `LIKE 'image_%'` claim predicate refuses to pick it up.
// `JobQueue` claims by the registered handlers' job_types, matching
// the production wiring in `server/src/index.ts`.
//
// Coverage:
//   * Payload codec round-trip + defensive decode of null / garbage /
//     wrong shape / unknown scope.
//   * applyRecommendation defense check: throws on non-member
//     winnerMediaId and leaves the group state unchanged.
//   * Auto-enqueue from image_quality_finalize:
//       - finalize success enqueues exactly one pending
//         `quality_selector_run` with the trip-scope payload.
//       - selector tick reads payload and applies recommendation
//         across the group.
//       - finalize failure does NOT enqueue.
//   * Payload routing:
//       - trip-scope → selectForTrip.
//       - group-scope → only the named group is updated.
//       - null / malformed → fallback to trip-from-media path.
//   * `user_confirmed = 1` group is not overwritten by the selector
//     handler (no exception, recommendation column stays at the user
//     value).
//   * Idempotency: re-running the same job yields the same state.
//   * No P5 / P6 regression: blur / exposure / color sub-trees and
//     per-dimension columns survive.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { DuplicateGroupsRepository } from "../dedup/index.js";
import {
  IMAGE_QUALITY_BLUR_JOB_TYPE,
  IMAGE_QUALITY_COLOR_JOB_TYPE,
  IMAGE_QUALITY_EXPOSURE_JOB_TYPE,
  IMAGE_QUALITY_FINALIZE_JOB_TYPE,
  JobQueue,
  JobRepository,
  makeImageQualityBlurHandler,
  makeImageQualityColorHandler,
  makeImageQualityExposureHandler,
  makeImageQualityFinalizeHandler,
  type JobHandler,
} from "../jobs/index.js";
import { createLogger } from "../logger.js";
import { MediaAnalysisRepository, MediaRepository } from "../media/index.js";
import {
  QUALITY_SELECTOR_JOB_TYPE,
  QualitySelectorService,
  decodeQualitySelectorPayload,
  encodeQualitySelectorPayload,
  makeQualitySelectorHandler,
} from "../quality/index.js";
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

async function makeColouredJpeg(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
): Promise<Buffer> {
  const channels = 3;
  const pixels = Buffer.alloc(width * height * channels);
  for (let i = 0; i < width * height; i += 1) {
    const off = i * channels;
    pixels[off] = r;
    pixels[off + 1] = g;
    pixels[off + 2] = b;
  }
  return sharp(pixels, { raw: { width, height, channels } }).jpeg({ quality: 95 }).toBuffer();
}

async function makeSharpCheckerboardJpeg(
  width: number,
  height: number,
  tile: number,
): Promise<Buffer> {
  const channels = 3;
  const pixels = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const cell = (Math.floor(x / tile) + Math.floor(y / tile)) % 2;
      const c = cell === 0 ? 12 : 240;
      const idx = (y * width + x) * channels;
      pixels[idx] = c;
      pixels[idx + 1] = c;
      pixels[idx + 2] = c;
    }
  }
  return sharp(pixels, { raw: { width, height, channels } }).jpeg({ quality: 95 }).toBuffer();
}

function seedMedia(
  db: SqliteDatabase,
  tripId: string,
  args: { storagePath?: string; createdAt?: string } = {},
): string {
  const mediaId = randomUUID();
  const now = args.createdAt ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO media_items
       (id, trip_id, type, original_path, mime_type, extension, file_size,
        status, user_decision, created_at, updated_at)
     VALUES (?, ?, 'image', ?, 'image/jpeg', 'jpg', 1024,
             'uploaded', 'undecided', ?, ?)`,
  ).run(mediaId, tripId, args.storagePath ?? `trips/${tripId}/originals/${mediaId}.jpg`, now, now);
  return mediaId;
}

function seedAnalysis(
  db: SqliteDatabase,
  mediaId: string,
  args: { qualityScore: number; sharpness?: number; exposure?: number; color?: number },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO media_analysis (
       id, media_id,
       sharpness_score, exposure_score, color_score,
       quality_score,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    mediaId,
    args.sharpness ?? null,
    args.exposure ?? null,
    args.color ?? null,
    args.qualityScore,
    now,
    now,
  );
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
    `INSERT INTO processing_jobs (id, media_id, job_type, status, payload, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(id, mediaId, jobType, payload, now, now);
  return id;
}

function readJob(db: SqliteDatabase, jobId: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM processing_jobs WHERE id = ?`).get(jobId) as
    | Record<string, unknown>
    | undefined;
}

function findPendingJobs(
  db: SqliteDatabase,
  mediaId: string,
  jobType: string,
): Record<string, unknown>[] {
  return db
    .prepare(
      `SELECT * FROM processing_jobs WHERE media_id = ? AND job_type = ? AND status = 'pending'`,
    )
    .all(mediaId, jobType) as Record<string, unknown>[];
}

function readGroup(db: SqliteDatabase, groupId: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM duplicate_groups WHERE id = ?`).get(groupId) as
    | Record<string, unknown>
    | undefined;
}

function readItems(db: SqliteDatabase, groupId: string): Record<string, unknown>[] {
  return db
    .prepare(`SELECT * FROM duplicate_group_items WHERE group_id = ? ORDER BY media_id ASC`)
    .all(groupId) as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-quality-selector-trigger-smoke-"));
  const dbPath = path.join(tmpRoot, "smoke.db");
  const storageRoot = path.join(tmpRoot, "storage");
  console.log(`[smoke] tmpRoot=${tmpRoot}`);

  const dbHandle = openDatabase(dbPath);
  try {
    runMigrations(dbHandle.db);

    const storage = LocalStorageProvider.create(storageRoot);
    const logger = createLogger({ nodeEnv: "test" });
    const tripService = new TripService(new TripRepository(dbHandle.db));
    const mediaRepo = new MediaRepository(dbHandle.db);
    const mediaAnalysisRepo = new MediaAnalysisRepository(dbHandle.db);
    const duplicateGroupsRepo = new DuplicateGroupsRepository(dbHandle.db);
    const jobRepo = new JobRepository(dbHandle.db);

    const finalizeSettings = {
      blurWeight: 0.45,
      exposureWeight: 0.35,
      colorWeight: 0.2,
      colorFloor: 0.5,
      workerVersion: "smoke-1.0",
    };

    const qualitySelectorService = new QualitySelectorService({
      duplicateGroupsRepo,
      mediaAnalysisRepo,
      mediaRepo,
      logger,
    });

    const imageHandlers = new Map<string, JobHandler>();
    imageHandlers.set(
      IMAGE_QUALITY_BLUR_JOB_TYPE,
      makeImageQualityBlurHandler({
        storage,
        mediaRepo,
        mediaAnalysisRepo,
        settings: {
          blurThresholdBlurry: 50,
          blurThresholdMaybe: 120,
          maxEdge: 256,
          workerVersion: "smoke-1.0",
        },
        logger,
      }),
    );
    imageHandlers.set(
      IMAGE_QUALITY_EXPOSURE_JOB_TYPE,
      makeImageQualityExposureHandler({
        storage,
        mediaRepo,
        mediaAnalysisRepo,
        settings: {
          maxEdge: 256,
          underMeanThreshold: 70,
          overMeanThreshold: 185,
          darkRatioThreshold: 0.5,
          brightRatioThreshold: 0.5,
          workerVersion: "smoke-1.0",
        },
        logger,
      }),
    );
    imageHandlers.set(
      IMAGE_QUALITY_COLOR_JOB_TYPE,
      makeImageQualityColorHandler({
        storage,
        mediaRepo,
        mediaAnalysisRepo,
        settings: {
          maxEdge: 256,
          lowSaturationThreshold: 0.1,
          highSaturationThreshold: 0.75,
          castThreshold: 30,
          lowContrastThreshold: 30,
          workerVersion: "smoke-1.0",
        },
        logger,
      }),
    );
    imageHandlers.set(
      IMAGE_QUALITY_FINALIZE_JOB_TYPE,
      makeImageQualityFinalizeHandler({
        mediaRepo,
        mediaAnalysisRepo,
        jobRepo,
        settings: finalizeSettings,
        logger,
      }),
    );
    imageHandlers.set(
      QUALITY_SELECTOR_JOB_TYPE,
      makeQualitySelectorHandler({ service: qualitySelectorService, mediaRepo, logger }),
    );

    // 60s pollInterval keeps the auto-polling silent during the test;
    // we drive every tick by hand. `zombieTimeoutMs=0` disables the
    // recovery sweep so it never claims jobs we didn't expect.
    const queue = new JobQueue({
      jobRepo,
      logger,
      channels: [
        { name: "image", concurrency: 1, handlers: imageHandlers, pollIntervalMs: 60_000 },
        { name: "video", concurrency: 1, handlers: new Map(), pollIntervalMs: 60_000 },
        { name: "ai", concurrency: 1, handlers: new Map(), pollIntervalMs: 60_000 },
      ],
      zombieTimeoutMs: 0,
    });

    /** Drain one job from the image channel. Returns the claimed
     * jobId / jobType (or null when no pending image job exists)
     * + the final status after the handler resolved. */
    async function runOneImageJob(): Promise<{
      jobId: string | null;
      jobType: string | null;
      status: string | null;
      errorMessage: string | null;
    }> {
      const tick = await queue.tickChannel("image");
      await queue.awaitInflight("image");
      const claimed = tick.claimed[0];
      if (!claimed) return { jobId: null, jobType: null, status: null, errorMessage: null };
      const row = readJob(dbHandle.db, claimed.jobId);
      return {
        jobId: claimed.jobId,
        jobType: claimed.jobType,
        status: (row?.status as string) ?? null,
        errorMessage: (row?.error_message as string | null) ?? null,
      };
    }

    /**
     * Drain pending image jobs of a specific type — convenience for
     * the per-dimension workers which we don't care about
     * individually. Stops when the next claim is for a different
     * jobType or when the channel goes idle.
     */
    async function runUntilNoPendingOfType(jobType: string): Promise<void> {
      // Keep looping until we either run a job of the wanted type or
      // the channel is idle. Safety cap to avoid infinite loops.
      for (let i = 0; i < 64; i += 1) {
        const pending = (
          dbHandle.db
            .prepare(
              `SELECT COUNT(*) AS n FROM processing_jobs WHERE job_type = ? AND status = 'pending'`,
            )
            .get(jobType) as { n: number }
        ).n;
        if (pending === 0) return;
        // Run one job — could be of the desired type or could be of
        // a different type (FIFO across all image_* + selector).
        const r = await runOneImageJob();
        if (r.jobId === null) return;
      }
    }

    try {
      // -----------------------------------------------------------------
      // CASE A: payload codec round-trip
      // -----------------------------------------------------------------
      {
        const encodedTrip = encodeQualitySelectorPayload({ scope: "trip", tripId: "trip-x" });
        const decodedTrip = decodeQualitySelectorPayload(encodedTrip);
        record(
          "payload: trip-scope round-trips",
          decodedTrip?.scope === "trip" && decodedTrip.tripId === "trip-x",
          JSON.stringify(decodedTrip),
        );
        const encodedGroup = encodeQualitySelectorPayload({ scope: "group", groupId: "grp-y" });
        const decodedGroup = decodeQualitySelectorPayload(encodedGroup);
        record(
          "payload: group-scope round-trips",
          decodedGroup?.scope === "group" && decodedGroup.groupId === "grp-y",
          JSON.stringify(decodedGroup),
        );
        record("payload: null → null", decodeQualitySelectorPayload(null) === null, "");
        record(
          "payload: garbage JSON → null",
          decodeQualitySelectorPayload("{not json") === null,
          "",
        );
        record(
          "payload: wrong shape → null",
          decodeQualitySelectorPayload('{"scope":"trip"}') === null,
          "",
        );
        record(
          "payload: unknown scope → null",
          decodeQualitySelectorPayload('{"scope":"mystery","tripId":"x"}') === null,
          "",
        );
      }

      // -----------------------------------------------------------------
      // CASE B: applyRecommendation defense check
      // -----------------------------------------------------------------
      {
        const trip = tripService.createTrip({ title: "CaseB defense" });
        const memberId = seedMedia(dbHandle.db, trip.id);
        const outsiderId = seedMedia(dbHandle.db, trip.id);
        const groupId = randomUUID();
        const now = new Date().toISOString();
        duplicateGroupsRepo.createGroupWithItems(
          {
            id: groupId,
            tripId: trip.id,
            groupType: "exact",
            createdAt: now,
            updatedAt: now,
          },
          [
            {
              id: randomUUID(),
              mediaId: memberId,
              recommendation: "undecided",
              reason: null,
              userDecision: "undecided",
              createdAt: now,
              updatedAt: now,
            },
          ],
        );
        let threw: unknown;
        try {
          duplicateGroupsRepo.applyRecommendation({
            groupId,
            winnerMediaId: outsiderId,
            perItemReasons: new Map([
              [outsiderId, { recommendation: "keep" as const, reason: "smuggled" }],
            ]),
            updatedAt: new Date().toISOString(),
          });
        } catch (err) {
          threw = err;
        }
        record(
          "defense: applyRecommendation throws on non-member winner",
          threw instanceof Error && /not a member of group/.test(threw.message),
          threw instanceof Error ? threw.message : String(threw),
        );
        const row = readGroup(dbHandle.db, groupId);
        record(
          "defense: group.recommended_media_id stayed NULL after rejected call",
          row?.recommended_media_id === null,
          `recommended=${String(row?.recommended_media_id)}`,
        );
      }

      // -----------------------------------------------------------------
      // CASE 1: full chain — blur + exposure + color + finalize
      //         auto-enqueue + selector handler applies
      // -----------------------------------------------------------------
      const trip1 = tripService.createTrip({ title: "Case1 chain" });
      const winnerBytes = await makeSharpCheckerboardJpeg(96, 96, 4);
      const loserBytes = await makeColouredJpeg(64, 64, 128, 128, 128);

      async function seedWithBytes(bytes: Buffer): Promise<string> {
        const mediaId = randomUUID();
        const stored = await storage.putOriginal({
          tripId: trip1.id,
          mediaId,
          extension: "jpg",
          data: bytes,
        });
        const now = new Date().toISOString();
        dbHandle.db
          .prepare(
            `INSERT INTO media_items
             (id, trip_id, type, original_path, mime_type, extension, file_size,
              status, user_decision, created_at, updated_at)
           VALUES (?, ?, 'image', ?, 'image/jpeg', 'jpg', ?,
                   'uploaded', 'undecided', ?, ?)`,
          )
          .run(mediaId, trip1.id, stored.logicalPath, bytes.length, now, now);
        return mediaId;
      }

      const winnerMediaId = await seedWithBytes(winnerBytes);
      const loserMediaId = await seedWithBytes(loserBytes);

      const groupNow = new Date().toISOString();
      const groupId = randomUUID();
      duplicateGroupsRepo.createGroupWithItems(
        {
          id: groupId,
          tripId: trip1.id,
          groupType: "exact",
          createdAt: groupNow,
          updatedAt: groupNow,
        },
        [
          {
            id: randomUUID(),
            mediaId: winnerMediaId,
            recommendation: "undecided",
            reason: null,
            userDecision: "undecided",
            createdAt: groupNow,
            updatedAt: groupNow,
          },
          {
            id: randomUUID(),
            mediaId: loserMediaId,
            recommendation: "undecided",
            reason: null,
            userDecision: "undecided",
            createdAt: groupNow,
            updatedAt: groupNow,
          },
        ],
      );

      // Run blur / exposure / color for both media so finalize has
      // something to aggregate. Insert all the jobs, then drain.
      for (const mid of [winnerMediaId, loserMediaId]) {
        insertJob(dbHandle.db, mid, IMAGE_QUALITY_BLUR_JOB_TYPE);
        insertJob(dbHandle.db, mid, IMAGE_QUALITY_EXPOSURE_JOB_TYPE);
        insertJob(dbHandle.db, mid, IMAGE_QUALITY_COLOR_JOB_TYPE);
      }
      await runUntilNoPendingOfType(IMAGE_QUALITY_BLUR_JOB_TYPE);
      await runUntilNoPendingOfType(IMAGE_QUALITY_EXPOSURE_JOB_TYPE);
      await runUntilNoPendingOfType(IMAGE_QUALITY_COLOR_JOB_TYPE);

      // Run finalize for the winner.
      const finalizeJobId = insertJob(dbHandle.db, winnerMediaId, IMAGE_QUALITY_FINALIZE_JOB_TYPE);
      const finalizeRun = await runOneImageJob();
      record(
        "chain: finalize tick success",
        finalizeRun.jobId === finalizeJobId &&
          finalizeRun.jobType === IMAGE_QUALITY_FINALIZE_JOB_TYPE &&
          finalizeRun.status === "success",
        JSON.stringify(finalizeRun),
      );

      const pendingSelectorJobs = findPendingJobs(
        dbHandle.db,
        winnerMediaId,
        QUALITY_SELECTOR_JOB_TYPE,
      );
      record(
        "chain: finalize success enqueues exactly one quality_selector_run job",
        pendingSelectorJobs.length === 1,
        `count=${pendingSelectorJobs.length}`,
      );
      const selectorPayload = decodeQualitySelectorPayload(
        (pendingSelectorJobs[0]?.payload as string | null) ?? null,
      );
      record(
        "chain: enqueued selector job has scope='trip' + tripId from media",
        selectorPayload?.scope === "trip" && selectorPayload.tripId === trip1.id,
        JSON.stringify(selectorPayload),
      );

      // Drive the selector handler — JobQueue claims by registered
      // job_types so quality_selector_run goes through cleanly.
      const selectorRun = await runOneImageJob();
      record(
        "chain: selector tick success",
        selectorRun.jobType === QUALITY_SELECTOR_JOB_TYPE && selectorRun.status === "success",
        JSON.stringify(selectorRun),
      );
      const groupRow1 = readGroup(dbHandle.db, groupId);
      record(
        "chain: group.recommended_media_id set to a member",
        groupRow1?.recommended_media_id === winnerMediaId ||
          groupRow1?.recommended_media_id === loserMediaId,
        `recommended=${String(groupRow1?.recommended_media_id)}`,
      );
      const items1 = readItems(dbHandle.db, groupId);
      const someKeep = items1.some((r) => r["recommendation"] === "keep");
      const someRemove = items1.some((r) => r["recommendation"] === "remove");
      record(
        "chain: items have recommendation written (one 'keep', one 'remove')",
        someKeep && someRemove,
        JSON.stringify(items1.map((r) => ({ m: r["media_id"], r: r["recommendation"] }))),
      );
      record(
        "chain: items.reason populated (non-null on every row)",
        items1.every((r) => r["reason"] !== null && (r["reason"] as string).length > 0),
        JSON.stringify(items1.map((r) => r["reason"])),
      );
      record(
        "chain: items.user_decision left at 'undecided' (selector doesn't touch user choice)",
        items1.every((r) => r["user_decision"] === "undecided"),
        JSON.stringify(items1.map((r) => r["user_decision"])),
      );

      // -----------------------------------------------------------------
      // CASE 2: idempotency — re-run the selector job
      // -----------------------------------------------------------------
      {
        const before = readGroup(dbHandle.db, groupId);
        const recommendedBefore = before?.recommended_media_id;
        const jobId = insertJob(
          dbHandle.db,
          winnerMediaId,
          QUALITY_SELECTOR_JOB_TYPE,
          encodeQualitySelectorPayload({ scope: "trip", tripId: trip1.id }),
        );
        const run = await runOneImageJob();
        record(
          "idempotent: re-run selector tick success",
          run.jobId === jobId && run.status === "success",
          JSON.stringify(run),
        );
        const after = readGroup(dbHandle.db, groupId);
        record(
          "idempotent: recommended_media_id unchanged",
          after?.recommended_media_id === recommendedBefore,
          `before=${String(recommendedBefore)} after=${String(after?.recommended_media_id)}`,
        );
      }

      // -----------------------------------------------------------------
      // CASE 3: user_confirmed=1 group is NOT overwritten
      // -----------------------------------------------------------------
      {
        const trip3 = tripService.createTrip({ title: "Case3 confirmed" });
        const userPickId = seedMedia(dbHandle.db, trip3.id);
        const higherQualityId = seedMedia(dbHandle.db, trip3.id);
        seedAnalysis(dbHandle.db, userPickId, { qualityScore: 0.4 });
        seedAnalysis(dbHandle.db, higherQualityId, { qualityScore: 0.9 });
        const cgNow = new Date().toISOString();
        const confirmedGroupId = randomUUID();
        duplicateGroupsRepo.createGroupWithItems(
          {
            id: confirmedGroupId,
            tripId: trip3.id,
            groupType: "exact",
            recommendedMediaId: userPickId,
            userConfirmed: true,
            createdAt: cgNow,
            updatedAt: cgNow,
          },
          [
            {
              id: randomUUID(),
              mediaId: userPickId,
              recommendation: "keep",
              reason: "user confirmed",
              userDecision: "keep",
              createdAt: cgNow,
              updatedAt: cgNow,
            },
            {
              id: randomUUID(),
              mediaId: higherQualityId,
              recommendation: "remove",
              reason: "user dropped",
              userDecision: "remove",
              createdAt: cgNow,
              updatedAt: cgNow,
            },
          ],
        );
        insertJob(
          dbHandle.db,
          userPickId,
          QUALITY_SELECTOR_JOB_TYPE,
          encodeQualitySelectorPayload({ scope: "group", groupId: confirmedGroupId }),
        );
        const run = await runOneImageJob();
        record(
          "confirmed-group: selector tick success",
          run.jobType === QUALITY_SELECTOR_JOB_TYPE && run.status === "success",
          JSON.stringify(run),
        );
        const row = readGroup(dbHandle.db, confirmedGroupId);
        record(
          "confirmed-group: recommended_media_id NOT overwritten",
          row?.recommended_media_id === userPickId,
          `recommended=${String(row?.recommended_media_id)}`,
        );
        record(
          "confirmed-group: user_confirmed stays 1",
          row?.user_confirmed === 1,
          `user_confirmed=${String(row?.user_confirmed)}`,
        );
        const items = readItems(dbHandle.db, confirmedGroupId);
        const pick = items.find((r) => r["media_id"] === userPickId);
        const drop = items.find((r) => r["media_id"] === higherQualityId);
        record(
          "confirmed-group: items.user_decision preserved",
          pick?.user_decision === "keep" && drop?.user_decision === "remove",
          JSON.stringify({ p: pick?.user_decision, d: drop?.user_decision }),
        );
        record(
          "confirmed-group: items.recommendation NOT touched (stays user's keep/remove)",
          pick?.recommendation === "keep" && drop?.recommendation === "remove",
          JSON.stringify({ p: pick?.recommendation, d: drop?.recommendation }),
        );
      }

      // -----------------------------------------------------------------
      // CASE 4: group-scope payload runs selectForGroup only
      // -----------------------------------------------------------------
      {
        const trip4 = tripService.createTrip({ title: "Case4 group scope" });
        const a1 = seedMedia(dbHandle.db, trip4.id);
        const a2 = seedMedia(dbHandle.db, trip4.id);
        seedAnalysis(dbHandle.db, a1, { qualityScore: 0.5 });
        seedAnalysis(dbHandle.db, a2, { qualityScore: 0.9 });
        const groupA = randomUUID();
        const cgNow = new Date().toISOString();
        duplicateGroupsRepo.createGroupWithItems(
          {
            id: groupA,
            tripId: trip4.id,
            groupType: "exact",
            createdAt: cgNow,
            updatedAt: cgNow,
          },
          [a1, a2].map((m) => ({
            id: randomUUID(),
            mediaId: m,
            recommendation: "undecided",
            reason: null,
            userDecision: "undecided",
            createdAt: cgNow,
            updatedAt: cgNow,
          })),
        );
        const b1 = seedMedia(dbHandle.db, trip4.id);
        const b2 = seedMedia(dbHandle.db, trip4.id);
        seedAnalysis(dbHandle.db, b1, { qualityScore: 0.3 });
        seedAnalysis(dbHandle.db, b2, { qualityScore: 0.7 });
        const groupB = randomUUID();
        duplicateGroupsRepo.createGroupWithItems(
          {
            id: groupB,
            tripId: trip4.id,
            groupType: "exact",
            createdAt: cgNow,
            updatedAt: cgNow,
          },
          [b1, b2].map((m) => ({
            id: randomUUID(),
            mediaId: m,
            recommendation: "undecided",
            reason: null,
            userDecision: "undecided",
            createdAt: cgNow,
            updatedAt: cgNow,
          })),
        );

        insertJob(
          dbHandle.db,
          a1,
          QUALITY_SELECTOR_JOB_TYPE,
          encodeQualitySelectorPayload({ scope: "group", groupId: groupA }),
        );
        const run = await runOneImageJob();
        record(
          "group-scope: selector tick success",
          run.jobType === QUALITY_SELECTOR_JOB_TYPE && run.status === "success",
          JSON.stringify(run),
        );
        const rowA = readGroup(dbHandle.db, groupA);
        const rowB = readGroup(dbHandle.db, groupB);
        record(
          "group-scope: groupA.recommended = a2 (highest quality)",
          rowA?.recommended_media_id === a2,
          `recommended=${String(rowA?.recommended_media_id)}`,
        );
        record(
          "group-scope: groupB.recommended_media_id stayed NULL (not in scope)",
          rowB?.recommended_media_id === null,
          `recommended=${String(rowB?.recommended_media_id)}`,
        );
      }

      // -----------------------------------------------------------------
      // CASE 5: missing payload → fallback to trip-from-media
      // -----------------------------------------------------------------
      {
        const trip5 = tripService.createTrip({ title: "Case5 missing payload" });
        const m1 = seedMedia(dbHandle.db, trip5.id);
        const m2 = seedMedia(dbHandle.db, trip5.id);
        seedAnalysis(dbHandle.db, m1, { qualityScore: 0.2 });
        seedAnalysis(dbHandle.db, m2, { qualityScore: 0.85 });
        const cgNow = new Date().toISOString();
        const g5 = randomUUID();
        duplicateGroupsRepo.createGroupWithItems(
          {
            id: g5,
            tripId: trip5.id,
            groupType: "exact",
            createdAt: cgNow,
            updatedAt: cgNow,
          },
          [m1, m2].map((m) => ({
            id: randomUUID(),
            mediaId: m,
            recommendation: "undecided",
            reason: null,
            userDecision: "undecided",
            createdAt: cgNow,
            updatedAt: cgNow,
          })),
        );
        insertJob(dbHandle.db, m1, QUALITY_SELECTOR_JOB_TYPE, null); // no payload
        const run = await runOneImageJob();
        record(
          "missing-payload: selector falls back to trip-from-media + tick success",
          run.jobType === QUALITY_SELECTOR_JOB_TYPE && run.status === "success",
          JSON.stringify(run),
        );
        const row = readGroup(dbHandle.db, g5);
        record(
          "missing-payload: group.recommended_media_id = highest-quality media",
          row?.recommended_media_id === m2,
          `recommended=${String(row?.recommended_media_id)}`,
        );
      }

      // -----------------------------------------------------------------
      // CASE 6: failed finalize → NO selector job enqueued
      // -----------------------------------------------------------------
      {
        const trip6 = tripService.createTrip({ title: "Case6 finalize failure" });
        const m = seedMedia(dbHandle.db, trip6.id);
        const now = new Date().toISOString();
        // media_analysis row with ALL scores NULL → finalize fails.
        dbHandle.db
          .prepare(
            `INSERT INTO media_analysis (id, media_id, created_at, updated_at) VALUES (?, ?, ?, ?)`,
          )
          .run(randomUUID(), m, now, now);
        insertJob(dbHandle.db, m, IMAGE_QUALITY_FINALIZE_JOB_TYPE);
        const run = await runOneImageJob();
        record(
          "finalize-failure: tick failed + error mentions 'no dimensions'",
          run.jobType === IMAGE_QUALITY_FINALIZE_JOB_TYPE &&
            run.status === "failed" &&
            /no dimensions available/.test(run.errorMessage ?? ""),
          `status=${run.status} err=${run.errorMessage}`,
        );
        const pending = findPendingJobs(dbHandle.db, m, QUALITY_SELECTOR_JOB_TYPE);
        record(
          "finalize-failure: NO quality_selector_run enqueued",
          pending.length === 0,
          `count=${pending.length}`,
        );
      }

      // -----------------------------------------------------------------
      // CASE 7: no P5/P6 regression
      // -----------------------------------------------------------------
      {
        const a = mediaAnalysisRepo.findByMediaId(winnerMediaId);
        record(
          "no regression: winner media_analysis still has per-dimension columns + raw_result.$.* keys",
          typeof a?.sharpnessScore === "number" &&
            typeof a?.exposureScore === "number" &&
            typeof a?.colorScore === "number" &&
            typeof a?.qualityScore === "number" &&
            typeof a?.rawResult === "string" &&
            /"blur"/.test(a.rawResult ?? "") &&
            /"exposure"/.test(a.rawResult ?? "") &&
            /"color"/.test(a.rawResult ?? "") &&
            /"final_quality"/.test(a.rawResult ?? ""),
          JSON.stringify({
            sharp: a?.sharpnessScore,
            exp: a?.exposureScore,
            col: a?.colorScore,
            q: a?.qualityScore,
            rawLen: a?.rawResult?.length ?? 0,
          }),
        );
      }

      // -----------------------------------------------------------------
      // CASE 8: 1-member fresh trip + group → end-to-end finalize +
      // auto-trigger landing a recommendation.
      // -----------------------------------------------------------------
      {
        const trip8 = tripService.createTrip({ title: "Case8 end-to-end" });
        const onlyBytes = await makeColouredJpeg(48, 48, 150, 150, 150);
        const onlyId = await (async () => {
          const id = randomUUID();
          const stored = await storage.putOriginal({
            tripId: trip8.id,
            mediaId: id,
            extension: "jpg",
            data: onlyBytes,
          });
          const now = new Date().toISOString();
          dbHandle.db
            .prepare(
              `INSERT INTO media_items
               (id, trip_id, type, original_path, mime_type, extension, file_size,
                status, user_decision, created_at, updated_at)
             VALUES (?, ?, 'image', ?, 'image/jpeg', 'jpg', ?,
                     'uploaded', 'undecided', ?, ?)`,
            )
            .run(id, trip8.id, stored.logicalPath, onlyBytes.length, now, now);
          return id;
        })();
        const g8 = randomUUID();
        const g8Now = new Date().toISOString();
        duplicateGroupsRepo.createGroupWithItems(
          {
            id: g8,
            tripId: trip8.id,
            groupType: "exact",
            createdAt: g8Now,
            updatedAt: g8Now,
          },
          [
            {
              id: randomUUID(),
              mediaId: onlyId,
              recommendation: "undecided",
              reason: null,
              userDecision: "undecided",
              createdAt: g8Now,
              updatedAt: g8Now,
            },
          ],
        );
        // Enqueue the per-dimension workers first and DRAIN them
        // before inserting finalize. Inserting all four at once would
        // be flaky: their `created_at` timestamps collide at the
        // millisecond, and the claim order falls back to `id ASC`
        // (UUID lexicographic), so finalize might race ahead of the
        // dimension jobs and fail with "no dimensions available".
        insertJob(dbHandle.db, onlyId, IMAGE_QUALITY_BLUR_JOB_TYPE);
        insertJob(dbHandle.db, onlyId, IMAGE_QUALITY_EXPOSURE_JOB_TYPE);
        insertJob(dbHandle.db, onlyId, IMAGE_QUALITY_COLOR_JOB_TYPE);
        for (let i = 0; i < 8; i += 1) {
          const r = await runOneImageJob();
          if (r.jobId === null) break;
        }
        // Now finalize; its success will auto-enqueue the selector.
        insertJob(dbHandle.db, onlyId, IMAGE_QUALITY_FINALIZE_JOB_TYPE);
        for (let i = 0; i < 8; i += 1) {
          const r = await runOneImageJob();
          if (r.jobId === null) break;
        }
        const row = readGroup(dbHandle.db, g8);
        record(
          "end-to-end: 1-member group got recommended_media_id = onlyId after chain",
          row?.recommended_media_id === onlyId,
          `recommended=${String(row?.recommended_media_id)}`,
        );
        const items = readItems(dbHandle.db, g8);
        record(
          "end-to-end: only item recommendation='keep'",
          items.length === 1 && items[0]?.recommendation === "keep",
          JSON.stringify(items.map((r) => r["recommendation"])),
        );
      }
    } finally {
      await queue.stop();
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
