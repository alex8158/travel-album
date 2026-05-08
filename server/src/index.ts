// Entry point. P0.T5 wires the SQLite connection + migration runner on
// top of the configuration loader from P0.T4. The actual HTTP server,
// storage provider, ffmpeg detection, and queue workers are introduced
// by:
//   P0.T6 structured logging + error responses
//   P0.T7 StorageProvider abstraction
//   P0.T8 ffmpeg/ffprobe startup detection + /api/health
//   P1.T3 Trip routes
// See docs/tasks.md.

import { ConfigError, loadConfig, type Config } from "./config/index.js";
import { closeDatabase, openDatabase, type DbHandle } from "./db/connection.js";
import { runMigrations, type MigrationResult } from "./db/migrate.js";

function printSummary(config: Config, dbHandle: DbHandle, migrationResult: MigrationResult): void {
  const lines: string[] = [
    "travel-album server: configuration + database initialised (P0.T5).",
    `  NODE_ENV                  = ${config.nodeEnv}`,
    `  PORT                      = ${config.port}`,
    `  STORAGE_DRIVER            = ${config.storage.driver}`,
    `  STORAGE_LOCAL_ROOT        = ${config.storage.localRoot}`,
    `  DATABASE_PATH (raw)       = ${config.database.path}`,
    `  DATABASE_PATH (resolved)  = ${dbHandle.resolvedPath}`,
    `  PRAGMA foreign_keys       = ${dbHandle.foreignKeysPragma}`,
    `  PRAGMA journal_mode       = ${dbHandle.journalModePragma}`,
    `  migrations directory      = ${migrationResult.migrationsDir}`,
    `  migrations total files    = ${migrationResult.totalFiles}`,
    `  migrations applied now    = ${
      migrationResult.appliedNow.length === 0 ? "(none)" : migrationResult.appliedNow.join(", ")
    }`,
    `  migrations already done   = ${
      migrationResult.alreadyApplied.length === 0
        ? "(none)"
        : migrationResult.alreadyApplied.join(", ")
    }`,
    `  IMAGE_WORKER_CONCURRENCY  = ${config.workers.imageConcurrency}`,
    `  VIDEO_WORKER_CONCURRENCY  = ${config.workers.videoConcurrency}`,
    `  AI_WORKER_CONCURRENCY     = ${config.workers.aiConcurrency}`,
    `  AI_ENABLED                = ${config.ai.enabled}`,
    `  PERMANENT_DELETE_ENABLED  = ${config.delete.permanentDeleteEnabled}`,
    `  FFMPEG_PATH               = ${config.ffmpeg.ffmpegPath ?? "(from PATH)"}`,
    `  FFPROBE_PATH              = ${config.ffmpeg.ffprobePath ?? "(from PATH)"}`,
    `  upload allowed image ext  = ${config.upload.allowedImageExt.join(", ")}`,
    `  upload allowed video ext  = ${config.upload.allowedVideoExt.join(", ")}`,
  ];
  if (config.meta.loadedDotenvFiles.length > 0) {
    lines.push(`  .env files loaded         = ${config.meta.loadedDotenvFiles.join(", ")}`);
  } else {
    lines.push("  .env files loaded         = (none; using process.env / defaults only)");
  }
  lines.push("HTTP routes / workers will be wired in subsequent P0 tasks.");
  console.log(lines.join("\n"));
}

function main(): void {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[startup] ${err.message}`);
    } else if (err instanceof Error) {
      console.error(`[startup] Unexpected error during configuration: ${err.message}`);
    } else {
      console.error("[startup] Unknown error during configuration.");
    }
    process.exit(1);
  }

  let dbHandle: DbHandle;
  try {
    dbHandle = openDatabase(config.database.path);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[startup] Failed to open database: ${detail}`);
    process.exit(1);
  }

  let migrationResult: MigrationResult;
  try {
    migrationResult = runMigrations(dbHandle.db);
  } catch (err) {
    closeDatabase(dbHandle);
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[startup] Migration failed: ${detail}`);
    process.exit(1);
  }

  printSummary(config, dbHandle, migrationResult);

  // Close cleanly so WAL gets checkpointed before process exit.
  // Once the HTTP server is wired up (P1.T3), this close moves to a
  // shutdown handler instead.
  closeDatabase(dbHandle);
}

main();
