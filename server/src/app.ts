// Express app factory (P0.T6 + P0.T8).
//
// Middleware order (matters):
//   1. express.json (small limit; tighten/expand per route in later tasks)
//   2. requestIdMiddleware  → req.requestId
//   3. requestLogger        → finish-event structured logs
//   4. application routes
//   5. notFoundHandler      → converts unmatched routes into NotFoundError
//   6. errorHandler         → renders unified error JSON
//
// Real business routes (Trip / Media / Duplicate / Video / Job, see
// docs/design.md §3.3) land in their own files starting with P1.T3.
//
// `/__debug/*` endpoints are deliberately gated to non-production so the
// P0.T6 verification can hit AppError and unknown-error paths without
// shipping demo handlers to production. They will be removed once real
// routes exist if no longer needed.

import express, { type Express } from "express";
import type { AIProvider } from "./ai/index.js";
import type { DedupService } from "./dedup/index.js";
import { AppError } from "./errors/AppError.js";
import { ERROR_CODES } from "./errors/errorCodes.js";
import type { JobService } from "./jobs/index.js";
import type { Logger } from "./logger.js";
import { makeErrorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { requestIdMiddleware } from "./middleware/requestId.js";
import { makeRequestLogger } from "./middleware/requestLogger.js";
import type {
  MediaRepository,
  MediaService,
  VideoEditPlanService,
  VideoService,
} from "./media/index.js";
import { makeDedupRouter } from "./routes/dedup.js";
import { makeHealthRouter } from "./routes/health.js";
import { makeJobsRouter } from "./routes/jobs.js";
import { makeMediaRouter } from "./routes/media.js";
import { makeStorageRouter } from "./routes/storage.js";
import { makeTripsRouter } from "./routes/trips.js";
import { makeVideoEditPlanRouter } from "./routes/videoEditPlan.js";
import { makeVideoRouter } from "./routes/video.js";
import type { Capabilities } from "./runtime/capabilities.js";
import type { LocalStorageProvider } from "./storage/index.js";
import type { TripRepository, TripService } from "./trips/index.js";
import type { UploadService } from "./upload/index.js";

export interface CreateAppOptions {
  readonly logger: Logger;
  /** Frozen runtime capability snapshot built at startup (P0.T8). */
  readonly capabilities: Capabilities;
  /** Storage provider; surfaced through /api/health for diagnostics. */
  readonly storage: LocalStorageProvider;
  /** Trip domain service powering /api/trips (P1.T3). */
  readonly tripService: TripService;
  /**
   * Trip repository — needed by the trips route for P6.T7
   * `autoSelectCoverForTrip` (the auto-cover selector reads + writes
   * `trips.cover_media_id` outside of TripService's zod-input layer).
   */
  readonly tripRepo: TripRepository;
  /** Upload_Manager powering POST /api/trips/:tripId/media/upload (P2.T4). */
  readonly uploadService: UploadService;
  /** Media read service powering GET /api/(trips/:tripId/)?media[/:id] (P2.T5). */
  readonly mediaService: MediaService;
  /** Media repository (read-only) — needed by the trips route for P3.T8 cover_url derivation. */
  readonly mediaRepo: MediaRepository;
  /** Job domain service powering /api/jobs (P4.T4). */
  readonly jobService: JobService;
  /** Dedup domain service powering /api/trips/:tripId/dedup/* (P5.T5). */
  readonly dedupService: DedupService;
  /** Video API (P9.T8) — segments list / detail / user_decision PATCH / process. */
  readonly videoService: VideoService;
  /** Video edit plan generator (P11.T4) — backs
   * `POST /api/trips/:tripId/generate-edit-plan`. Pure planning;
   * does NOT render or write any DB row. */
  readonly videoEditPlanService: VideoEditPlanService;
  /**
   * AIProvider (P10.T1) — read at the Media router to gate
   * `POST /api/media/:id/ai-refine` (P10.T3). Defaults to
   * `NoopProvider` so `available === false` and the endpoint returns
   * 501 + `AI_NOT_CONFIGURED` until a real provider is wired
   * (CLAUDE.md §2.8 — base features must work without AI).
   */
  readonly aiProvider: AIProvider;
  /**
   * Mount `/__debug/*` verification endpoints. Should be true only for
   * development/test environments — never in production.
   */
  readonly debugRoutes: boolean;
}

export function createApp(opts: CreateAppOptions): Express {
  const {
    logger,
    capabilities,
    storage,
    tripService,
    tripRepo,
    uploadService,
    mediaService,
    mediaRepo,
    jobService,
    dedupService,
    videoService,
    videoEditPlanService,
    aiProvider,
    debugRoutes,
  } = opts;

  const app = express();
  app.disable("x-powered-by");

  app.use(express.json({ limit: "1mb" }));
  app.use(requestIdMiddleware);
  app.use(makeRequestLogger(logger));

  // Minimal liveness probe. Returns immediately and does no I/O — useful
  // for orchestrators that just need a fast 200.
  app.get("/api/ping", (_req, res) => {
    res.json({ status: "ok", time: new Date().toISOString() });
  });

  // Capability-aware health endpoint (P0.T8). Reads from a cached
  // snapshot; never re-spawns ffmpeg / ffprobe.
  app.use("/api/health", makeHealthRouter({ capabilities, storage }));

  // Trip CRUD (P1.T3) + derived cover_url (P3.T8).
  app.use("/api/trips", makeTripsRouter({ service: tripService, tripRepo, mediaRepo, logger }));

  // Media routes (P2.T4 upload + P2.T5 read + P10.T3 ai-refine).
  // Mounted at /api so this router can own paths like
  // /trips/:tripId/media/upload and /media/:id without colliding
  // with the Trip CRUD router above. `aiProvider` is plumbed
  // through so the ai-refine endpoint can gate availability before
  // touching the queue.
  app.use("/api", makeMediaRouter({ uploadService, mediaService, aiProvider }));

  // Job API (P4.T4). Mounted at /api/jobs — list / single / retry /
  // cancel. Retry / cancel are pure DB mutations; the JobQueue
  // picks up retrying rows on its next tick.
  app.use("/api/jobs", makeJobsRouter({ service: jobService }));

  // Dedup API (P5.T5). Mounted at /api so the routes live under
  // `/api/trips/:tripId/dedup/*` alongside the Media upload /
  // reprocess endpoints. Synchronous execution; each call is bound
  // to a single tripId from the URL path.
  app.use("/api", makeDedupRouter({ service: dedupService }));

  // Video API (P9.T8). Mounted at /api so the routes live under
  // `/api/media/:mediaId/video-segments[/:segmentId]`,
  // `/api/video-segments/:segmentId/user-decision`, and
  // `/api/media/:mediaId/process-video-segments`. Read paths
  // surface the P9.T1-T7 produced data; the PATCH respects R-107
  // (system rescoring never overwrites user_decision); the process
  // endpoint enqueues the three video-channel jobs in dependency
  // order and threads the optional `force` flag into the segments
  // worker payload.
  app.use("/api", makeVideoRouter({ videoService }));

  // Video edit plan generation (P11.T4). Mounted at /api so the
  // route is `/api/trips/:tripId/generate-edit-plan`. Pure plan
  // production — never renders, never writes any DB row. The
  // future P11.T5 render endpoint consumes plan JSON the client
  // gets back from this call.
  app.use("/api", makeVideoEditPlanRouter({ videoEditPlanService }));

  // Storage static-file route (P3.T1). Mounted at /storage (NOT under
  // /api) so the URL space cleanly separates JSON API from file
  // delivery. Read-only; validation lives in the router.
  app.use("/storage", makeStorageRouter({ storage }));

  if (debugRoutes) {
    // Demonstrates the AppError path: chosen status, code, message, details.
    app.get("/__debug/app-error", (_req, _res, next) => {
      next(
        new AppError(ERROR_CODES.BAD_REQUEST, "demo bad request", {
          statusCode: 400,
          details: { hint: "this route only exists when NODE_ENV !== production" },
        }),
      );
    });
    // Demonstrates the unknown-error path: must NOT leak the message or
    // stack to the client. The stack is only logged server-side.
    app.get("/__debug/throw", () => {
      throw new Error("demo unexpected error: secret stack info");
    });
  }

  app.use(notFoundHandler);
  app.use(makeErrorHandler(logger));

  return app;
}
