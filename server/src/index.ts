// Entry point. P0.T8 layers ffmpeg / ffprobe startup detection and the
// /api/health route on top of the sequence introduced in P0.T4-T7.
// Subsequent tasks add:
//   P1.T3 Trip routes (and the rest of the business surface)
// See docs/tasks.md.

import { createApp } from "./app.js";
import { ConfigError, loadConfig, type Config } from "./config/index.js";
import { closeDatabase, openDatabase, type DbHandle } from "./db/connection.js";
import { runMigrations, type MigrationResult } from "./db/migrate.js";
import { DedupEngine, DedupService, DuplicateGroupsRepository } from "./dedup/index.js";
import {
  IMAGE_ENHANCE_JOB_TYPE,
  IMAGE_HASH_JOB_TYPE,
  IMAGE_QUALITY_BLUR_JOB_TYPE,
  IMAGE_QUALITY_COLOR_JOB_TYPE,
  IMAGE_QUALITY_EXPOSURE_JOB_TYPE,
  IMAGE_QUALITY_FINALIZE_JOB_TYPE,
  JobQueue,
  JobRepository,
  JobService,
  VIDEO_COVER_JOB_TYPE,
  VIDEO_KEYFRAMES_JOB_TYPE,
  VIDEO_METADATA_JOB_TYPE,
  VIDEO_PROXY_JOB_TYPE,
  VIDEO_SEGMENT_QUALITY_JOB_TYPE,
  VIDEO_SEGMENTS_JOB_TYPE,
  makeImageEnhanceHandler,
  makeImageHashHandler,
  makeImageMetadataHandler,
  makeImageQualityBlurHandler,
  makeImageQualityColorHandler,
  makeImageQualityExposureHandler,
  makeImageQualityFinalizeHandler,
  makeImageThumbnailHandler,
  makeVideoCoverHandler,
  makeVideoKeyframesHandler,
  makeVideoMetadataHandler,
  makeVideoProxyHandler,
  makeVideoSegmentQualityHandler,
  makeVideoSegmentsHandler,
  type JobHandler,
  type JobQueueChannelConfig,
} from "./jobs/index.js";
import { createLogger, type Logger } from "./logger.js";
import {
  QUALITY_SELECTOR_JOB_TYPE,
  QualitySelectorService,
  makeQualitySelectorHandler,
} from "./quality/index.js";
import {
  MediaAnalysisRepository,
  MediaRepository,
  MediaService,
  MediaVersionsRepository,
  VideoSegmentsRepository,
  VideoService,
} from "./media/index.js";
import { createAIProviderFromConfig, type AIProvider } from "./ai/index.js";
import { detectCapabilities, type Capabilities } from "./runtime/capabilities.js";
import { LocalStorageProvider } from "./storage/index.js";
import { TripRepository, TripService } from "./trips/index.js";
import { UploadService } from "./upload/index.js";

const FORCE_EXIT_TIMEOUT_MS = 10_000;

function logStartup(
  logger: Logger,
  config: Config,
  dbHandle: DbHandle,
  migrationResult: MigrationResult,
  storage: LocalStorageProvider,
  capabilities: Capabilities,
): void {
  logger.info(
    {
      config: {
        nodeEnv: config.nodeEnv,
        port: config.port,
        storage: config.storage,
        database: { path: config.database.path },
        workers: config.workers,
        ai: { enabled: config.ai.enabled },
        delete: config.delete,
        ffmpegPathSet: config.ffmpeg.ffmpegPath !== undefined,
        ffprobePathSet: config.ffmpeg.ffprobePath !== undefined,
      },
      database: {
        resolvedPath: dbHandle.resolvedPath,
        foreignKeys: dbHandle.foreignKeysPragma,
        journalMode: dbHandle.journalModePragma,
      },
      migrations: {
        appliedNow: migrationResult.appliedNow,
        alreadyApplied: migrationResult.alreadyApplied,
        totalFiles: migrationResult.totalFiles,
      },
      storage: {
        driver: config.storage.driver,
        rawRoot: config.storage.localRoot,
        resolvedRoot: storage.root,
      },
      capabilities: {
        ffmpegAvailable: capabilities.ffmpegAvailable,
        ffmpegVersion: capabilities.ffmpegVersion,
        ffprobeAvailable: capabilities.ffprobeAvailable,
        ffprobeVersion: capabilities.ffprobeVersion,
        permanentDeleteEnabled: capabilities.permanentDeleteEnabled,
        aiEnabled: capabilities.aiEnabled,
      },
      dotenv: { loaded: config.meta.loadedDotenvFiles },
    },
    "server initialised",
  );
}

