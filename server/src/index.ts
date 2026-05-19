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
  IMAGE_HASH_JOB_TYPE,
  IMAGE_QUALITY_BLUR_JOB_TYPE,
  IMAGE_QUALITY_EXPOSURE_JOB_TYPE,
  JobQueue,
  JobRepository,
  JobService,
  makeImageHashHandler,
  makeImageMetadataHandler,
  makeImageQualityBlurHandler,
  makeImageQualityExposureHandler,
  makeImageThumbnailHandler,
  type JobHandler,
  type JobQueueChannelConfig,
} from "./jobs/index.js";
import { createLogger, type Logger } from "./logger.js";
import {
  MediaAnalysisRepository,
  MediaRepository,
  MediaService,
  MediaVersionsRepository,
} from "./media/index.js";
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

  // 7) Domain services. The TripService is stateless beyond the DB
  // handle; UploadService composes media + job repositories and the
  // storage / classifier dependencies. Future services follow the
  // same pattern.
  const tripService = new TripService(new TripRepository(dbHandle.db));
  const mediaRepo = new MediaRepository(dbHandle.db);
  const mediaVersionsRepo = new MediaVersionsRepository(dbHandle.db);
  const mediaAnalysisRepo = new MediaAnalysisRepository(dbHandle.db);
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
  const mediaService = new MediaService(mediaRepo, tripService, mediaVersionsRepo, jobRepo);
  const jobService = new JobService(jobRepo);
  const duplicateGroupsRepo = new DuplicateGroupsRepository(dbHandle.db);
  const dedupEngine = new DedupEngine({ mediaRepo, duplicateGroupsRepo, logger });
  const dedupService = new DedupService(dedupEngine, tripService, duplicateGroupsRepo, mediaRepo);

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
  const channels: JobQueueChannelConfig[] = [
    { name: "image", concurrency: config.workers.imageConcurrency, handlers: imageHandlers },
    { name: "video", concurrency: config.workers.videoConcurrency, handlers: new Map() },
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
    uploadService,
    mediaService,
    mediaRepo,
    jobService,
    dedupService,
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
