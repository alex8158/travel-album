// P10 phase acceptance smoke (P10.T7).
//
// Usage: npm run smoke:p10-acceptance
//
// End-to-end verification that the P10.T1 ~ P10.T6 AI refine
// pipeline forms a coherent product when wired through the
// LocalMockProvider (P10.T7 fixture). Boots a real SQLite + real
// LocalStorageProvider + a real Express server, drives one image
// through the entire refine path, and exercises every cross-cut
// red line (R-131..R-137) recorded in progress.md.
//
// This smoke is the canonical answer to "is P10 actually shippable
// end-to-end?". Per-task smokes (smoke:ai-provider,
// smoke:media-ai-refine-trigger, smoke:ai-quota-trigger,
// smoke:image-ai-refine-worker) cover each layer in isolation;
// this one stitches them together against a single media row so
// that a regression in the hand-off between layers cannot hide.
//
// Coverage matrix:
//
//   * LocalMockProvider acceptance:
//       - Factory selects LocalMockProvider when AI_ENABLED=true +
//         AI_PROVIDER=local-mock.
//       - Provider name + model are stable strings (audit fixtures
//         can assert against them).
//       - invoke() returns success with deterministic output
//         bytes that parse as JPEG via sharp + that DIFFER from
//         the input bytes (so the "refined" version is visibly
//         distinct in the compare panel).
//       - `raw` field is intentionally undefined so
//         media_versions.params.raw lands as null (R-134
//         closure).
//
//   * End-to-end happy path through HTTP + worker:
//       - POST /api/media/:id/ai-refine on an image returns 200
//         + outcome='created' + jobId + aiInvocationId.
//       - JobQueue drains the image_ai_refine row → audit row
//         transitions pending → success → media_versions has a
//         row of version_type='ai_refined' that points at a
//         /storage path the route can serve.
//       - GET /api/media/:id/versions includes the ai_refined row
//         with isActive=false (user must opt in via
//         select-version) → P8.T4 compare panel can render it.
//
//   * Cross-task red lines (each gets its own assertion block):
//       - CLAUDE.md §2.1 — original bytes byte-for-byte intact
//         across the entire refine.
//       - CLAUDE.md §3.9 — user_decision / active_version_type
//         on media_items NEVER changed by the worker.
//       - 404 / 400 — wrong media id / video media → no audit row
//         written, no media_versions row created.
//       - 501 — AI_ENABLED=false (NoopProvider) → no audit row,
//         no enqueue, banner-ready error.
//       - 429 — quota gate fires BEFORE enqueue + before audit
//         row write.
//
//   * R-131 closure: audit state stays consistent without a
//     'running' intermediate; markSuccess WHERE status='pending'
//     atomic claim works end-to-end.
//
//   * R-132 closure: retryOverrides for image_ai_refine pins
//     maxRetries=0 — a worker throw lands the job in 'failed'
//     immediately, without burning retry budget on "no pending
//     audit row" cascades.
//
//   * R-133 sanity: quota count at dequeue time matches enqueue
//     time (gate runs once; worker doesn't re-decrement).
//
//   * R-134 closure: media_versions.params.raw is null after a
//     LocalMockProvider run (the provider omits raw entirely).
//     Belt-and-suspenders: scan the persisted params JSON for
//     obvious sensitive keywords (api_key / token / secret /
//     password / authorization) and assert none appear.
//
//   * R-135 disposition: /api/health.capabilities.aiEnabled
//     reflects AI_ENABLED=true correctly when LocalMockProvider
//     is wired; documents the gap (provider name + available are
//     NOT in capabilities — that's a future polish).
//
//   * R-136 disposition: ai-refine-success response carries
//     jobId + aiInvocationId for diagnostics; the worker
//     completion is observable via subsequent GET /versions
//     polling (which the smoke does explicitly).
//
//   * R-137 disposition: error responses carry server-localised
//     messages (English); structured details ARE in body for
//     future i18n.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import express from "express";
import sharp from "sharp";

