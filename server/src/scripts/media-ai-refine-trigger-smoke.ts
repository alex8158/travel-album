// Manual smoke test for media AI-refine enqueue (P10.T3).
//
// Usage: npm run smoke:media-ai-refine-trigger
//
// Two layers verified in one file:
//
//   * Service layer (MediaService.aiRefineMedia) — closed-form
//     domain gates: media missing / soft-deleted / non-image /
//     idempotency / scope-guard. Mirrors the pattern of
//     smoke:media-enhance-trigger but for `image_ai_refine`.
//   * HTTP layer (POST /api/media/:id/ai-refine through a real
//     Express server) — the AI availability gate (501 +
//     AI_NOT_CONFIGURED) lives at the route layer, NOT the service,
//     so HTTP coverage is mandatory here. Tests both Noop (default,
//     `available=false` → 501) and a stub `AvailableProvider`
//     (`available=true` → 200 + enqueue) without ever attempting a
//     real network call.
//
// Coverage:
//   1. Fresh image media + AvailableProvider → outcome='created'
//      + pending `image_ai_refine` row on disk.
//   2. Second call while pending → outcome='skipped'
//      + reason='already pending' + no duplicate row.
//   3. Existing running → outcome='skipped' + reason='already running'.
//   4. Terminal-ish (failed / success / cancelled) → outcome='reset'
//      + same job id + row flipped to 'retrying'.
//   5. Idempotency (created → skipped) within a single test.
//   6. Missing media → NotFoundError.
//   7. Soft-deleted media → NotFoundError (P7 contract).
//   8. Video media → BadRequestError (image-only).
//   9. Unknown-type media → BadRequestError.
//  10. Scope-guard: ai-refine does NOT write media_versions, does
//      NOT touch media_items columns (no preview_path / status /
//      user_decision / active_version_type mutation).
//  11. HTTP: AI_ENABLED=false (NoopProvider) → 501 + body.error.code
//      === 'AI_NOT_CONFIGURED'; no `processing_jobs` row created.
//  12. HTTP: AI_ENABLED=true + AvailableProvider → 200 + envelope
//      shape + row created.
//  13. HTTP: AI_ENABLED=true + AvailableProvider on missing media
//      → 404 (domain error reaches client).
//  14. HTTP: AI_ENABLED=true + AvailableProvider on video media
//      → 400.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import express from "express";

