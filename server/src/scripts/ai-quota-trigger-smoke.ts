// Manual smoke test for the AI quota gate on POST /api/media/:id/ai-refine
// (P10.T4).
//
// Usage: npm run smoke:ai-quota-trigger
//
// The P10.T3 smoke (smoke:media-ai-refine-trigger) covers the
// availability + domain gates. This smoke focuses narrowly on the
// quota counting layer added in P10.T4:
//
//   * dailyLimit / tripLimit = 0 (default) → unlimited, no gate.
//   * dailyLimit / tripLimit > 0 → 429 + AI_QUOTA_EXCEEDED once
//     the corresponding count reaches the limit.
//   * Counting strictly follows `ai_invocations` rows, which are
//     only written for `created` / `reset` outcomes — so failures
//     (404 / 400 / 501) and `skipped` (duplicate pending/running)
//     do NOT count toward the quota.
//   * Per-trip count uses INNER JOIN on media_items, so calls
//     against media in OTHER trips don't contribute. Orphans
//     (media hard-deleted, FK flipped to NULL) drop out by
//     design.
//   * Daily count uses `created_at >= startOfUtcDay(now)`, so
//     audit rows from "yesterday" (verified by a clock override
//     pointing at the day BEFORE the test starts, then jumping
//     to "today") drop out of the count.
//
// All 4 endpoint conditions are exercised: 501 + 404 + 400 + 429.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import express from "express";

import {
  AiInvocationsRepository,
  NoopProvider,
  type AIProvider,
  type AIRequest,
  type AIRequestType,
  type AIResponse,
} from "../ai/index.js";
import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { DuplicateGroupsRepository } from "../dedup/index.js";
import { JobRepository } from "../jobs/index.js";
import { createLogger } from "../logger.js";
import {
  MediaRepository,
  MediaService,
  MediaVersionsRepository,
  type MediaSoftDeleteDeps,
} from "../media/index.js";
import { makeErrorHandler, notFoundHandler } from "../middleware/errorHandler.js";
import { requestIdMiddleware } from "../middleware/requestId.js";
import { makeMediaRouter } from "../routes/media.js";
import { LocalStorageProvider } from "../storage/index.js";
import { TripRepository, TripService } from "../trips/index.js";
import { UploadService } from "../upload/index.js";

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
// AvailableTestProvider — same shape as the P10.T3 smoke's. Used by
// the HTTP layer cases where we want the route's availability gate
// to pass so we can exercise the quota gate behind it.
// ---------------------------------------------------------------------------

class AvailableTestProvider implements AIProvider {
  readonly name = "available-test-stub";
  readonly available = true;
  readonly supports: ReadonlySet<AIRequestType> = new Set(["image_ai_refine"]);

  async invoke(_req: AIRequest): Promise<AIResponse> {
    throw new Error(
      "AvailableTestProvider.invoke called — P10.T4 must not call invoke; worker (P10.T5) is the only caller",
    );
  }
}

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

interface Seeded {
  readonly tripId: string;
  readonly mediaId: string;
}