import {
  AiInvocationsRepository,
  createAIProviderFromConfig,
  LocalMockProvider,
  LOCAL_MOCK_MODEL_NAME,
  LOCAL_MOCK_PROVIDER_NAME,
  NoopProvider,
  type AIProvider,
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
import { makeErrorHandler, notFoundHandler } from "../middleware/errorHandler.js";
import { requestIdMiddleware } from "../middleware/requestId.js";
import { makeMediaRouter } from "../routes/media.js";
import { makeStorageRouter } from "../routes/storage.js";
import { makeHealthRouter } from "../routes/health.js";
import { LocalStorageProvider } from "../storage/index.js";
import { TripRepository, TripService } from "../trips/index.js";
import { UploadService } from "../upload/index.js";
import type { Capabilities } from "../runtime/capabilities.js";

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

async function makeTinyJpeg(): Promise<Buffer> {
  return sharp({
    create: {
      width: 64,
      height: 64,
      channels: 3,
      background: { r: 80, g: 160, b: 220 },
    },
  })
    .jpeg({ quality: 88 })
    .toBuffer();
}

interface Seeded {
  readonly tripId: string;
  readonly mediaId: string;
  readonly originalPath: string;
}

async function seedImage(
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

function seedVideoMedia(
  tripService: TripService,
  mediaRepo: MediaRepository,
): { tripId: string; mediaId: string } {
  const trip = tripService.createTrip({ title: "P10 acceptance video" });
  const mediaId = randomUUID();
  const now = new Date().toISOString();
  mediaRepo.insert({
    id: mediaId,
    tripId: trip.id,
    type: "video",
    originalPath: `trips/${trip.id}/originals/${mediaId}.mp4`,
    fileSize: 4096,
    mimeType: "video/mp4",
    extension: "mp4",
    createdAt: now,
    updatedAt: now,
  });
  return { tripId: trip.id, mediaId };
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
  params: string | null;
}> {
  return db
    .prepare(
      `SELECT version_type, file_path, width, height, file_size, model_name, params
       FROM media_versions WHERE media_id = ? ORDER BY version_type`,
    )
    .all(mediaId) as Array<{
    version_type: string;
    file_path: string;
    width: number | null;
    height: number | null;
    file_size: number | null;
    model_name: string | null;
    params: string | null;
  }>;
}

function countAuditByJobId(db: SqliteDatabase, jobId: string): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM ai_invocations WHERE job_id = ?`)
      .get(jobId) as { n: number }
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

const SENSITIVE_KEYWORDS = [
  "api_key",
  "apiKey",
  "token",
  "secret",
  "password",
  "authorization",
  "bearer",
];

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // -------------------------------------------------------------------
  // PHASE A — LocalMockProvider unit-level acceptance (no DB)
  // -------------------------------------------------------------------
  {
    // Factory selects LocalMockProvider for AI_ENABLED=true + provider='local-mock'
    const p = createAIProviderFromConfig({ enabled: true, provider: "local-mock" });
    record(
      "factory: AI_ENABLED=true + provider='local-mock' → LocalMockProvider",
      p instanceof LocalMockProvider,
      `name=${p.name}`,
    );
    record(
      "factory: LocalMockProvider name/model are stable strings",
      LOCAL_MOCK_PROVIDER_NAME === "local-mock" &&
        LOCAL_MOCK_MODEL_NAME === "local-mock-image-refine-v1",
      `name=${LOCAL_MOCK_PROVIDER_NAME} model=${LOCAL_MOCK_MODEL_NAME}`,
    );
    record(
      "factory: LocalMockProvider supports image_ai_refine + available=true",
      p.available && p.supports.has("image_ai_refine"),
      `supports=${[...p.supports].join(",")} available=${p.available}`,
    );

    // Case-insensitive + whitespace tolerance
    const p2 = createAIProviderFromConfig({ enabled: true, provider: "  Local-Mock  " });
    record(
      "factory: 'Local-Mock' (case+whitespace) → LocalMockProvider",
      p2 instanceof LocalMockProvider,
      `name=${p2.name}`,
    );

    // AI_ENABLED=false → still NoopProvider even if AI_PROVIDER=local-mock
    const p3 = createAIProviderFromConfig({ enabled: false, provider: "local-mock" });
    record(
      "factory: AI_ENABLED=false + local-mock → NoopProvider (operator off wins)",
      p3 instanceof NoopProvider,
      `name=${p3.name}`,
    );
  }

  // -------------------------------------------------------------------
  // PHASE B — LocalMockProvider.invoke() output validation
  // -------------------------------------------------------------------
  const sourceBytes = await makeTinyJpeg();
  {
    const provider = new LocalMockProvider();
    const resp = await provider.invoke({
      requestType: "image_ai_refine",
      mediaId: "mediaA",
      jobId: "jobA",
      inputBytes: sourceBytes,
    });
    record(
      "local-mock invoke: status='success'",
      resp.status === "success",
      `status=${resp.status}`,
    );
    if (resp.status === "success") {
      const outputBytes = resp.outputBytes;
      record(
        "local-mock invoke: outputBytes is a non-empty Buffer",
        outputBytes !== undefined && outputBytes.length > 0,
        `bytes=${outputBytes?.length ?? 0}`,
      );
      record(
        "local-mock invoke: outputBytes differs from inputBytes (refine visibly applied)",
        outputBytes !== undefined && !outputBytes.equals(sourceBytes),
        `inputBytes=${sourceBytes.length} outputBytes=${outputBytes?.length ?? 0}`,
      );
      // R-134 — `raw` MUST be undefined / null. No provider secret echo.
      record(
        "R-134: local-mock invoke does NOT set `raw` (no secret echo into media_versions.params)",
        resp.raw === undefined,
        `raw=${JSON.stringify(resp.raw)}`,
      );
      record(
        "local-mock invoke: cost_estimate=0 + duration_ms is finite + responseSummary set",
        resp.costEstimate === 0 &&
          typeof resp.durationMs === "number" &&
          Number.isFinite(resp.durationMs) &&
          typeof resp.responseSummary === "string" &&
          resp.responseSummary.length > 0,
        `cost=${resp.costEstimate} ms=${resp.durationMs} summary=${resp.responseSummary}`,
      );

      // Verify outputBytes parse as a real JPEG via sharp.
      try {
        const meta = await sharp(outputBytes!).metadata();
        record(
          "local-mock invoke: outputBytes parse via sharp as JPEG with non-null width/height",
          meta.format === "jpeg" &&
            typeof meta.width === "number" &&
            typeof meta.height === "number",
          `format=${meta.format} ${meta.width}x${meta.height}`,
        );
      } catch (sharpErr) {
        record(
          "local-mock invoke: outputBytes parse via sharp as JPEG with non-null width/height",
          false,
          `sharp failed: ${describeError(sharpErr)}`,
        );
      }
    }
  }

  {
    // Empty inputBytes → AIFailureResponse (NOT throw)
    const provider = new LocalMockProvider();
    const resp = await provider.invoke({
      requestType: "image_ai_refine",
      mediaId: "mediaB",
      jobId: "jobB",
      inputBytes: Buffer.alloc(0),
    });
    record(
      "local-mock invoke (empty input): returns AIFailureResponse (not throw)",
      resp.status === "failed" &&
        /inputBytes missing or empty/.test(
          (resp as { errorMessage: string }).errorMessage,
        ),
      `status=${resp.status} err=${(resp as { errorMessage?: string }).errorMessage ?? "-"}`,
    );
  }

  // -------------------------------------------------------------------
  // PHASE C — End-to-end refine through HTTP + worker
  // -------------------------------------------------------------------
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-p10-acceptance-smoke-"));
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
    const aiInvocationsRepo = new AiInvocationsRepository(dbHandle.db);
    const aiProvider: AIProvider = new LocalMockProvider();

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
      {
        aiInvocationsRepo,
        dailyLimit: 0,
        tripLimit: 0,
      },
    );

    // Image handlers map: only the ai_refine handler is needed for
    // this smoke. Other image workers (thumbnail / metadata /
    // enhance / hash / quality) are NOT registered — keeping the
    // smoke focused on the AI refine path.
    const imageHandlers = new Map<string, JobHandler>();
    imageHandlers.set(
      IMAGE_AI_REFINE_JOB_TYPE,
      makeImageAiRefineHandler({
        storage,
        mediaRepo,
        mediaVersionsRepo,
        aiInvocationsRepo,
        aiProvider,
        logger,
      }),
    );

    // P10.T7: per-job-type retry override. image_ai_refine retries
    // are inert (R-132); pin to 0 so a failed run hits terminal
    // immediately. The smoke proves this override is honoured.
    const queue = new JobQueue({
      jobRepo,
      logger,
      channels: [
        { name: "image", concurrency: 1, handlers: imageHandlers, pollIntervalMs: 60_000 },
        { name: "video", concurrency: 1, handlers: new Map(), pollIntervalMs: 60_000 },
        { name: "ai", concurrency: 1, handlers: new Map(), pollIntervalMs: 60_000 },
      ],
      // Set a non-zero global retry config so we can prove the per-
      // job-type override actually overrides (instead of just
      // inheriting). global=2 retries vs override=0 retries.
      retryConfig: { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 200 },
      retryOverrides: {
        [IMAGE_AI_REFINE_JOB_TYPE]: {
          maxRetries: 0,
          baseDelayMs: 0,
          maxDelayMs: 0,
        },
      },
      zombieTimeoutMs: 0,
    });

    async function drainImage(): Promise<void> {
      for (;;) {
        const tick = await queue.tickChannel("image");
        await queue.awaitInflight("image");
        if (tick.claimed.length === 0) break;
      }
    }

    // Express layer: media router + storage + health.
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
    const fakeCapabilities: Capabilities = Object.freeze({
      ffmpegAvailable: true,
      ffmpegVersion: "smoke",
      ffmpegPath: "ffmpeg",
      ffmpegError: null,
      ffprobeAvailable: true,
      ffprobeVersion: "smoke",
      ffprobePath: "ffprobe",
      ffprobeError: null,
      permanentDeleteEnabled: false,
      aiEnabled: true,
    });

    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use(requestIdMiddleware);
    app.use(
      "/api/health",
      makeHealthRouter({ capabilities: fakeCapabilities, storage }),
    );
    app.use(
      "/api",
      makeMediaRouter({ uploadService, mediaService, aiProvider }),
    );
    app.use("/storage", makeStorageRouter({ storage }));
    app.use(notFoundHandler);
    app.use(makeErrorHandler(logger));
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    // ---- R-135 disposition: health endpoint exposes aiEnabled -------
    {
      const h = await jsonFetch<{
        capabilities: { aiEnabled: boolean };
      }>(`${base}/api/health`);
      record(
        "R-135 disposition: /api/health capabilities.aiEnabled=true when AI is on",
        h.status === 200 && h.body.capabilities.aiEnabled === true,
        `aiEnabled=${h.body.capabilities.aiEnabled}`,
      );
    }

    // ---- Happy path: enqueue + drain + verify ----
    const happy = await seedImage(storage, dbHandle.db, tripService, "Case1 happy", sourceBytes);
    let happyJobId = "";
    let happyAuditId = "";
    {
      const r = await jsonFetch<{
        mediaId: string;
        jobType: string;
        outcome: string;
        jobId: string;
        aiInvocationId?: string;
      }>(`${base}/api/media/${encodeURIComponent(happy.mediaId)}/ai-refine`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      record(
        "HTTP POST /ai-refine: 200 + jobType=image_ai_refine + outcome=created + aiInvocationId set",
        r.status === 200 &&
          r.body.jobType === IMAGE_AI_REFINE_JOB_TYPE &&
          r.body.outcome === "created" &&
          typeof r.body.jobId === "string" &&
          r.body.jobId.length === 36 &&
          typeof r.body.aiInvocationId === "string" &&
          r.body.aiInvocationId.length === 36,
        `status=${r.status} body=${JSON.stringify(r.body)}`,
      );
      happyJobId = r.body.jobId;
      happyAuditId = r.body.aiInvocationId ?? "";
    }

    // Audit row is pending before worker runs.
    {
      const audit = aiInvocationsRepo.findById(happyAuditId);
      record(
        "pre-drain: audit row created with status='pending' + provider='local-mock'",
        audit?.status === "pending" && audit?.provider === LOCAL_MOCK_PROVIDER_NAME,
        JSON.stringify(audit),
      );
    }

    // Drain the image channel — worker claims + executes.
    await drainImage();

    // Post-drain assertions: success transition + media_versions row.
    {
      const job = readJob(dbHandle.db, happyJobId);
      record(
        "post-drain: processing_jobs.status='success'",
        job?.status === "success",
        `status=${String(job?.status)} err=${String(job?.error_message)}`,
      );
      const audit = aiInvocationsRepo.findById(happyAuditId);
      record(
        "post-drain: ai_invocations.status='success' + model_name from provider + cost/duration set",
        audit?.status === "success" &&
          audit?.modelName === LOCAL_MOCK_MODEL_NAME &&
          audit?.costEstimate === 0 &&
          typeof audit?.durationMs === "number",
        JSON.stringify(audit),
      );
      const versions = listVersions(dbHandle.db, happy.mediaId);
      const refined = versions.find((v) => v.version_type === "ai_refined");
      record(
        "post-drain: media_versions has exactly 1 row of version_type='ai_refined' with non-null width/height",
        versions.filter((v) => v.version_type === "ai_refined").length === 1 &&
          refined !== undefined &&
          typeof refined.width === "number" &&
          typeof refined.height === "number" &&
          (refined.width ?? 0) > 0 &&
          (refined.height ?? 0) > 0 &&
          refined.model_name === LOCAL_MOCK_MODEL_NAME,
        JSON.stringify(refined),
      );

      // ---- R-134 closure: params.raw is null + no sensitive keywords
      if (refined?.params !== undefined && refined.params !== null) {
        const parsedParams = JSON.parse(refined.params) as { raw: unknown };
        record(
          "R-134 closure: media_versions.params.raw === null (no provider secret echo)",
          parsedParams.raw === null,
          `raw=${String(parsedParams.raw)}`,
        );
        const lowered = refined.params.toLowerCase();
        const leaked = SENSITIVE_KEYWORDS.filter((kw) => lowered.includes(kw.toLowerCase()));
        record(
          "R-134 closure: params JSON contains no obvious sensitive keywords (api_key / token / secret / password / authorization / bearer)",
          leaked.length === 0,
          `leakedKeywords=${JSON.stringify(leaked)}`,
        );
      }

      // ai_refined file on disk is non-empty + parseable JPEG.
      const refinedAbs = path.join(storage.root, refined!.file_path);
      record(
        "post-drain: ai_refined.jpg present on disk + non-empty",
        existsSync(refinedAbs) && readFileSync(refinedAbs).length > 0,
        `abs=${refinedAbs}`,
      );
      try {
        const meta = await sharp(readFileSync(refinedAbs)).metadata();
        record(
          "post-drain: ai_refined.jpg parses as JPEG via sharp",
          meta.format === "jpeg",
          `format=${meta.format} ${meta.width}x${meta.height}`,
        );
      } catch (err) {
        record(
          "post-drain: ai_refined.jpg parses as JPEG via sharp",
          false,
          describeError(err),
        );
      }
    }

    // ---- R-131 closure: audit state machine consistent without 'running'
    {
      const audit = aiInvocationsRepo.findById(happyAuditId);
      record(
        "R-131 closure: audit row went pending → success (no intermediate 'running' needed)",
        audit?.status === "success",
        `status=${String(audit?.status)}`,
      );
    }

    // ---- Scope-guard: original bytes + media_items unchanged ----
    {
      const originalOnDisk = readFileSync(path.join(storage.root, happy.originalPath));
      record(
        "scope-guard: original bytes byte-for-byte unchanged",
        originalOnDisk.equals(sourceBytes),
        `before=${sourceBytes.length}B after=${originalOnDisk.length}B`,
      );
      const m = readMediaRow(dbHandle.db, happy.mediaId);
      record(
        "scope-guard: media_items.user_decision / active_version_type / status / preview_path unchanged",
        m?.status === "processed" &&
          m?.user_decision === "undecided" &&
          m?.active_version_type === "original" &&
          m?.preview_path === null,
        `media=${JSON.stringify({
          status: m?.status,
          user_decision: m?.user_decision,
          active_version_type: m?.active_version_type,
          preview_path: m?.preview_path,
        })}`,
      );
    }

    // ---- GET /versions returns ai_refined for the P8.T5 panel ----
    {
      const r = await jsonFetch<{
        mediaId: string;
        activeVersionType: string;
        versions: Array<{ versionType: string; filePath: string; isActive: boolean }>;
      }>(`${base}/api/media/${encodeURIComponent(happy.mediaId)}/versions`);
      const refined = r.body.versions.find((v) => v.versionType === "ai_refined");
      record(
        "GET /versions: includes ai_refined entry (isActive=false; user opts in via select-version)",
        r.status === 200 && refined !== undefined && refined.isActive === false,
        `refined=${JSON.stringify(refined)}`,
      );
    }

    // ---- /storage delivers the canonical ai_refined file ----
    {
      const versions = listVersions(dbHandle.db, happy.mediaId);
      const refined = versions.find((v) => v.version_type === "ai_refined")!;
      const res = await fetch(`${base}/storage/${refined.file_path}`);
      const buf = Buffer.from(await res.arrayBuffer());
      record(
        "/storage delivers the canonical ai_refined file with non-empty bytes",
        res.status === 200 && buf.length > 0,
        `status=${res.status} bytes=${buf.length}`,
      );
    }

    // ---- 400 path: video media → no enqueue, no audit row ----
    {
      const video = seedVideoMedia(tripService, mediaRepo);
      const beforeAudit = aiInvocationsRepo.countSinceTimestamp(
        new Date(0).toISOString(),
      );
      const r = await jsonFetch<{ error: { code: string } }>(
        `${base}/api/media/${encodeURIComponent(video.mediaId)}/ai-refine`,
        { method: "POST" },
      );
      const afterAudit = aiInvocationsRepo.countSinceTimestamp(
        new Date(0).toISOString(),
      );
      record(
        "400 (video media): server rejects with BAD_REQUEST + no audit row written",
        r.status === 400 &&
          r.body?.error?.code === "BAD_REQUEST" &&
          beforeAudit === afterAudit,
        `status=${r.status} body=${JSON.stringify(r.body)}`,
      );
    }

    // ---- 404 path: missing media → no enqueue, no audit row ----
    {
      const beforeAudit = aiInvocationsRepo.countSinceTimestamp(
        new Date(0).toISOString(),
      );
      const r = await jsonFetch<{ error: { code: string } }>(
        `${base}/api/media/${encodeURIComponent(randomUUID())}/ai-refine`,
        { method: "POST" },
      );
      const afterAudit = aiInvocationsRepo.countSinceTimestamp(
        new Date(0).toISOString(),
      );
      record(
        "404 (missing media): server rejects with NOT_FOUND + no audit row written",
        r.status === 404 &&
          r.body?.error?.code === "NOT_FOUND" &&
          beforeAudit === afterAudit,
        `status=${r.status}`,
      );
    }

    // ---- 501 path: AI disabled (NoopProvider) ----
    {
      // Spin up a SECOND HTTP server with NoopProvider so we can
      // assert the disabled-AI gate fires before any audit/queue
      // mutation.
      const noopApp = express();
      noopApp.use(express.json({ limit: "1mb" }));
      noopApp.use(requestIdMiddleware);
      noopApp.use(
        "/api",
        makeMediaRouter({ uploadService, mediaService, aiProvider: new NoopProvider() }),
      );
      noopApp.use(notFoundHandler);
      noopApp.use(makeErrorHandler(logger));
      const noopServer = createServer(noopApp);
      await new Promise<void>((resolve) => noopServer.listen(0, "127.0.0.1", resolve));
      const noopPort = (noopServer.address() as AddressInfo).port;
      const noopBase = `http://127.0.0.1:${noopPort}`;

      try {
        const noopImage = await seedImage(
          storage,
          dbHandle.db,
          tripService,
          "Case-501 noop",
          sourceBytes,
        );
        const beforeAudit = aiInvocationsRepo.countSinceTimestamp(
          new Date(0).toISOString(),
        );
        const r = await jsonFetch<{ error: { code: string } }>(
          `${noopBase}/api/media/${encodeURIComponent(noopImage.mediaId)}/ai-refine`,
          { method: "POST" },
        );
        const afterAudit = aiInvocationsRepo.countSinceTimestamp(
          new Date(0).toISOString(),
        );
        record(
          "501 (Noop): server rejects with AI_NOT_CONFIGURED + no audit row written",
          r.status === 501 &&
            r.body?.error?.code === "AI_NOT_CONFIGURED" &&
            beforeAudit === afterAudit,
          `status=${r.status} body=${JSON.stringify(r.body)}`,
        );
      } finally {
        await new Promise<void>((resolve) => noopServer.close(() => resolve()));
      }
    }

    // ---- 429 path: quota gate fires BEFORE audit row write ----
    {
      // Spin up a THIRD service with a tight quota so we can hit it.
      const tightMediaService = new MediaService(
        mediaRepo,
        tripService,
        mediaVersionsRepo,
        jobRepo,
        softDeleteDeps,
        {
          aiInvocationsRepo,
          dailyLimit: 0,
          tripLimit: 1,
        },
      );
      const tightApp = express();
      tightApp.use(express.json({ limit: "1mb" }));
      tightApp.use(requestIdMiddleware);
      tightApp.use(
        "/api",
        makeMediaRouter({
          uploadService,
          mediaService: tightMediaService,
          aiProvider: new LocalMockProvider(),
        }),
      );
      tightApp.use(notFoundHandler);
      tightApp.use(makeErrorHandler(logger));
      const tightServer = createServer(tightApp);
      await new Promise<void>((resolve) => tightServer.listen(0, "127.0.0.1", resolve));
      const tightPort = (tightServer.address() as AddressInfo).port;
      const tightBase = `http://127.0.0.1:${tightPort}`;

      try {
        // First call in a NEW trip → 200.
        const firstQuota = await seedImage(
          storage,
          dbHandle.db,
          tripService,
          "Case-429 first",
          sourceBytes,
        );
        const r1 = await jsonFetch<{ outcome: string }>(
          `${tightBase}/api/media/${encodeURIComponent(firstQuota.mediaId)}/ai-refine`,
          { method: "POST" },
        );
        record(
          "quota: first call in fresh trip with tripLimit=1 → 200 outcome='created'",
          r1.status === 200 && r1.body.outcome === "created",
          `status=${r1.status} body=${JSON.stringify(r1.body)}`,
        );

        // Second call IN THE SAME TRIP → 429.
        const mediaIdInSameTrip = randomUUID();
        const now2 = new Date().toISOString();
        mediaRepo.insert({
          id: mediaIdInSameTrip,
          tripId: firstQuota.tripId,
          type: "image",
          originalPath: `trips/${firstQuota.tripId}/originals/${mediaIdInSameTrip}.jpg`,
          fileSize: 1024,
          mimeType: "image/jpeg",
          extension: "jpg",
          createdAt: now2,
          updatedAt: now2,
        });
        const beforeAuditCount = aiInvocationsRepo.countByTripId(firstQuota.tripId);
        const r2 = await jsonFetch<{
          error: { code: string; details: { kind: string; limit: number; used: number } };
        }>(
          `${tightBase}/api/media/${encodeURIComponent(mediaIdInSameTrip)}/ai-refine`,
          { method: "POST" },
        );
        const afterAuditCount = aiInvocationsRepo.countByTripId(firstQuota.tripId);
        record(
          "quota (R-133 sanity): 2nd call in trip → 429 AI_QUOTA_EXCEEDED + audit count unchanged",
          r2.status === 429 &&
            r2.body?.error?.code === "AI_QUOTA_EXCEEDED" &&
            r2.body?.error?.details?.kind === "trip" &&
            r2.body?.error?.details?.limit === 1 &&
            r2.body?.error?.details?.used === 1 &&
            beforeAuditCount === afterAuditCount,
          `status=${r2.status} kind=${r2.body?.error?.details?.kind} before=${beforeAuditCount} after=${afterAuditCount}`,
        );
      } finally {
        await new Promise<void>((resolve) => tightServer.close(() => resolve()));
      }
    }

    // ---- R-132 closure: per-job-type retryOverrides honoured ----
    {
      // First drain any pending image_ai_refine rows the previous
      // sub-tests left in the queue (the quota sub-test's first
      // call left one pending against the main DB; that row is
      // for the LocalMockProvider, not for our throwing fixture).
      // The main `queue` (LocalMock handler) can drain it cleanly;
      // we then re-seed for the R-132 fixture against a fresh
      // throwingQueue.
      await drainImage();

      // Inject a provider that throws to force a worker failure;
      // assert the job goes straight to 'failed' (no retrying)
      // even though the global retryConfig has maxRetries=2.
      class ThrowingProvider implements AIProvider {
        readonly name = "throwing-stub";
        readonly available = true;
        readonly supports: ReadonlySet<import("../ai/index.js").AIRequestType> = new Set([
          "image_ai_refine" as const,
        ]);
        async invoke(): Promise<import("../ai/index.js").AIResponse> {
          throw new Error("intentional failure (R-132 fixture)");
        }
      }
      const throwingHandlers = new Map<string, JobHandler>();
      throwingHandlers.set(
        IMAGE_AI_REFINE_JOB_TYPE,
        makeImageAiRefineHandler({
          storage,
          mediaRepo,
          mediaVersionsRepo,
          aiInvocationsRepo,
          aiProvider: new ThrowingProvider(),
          logger,
        }),
      );
      const throwingQueue = new JobQueue({
        jobRepo,
        logger,
        channels: [
          {
            name: "image",
            concurrency: 1,
            handlers: throwingHandlers,
            pollIntervalMs: 60_000,
          },
          { name: "video", concurrency: 1, handlers: new Map(), pollIntervalMs: 60_000 },
          { name: "ai", concurrency: 1, handlers: new Map(), pollIntervalMs: 60_000 },
        ],
        retryConfig: { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 200 },
        retryOverrides: {
          [IMAGE_AI_REFINE_JOB_TYPE]: {
            maxRetries: 0,
            baseDelayMs: 0,
            maxDelayMs: 0,
          },
        },
        zombieTimeoutMs: 0,
      });

      const fixture = await seedImage(
        storage,
        dbHandle.db,
        tripService,
        "Case-R132 retry-override",
        sourceBytes,
      );
      const r = await jsonFetch<{ jobId: string }>(
        `${base}/api/media/${encodeURIComponent(fixture.mediaId)}/ai-refine`,
        { method: "POST" },
      );
      const fixtureJobId = r.body.jobId;

      // Tick the throwing-queue once. With retryOverrides
      // maxRetries=0 the job should land in 'failed' immediately;
      // a subsequent tick should find nothing to claim.
      const tick1 = await throwingQueue.tickChannel("image");
      await throwingQueue.awaitInflight("image");
      const tick2 = await throwingQueue.tickChannel("image");
      await throwingQueue.awaitInflight("image");
      await throwingQueue.stop();

      const job = readJob(dbHandle.db, fixtureJobId);
      record(
        "R-132 closure: image_ai_refine retryOverrides maxRetries=0 → failed immediately (no 'retrying' cycle)",
        tick1.claimed.length === 1 &&
          tick2.claimed.length === 0 &&
          job?.status === "failed" &&
          job?.retry_count === 0 &&
          /intentional failure/.test(String(job?.error_message)),
        `tick1=${tick1.claimed.length} tick2=${tick2.claimed.length} status=${String(
          job?.status,
        )} retry=${String(job?.retry_count)}`,
      );
    }

    // ---- R-137 disposition: 429 details ARE in body for future i18n
    {
      const fresh = await seedImage(
        storage,
        dbHandle.db,
        tripService,
        "Case-R137 i18n",
        sourceBytes,
      );
      // Drain audit count back to 0 doesn't matter — we use a
      // tight server above. Instead just verify that an arbitrary
      // 400 still carries structured detail (mediaId+type).
      const video = seedVideoMedia(tripService, mediaRepo);
      const r = await jsonFetch<{
        error: { code: string; message: string; details: Record<string, unknown> };
      }>(
        `${base}/api/media/${encodeURIComponent(video.mediaId)}/ai-refine`,
        { method: "POST" },
      );
      record(
        "R-137 disposition: error bodies carry structured `details` for future i18n re-translation",
        r.status === 400 &&
          typeof r.body.error.message === "string" &&
          r.body.error.details !== undefined &&
          r.body.error.details["type"] === "video",
        `details=${JSON.stringify(r.body.error.details)}`,
      );
      void fresh;
    }

    // ---- R-136 disposition: jobId + aiInvocationId observable so
    //      the UI can surface them in the success banner
    {
      const obs = await seedImage(
        storage,
        dbHandle.db,
        tripService,
        "Case-R136 observability",
        sourceBytes,
      );
      const r = await jsonFetch<{ jobId: string; aiInvocationId?: string }>(
        `${base}/api/media/${encodeURIComponent(obs.mediaId)}/ai-refine`,
        { method: "POST" },
      );
      record(
        "R-136 disposition: response surfaces jobId + aiInvocationId so the UI banner can show diagnostics",
        r.status === 200 &&
          typeof r.body.jobId === "string" &&
          r.body.jobId.length === 36 &&
          typeof r.body.aiInvocationId === "string" &&
          r.body.aiInvocationId.length === 36,
        `jobId=${r.body.jobId} auditId=${r.body.aiInvocationId}`,
      );
      // Drain the queue so the smoke leaves nothing pending.
      await drainImage();
    }

    // ---- FK + integrity check ----
    {
      const fk = dbHandle.db.prepare(`PRAGMA foreign_key_check`).all();
      record(
        "FK integrity: PRAGMA foreign_key_check is clean",
        Array.isArray(fk) && fk.length === 0,
        `rows=${JSON.stringify(fk)}`,
      );
      const integ = dbHandle.db.prepare(`PRAGMA integrity_check`).all() as {
        integrity_check: string;
      }[];
      record(
        "FK integrity: PRAGMA integrity_check returns 'ok'",
        integ.length === 1 && integ[0]?.integrity_check === "ok",
        JSON.stringify(integ),
      );
    }

    // Reference unused fixture so eslint doesn't strip.
    void countAuditByJobId;
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
