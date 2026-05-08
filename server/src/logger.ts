// Centralised logger (P0.T6).
//
// Output strategy:
//   - production : line-delimited JSON via pino's default destination.
//                  Suitable for ingestion by log aggregators.
//   - test       : line-delimited JSON, level "warn" by default to keep
//                  test output quiet.
//   - development: human-readable via `pino-pretty` transport (devDep);
//                  level "debug" by default.
//
// `LOG_LEVEL` env var always overrides the per-environment default.
// The logger is structured: log calls take an object as the first
// argument and a message string as the second, so fields like
// `requestId`, `code`, `method`, `path`, `statusCode`, `durationMs`
// can be queried by name in production log tooling.

import pino, { type Logger as PinoLogger, type LoggerOptions } from "pino";

export type Logger = PinoLogger;

export interface CreateLoggerOptions {
  readonly nodeEnv: "development" | "test" | "production";
  /** Override default level for this env (e.g. tests setting "silent"). */
  readonly level?: pino.Level;
}

const DEFAULT_LEVEL: Record<CreateLoggerOptions["nodeEnv"], pino.Level> = {
  development: "debug",
  test: "warn",
  production: "info",
};

export function createLogger(opts: CreateLoggerOptions): Logger {
  const envLevel = process.env.LOG_LEVEL as pino.Level | undefined;
  const level = opts.level ?? envLevel ?? DEFAULT_LEVEL[opts.nodeEnv];

  const baseOpts: LoggerOptions = {
    level,
    base: { service: "travel-album-server" },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (opts.nodeEnv === "development") {
    return pino({
      ...baseOpts,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          singleLine: false,
          translateTime: "yyyy-mm-dd HH:MM:ss.l",
          ignore: "pid,hostname,service",
        },
      },
    });
  }

  return pino(baseOpts);
}