function seedImageMedia(
  tripService: TripService,
  mediaRepo: MediaRepository,
  title = "AI Quota Smoke Trip",
): Seeded {
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

function seedImageMediaInTrip(
  tripId: string,
  mediaRepo: MediaRepository,
): { mediaId: string } {
  const mediaId = randomUUID();
  const now = new Date().toISOString();
  mediaRepo.insert({
    id: mediaId,
    tripId,
    type: "image",
    originalPath: `trips/${tripId}/originals/${mediaId}.jpg`,
    fileSize: 1024,
    mimeType: "image/jpeg",
    extension: "jpg",
    createdAt: now,
    updatedAt: now,
  });
  return { mediaId };
}

function seedMediaOfType(
  tripService: TripService,
  mediaRepo: MediaRepository,
  type: "video",
): Seeded {
  const trip = tripService.createTrip({ title: `Quota Smoke ${type}` });
  const mediaId = randomUUID();
  const now = new Date().toISOString();
  mediaRepo.insert({
    id: mediaId,
    tripId: trip.id,
    type,
    originalPath: `trips/${trip.id}/originals/${mediaId}.mp4`,
    fileSize: 4096,
    mimeType: "video/mp4",
    extension: "mp4",
    createdAt: now,
    updatedAt: now,
  });
  return { tripId: trip.id, mediaId };
}

function countAiInvocations(db: SqliteDatabase, mediaId?: string): number {
  if (mediaId !== undefined) {
    return (
      db
        .prepare(`SELECT COUNT(*) AS n FROM ai_invocations WHERE media_id = ?`)
        .get(mediaId) as { n: number }
    ).n;
  }
  return (db.prepare(`SELECT COUNT(*) AS n FROM ai_invocations`).get() as { n: number }).n;
}

function countAiInvocationsForTrip(db: SqliteDatabase, tripId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM ai_invocations ai
         INNER JOIN media_items m ON ai.media_id = m.id
         WHERE m.trip_id = ?`,
      )
      .get(tripId) as { n: number }
  ).n;
}

interface ApiResponse<T> {
  readonly status: number;
  readonly body: T;
}

async function jsonFetch<T = unknown>(url: string, init?: RequestInit): Promise<ApiResponse<T>> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text.length === 0 ? null : (JSON.parse(text) as unknown);
  } catch {
    body = text;
  }
  return { status: res.status, body: body as T };
}

/**
 * Build a fresh MediaService with the given quota knobs. Used to
 * exercise the gate at the service layer without spinning up HTTP.
 */
function makeService(
  args: {
    db: SqliteDatabase;
    tripRepo: TripRepository;
    duplicateGroupsRepo: DuplicateGroupsRepository;
    mediaRepo: MediaRepository;
    tripService: TripService;
    mediaVersionsRepo: MediaVersionsRepository;
    jobRepo: JobRepository;
    aiInvocationsRepo: AiInvocationsRepository;
    dailyLimit: number;
    tripLimit: number;
    logger: ReturnType<typeof createLogger>;
    now?: () => Date;
  },
): MediaService {
  const softDeleteDeps: MediaSoftDeleteDeps = {
    db: args.db,
    tripRepo: args.tripRepo,
    duplicateGroupsRepo: args.duplicateGroupsRepo,
    logger: args.logger,
  };
  return new MediaService(
    args.mediaRepo,
    args.tripService,
    args.mediaVersionsRepo,
    args.jobRepo,
    softDeleteDeps,
    args.now !== undefined
      ? {
          aiInvocationsRepo: args.aiInvocationsRepo,
          dailyLimit: args.dailyLimit,
          tripLimit: args.tripLimit,
          now: args.now,
        }
      : {
          aiInvocationsRepo: args.aiInvocationsRepo,
          dailyLimit: args.dailyLimit,
          tripLimit: args.tripLimit,
        },
  );
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-ai-quota-trigger-smoke-"));
  const dbPath = path.join(tmpRoot, "smoke.db");
  const storageRoot = path.join(tmpRoot, "storage");
  console.log(`[smoke] tmpRoot=${tmpRoot}`);

  const dbHandle = openDatabase(dbPath);
  let server: ReturnType<typeof createServer> | null = null;
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
    const aiInvocationsRepo = new AiInvocationsRepository(dbHandle.db);

    // =================================================================
    // CASE 1: dailyLimit=0 (default) → unlimited, no gate
    // =================================================================
    {
      const svc = makeService({
        db: dbHandle.db,
        tripRepo,
        duplicateGroupsRepo,
        mediaRepo,
        tripService,
        mediaVersionsRepo,
        jobRepo,
        aiInvocationsRepo,
        dailyLimit: 0,
        tripLimit: 0,
        logger,
      });
      // 5 calls in a row — none should throw, all should create
      // an ai_invocations audit row.
      const before = countAiInvocations(dbHandle.db);
      for (let i = 0; i < 5; i += 1) {
        const seeded = seedImageMedia(tripService, mediaRepo, `Case1 unlimited #${i}`);
        const r = svc.aiRefineMedia(seeded.mediaId, { providerName: "stub" });
        if (r.outcome !== "created") {
          record(`unlimited: call #${i} should be 'created' (got ${r.outcome})`, false, "");
        }
      }
      const after = countAiInvocations(dbHandle.db);
      record(
        "unlimited: dailyLimit=0 + tripLimit=0 → no 429; 5 audit rows added",
        after - before === 5,
        `before=${before} after=${after}`,
      );
    }

    // =================================================================
    // CASE 2: dailyLimit=3 → first 3 succeed, 4th 429
    // =================================================================
    {
      const svc = makeService({
        db: dbHandle.db,
        tripRepo,
        duplicateGroupsRepo,
        mediaRepo,
        tripService,
        mediaVersionsRepo,
        jobRepo,
        aiInvocationsRepo,
        dailyLimit: 3,
        tripLimit: 0,
        logger,
        // Pin "today" to a fresh date so existing audit rows from
        // CASE 1 don't bleed into this case's daily count.
        now: () => new Date(Date.UTC(2030, 0, 15, 12, 0, 0)),
      });
      // Burn 2 (so 2 audit rows exist in this UTC day). Then a 3rd
      // brings the count to 3 → still allowed (>= rule). 4th → 429.
      const today = new Date(Date.UTC(2030, 0, 15, 12, 0, 0)).toISOString();
      for (let i = 0; i < 3; i += 1) {
        const seeded = seedImageMedia(tripService, mediaRepo, `Case2 daily #${i}`);
        const r = svc.aiRefineMedia(seeded.mediaId, { providerName: "stub" });
        if (r.outcome !== "created") {
          record(
            `daily-gate(call #${i}): expected 'created' before limit, got ${r.outcome}`,
            false,
            "",
          );
        }
      }
      const usedAfter3 = aiInvocationsRepo.countSinceTimestamp(
        new Date(Date.UTC(2030, 0, 15, 0, 0, 0)).toISOString(),
      );
      record(
        "daily-gate: 3 audit rows in today bucket after 3 enqueues",
        usedAfter3 === 3,
        `usedToday=${usedAfter3} todayPin=${today}`,
      );
      // 4th call hits the gate.
      const seededFourth = seedImageMedia(tripService, mediaRepo, "Case2 daily #3");
      let threw: unknown;
      try {
        svc.aiRefineMedia(seededFourth.mediaId, { providerName: "stub" });
      } catch (err) {
        threw = err;
      }
      record(
        "daily-gate: 4th call throws AppError with AI_QUOTA_EXCEEDED",
        threw !== undefined && /AI daily quota exceeded/.test(describeError(threw)),
        describeError(threw),
      );
      const codeOk =
        threw !== undefined &&
        (threw as { code?: string; statusCode?: number }).code === "AI_QUOTA_EXCEEDED" &&
        (threw as { code?: string; statusCode?: number }).statusCode === 429;
      record(
        "daily-gate: thrown error has code='AI_QUOTA_EXCEEDED' + statusCode=429",
        codeOk,
        `err=${JSON.stringify(threw, null, 0)?.slice(0, 100)}`,
      );
      // No audit row written for the rejected call.
      record(
        "daily-gate: rejected call did NOT write an audit row",
        countAiInvocations(dbHandle.db, seededFourth.mediaId) === 0,
        `count=${countAiInvocations(dbHandle.db, seededFourth.mediaId)}`,
      );
    }

    // =================================================================
    // CASE 3: dailyLimit=3 but "today" shifts → yesterday's count
    // drops out, gate reopens.
    // =================================================================
    {
      // We just used "2030-01-15" above. Move "today" to
      // "2030-01-16" → all those rows are now in "yesterday's"
      // bucket, the daily count resets.
      const svcTomorrow = makeService({
        db: dbHandle.db,
        tripRepo,
        duplicateGroupsRepo,
        mediaRepo,
        tripService,
        mediaVersionsRepo,
        jobRepo,
        aiInvocationsRepo,
        dailyLimit: 3,
        tripLimit: 0,
        logger,
        now: () => new Date(Date.UTC(2030, 0, 16, 12, 0, 0)),
      });
      const seeded = seedImageMedia(tripService, mediaRepo, "Case3 next-day");
      const r = svcTomorrow.aiRefineMedia(seeded.mediaId, { providerName: "stub" });
      record(
        "daily-gate: count resets on next UTC day (call goes through)",
        r.outcome === "created",
        `outcome=${r.outcome}`,
      );
    }

    // =================================================================
    // CASE 4: tripLimit=2 — first 2 against ONE trip succeed, 3rd 429.
    // Calls against a DIFFERENT trip are unaffected.
    // =================================================================
    {
      const svc = makeService({
        db: dbHandle.db,
        tripRepo,
        duplicateGroupsRepo,
        mediaRepo,
        tripService,
        mediaVersionsRepo,
        jobRepo,
        aiInvocationsRepo,
        dailyLimit: 0,
        tripLimit: 2,
        logger,
      });
      // Two media in the same trip.
      const seededA = seedImageMedia(tripService, mediaRepo, "Case4 trip-A");
      const tripA = seededA.tripId;
      const a1 = seededA;
      const a2 = seedImageMediaInTrip(tripA, mediaRepo);

      const r1 = svc.aiRefineMedia(a1.mediaId, { providerName: "stub" });
      const r2 = svc.aiRefineMedia(a2.mediaId, { providerName: "stub" });
      record(
        "trip-gate: first 2 calls in trip A → both 'created'",
        r1.outcome === "created" && r2.outcome === "created",
        `r1=${r1.outcome} r2=${r2.outcome}`,
      );
      record(
        "trip-gate: trip A audit row count is 2",
        countAiInvocationsForTrip(dbHandle.db, tripA) === 2,
        `count=${countAiInvocationsForTrip(dbHandle.db, tripA)}`,
      );

      const a3 = seedImageMediaInTrip(tripA, mediaRepo);
      let threw: unknown;
      try {
        svc.aiRefineMedia(a3.mediaId, { providerName: "stub" });
      } catch (err) {
        threw = err;
      }
      record(
        "trip-gate: 3rd call in trip A throws AI_QUOTA_EXCEEDED",
        threw !== undefined &&
          /AI trip quota exceeded/.test(describeError(threw)) &&
          (threw as { code?: string }).code === "AI_QUOTA_EXCEEDED" &&
          (threw as { statusCode?: number }).statusCode === 429,
        describeError(threw),
      );
      record(
        "trip-gate: rejected 3rd call did NOT write an audit row (count still 2)",
        countAiInvocationsForTrip(dbHandle.db, tripA) === 2,
        `count=${countAiInvocationsForTrip(dbHandle.db, tripA)}`,
      );

      // A different trip is unaffected.
      const seededB = seedImageMedia(tripService, mediaRepo, "Case4 trip-B");
      const rB = svc.aiRefineMedia(seededB.mediaId, { providerName: "stub" });
      record(
        "trip-gate: different trip is unaffected — 'created'",
        rB.outcome === "created",
        `outcome=${rB.outcome}`,
      );
    }

    // =================================================================
    // CASE 5: idempotent (pending) calls do NOT count
    // =================================================================
    {
      const svc = makeService({
        db: dbHandle.db,
        tripRepo,
        duplicateGroupsRepo,
        mediaRepo,
        tripService,
        mediaVersionsRepo,
        jobRepo,
        aiInvocationsRepo,
        dailyLimit: 1,
        tripLimit: 0,
        logger,
        now: () => new Date(Date.UTC(2030, 1, 1, 12, 0, 0)), // fresh day
      });
      const seeded = seedImageMedia(tripService, mediaRepo, "Case5 idempotent");
      const r1 = svc.aiRefineMedia(seeded.mediaId, { providerName: "stub" });
      record(
        "skipped-no-count: first call → 'created' (consumes the daily=1 budget)",
        r1.outcome === "created",
        `r1=${r1.outcome}`,
      );
      // Second call on the SAME media — should be 'skipped' (the
      // job from r1 is still pending). It must NOT throw 429 even
      // though the quota is "full"; idempotency wins over quota
      // per the P10.T4 ordering.
      const r2 = svc.aiRefineMedia(seeded.mediaId, { providerName: "stub" });
      record(
        "skipped-no-count: second call on same media → 'skipped' (idempotent, NOT 429)",
        r2.outcome === "skipped" && r2.jobId === r1.jobId,
        `r2=${JSON.stringify(r2)}`,
      );
      record(
        "skipped-no-count: still exactly 1 audit row for this media",
        countAiInvocations(dbHandle.db, seeded.mediaId) === 1,
        `count=${countAiInvocations(dbHandle.db, seeded.mediaId)}`,
      );
      // A different media → 429 because the budget is genuinely full.
      const seededOther = seedImageMedia(tripService, mediaRepo, "Case5 over-budget");
      let threw: unknown;
      try {
        svc.aiRefineMedia(seededOther.mediaId, { providerName: "stub" });
      } catch (err) {
        threw = err;
      }
      record(
        "skipped-no-count: different media in same day-bucket → 429",
        threw !== undefined && /AI daily quota exceeded/.test(describeError(threw)),
        describeError(threw),
      );
    }

    // =================================================================
    // CASE 6: failed gates (404 / 400) do NOT count toward quota
    // =================================================================
    {
      const svc = makeService({
        db: dbHandle.db,
        tripRepo,
        duplicateGroupsRepo,
        mediaRepo,
        tripService,
        mediaVersionsRepo,
        jobRepo,
        aiInvocationsRepo,
        dailyLimit: 0, // unlimited — focus is on the audit-row count
        tripLimit: 0,
        logger,
      });
      const auditBefore = countAiInvocations(dbHandle.db);

      // 404: missing media
      let threw404: unknown;
      try {
        svc.aiRefineMedia(randomUUID(), { providerName: "stub" });
      } catch (err) {
        threw404 = err;
      }
      record(
        "no-count(404): missing media → NotFoundError, no audit row",
        threw404 !== undefined &&
          /Media not found/.test(describeError(threw404)) &&
          countAiInvocations(dbHandle.db) === auditBefore,
        describeError(threw404),
      );

      // 400: video media
      const video = seedMediaOfType(tripService, mediaRepo, "video");
      let threw400: unknown;
      try {
        svc.aiRefineMedia(video.mediaId, { providerName: "stub" });
      } catch (err) {
        threw400 = err;
      }
      record(
        "no-count(400): video media → BadRequestError, no audit row",
        threw400 !== undefined &&
          /only supported for image media/.test(describeError(threw400)) &&
          countAiInvocations(dbHandle.db) === auditBefore,
        describeError(threw400),
      );

      // 501: AI disabled — exercised via HTTP (route layer)
    }

    // =================================================================
    // CASE 7: HTTP layer — 501 (NoopProvider) does NOT count
    // =================================================================
    {
      const svc = makeService({
        db: dbHandle.db,
        tripRepo,
        duplicateGroupsRepo,
        mediaRepo,
        tripService,
        mediaVersionsRepo,
        jobRepo,
        aiInvocationsRepo,
        dailyLimit: 0,
        tripLimit: 0,
        logger,
      });

      const uploadService = new UploadService({
        db: dbHandle.db,
        storage,
        tripService,
        mediaRepo,
        jobRepo,
        classifyOptions: {
          imageExtensions: ["jpg", "jpeg", "png", "webp", "heic"],
          videoExtensions: ["mp4", "mov", "m4v", "avi", "mkv"],
        },
        maxFileSize: 10 * 1024 * 1024,
        logger,
      });

      const app = express();
      app.use(express.json({ limit: "1mb" }));
      app.use(requestIdMiddleware);
      app.use(
        "/api",
        makeMediaRouter({
          uploadService,
          mediaService: svc,
          aiProvider: new NoopProvider(),
        }),
      );
      app.use(notFoundHandler);
      app.use(makeErrorHandler(logger));
      server = createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}`;

      const seeded = seedImageMedia(tripService, mediaRepo, "Case7 HTTP 501 noop");
      const auditBefore = countAiInvocations(dbHandle.db);
      const r = await jsonFetch<{ error: { code: string } }>(
        `${base}/api/media/${encodeURIComponent(seeded.mediaId)}/ai-refine`,
        { method: "POST", headers: { "content-type": "application/json" } },
      );
      const auditAfter = countAiInvocations(dbHandle.db);
      record(
        "HTTP+Noop: 501 + AI_NOT_CONFIGURED + audit count unchanged",
        r.status === 501 &&
          r.body?.error?.code === "AI_NOT_CONFIGURED" &&
          auditBefore === auditAfter,
        `status=${r.status} code=${r.body?.error?.code} before=${auditBefore} after=${auditAfter}`,
      );

      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }

    // =================================================================
    // CASE 8: HTTP layer — 429 from quota gate, body shape correct
    // =================================================================
    {
      const svc = makeService({
        db: dbHandle.db,
        tripRepo,
        duplicateGroupsRepo,
        mediaRepo,
        tripService,
        mediaVersionsRepo,
        jobRepo,
        aiInvocationsRepo,
        dailyLimit: 0,
        tripLimit: 1, // tight limit so we hit it on the 2nd image of a trip
        logger,
      });

      const uploadService = new UploadService({
        db: dbHandle.db,
        storage,
        tripService,
        mediaRepo,
        jobRepo,
        classifyOptions: {
          imageExtensions: ["jpg", "jpeg", "png", "webp", "heic"],
          videoExtensions: ["mp4", "mov", "m4v", "avi", "mkv"],
        },
        maxFileSize: 10 * 1024 * 1024,
        logger,
      });

      const app = express();
      app.use(express.json({ limit: "1mb" }));
      app.use(requestIdMiddleware);
      app.use(
        "/api",
        makeMediaRouter({
          uploadService,
          mediaService: svc,
          aiProvider: new AvailableTestProvider(),
        }),
      );
      app.use(notFoundHandler);
      app.use(makeErrorHandler(logger));
      server = createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}`;

      // Two images in a fresh trip → first goes through, second 429.
      const seededFirst = seedImageMedia(tripService, mediaRepo, "Case8 HTTP 429 first");
      const r1 = await jsonFetch<{ outcome: string; aiInvocationId?: string }>(
        `${base}/api/media/${encodeURIComponent(seededFirst.mediaId)}/ai-refine`,
        { method: "POST", headers: { "content-type": "application/json" } },
      );
      record(
        "HTTP+Quota: first call in trip → 200 + outcome='created' + aiInvocationId present",
        r1.status === 200 &&
          r1.body.outcome === "created" &&
          typeof r1.body.aiInvocationId === "string" &&
          r1.body.aiInvocationId!.length === 36,
        `status=${r1.status} body=${JSON.stringify(r1.body)}`,
      );

      const secondInSameTrip = seedImageMediaInTrip(seededFirst.tripId, mediaRepo);
      const r2 = await jsonFetch<{
        error: { code: string; message: string; details: { kind: string; limit: number; used: number } };
      }>(
        `${base}/api/media/${encodeURIComponent(secondInSameTrip.mediaId)}/ai-refine`,
        { method: "POST", headers: { "content-type": "application/json" } },
      );
      record(
        "HTTP+Quota: 2nd call in same trip → 429 + body.error.code='AI_QUOTA_EXCEEDED'",
        r2.status === 429 && r2.body?.error?.code === "AI_QUOTA_EXCEEDED",
        `status=${r2.status} body=${JSON.stringify(r2.body)?.slice(0, 200)}`,
      );
      record(
        "HTTP+Quota: 429 body carries details.kind='trip' + limit=1 + used=1",
        r2.body?.error?.details?.kind === "trip" &&
          r2.body?.error?.details?.limit === 1 &&
          r2.body?.error?.details?.used === 1,
        `details=${JSON.stringify(r2.body?.error?.details)}`,
      );
      record(
        "HTTP+Quota: rejected 2nd call wrote NO audit row",
        countAiInvocations(dbHandle.db, secondInSameTrip.mediaId) === 0,
        `count=${countAiInvocations(dbHandle.db, secondInSameTrip.mediaId)}`,
      );

      // Repeating the FIRST call (already in pending) — should be
      // 'skipped' (200), NOT 429, even though the budget is full.
      const r1Again = await jsonFetch<{ outcome: string; aiInvocationId?: string }>(
        `${base}/api/media/${encodeURIComponent(seededFirst.mediaId)}/ai-refine`,
        { method: "POST", headers: { "content-type": "application/json" } },
      );
      record(
        "HTTP+Quota: repeated call on existing pending → 200 + 'skipped' (idempotency beats quota)",
        r1Again.status === 200 && r1Again.body.outcome === "skipped",
        `status=${r1Again.status} body=${JSON.stringify(r1Again.body)}`,
      );
      record(
        "HTTP+Quota: idempotent 'skipped' call did NOT write a fresh audit row",
        r1Again.body.aiInvocationId === undefined &&
          countAiInvocations(dbHandle.db, seededFirst.mediaId) === 1,
        `body=${JSON.stringify(r1Again.body)} count=${countAiInvocations(dbHandle.db, seededFirst.mediaId)}`,
      );

      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
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