import {
  IMAGE_AI_REFINE_JOB_TYPE,
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
// stub provider — `available=true` so the HTTP layer's gate passes,
// but `invoke()` still throws (it should never be called by P10.T3 —
// that's the worker's job in P10.T5). The smoke deliberately makes
// `invoke()` throw a marked-error so any accidental wiring change
// that DOES call it surfaces as an obvious failure rather than a
// silent network attempt.
// ---------------------------------------------------------------------------

class AvailableTestProvider implements AIProvider {
  readonly name = "available-test-stub";
  readonly available = true;
  readonly supports: ReadonlySet<AIRequestType> = new Set(["image_ai_refine"]);

  async invoke(_req: AIRequest): Promise<AIResponse> {
    throw new Error(
      "AvailableTestProvider.invoke called — P10.T3 should not call invoke; worker (P10.T5) is the only caller",
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
  title = "AI Refine Smoke Trip",
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

function seedMediaOfType(
  tripService: TripService,
  mediaRepo: MediaRepository,
  type: "video" | "unknown",
): Seeded {
  const trip = tripService.createTrip({ title: `AI Refine Smoke ${type}` });
  const mediaId = randomUUID();
  const now = new Date().toISOString();
  mediaRepo.insert({
    id: mediaId,
    tripId: trip.id,
    type,
    originalPath: type === "video" ? `trips/${trip.id}/originals/${mediaId}.mp4` : null,
    fileSize: type === "video" ? 4096 : null,
    mimeType: type === "video" ? "video/mp4" : null,
    extension: type === "video" ? "mp4" : null,
    createdAt: now,
    updatedAt: now,
  });
  return { tripId: trip.id, mediaId };
}

function insertJobRow(
  db: SqliteDatabase,
  mediaId: string,
  status: "pending" | "running" | "failed" | "success" | "cancelled",
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  const started = status === "running" || status === "success" || status === "failed" ? now : null;
  const finished = status === "success" || status === "failed" ? now : null;
  db.prepare(
    `INSERT INTO processing_jobs
       (id, media_id, job_type, status, started_at, finished_at, error_message,
        retry_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    id,
    mediaId,
    IMAGE_AI_REFINE_JOB_TYPE,
    status,
    started,
    finished,
    status === "failed" ? "stub error" : null,
    now,
    now,
  );
  return id;
}

function readJob(db: SqliteDatabase, jobId: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM processing_jobs WHERE id = ?`).get(jobId) as
    | Record<string, unknown>
    | undefined;
}

function countJobsByType(db: SqliteDatabase, mediaId: string, jobType: string): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM processing_jobs WHERE media_id = ? AND job_type = ?`)
      .get(mediaId, jobType) as { n: number }
  ).n;
}

function readMedia(db: SqliteDatabase, mediaId: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM media_items WHERE id = ?`).get(mediaId) as
    | Record<string, unknown>
    | undefined;
}

function countMediaVersions(db: SqliteDatabase, mediaId: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM media_versions WHERE media_id = ?`).get(mediaId) as {
      n: number;
    }
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

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-ai-refine-trigger-smoke-"));
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

    // -----------------------------------------------------------------
    // CASE 1: fresh image → outcome='created' + pending row inserted
    // -----------------------------------------------------------------
    {
      const seeded = seedImageMedia(tripService, mediaRepo, "Case1 fresh");
      const before = countJobsByType(dbHandle.db, seeded.mediaId, IMAGE_AI_REFINE_JOB_TYPE);
      const result = mediaService.aiRefineMedia(seeded.mediaId);
      const after = countJobsByType(dbHandle.db, seeded.mediaId, IMAGE_AI_REFINE_JOB_TYPE);
      record(
        "fresh: outcome='created' + jobType='image_ai_refine' + before/after job count goes 0→1",
        result.outcome === "created" &&
          result.jobType === IMAGE_AI_REFINE_JOB_TYPE &&
          result.jobId.length === 36 &&
          before === 0 &&
          after === 1,
        JSON.stringify(result),
      );
      const row = readJob(dbHandle.db, result.jobId);
      record(
        "fresh: inserted row is status='pending' with retry_count=0",
        row?.status === "pending" && row?.retry_count === 0,
        `status=${String(row?.status)} retry=${String(row?.retry_count)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 2: existing pending → outcome='skipped' (no duplicate)
    // -----------------------------------------------------------------
    {
      const seeded = seedImageMedia(tripService, mediaRepo, "Case2 pending");
      const existing = insertJobRow(dbHandle.db, seeded.mediaId, "pending");
      const result = mediaService.aiRefineMedia(seeded.mediaId);
      record(
        "skipped(pending): outcome='skipped' + reuses existing jobId + reason mentions pending",
        result.outcome === "skipped" &&
          result.jobId === existing &&
          /pending/.test(result.reason ?? ""),
        JSON.stringify(result),
      );
      record(
        "skipped(pending): no duplicate row inserted (count stays at 1)",
        countJobsByType(dbHandle.db, seeded.mediaId, IMAGE_AI_REFINE_JOB_TYPE) === 1,
        `count=${countJobsByType(dbHandle.db, seeded.mediaId, IMAGE_AI_REFINE_JOB_TYPE)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 3: existing running → outcome='skipped'
    // -----------------------------------------------------------------
    {
      const seeded = seedImageMedia(tripService, mediaRepo, "Case3 running");
      const existing = insertJobRow(dbHandle.db, seeded.mediaId, "running");
      const result = mediaService.aiRefineMedia(seeded.mediaId);
      record(
        "skipped(running): outcome='skipped' + reuses jobId + reason mentions running",
        result.outcome === "skipped" &&
          result.jobId === existing &&
          /running/.test(result.reason ?? ""),
        JSON.stringify(result),
      );
    }

    // -----------------------------------------------------------------
    // CASE 4: terminal-ish (failed) → outcome='reset' + same job id
    // -----------------------------------------------------------------
    {
      const seeded = seedImageMedia(tripService, mediaRepo, "Case4 failed");
      const existing = insertJobRow(dbHandle.db, seeded.mediaId, "failed");
      const result = mediaService.aiRefineMedia(seeded.mediaId);
      record(
        "reset(failed): outcome='reset' + same jobId reused",
        result.outcome === "reset" && result.jobId === existing,
        JSON.stringify(result),
      );
      const row = readJob(dbHandle.db, existing);
      record(
        "reset(failed): row flipped to 'retrying' with retry_count=0",
        row?.status === "retrying" && row?.retry_count === 0,
        `status=${String(row?.status)} retry=${String(row?.retry_count)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 5: terminal-ish (success) → outcome='reset'
    // -----------------------------------------------------------------
    {
      const seeded = seedImageMedia(tripService, mediaRepo, "Case5 success");
      insertJobRow(dbHandle.db, seeded.mediaId, "success");
      const result = mediaService.aiRefineMedia(seeded.mediaId);
      record(
        "reset(success): outcome='reset'",
        result.outcome === "reset",
        JSON.stringify(result),
      );
    }

    // -----------------------------------------------------------------
    // CASE 6: terminal-ish (cancelled) → outcome='reset'
    // -----------------------------------------------------------------
    {
      const seeded = seedImageMedia(tripService, mediaRepo, "Case6 cancelled");
      insertJobRow(dbHandle.db, seeded.mediaId, "cancelled");
      const result = mediaService.aiRefineMedia(seeded.mediaId);
      record(
        "reset(cancelled): outcome='reset'",
        result.outcome === "reset",
        JSON.stringify(result),
      );
    }

    // -----------------------------------------------------------------
    // CASE 7: idempotency — first call 'created', second 'skipped'
    // -----------------------------------------------------------------
    {
      const seeded = seedImageMedia(tripService, mediaRepo, "Case7 idempotent");
      const first = mediaService.aiRefineMedia(seeded.mediaId);
      const second = mediaService.aiRefineMedia(seeded.mediaId);
      record(
        "idempotent: created → skipped (no duplicate)",
        first.outcome === "created" &&
          second.outcome === "skipped" &&
          second.jobId === first.jobId,
        `first=${first.outcome} second=${second.outcome}`,
      );
      record(
        "idempotent: exactly 1 image_ai_refine row exists",
        countJobsByType(dbHandle.db, seeded.mediaId, IMAGE_AI_REFINE_JOB_TYPE) === 1,
        `count=${countJobsByType(dbHandle.db, seeded.mediaId, IMAGE_AI_REFINE_JOB_TYPE)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 8: missing media → NotFoundError
    // -----------------------------------------------------------------
    {
      let threw: unknown;
      try {
        mediaService.aiRefineMedia(randomUUID());
      } catch (err) {
        threw = err;
      }
      record(
        "missing: NotFoundError",
        threw !== undefined && /Media not found/.test(describeError(threw)),
        describeError(threw),
      );
    }

    // -----------------------------------------------------------------
    // CASE 9: soft-deleted media → NotFoundError (P7 contract)
    // -----------------------------------------------------------------
    {
      const seeded = seedImageMedia(tripService, mediaRepo, "Case9 soft-deleted");
      mediaService.softDeleteMedia(seeded.mediaId);
      let threw: unknown;
      try {
        mediaService.aiRefineMedia(seeded.mediaId);
      } catch (err) {
        threw = err;
      }
      record(
        "soft-deleted: NotFoundError (P7 recycle-bin contract)",
        threw !== undefined && /Media not found/.test(describeError(threw)),
        describeError(threw),
      );
    }

    // -----------------------------------------------------------------
    // CASE 10: video media → BadRequestError (image-only)
    // -----------------------------------------------------------------
    {
      const seeded = seedMediaOfType(tripService, mediaRepo, "video");
      let threw: unknown;
      try {
        mediaService.aiRefineMedia(seeded.mediaId);
      } catch (err) {
        threw = err;
      }
      record(
        "video: BadRequestError + mentions 'video'",
        threw !== undefined &&
          /image-only|only supported for image media/.test(describeError(threw)) &&
          /video/.test(describeError(threw)),
        describeError(threw),
      );
    }

    // -----------------------------------------------------------------
    // CASE 11: unknown-type media → BadRequestError
    // -----------------------------------------------------------------
    {
      const seeded = seedMediaOfType(tripService, mediaRepo, "unknown");
      let threw: unknown;
      try {
        mediaService.aiRefineMedia(seeded.mediaId);
      } catch (err) {
        threw = err;
      }
      record(
        "unknown: BadRequestError",
        threw !== undefined && /only supported for image media/.test(describeError(threw)),
        describeError(threw),
      );
    }

    // -----------------------------------------------------------------
    // CASE 12: scope-guard — service does NOT write media_versions or
    // mutate media_items
    // -----------------------------------------------------------------
    {
      const seeded = seedImageMedia(tripService, mediaRepo, "Case12 scope-guard");
      const beforeMedia = readMedia(dbHandle.db, seeded.mediaId);
      const beforeVersions = countMediaVersions(dbHandle.db, seeded.mediaId);
      mediaService.aiRefineMedia(seeded.mediaId);
      const afterMedia = readMedia(dbHandle.db, seeded.mediaId);
      const afterVersions = countMediaVersions(dbHandle.db, seeded.mediaId);
      record(
        "scope-guard: media_items columns unchanged (active_version_type / status / user_decision / preview_path)",
        afterMedia?.active_version_type === beforeMedia?.active_version_type &&
          afterMedia?.status === beforeMedia?.status &&
          afterMedia?.user_decision === beforeMedia?.user_decision &&
          afterMedia?.preview_path === beforeMedia?.preview_path &&
          afterMedia?.deleted_at === beforeMedia?.deleted_at,
        "ok",
      );
      record(
        "scope-guard: no media_versions rows written (worker territory)",
        beforeVersions === afterVersions,
        `before=${beforeVersions} after=${afterVersions}`,
      );
    }

    // -----------------------------------------------------------------
    // HTTP LAYER — boot a real Express server. Two phases:
    //   phase A: NoopProvider (default) → 501 + AI_NOT_CONFIGURED
    //   phase B: AvailableTestProvider → 200 + enqueue
    // -----------------------------------------------------------------
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

    // -- Phase A: NoopProvider (default) → 501 --
    {
      const app = express();
      app.use(express.json({ limit: "1mb" }));
      app.use(requestIdMiddleware);
      app.use(
        "/api",
        makeMediaRouter({
          uploadService,
          mediaService,
          aiProvider: new NoopProvider(),
        }),
      );
      app.use(notFoundHandler);
      app.use(makeErrorHandler(logger));
      server = createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}`;

      const seeded = seedImageMedia(tripService, mediaRepo, "PhaseA noop image");
      const before = countJobsByType(dbHandle.db, seeded.mediaId, IMAGE_AI_REFINE_JOB_TYPE);
      const r = await jsonFetch<{ error: { code: string; message: string } }>(
        `${base}/api/media/${encodeURIComponent(seeded.mediaId)}/ai-refine`,
        { method: "POST", headers: { "content-type": "application/json" } },
      );
      const after = countJobsByType(dbHandle.db, seeded.mediaId, IMAGE_AI_REFINE_JOB_TYPE);
      record(
        "HTTP+Noop: 501 + body.error.code='AI_NOT_CONFIGURED'",
        r.status === 501 && r.body?.error?.code === "AI_NOT_CONFIGURED",
        `status=${r.status} body=${JSON.stringify(r.body)}`,
      );
      record(
        "HTTP+Noop: NO processing_jobs row created (gate fires before enqueue)",
        before === 0 && after === 0,
        `before=${before} after=${after}`,
      );

      // Same gate fires regardless of media existence — i.e. AI being
      // disabled MUST shadow even the 404 path. Mirrors design.md
      // §11.2: an unavailable feature returns 501 even when the
      // resource happens to be missing.
      const ghostId = randomUUID();
      const rGhost = await jsonFetch<{ error: { code: string } }>(
        `${base}/api/media/${encodeURIComponent(ghostId)}/ai-refine`,
        { method: "POST", headers: { "content-type": "application/json" } },
      );
      record(
        "HTTP+Noop: 501 even for non-existent media (gate shadows domain checks)",
        rGhost.status === 501 && rGhost.body?.error?.code === "AI_NOT_CONFIGURED",
        `status=${rGhost.status} code=${rGhost.body?.error?.code}`,
      );

      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }

    // -- Phase B: AvailableTestProvider → 200 + domain results --
    {
      const app = express();
      app.use(express.json({ limit: "1mb" }));
      app.use(requestIdMiddleware);
      app.use(
        "/api",
        makeMediaRouter({
          uploadService,
          mediaService,
          aiProvider: new AvailableTestProvider(),
        }),
      );
      app.use(notFoundHandler);
      app.use(makeErrorHandler(logger));
      server = createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}`;

      // Happy path: image, AI available → 200 + enqueue
      const seeded = seedImageMedia(tripService, mediaRepo, "PhaseB image happy");
      const r = await jsonFetch<{
        mediaId: string;
        jobType: string;
        outcome: string;
        jobId: string;
      }>(`${base}/api/media/${encodeURIComponent(seeded.mediaId)}/ai-refine`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      record(
        "HTTP+Available: 200 + envelope { mediaId, jobType='image_ai_refine', outcome='created', jobId }",
        r.status === 200 &&
          r.body.mediaId === seeded.mediaId &&
          r.body.jobType === IMAGE_AI_REFINE_JOB_TYPE &&
          r.body.outcome === "created" &&
          r.body.jobId.length === 36,
        `status=${r.status} body=${JSON.stringify(r.body)}`,
      );
      record(
        "HTTP+Available: a pending image_ai_refine row exists in DB",
        countJobsByType(dbHandle.db, seeded.mediaId, IMAGE_AI_REFINE_JOB_TYPE) === 1,
        `count=${countJobsByType(dbHandle.db, seeded.mediaId, IMAGE_AI_REFINE_JOB_TYPE)}`,
      );

      // Idempotency over HTTP: second POST → 200 + outcome='skipped'
      const r2 = await jsonFetch<{ outcome: string; jobId: string; reason?: string }>(
        `${base}/api/media/${encodeURIComponent(seeded.mediaId)}/ai-refine`,
        { method: "POST", headers: { "content-type": "application/json" } },
      );
      record(
        "HTTP+Available: second POST → 200 + outcome='skipped' + same jobId",
        r2.status === 200 && r2.body.outcome === "skipped" && r2.body.jobId === r.body.jobId,
        `status=${r2.status} body=${JSON.stringify(r2.body)}`,
      );
      record(
        "HTTP+Available: no duplicate row (count still 1)",
        countJobsByType(dbHandle.db, seeded.mediaId, IMAGE_AI_REFINE_JOB_TYPE) === 1,
        `count=${countJobsByType(dbHandle.db, seeded.mediaId, IMAGE_AI_REFINE_JOB_TYPE)}`,
      );

      // Missing media → 404 (domain error reaches client)
      const ghostId = randomUUID();
      const r404 = await jsonFetch<{ error: { code: string } }>(
        `${base}/api/media/${encodeURIComponent(ghostId)}/ai-refine`,
        { method: "POST", headers: { "content-type": "application/json" } },
      );
      record(
        "HTTP+Available: missing media → 404 + body.error.code='NOT_FOUND'",
        r404.status === 404 && r404.body?.error?.code === "NOT_FOUND",
        `status=${r404.status} code=${r404.body?.error?.code}`,
      );

      // Video media → 400
      const videoSeed = seedMediaOfType(tripService, mediaRepo, "video");
      const r400 = await jsonFetch<{ error: { code: string; message: string } }>(
        `${base}/api/media/${encodeURIComponent(videoSeed.mediaId)}/ai-refine`,
        { method: "POST", headers: { "content-type": "application/json" } },
      );
      record(
        "HTTP+Available: video media → 400 + body.error.code='BAD_REQUEST'",
        r400.status === 400 && r400.body?.error?.code === "BAD_REQUEST",
        `status=${r400.status} body=${JSON.stringify(r400.body)}`,
      );

      // Soft-deleted media → 404 (P7 contract)
      const sd = seedImageMedia(tripService, mediaRepo, "PhaseB soft-deleted");
      mediaService.softDeleteMedia(sd.mediaId);
      const rSd = await jsonFetch<{ error: { code: string } }>(
        `${base}/api/media/${encodeURIComponent(sd.mediaId)}/ai-refine`,
        { method: "POST", headers: { "content-type": "application/json" } },
      );
      record(
        "HTTP+Available: soft-deleted media → 404 (P7 contract)",
        rSd.status === 404 && rSd.body?.error?.code === "NOT_FOUND",
        `status=${rSd.status}`,
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
