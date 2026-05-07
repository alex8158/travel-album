// Entry point. P0.T4 wires the configuration loader; the actual HTTP
// server, database connection, storage provider, ffmpeg detection, and
// queue workers are introduced by:
//   P0.T5 SQLite connection + migrations
//   P0.T6 structured logging + error responses
//   P0.T7 StorageProvider abstraction
//   P0.T8 ffmpeg/ffprobe startup detection + /api/health
//   P1.T3 Trip routes
// See docs/tasks.md.

import { ConfigError, loadConfig, type Config } from "./config/index.js";

function printSummary(config: Config): void {
  const lines: string[] = [
    "travel-album server: configuration loaded (P0.T4).",
    `  NODE_ENV                  = ${config.nodeEnv}`,
    `  PORT                      = ${config.port}`,
    `  STORAGE_DRIVER            = ${config.storage.driver}`,
    `  STORAGE_LOCAL_ROOT        = ${config.storage.localRoot}`,
    `  DATABASE_PATH             = ${config.database.path}`,
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
  lines.push("HTTP routes / DB / workers will be wired in subsequent P0 tasks.");
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
  printSummary(config);
}

main();
