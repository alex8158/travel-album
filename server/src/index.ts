// Entry point. P0.T7 layers the LocalStorageProvider on top of the
// startup sequence introduced in P0.T4-T6. Subsequent tasks add:
//   P0.T8 ffmpeg/ffprobe startup detection + /api/health
//   P1.T3 Trip routes
// See docs/tasks.md.

import { createApp } from "./app.js";
import { ConfigError, loadConfig, type Config } from "./config/index.js";
import { closeDatabase, openDatabase, type DbHandle } from "./db/connection.js";
import { runMigrations, type MigrationResult } from "./db/migrate.js";
import { createLogger, type Logger } from "./logger.js";
import { LocalStorageProvider } from "./storage/index.js";

const FORCE_EXIT_TIMEOUT_MS = 10_000;

function logStartup(
  logger: Logger,
  config: Config,
  dbHandle: DbHandle,
  migrationResult: MigrationResult,
  storage: LocalStorageProvider,
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

function main(): void {
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

  logStartup(logger, config, dbHandle, migrationResult, storage);

  // 6) HTTP server.
  const app = createApp({
    logger,
    debugRoutes: config.nodeEnv !== "production",
  });

  const server = app.listen(config.port, () => {
    logger.info(
      { port: config.port, address: `http://localhost:${config.port}` },
      "http server listening",
    );
  });

  // 7) Graceful shutdown. Same path for SIGINT, SIGTERM, and uncaught
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
      try {
        closeDatabase(dbHandle);
      } catch (dbErr) {
        logger.error({ err: serializeReason(dbErr) }, "error closing database");
      }
      clearTimeout(forceExit);
      process.exit(closeErr ? 1 : exitCode);
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

main();
