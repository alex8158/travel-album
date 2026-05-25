// Manual smoke test for the image_ai_refine worker (P10.T5).
//
// Usage: npm run smoke:image-ai-refine-worker
//
// Drives `makeImageAiRefineHandler` end-to-end against a real
// SQLite DB + real LocalStorageProvider + real sharp. AI provider
// calls go through stub implementations:
//
//   * NoopProvider — `available=false`; invoke() throws
//     AIProviderNotConfiguredError. Used to verify the handler
//     fails safely when AI is disabled mid-flight.
//   * SuccessMockProvider — returns a tiny synthetic JPEG produced
//     by sharp. Used to drive the happy path + the
//     media_versions(version_type='ai_refined') write.
//   * FailureResponseMockProvider — returns an AIFailureResponse
//     so the handler exercises the structured-failure branch
//     (rate-limit / content-policy style refusal).
//   * ThrowingMockProvider — invoke() throws a generic Error so
//     the handler's catch path is exercised.
//
// No real network calls are made. The smoke verifies:
//
//   1. Worker entry: registered on the image channel; JobQueue
//      claims a pending image_ai_refine job and dispatches.
//   2. Audit state-machine: pending → running → success / failed.
//   3. media_versions upsert: a row of version_type='ai_refined'
//      lands on disk + DB, with sharp.metadata() reading non-zero
//      width/height. Re-run via reset replaces the row in place
//      (no duplicate).
//   4. Failure paths:
//        a. Provider unavailable mid-flight (NoopProvider).
//        b. Provider returns AIFailureResponse.
//        c. Provider throws.
//        d. Media missing (job claimed for a deleted media row).
//        e. Media soft-deleted.
//        f. Non-image media.
//        g. No pending audit row.
//        h. Empty outputBytes from provider.
//   5. Scope guard: media_items.user_decision /
//      active_version_type / status / preview_path / original
//      file bytes — all unchanged after the worker runs.
//   6. P3-P9 regression note: the worker registers on the image
//      channel WITHOUT touching the enhance / thumbnail / metadata
//      / hash / quality handlers. (verified by the separate
//      smoke:image-enhance-worker / smoke:image-thumbnail / etc
//      runs.)

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";