function serializeReason(reason: unknown): unknown {
  if (reason instanceof Error) {
    return { name: reason.name, message: reason.message, stack: reason.stack };
  }
  return reason;
}

async function main(): Promise<void> {
  // 1) Configuration. No logger yet; failures go to stderr.
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    const msg =
      err instanceof ConfigError
        ? err.message
        : err instanceof Error
          ? `Unexpected error during configuration: ${err.message}`
          : "Unknown error during configuration.";
    process.stderr.write(`[startup] ${msg}\n`);
    process.exit(1);
  }

  // 2) Logger. From here on, all errors go through structured logging.
  const logger = createLogger({ nodeEnv: config.nodeEnv });

  // 3) Database.
  let dbHandle: DbHandle;
  try {
    dbHandle = openDatabase(config.database.path);
  } catch (err) {
    logger.fatal({ err: serializeReason(err) }, "failed to open database");
    process.exit(1);
  }

  // 4) Migrations.
  let migrationResult: MigrationResult;
  try {
    migrationResult = runMigrations(dbHandle.db);
  } catch (err) {
    closeDatabase(dbHandle);
    logger.fatal({ err: serializeReason(err) }, "migration failed");
    process.exit(1);
  }

  // 5) Storage. Creates the configured root directory if it does not
  // exist so subsequent put* calls do not race on mkdir.
  let storage: LocalStorageProvider;
  try {
    storage = LocalStorageProvider.create(config.storage.localRoot);
  } catch (err) {
    closeDatabase(dbHandle);
    logger.fatal({ err: serializeReason(err) }, "failed to initialise storage");
    process.exit(1);
  }

  // 6) Runtime capabilities (ffmpeg / ffprobe). Probes are bounded by a
  // 3s timeout each and never throw — missing binaries become structured
  // warnings, not a fatal error. The result is frozen and consumed by
  // /api/health and (later) video workers.
  let capabilities: Capabilities;
  try {
    capabilities = await detectCapabilities(config, logger);
  } catch (err) {
    closeDatabase(dbHandle);
    logger.fatal({ err: serializeReason(err) }, "capability detection failed unexpectedly");
    process.exit(1);
  }

  // 6b) AI provider (P10.T1). Default is `NoopProvider` — base
  // features must work without AI (CLAUDE.md §2.8). The factory
  // logs its choice (INFO when disabled, WARN when an unknown
  // provider id was requested). The instance is held here for
  // future P10.T3+ wiring (HTTP `POST /api/media/:id/ai-refine`
  // + the image_ai_refine worker); P10.T1 does not yet attach it
  // to `CreateAppOptions`.
  const aiProvider: AIProvider = createAIProviderFromConfig(config.ai, logger);
  void aiProvider;

  // 7) Domain services. The TripService is stateless beyond the DB
  // handle; UploadService composes media + job repositories and the
  // storage / classifier dependencies. Future services follow the
  // same pattern.
  const tripRepo = new TripRepository(dbHandle.db);
  const tripService = new TripService(tripRepo);
  const mediaRepo = new MediaRepository(dbHandle.db);
  const mediaVersionsRepo = new MediaVersionsRepository(dbHandle.db);
  const mediaAnalysisRepo = new MediaAnalysisRepository(dbHandle.db);
  const videoSegmentsRepo = new VideoSegmentsRepository(dbHandle.db);
  const jobRepo = new JobRepository(dbHandle.db);
  const uploadService = new UploadService({
    db: dbHandle.db,
    storage,
    tripService,
    mediaRepo,
    jobRepo,
    classifyOptions: {
      imageExtensions: config.upload.allowedImageExt,
      videoExtensions: config.upload.allowedVideoExt,
    },
    maxFileSize: config.upload.maxFileSize,
    logger,
  });
  const jobService = new JobService(jobRepo);
  const duplicateGroupsRepo = new DuplicateGroupsRepository(dbHandle.db);
  // MediaService takes the P7.T1 soft-delete bundle last; pulling
  // duplicateGroupsRepo out before instantiation so the dep is
  // available here. The bundle is optional on the type so smokes /
  // tests can still build a minimal service.
  const mediaService = new MediaService(mediaRepo, tripService, mediaVersionsRepo, jobRepo, {
    db: dbHandle.db,
    tripRepo,
    duplicateGroupsRepo,
    logger,
  });
  const dedupEngine = new DedupEngine({ mediaRepo, duplicateGroupsRepo, logger });
  const dedupService = new DedupService(
    dedupEngine,
    tripService,
    duplicateGroupsRepo,
    mediaRepo,
    // P7.T3 — deleteOthers funnels each remove-candidate through
    // MediaService.softDeleteMedia so the cross-table cleanup +
    // auto-cover refresh chain stays in one place. Optional on the
    // DedupService constructor so existing smokes that build the
    // service directly without a full media wiring still compile.
    mediaService,
  );
  // P9.T8 — Video API service. Reads `video_segments` rows + the
  // P9.T5 keyframes manifest off disk, writes `user_decision`
  // (only — never scores), and enqueues the P9.T5/T6/T7 jobs.
  const videoService = new VideoService(
    mediaRepo,
    videoSegmentsRepo,
    jobRepo,
    storage,
  );

  // P4.T1: JobQueue — multi-channel polling scheduler. Replaces the
  // P3.T2 ImageChannelExecutor in production wiring. Each channel
  // owns its own concurrency cap (from config). Video / AI channels
  // are registered with empty handler maps as structural placeholders
  // — they exist so a future video / AI worker can be slotted in
  // without changing the boot shape, but they never claim today.
  //
  // P4.T2: opt into the failure-retry policy (`maxRetries` /
  // `baseDelayMs` / `maxDelayMs` from config.workers). Handler
  // failures route through `running → retrying → running → ...`
  // with exponential backoff, finally `→ failed` only after the
  // budget is exhausted. The defaults are 3 retries / 1 s base /
  // 60 s cap, all overridable via env.
  //
  // P4.T3: opt into zombie recovery (`zombieTimeoutMs` from
  // config.workers.zombieTimeoutMs, env `ZOMBIE_TIMEOUT_MS`,
  // default 30 min). On `start()`, JobQueue scans rows stuck in
  // `running` past the cutoff and routes them back through the
  // retry-budget judge — recovering from crash / kill -9 / OOM
  // / the small markRetrying-itself-failed window in P4.T2.
  const imageHandlers = new Map<string, JobHandler>();
  imageHandlers.set(
    "image_thumbnail",
    makeImageThumbnailHandler({ storage, mediaRepo, mediaVersionsRepo, logger }),
  );
  imageHandlers.set(
    "image_metadata",
    makeImageMetadataHandler({ storage, mediaRepo, mediaVersionsRepo, logger }),
  );
  imageHandlers.set(IMAGE_HASH_JOB_TYPE, makeImageHashHandler({ storage, mediaRepo, logger }));
  imageHandlers.set(
    IMAGE_QUALITY_BLUR_JOB_TYPE,
    makeImageQualityBlurHandler({
      storage,
      mediaRepo,
      mediaAnalysisRepo,
      settings: {
        blurThresholdBlurry: config.quality.blurThresholdBlurry,
        blurThresholdMaybe: config.quality.blurThresholdMaybe,
        maxEdge: config.quality.blur.maxEdge,
        workerVersion: config.quality.blur.workerVersion,
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
        maxEdge: config.quality.exposure.maxEdge,
        underMeanThreshold: config.quality.exposure.underMeanThreshold,
        overMeanThreshold: config.quality.exposure.overMeanThreshold,
        darkRatioThreshold: config.quality.exposure.darkPixelRatioThreshold,
        brightRatioThreshold: config.quality.exposure.brightPixelRatioThreshold,
        workerVersion: config.quality.exposure.workerVersion,
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
        maxEdge: config.quality.color.maxEdge,
        lowSaturationThreshold: config.quality.color.lowSaturationThreshold,
        highSaturationThreshold: config.quality.color.highSaturationThreshold,
        castThreshold: config.quality.color.castThreshold,
        lowContrastThreshold: config.quality.color.lowContrastThreshold,
        workerVersion: config.quality.color.workerVersion,
      },
      logger,
    }),
  );
  imageHandlers.set(
    IMAGE_QUALITY_FINALIZE_JOB_TYPE,
    makeImageQualityFinalizeHandler({
      mediaRepo,
      mediaAnalysisRepo,
      // The finalize handler enqueues a `quality_selector_run`
      // follow-up on success — passing the same JobRepository the
      // executor is reading from keeps the writes inside the same
      // SQLite handle, no extra connection plumbing.
      jobRepo,
      settings: {
        blurWeight: config.quality.finalize.blurWeight,
        exposureWeight: config.quality.finalize.exposureWeight,
        colorWeight: config.quality.finalize.colorWeight,
        colorFloor: config.quality.finalize.colorFloor,
        workerVersion: config.quality.finalize.workerVersion,
      },
      logger,
    }),
  );
  // P8.T2 image_enhance handler — sharp pipeline + derived
  // enhanced.jpg + media_versions(version_type='enhanced') upsert.
  // Settings flow from `config.quality.enhance.*`; defaults are
  // tuned conservatively per requirements §7.9 acceptance #5 to
  // avoid over-saturation / over-sharpening.
  imageHandlers.set(
    IMAGE_ENHANCE_JOB_TYPE,
    makeImageEnhanceHandler({
      storage,
      mediaRepo,
      mediaVersionsRepo,
      settings: {
        maxEdge: config.quality.enhance.maxEdge,
        brightness: config.quality.enhance.brightness,
        saturation: config.quality.enhance.saturation,
        gamma: config.quality.enhance.gamma,
        linearA: config.quality.enhance.linearA,
        linearB: config.quality.enhance.linearB,
        sharpenSigma: config.quality.enhance.sharpenSigma,
        sharpenM1: config.quality.enhance.sharpenM1,
        sharpenM2: config.quality.enhance.sharpenM2,
        jpegQuality: config.quality.enhance.jpegQuality,
        workerVersion: config.quality.enhance.workerVersion,
      },
      logger,
    }),
  );
  // P6.T5 follow-up: Quality_Selector runs as a job too, so the
  // recommendation writeback rides the same multi-channel scheduler
  // (and surfaces in the Job API with status / retry behaviour).
  const qualitySelectorService = new QualitySelectorService({
    duplicateGroupsRepo,
    mediaAnalysisRepo,
    mediaRepo,
    logger,
  });
  imageHandlers.set(
    QUALITY_SELECTOR_JOB_TYPE,
    makeQualitySelectorHandler({
      service: qualitySelectorService,
      mediaRepo,
      // P6.T7 — handler refreshes trip cover after the selector
      // finishes ranking. Shared TripRepository instance keeps all
      // trip writes on one SQLite handle.
      tripRepo,
      logger,
    }),
  );
  // P9.T2 — video channel gets its first handler. Concurrency 1 by
  // default (config.workers.videoConcurrency) so ffprobe / future
  // ffmpeg spawns don't compete for the same CPU core. ffprobe path
  // flows from config.ffmpeg.ffprobePath (PATH fallback at runtime
  // inside the worker).
  const videoHandlers = new Map<string, JobHandler>();
  videoHandlers.set(
    VIDEO_METADATA_JOB_TYPE,
    makeVideoMetadataHandler({
      storage,
      mediaRepo,
      mediaVersionsRepo,
      settings: {
        ffprobePath: config.ffmpeg.ffprobePath ?? "ffprobe",
        ffprobeTimeoutMs: 30_000,
        workerVersion: "1.0",
      },
      logger,
    }),
  );
  // P9.T3 — `video_cover` worker. Shares the video-channel
  // VIDEO_WORKER_CONCURRENCY=1 budget with `video_metadata`. ffmpeg
  // path flows from config.ffmpeg.ffmpegPath (PATH fallback to
  // "ffmpeg" at worker runtime). Settings come from
  // config.video.cover.* — defaults documented inline in
  // config/index.ts.
  videoHandlers.set(
    VIDEO_COVER_JOB_TYPE,
    makeVideoCoverHandler({
      storage,
      mediaRepo,
      mediaVersionsRepo,
      settings: {
        ffmpegPath: config.ffmpeg.ffmpegPath ?? "ffmpeg",
        timeoutMs: config.video.cover.timeoutMs,
        maxEdge: config.video.cover.maxEdge,
        jpegQuality: config.video.cover.jpegQuality,
        fallbackSeekSeconds: config.video.cover.fallbackSeekSeconds,
        workerVersion: config.video.cover.workerVersion,
      },
      logger,
    }),
  );
  // P9.T4 — `video_proxy` worker (H.264 / AAC 720p MP4). Same
  // video-channel budget; proxy transcoding is the heaviest video
  // task, so the serial budget=1 keeps the host responsive. ffmpeg
  // / ffprobe paths flow from config.ffmpeg.{ffmpegPath, ffprobePath};
  // transcode settings flow from config.video.proxy.* — defaults
  // documented inline in config/index.ts.
  videoHandlers.set(
    VIDEO_PROXY_JOB_TYPE,
    makeVideoProxyHandler({
      storage,
      mediaRepo,
      mediaVersionsRepo,
      settings: {
        ffmpegPath: config.ffmpeg.ffmpegPath ?? "ffmpeg",
        ffprobePath: config.ffmpeg.ffprobePath ?? "ffprobe",
        timeoutMs: config.video.proxy.timeoutMs,
        targetHeight: config.video.proxy.targetHeight,
        crf: config.video.proxy.crf,
        preset: config.video.proxy.preset,
        videoCodec: config.video.proxy.videoCodec,
        audioCodec: config.video.proxy.audioCodec,
        audioBitrateKbps: config.video.proxy.audioBitrateKbps,
        workerVersion: config.video.proxy.workerVersion,
      },
      logger,
    }),
  );
  // P9.T5 — `video_keyframes` worker (fixed-interval frame
  // extraction). Same video-channel budget. Settings come from
  // config.video.keyframes.*; defaults documented inline in
  // config/index.ts.
  videoHandlers.set(
    VIDEO_KEYFRAMES_JOB_TYPE,
    makeVideoKeyframesHandler({
      storage,
      mediaRepo,
      mediaVersionsRepo,
      settings: {
        ffmpegPath: config.ffmpeg.ffmpegPath ?? "ffmpeg",
        timeoutMs: config.video.keyframes.timeoutMs,
        intervalSec: config.video.keyframes.intervalSec,
        maxFrames: config.video.keyframes.maxFrames,
        jpegQuality: config.video.keyframes.jpegQuality,
        workerVersion: config.video.keyframes.workerVersion,
      },
      logger,
    }),
  );
  // P9.T6 — `video_segments` worker (fixed-duration slicing). Same
  // video-channel budget. Reuses `config.video.segments.durationSec`
  // (which maps to env VIDEO_SEGMENT_DURATION introduced for P9.T1)
  // plus dedicated timeoutMs / workerVersion knobs.
  videoHandlers.set(
    VIDEO_SEGMENTS_JOB_TYPE,
    makeVideoSegmentsHandler({
      storage,
      mediaRepo,
      mediaVersionsRepo,
      videoSegmentsRepo,
      settings: {
        ffmpegPath: config.ffmpeg.ffmpegPath ?? "ffmpeg",
        ffprobePath: config.ffmpeg.ffprobePath ?? "ffprobe",
        timeoutMs: config.video.segments.timeoutMs,
        durationSec: config.video.segments.durationSec,
        workerVersion: config.video.segments.workerVersion,
      },
      logger,
    }),
  );
  // P9.T7 — `video_segment_quality` worker (per-keyframe Laplacian
  // sharpness + ffmpeg blackdetect → per-segment scoring). Same
  // video-channel budget. Reuses the existing image-blur
  // `BLUR_THRESHOLD_MAYBE` env (config.quality.blurThresholdMaybe)
  // as the `normaliseSharpness` denominator so image / video stay
  // comparable; the other thresholds come from
  // config.video.segmentQuality.*.
  videoHandlers.set(
    VIDEO_SEGMENT_QUALITY_JOB_TYPE,
    makeVideoSegmentQualityHandler({
      storage,
      mediaRepo,
      mediaVersionsRepo,
      videoSegmentsRepo,
      settings: {
        ffmpegPath: config.ffmpeg.ffmpegPath ?? "ffmpeg",
        timeoutMs: config.video.segmentQuality.timeoutMs,
        blurMaxEdge: config.video.segmentQuality.blurMaxEdge,
        normaliseSharpnessMaybeThreshold: config.quality.blurThresholdMaybe,
        blurWasteThreshold: config.video.segmentQuality.blurWasteThreshold,
        blackRatioThreshold: config.video.segmentQuality.blackRatioThreshold,
        blackdetectMinDurationSec: config.video.segmentQuality.blackdetectMinDurationSec,
        blackdetectPicTh: config.video.segmentQuality.blackdetectPicTh,
        blackdetectPixTh: config.video.segmentQuality.blackdetectPixTh,
        recommendThreshold: config.video.segmentQuality.recommendThreshold,
        workerVersion: config.video.segmentQuality.workerVersion,
      },
      logger,
    }),
  );
  const channels: JobQueueChannelConfig[] = [
    { name: "image", concurrency: config.workers.imageConcurrency, handlers: imageHandlers },
    { name: "video", concurrency: config.workers.videoConcurrency, handlers: videoHandlers },
    { name: "ai", concurrency: config.workers.aiConcurrency, handlers: new Map() },
  ];
  const jobQueue = new JobQueue({
    jobRepo,
    logger,
    channels,
    retryConfig: {
      maxRetries: config.workers.jobRetryMax,
      baseDelayMs: config.workers.jobRetryBaseDelayMs,
      maxDelayMs: config.workers.jobRetryMaxDelayMs,
    },
    zombieTimeoutMs: config.workers.zombieTimeoutMs,
  });

  logStartup(logger, config, dbHandle, migrationResult, storage, capabilities);

  // Start polling AFTER the startup log so any noise from the very
  // first tick lands after the "server initialised" line.
  jobQueue.start();

  // 8) HTTP server.
  const app = createApp({
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
    debugRoutes: config.nodeEnv !== "production",
  });

  const server = app.listen(config.port, () => {
    logger.info(
      { port: config.port, address: `http://localhost:${config.port}` },
      "http server listening",
    );
  });

  // 9) Graceful shutdown. Same path for SIGINT, SIGTERM, and uncaught
  // exceptions: stop accepting new connections, close the DB, exit.
  let shuttingDown = false;
  const shutdown = (reason: string, exitCode: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ reason }, "shutting down");

    const forceExit = setTimeout(() => {
      logger.warn(
        { timeoutMs: FORCE_EXIT_TIMEOUT_MS },
        "graceful shutdown timed out; forcing exit",
      );
      process.exit(1);
    }, FORCE_EXIT_TIMEOUT_MS);
    forceExit.unref();

    server.close((closeErr) => {
      if (closeErr) {
        logger.error({ err: serializeReason(closeErr) }, "error closing http server");
      }
      // Stop the JobQueue BEFORE closing the DB so any in-flight
      // handler can finish its status UPDATE on a live connection.
      // The 10-second forceExit guards against a runaway handler.
      void jobQueue
        .stop()
        .catch((execErr) => {
          logger.error({ err: serializeReason(execErr) }, "error stopping job queue");
        })
        .finally(() => {
          try {
            closeDatabase(dbHandle);
          } catch (dbErr) {
            logger.error({ err: serializeReason(dbErr) }, "error closing database");
          }
          clearTimeout(forceExit);
          process.exit(closeErr ? 1 : exitCode);
        });
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT", 0));
  process.on("SIGTERM", () => shutdown("SIGTERM", 0));
  process.on("uncaughtException", (err) => {
    logger.fatal({ err: serializeReason(err) }, "uncaught exception");
    shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason: serializeReason(reason) }, "unhandled promise rejection");
  });
}

void main().catch((err) => {
  // No logger if main() failed before createLogger ran, so fall back to stderr.
  process.stderr.write(
    `[startup] unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