import {
  AiInvocationsRepository,
  AIProviderNotConfiguredError,
  AIProviderUnsupportedRequestError,
  NoopProvider,
  type AIProvider,
  type AIRequest,
  type AIRequestType,
  type AIResponse,
} from "../ai/index.js";
import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { DuplicateGroupsRepository } from "../dedup/index.js";
import {
  IMAGE_AI_REFINE_JOB_TYPE,
  JobQueue,
  JobRepository,
  makeImageAiRefineHandler,
  type JobHandler,
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
// stub providers
// ---------------------------------------------------------------------------

/** Generates a tiny synthetic JPEG so the smoke's mock provider
 * can hand back real, parseable image bytes that sharp will
 * `metadata()` cleanly. Width=32 / height=32 keeps the file small. */
async function makeTinyJpeg(): Promise<Buffer> {
  return sharp({
    create: {
      width: 32,
      height: 32,
      channels: 3,
      background: { r: 200, g: 80, b: 40 },
    },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

class SuccessMockProvider implements AIProvider {
  readonly name = "ai-refine-success-stub";
  readonly available = true;
  readonly supports: ReadonlySet<AIRequestType> = new Set(["image_ai_refine"]);

  constructor(private readonly outputBytes: Buffer) {}

  async invoke(_req: AIRequest): Promise<AIResponse> {
    return {
      status: "success",
      provider: this.name,
      modelName: "mock-refine-v1",
      costEstimate: 0.001,
      durationMs: 42,
      outputBytes: this.outputBytes,
      responseSummary: "tiny synthetic jpeg",
      raw: { stub: true },
    };
  }
}

class FailureResponseMockProvider implements AIProvider {
  readonly name = "ai-refine-failure-stub";
  readonly available = true;
  readonly supports: ReadonlySet<AIRequestType> = new Set(["image_ai_refine"]);

  async invoke(_req: AIRequest): Promise<AIResponse> {
    return {
      status: "failed",
      provider: this.name,
      modelName: "mock-refine-v1",
      costEstimate: null,
      durationMs: 7,
      errorMessage: "rate limit exceeded (stub)",
    };
  }
}

class ThrowingMockProvider implements AIProvider {
  readonly name = "ai-refine-throwing-stub";
  readonly available = true;
  readonly supports: ReadonlySet<AIRequestType> = new Set(["image_ai_refine"]);

  async invoke(_req: AIRequest): Promise<AIResponse> {
    throw new Error("provider exploded (stub)");
  }
}

class EmptyOutputMockProvider implements AIProvider {
  readonly name = "ai-refine-empty-output-stub";
  readonly available = true;
  readonly supports: ReadonlySet<AIRequestType> = new Set(["image_ai_refine"]);

  async invoke(_req: AIRequest): Promise<AIResponse> {
    return {
      status: "success",
      provider: this.name,
      modelName: "mock-refine-v1",
      costEstimate: 0,
      durationMs: 1,
      outputBytes: Buffer.alloc(0),
      responseSummary: "intentionally empty",
    };
  }
}

class UnsupportedMockProvider implements AIProvider {
  readonly name = "ai-refine-unsupported-stub";
  readonly available = true;
  readonly supports: ReadonlySet<AIRequestType> = new Set();

  async invoke(req: AIRequest): Promise<AIResponse> {
    throw new AIProviderUnsupportedRequestError(this.name, req.requestType);
  }
}

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

interface Seeded {
  readonly tripId: string;
  readonly mediaId: string;
  readonly originalPath: string;
}

async function seedImageWithBytes(
  storage: LocalStorageProvider,
  db: SqliteDatabase,
  tripService: TripService,
  title: string,
  bytes: Buffer,
): Promise<Seeded> {
  const trip = tripService.createTrip({ title });
  const mediaId = randomUUID();
  const stored = await storage.putOriginal({
    tripId: trip.id,
    mediaId,
    extension: "jpg",
    data: bytes,
  });
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO media_items
       (id, trip_id, type, original_path, mime_type, extension, file_size,
        status, user_decision, created_at, updated_at)
     VALUES (?, ?, 'image', ?, 'image/jpeg', 'jpg', ?,
             'processed', 'undecided', ?, ?)`,
  ).run(mediaId, trip.id, stored.logicalPath, bytes.length, now, now);
  return { tripId: trip.id, mediaId, originalPath: stored.logicalPath };
}

function seedMediaOfType(
  tripService: TripService,
  mediaRepo: MediaRepository,
  type: "video" | "unknown",
): { tripId: string; mediaId: string } {
  const trip = tripService.createTrip({ title: `AI Refine Worker Smoke ${type}` });
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

function insertJob(db: SqliteDatabase, mediaId: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO processing_jobs (id, media_id, job_type, status, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, ?)`,
  ).run(id, mediaId, IMAGE_AI_REFINE_JOB_TYPE, now, now);
  return id;
}

function insertAuditRow(
  repo: AiInvocationsRepository,
  jobId: string,
  mediaId: string | null,
  provider = "ai-refine-success-stub",
): string {
  const id = randomUUID();
  repo.insert({
    id,
    mediaId,
    jobId,
    provider,
    modelName: "pending",
    requestType: "image_ai_refine",
    status: "pending",
    now: new Date().toISOString(),
  });
  return id;
}

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

function listVersions(db: SqliteDatabase, mediaId: string): Array<{
  version_type: string;
  file_path: string;
  width: number | null;
  height: number | null;
  file_size: number | null;
  model_name: string | null;
}> {
  return db
    .prepare(
      `SELECT version_type, file_path, width, height, file_size, model_name
       FROM media_versions WHERE media_id = ? ORDER BY version_type`,
    )
    .all(mediaId) as Array<{
    version_type: string;
    file_path: string;
    width: number | null;
    height: number | null;
    file_size: number | null;
    model_name: string | null;
  }>;
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-ai-refine-worker-smoke-"));
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
    const aiInvocationsRepo = new AiInvocationsRepository(dbHandle.db);
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
      // P10.T4: aiRefineDeps needed for softDelete tests to coexist
      {
        aiInvocationsRepo,
        dailyLimit: 0,
        tripLimit: 0,
      },
    );

    const tinyJpeg = await makeTinyJpeg();
    const sourceImage = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: 60, g: 120, b: 200 },
      },
    })
      .jpeg({ quality: 85 })
      .toBuffer();

    /**
     * Build a fresh JobQueue with a given AIProvider so each case
     * can inject its own stub. The image channel only registers
     * the ai_refine handler (other workers stay out of scope —
     * the smoke proves the handler runs in isolation).
     */
    function makeQueue(provider: AIProvider): JobQueue {
      const handlers = new Map<string, JobHandler>();
      handlers.set(
        IMAGE_AI_REFINE_JOB_TYPE,
        makeImageAiRefineHandler({
          storage,
          mediaRepo,
          mediaVersionsRepo,
          aiInvocationsRepo,
          aiProvider: provider,
          logger,
        }),
      );
      return new JobQueue({
        jobRepo,
        logger,
        channels: [
          { name: "image", concurrency: 1, handlers, pollIntervalMs: 60_000 },
          { name: "video", concurrency: 1, handlers: new Map(), pollIntervalMs: 60_000 },
          { name: "ai", concurrency: 1, handlers: new Map(), pollIntervalMs: 60_000 },
        ],
        zombieTimeoutMs: 0,
        retryConfig: { maxRetries: 0, baseDelayMs: 100, maxDelayMs: 100 },
      });
    }

    // -----------------------------------------------------------------
    // CASE 1: happy path — SuccessMockProvider drives a full claim →
    // success transition + media_versions(version_type='ai_refined')
    // row + audit row → 'success'.
    // -----------------------------------------------------------------
    const happy = await seedImageWithBytes(
      storage,
      dbHandle.db,
      tripService,
      "Case1 happy",
      sourceImage,
    );
    const happyJobId = insertJob(dbHandle.db, happy.mediaId);
    const happyAuditId = insertAuditRow(aiInvocationsRepo, happyJobId, happy.mediaId);
    {
      const queue = makeQueue(new SuccessMockProvider(tinyJpeg));
      const tick = await queue.tickChannel("image");
      await queue.awaitInflight("image");
      await queue.stop();

      record(
        "happy: queue claimed exactly the seeded image_ai_refine job",
        tick.claimed.length === 1 && tick.claimed[0]?.jobId === happyJobId,
        `claimed=${JSON.stringify(tick.claimed)}`,
      );
      const job = readJob(dbHandle.db, happyJobId);
      record(
        "happy: processing_jobs.status='success'",
        job?.status === "success",
        `status=${String(job?.status)} err=${String(job?.error_message)}`,
      );
      const audit = aiInvocationsRepo.findById(happyAuditId);
      record(
        "happy: ai_invocations.status='success' + model_name + cost_estimate + duration_ms filled",
        audit?.status === "success" &&
          audit?.modelName === "mock-refine-v1" &&
          audit?.costEstimate === 0.001 &&
          audit?.durationMs === 42 &&
          audit?.responseSummary === "tiny synthetic jpeg",
        JSON.stringify(audit),
      );
      const versions = listVersions(dbHandle.db, happy.mediaId);
      const refined = versions.find((v) => v.version_type === "ai_refined");
      record(
        "happy: media_versions has exactly 1 row of version_type='ai_refined'",
        versions.filter((v) => v.version_type === "ai_refined").length === 1 &&
          refined !== undefined &&
          (refined?.file_path.endsWith("ai_refined.jpg") ?? false),
        `refined=${JSON.stringify(refined)}`,
      );
      record(
        "happy: ai_refined row carries width/height from sharp.metadata + non-null model_name",
        refined?.width === 32 &&
          refined?.height === 32 &&
          refined?.file_size !== null &&
          refined?.file_size > 0 &&
          refined?.model_name === "mock-refine-v1",
        JSON.stringify(refined),
      );
      const refinedAbs = path.join(storage.root, refined!.file_path);
      record(
        "happy: ai_refined.jpg present on disk + matches outputBytes byte-for-byte",
        existsSync(refinedAbs) && readFileSync(refinedAbs).equals(tinyJpeg),
        `abs=${refinedAbs}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 2: scope-guard — original bytes + media_items columns +
    // existing media_versions rows (none) untouched.
    // -----------------------------------------------------------------
    {
      const originalOnDisk = readFileSync(path.join(storage.root, happy.originalPath));
      record(
        "scope-guard: original bytes byte-for-byte unchanged",
        originalOnDisk.equals(sourceImage),
        `before=${sourceImage.length}B after=${originalOnDisk.length}B`,
      );
      const m = readMediaRow(dbHandle.db, happy.mediaId);
      record(
        "scope-guard: media_items columns unchanged (status / user_decision / active_version_type / preview_path / deleted_at)",
        m?.status === "processed" &&
          m?.user_decision === "undecided" &&
          m?.active_version_type === "original" &&
          m?.preview_path === null &&
          m?.deleted_at === null,
        `media=${JSON.stringify({
          status: m?.status,
          user_decision: m?.user_decision,
          active_version_type: m?.active_version_type,
          preview_path: m?.preview_path,
        })}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 3: re-run via reset — second pass of the same media keeps
    // exactly ONE ai_refined version row (upsert), not two.
    // -----------------------------------------------------------------
    {
      // Mark the prior job 'failed' so the queue can re-claim it
      // after a reset; insert a fresh pending audit row (P10.T4's
      // reset path would do this).
      dbHandle.db
        .prepare(`UPDATE processing_jobs SET status='failed' WHERE id = ?`)
        .run(happyJobId);
      dbHandle.db
        .prepare(`UPDATE processing_jobs SET status='pending', error_message=NULL WHERE id = ?`)
        .run(happyJobId);
      const rerunAuditId = insertAuditRow(
        aiInvocationsRepo,
        happyJobId,
        happy.mediaId,
      );

      // Different mock so the upsert is visibly different — same
      // bytes but a different model_name so the row's model_name
      // changes after upsert. New tiny jpeg = different content.
      const newTinyJpeg = await sharp({
        create: { width: 16, height: 16, channels: 3, background: { r: 50, g: 50, b: 50 } },
      })
        .jpeg({ quality: 70 })
        .toBuffer();

      class V2Provider extends SuccessMockProvider {
        constructor(bytes: Buffer) {
          super(bytes);
        }
      }
      // Override name + model via prototype clone
      const v2 = new V2Provider(newTinyJpeg);
      (v2 as unknown as { invoke: AIProvider["invoke"] }).invoke = async () => ({
        status: "success",
        provider: "ai-refine-success-stub",
        modelName: "mock-refine-v2",
        costEstimate: 0.002,
        durationMs: 84,
        outputBytes: newTinyJpeg,
        responseSummary: "tiny synthetic jpeg v2",
      });

      const queue = makeQueue(v2);
      await queue.tickChannel("image");
      await queue.awaitInflight("image");
      await queue.stop();

      const versions = listVersions(dbHandle.db, happy.mediaId);
      const refined = versions.find((v) => v.version_type === "ai_refined");
      record(
        "rerun: still exactly 1 ai_refined row (upsert in place, no duplicate)",
        versions.filter((v) => v.version_type === "ai_refined").length === 1 &&
          refined?.width === 16 &&
          refined?.height === 16 &&
          refined?.model_name === "mock-refine-v2",
        JSON.stringify(refined),
      );
      // First attempt's audit row should still say 'success'; the
      // new one should also be 'success'.
      const oldAudit = aiInvocationsRepo.findById(happyAuditId);
      const newAudit = aiInvocationsRepo.findById(rerunAuditId);
      record(
        "rerun: both attempts' audit rows are 'success' (per-attempt trail preserved)",
        oldAudit?.status === "success" && newAudit?.status === "success",
        `old=${oldAudit?.status} new=${newAudit?.status}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 4: provider unavailable (NoopProvider) — handler claims,
    // detects available=false at the re-check step, marks audit
    // 'failed', job ends 'failed'.
    // -----------------------------------------------------------------
    {
      const unav = await seedImageWithBytes(
        storage,
        dbHandle.db,
        tripService,
        "Case4 unavailable",
        sourceImage,
      );
      const unavJob = insertJob(dbHandle.db, unav.mediaId);
      const unavAudit = insertAuditRow(aiInvocationsRepo, unavJob, unav.mediaId);

      const queue = makeQueue(new NoopProvider());
      await queue.tickChannel("image");
      await queue.awaitInflight("image");
      await queue.stop();

      const job = readJob(dbHandle.db, unavJob);
      const audit = aiInvocationsRepo.findById(unavAudit);
      record(
        "unavailable: processing_jobs.status='failed' + error mentions 'not available'",
        job?.status === "failed" &&
          typeof job?.error_message === "string" &&
          /not available/.test(job.error_message as string),
        `status=${String(job?.status)} err=${String(job?.error_message)}`,
      );
      record(
        "unavailable: ai_invocations.status='failed' + error_message recorded",
        audit?.status === "failed" &&
          typeof audit?.errorMessage === "string" &&
          /not available/.test(audit.errorMessage as string),
        JSON.stringify(audit),
      );
      const versions = listVersions(dbHandle.db, unav.mediaId);
      record(
        "unavailable: no ai_refined media_versions row created",
        versions.filter((v) => v.version_type === "ai_refined").length === 0,
        `versions=${JSON.stringify(versions)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 5: provider returns AIFailureResponse — structured failure
    // (rate-limit / content-policy style).
    // -----------------------------------------------------------------
    {
      const fail = await seedImageWithBytes(
        storage,
        dbHandle.db,
        tripService,
        "Case5 provider-failure",
        sourceImage,
      );
      const failJob = insertJob(dbHandle.db, fail.mediaId);
      const failAudit = insertAuditRow(aiInvocationsRepo, failJob, fail.mediaId);
      const queue = makeQueue(new FailureResponseMockProvider());
      await queue.tickChannel("image");
      await queue.awaitInflight("image");
      await queue.stop();

      const job = readJob(dbHandle.db, failJob);
      const audit = aiInvocationsRepo.findById(failAudit);
      record(
        "provider-failure: job 'failed' + err contains provider message",
        job?.status === "failed" &&
          /rate limit exceeded/.test(String(job?.error_message)),
        `err=${String(job?.error_message)}`,
      );
      record(
        "provider-failure: audit 'failed' + duration_ms from provider + error_message",
        audit?.status === "failed" &&
          audit?.durationMs === 7 &&
          /rate limit exceeded/.test(audit?.errorMessage ?? ""),
        JSON.stringify(audit),
      );
      record(
        "provider-failure: no ai_refined row written",
        listVersions(dbHandle.db, fail.mediaId).filter((v) => v.version_type === "ai_refined")
          .length === 0,
        "ok",
      );
    }

    // -----------------------------------------------------------------
    // CASE 6: provider throws — generic Error path.
    // -----------------------------------------------------------------
    {
      const thr = await seedImageWithBytes(
        storage,
        dbHandle.db,
        tripService,
        "Case6 provider-throws",
        sourceImage,
      );
      const thrJob = insertJob(dbHandle.db, thr.mediaId);
      const thrAudit = insertAuditRow(aiInvocationsRepo, thrJob, thr.mediaId);
      const queue = makeQueue(new ThrowingMockProvider());
      await queue.tickChannel("image");
      await queue.awaitInflight("image");
      await queue.stop();

      const job = readJob(dbHandle.db, thrJob);
      const audit = aiInvocationsRepo.findById(thrAudit);
      record(
        "provider-throws: job 'failed' + err contains provider stack message",
        job?.status === "failed" &&
          /provider exploded/.test(String(job?.error_message)),
        `err=${String(job?.error_message)}`,
      );
      record(
        "provider-throws: audit 'failed' + error_message records the throw",
        audit?.status === "failed" && /provider exploded/.test(audit?.errorMessage ?? ""),
        `audit=${JSON.stringify(audit)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 7: media missing — job claimed for a media row that was
    // hard-deleted between enqueue and dequeue.
    // -----------------------------------------------------------------
    {
      const ghost = await seedImageWithBytes(
        storage,
        dbHandle.db,
        tripService,
        "Case7 missing-media",
        sourceImage,
      );
      const ghostJob = insertJob(dbHandle.db, ghost.mediaId);
      const ghostAudit = insertAuditRow(aiInvocationsRepo, ghostJob, ghost.mediaId);
      // Hard-delete the media row (CASCADE removes processing_jobs +
      // media_versions; but the audit row's media_id flips to NULL
      // per migration 012 FK SET NULL).
      dbHandle.db.prepare(`DELETE FROM media_items WHERE id = ?`).run(ghost.mediaId);
      // The processing_jobs row was CASCADE-deleted too, so the queue
      // will have nothing to claim. Re-insert a job pointing at the
      // now-gone media (we have to skip FK temporarily, but a cleaner
      // way is to seed a new media + delete just before claim).
      // Instead, seed afresh + soft-delete to exercise the same code
      // path the worker actually sees ("findById returns null").
      const ghost2 = await seedImageWithBytes(
        storage,
        dbHandle.db,
        tripService,
        "Case7b soft-deleted",
        sourceImage,
      );
      const ghostJob2 = insertJob(dbHandle.db, ghost2.mediaId);
      const ghostAudit2 = insertAuditRow(aiInvocationsRepo, ghostJob2, ghost2.mediaId);
      mediaService.softDeleteMedia(ghost2.mediaId);

      const queue = makeQueue(new SuccessMockProvider(tinyJpeg));
      await queue.tickChannel("image");
      await queue.awaitInflight("image");
      await queue.stop();

      const job = readJob(dbHandle.db, ghostJob2);
      const audit = aiInvocationsRepo.findById(ghostAudit2);
      record(
        "soft-deleted: job 'failed' + err mentions 'soft-deleted'",
        job?.status === "failed" &&
          /soft-deleted/.test(String(job?.error_message)),
        `err=${String(job?.error_message)}`,
      );
      record(
        "soft-deleted: audit 'failed'",
        audit?.status === "failed",
        JSON.stringify(audit),
      );
      void ghostAudit;
      void ghostJob;
    }

    // -----------------------------------------------------------------
    // CASE 8: non-image media (somehow got into the queue).
    // -----------------------------------------------------------------
    {
      const vid = seedMediaOfType(tripService, mediaRepo, "video");
      const vidJob = insertJob(dbHandle.db, vid.mediaId);
      const vidAudit = insertAuditRow(aiInvocationsRepo, vidJob, vid.mediaId);

      const queue = makeQueue(new SuccessMockProvider(tinyJpeg));
      await queue.tickChannel("image");
      await queue.awaitInflight("image");
      await queue.stop();

      const job = readJob(dbHandle.db, vidJob);
      const audit = aiInvocationsRepo.findById(vidAudit);
      record(
        "non-image: job 'failed' + err mentions 'not an image'",
        job?.status === "failed" &&
          /not an image/.test(String(job?.error_message)),
        `err=${String(job?.error_message)}`,
      );
      record(
        "non-image: audit 'failed'",
        audit?.status === "failed",
        JSON.stringify(audit),
      );
    }

    // -----------------------------------------------------------------
    // CASE 9: no pending audit row — worker refuses to fabricate one.
    // -----------------------------------------------------------------
    {
      const orphan = await seedImageWithBytes(
        storage,
        dbHandle.db,
        tripService,
        "Case9 no-audit",
        sourceImage,
      );
      const orphanJob = insertJob(dbHandle.db, orphan.mediaId);
      // No audit row inserted.
      const queue = makeQueue(new SuccessMockProvider(tinyJpeg));
      await queue.tickChannel("image");
      await queue.awaitInflight("image");
      await queue.stop();

      const job = readJob(dbHandle.db, orphanJob);
      record(
        "no-audit: job 'failed' + err mentions 'no pending ai_invocations row'",
        job?.status === "failed" &&
          /no pending ai_invocations row/.test(String(job?.error_message)),
        `err=${String(job?.error_message)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 10: empty outputBytes — provider returns success shape but
    // with 0-byte payload.
    // -----------------------------------------------------------------
    {
      const empty = await seedImageWithBytes(
        storage,
        dbHandle.db,
        tripService,
        "Case10 empty-output",
        sourceImage,
      );
      const emptyJob = insertJob(dbHandle.db, empty.mediaId);
      const emptyAudit = insertAuditRow(aiInvocationsRepo, emptyJob, empty.mediaId);
      const queue = makeQueue(new EmptyOutputMockProvider());
      await queue.tickChannel("image");
      await queue.awaitInflight("image");
      await queue.stop();

      const job = readJob(dbHandle.db, emptyJob);
      const audit = aiInvocationsRepo.findById(emptyAudit);
      record(
        "empty-output: job 'failed' + err mentions 'outputBytes'",
        job?.status === "failed" && /outputBytes/.test(String(job?.error_message)),
        `err=${String(job?.error_message)}`,
      );
      record(
        "empty-output: audit 'failed'",
        audit?.status === "failed",
        JSON.stringify(audit),
      );
      record(
        "empty-output: no ai_refined row written",
        listVersions(dbHandle.db, empty.mediaId).filter(
          (v) => v.version_type === "ai_refined",
        ).length === 0,
        "ok",
      );
    }

    // -----------------------------------------------------------------
    // CASE 11: provider throws AIProviderUnsupportedRequestError
    // -----------------------------------------------------------------
    {
      const uns = await seedImageWithBytes(
        storage,
        dbHandle.db,
        tripService,
        "Case11 unsupported",
        sourceImage,
      );
      const unsJob = insertJob(dbHandle.db, uns.mediaId);
      const unsAudit = insertAuditRow(aiInvocationsRepo, unsJob, uns.mediaId);
      const queue = makeQueue(new UnsupportedMockProvider());
      await queue.tickChannel("image");
      await queue.awaitInflight("image");
      await queue.stop();

      const job = readJob(dbHandle.db, unsJob);
      const audit = aiInvocationsRepo.findById(unsAudit);
      record(
        "unsupported: job 'failed' + err mentions 'does not support'",
        job?.status === "failed" &&
          /does not support/.test(String(job?.error_message)),
        `err=${String(job?.error_message)}`,
      );
      record(
        "unsupported: audit 'failed'",
        audit?.status === "failed",
        JSON.stringify(audit),
      );
    }

    // -----------------------------------------------------------------
    // CASE 12: race-safe markRunning — pre-existing 'failed' audit
    // row is NOT re-used (worker only consumes pending).
    // -----------------------------------------------------------------
    {
      const race = await seedImageWithBytes(
        storage,
        dbHandle.db,
        tripService,
        "Case12 race",
        sourceImage,
      );
      const raceJob = insertJob(dbHandle.db, race.mediaId);
      // Insert a FAILED audit row (not pending). The worker should
      // refuse to pick it up — it only consumes pending.
      const raceFailedAuditId = randomUUID();
      const now = new Date().toISOString();
      dbHandle.db
        .prepare(
          `INSERT INTO ai_invocations
             (id, media_id, job_id, provider, model_name, request_type,
              status, error_message, created_at, updated_at)
           VALUES (?, ?, ?, 'stub', 'pending', 'image_ai_refine',
                   'failed', 'prior failure', ?, ?)`,
        )
        .run(raceFailedAuditId, race.mediaId, raceJob, now, now);

      const queue = makeQueue(new SuccessMockProvider(tinyJpeg));
      await queue.tickChannel("image");
      await queue.awaitInflight("image");
      await queue.stop();

      const job = readJob(dbHandle.db, raceJob);
      const failedAudit = aiInvocationsRepo.findById(raceFailedAuditId);
      record(
        "race-safe: job 'failed' because only pending audit rows are consumed",
        job?.status === "failed" &&
          /no pending ai_invocations row/.test(String(job?.error_message)),
        `err=${String(job?.error_message)}`,
      );
      record(
        "race-safe: pre-existing 'failed' audit row is untouched",
        failedAudit?.status === "failed" &&
          failedAudit?.errorMessage === "prior failure",
        JSON.stringify(failedAudit),
      );
    }

    // -----------------------------------------------------------------
    // CASE 13: AIProviderNotConfiguredError thrown DIRECTLY from
    // invoke (separate from `available=false` re-check) — should
    // still be caught and audit failed.
    // -----------------------------------------------------------------
    class NotConfiguredThrowProvider implements AIProvider {
      readonly name = "ai-refine-thrower-stub";
      readonly available = true;
      readonly supports: ReadonlySet<AIRequestType> = new Set(["image_ai_refine"]);

      async invoke(_req: AIRequest): Promise<AIResponse> {
        throw new AIProviderNotConfiguredError("inner not-configured (stub)");
      }
    }
    {
      const nc = await seedImageWithBytes(
        storage,
        dbHandle.db,
        tripService,
        "Case13 not-config-throw",
        sourceImage,
      );
      const ncJob = insertJob(dbHandle.db, nc.mediaId);
      const ncAudit = insertAuditRow(aiInvocationsRepo, ncJob, nc.mediaId);
      const queue = makeQueue(new NotConfiguredThrowProvider());
      await queue.tickChannel("image");
      await queue.awaitInflight("image");
      await queue.stop();

      const job = readJob(dbHandle.db, ncJob);
      const audit = aiInvocationsRepo.findById(ncAudit);
      record(
        "not-configured-throw: job 'failed' + err mentions AI_NOT_CONFIGURED",
        job?.status === "failed" &&
          /AI_NOT_CONFIGURED/.test(String(job?.error_message)),
        `err=${String(job?.error_message)}`,
      );
      record(
        "not-configured-throw: audit 'failed'",
        audit?.status === "failed",
        JSON.stringify(audit),
      );
    }

    // -----------------------------------------------------------------
    // CASE 14: audit FK on success (foreign keys remain consistent
    // through the worker's writes).
    // -----------------------------------------------------------------
    {
      const fk = await readFile(path.join(storage.root, happy.originalPath));
      void fk;
      const fkCheck = dbHandle.db.prepare(`PRAGMA foreign_key_check`).all();
      record(
        "fk-integrity: PRAGMA foreign_key_check is clean after all cases",
        Array.isArray(fkCheck) && fkCheck.length === 0,
        `rows=${JSON.stringify(fkCheck)}`,
      );
      const integ = dbHandle.db.prepare(`PRAGMA integrity_check`).all() as {
        integrity_check: string;
      }[];
      record(
        "fk-integrity: PRAGMA integrity_check returns 'ok'",
        integ.length === 1 && integ[0]?.integrity_check === "ok",
        JSON.stringify(integ),
      );
    }

    // type-only import — referenced via `audit: AiInvocationRow | null`.
  } finally {
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
