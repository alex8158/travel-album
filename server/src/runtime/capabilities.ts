// Runtime capabilities snapshot (P0.T8).
//
// Built once at startup via `detectCapabilities`, then frozen and
// passed by reference to whoever needs it (currently the /api/health
// route, future video workers via design.md §8.4). The snapshot is the
// ONLY trusted source for "is ffmpeg available right now?" — workers
// should not re-spawn `ffmpeg -version` per task.
//
// Fields:
//   - ff{mpeg,probe}Available : boolean from a successful exit-0 probe
//   - ff{mpeg,probe}Version   : first stdout line (e.g. "ffmpeg version 8.1 ...")
//   - ff{mpeg,probe}Path      : the command spawned (absolute path or PATH name);
//                               kept for diagnostics, NOT exposed via /api/health
//   - ff{mpeg,probe}Error     : machine-readable failure reason; NOT exposed via /api/health
//   - permanentDeleteEnabled  : mirrors config.delete.permanentDeleteEnabled
//   - aiEnabled               : mirrors config.ai.enabled

import type { Config } from "../config/index.js";
import type { Logger } from "../logger.js";
import { probeBinary, type ProbeResult } from "../media/ffmpegProbe.js";

export interface Capabilities {
  readonly ffmpegAvailable: boolean;
  readonly ffmpegVersion: string | null;
  readonly ffmpegPath: string | null;
  readonly ffmpegError: string | null;
  readonly ffprobeAvailable: boolean;
  readonly ffprobeVersion: string | null;
  readonly ffprobePath: string | null;
  readonly ffprobeError: string | null;
  readonly permanentDeleteEnabled: boolean;
  readonly aiEnabled: boolean;
}

const PROBE_TIMEOUT_MS = 3_000;

const FFMPEG_INSTALL_HINT =
  "Install ffmpeg (macOS: 'brew install ffmpeg'; Ubuntu: 'sudo apt-get install ffmpeg'). " +
  "Video tasks will fail with FFMPEG_NOT_AVAILABLE; image processing is unaffected.";

const FFPROBE_INSTALL_HINT =
  "ffprobe normally ships alongside ffmpeg from the same package; install ffmpeg to get both.";

/**
 * Detect ffmpeg and ffprobe availability in parallel. Never throws —
 * each probe failure becomes a structured field on the result. Logs a
 * single info line for each successful probe, or a warn line including
 * the install hint when missing.
 */
export async function detectCapabilities(config: Config, logger: Logger): Promise<Capabilities> {
  const ffmpegCommand = config.ffmpeg.ffmpegPath ?? "ffmpeg";
  const ffprobeCommand = config.ffmpeg.ffprobePath ?? "ffprobe";

  const [ffmpegResult, ffprobeResult] = await Promise.all([
    probeBinary({ command: ffmpegCommand, args: ["-version"], timeoutMs: PROBE_TIMEOUT_MS }),
    probeBinary({ command: ffprobeCommand, args: ["-version"], timeoutMs: PROBE_TIMEOUT_MS }),
  ]);

  reportProbe(logger, "ffmpeg", ffmpegCommand, ffmpegResult, FFMPEG_INSTALL_HINT);
  reportProbe(logger, "ffprobe", ffprobeCommand, ffprobeResult, FFPROBE_INSTALL_HINT);

  const snapshot: Capabilities = {
    ffmpegAvailable: ffmpegResult.available,
    ffmpegVersion: ffmpegResult.version,
    ffmpegPath: ffmpegResult.available ? ffmpegCommand : null,
    ffmpegError: ffmpegResult.error,
    ffprobeAvailable: ffprobeResult.available,
    ffprobeVersion: ffprobeResult.version,
    ffprobePath: ffprobeResult.available ? ffprobeCommand : null,
    ffprobeError: ffprobeResult.error,
    permanentDeleteEnabled: config.delete.permanentDeleteEnabled,
    aiEnabled: config.ai.enabled,
  };

  return Object.freeze(snapshot);
}

function reportProbe(
  logger: Logger,
  binary: "ffmpeg" | "ffprobe",
  command: string,
  result: ProbeResult,
  hint: string,
): void {
  if (result.available) {
    logger.info({ binary, command, version: result.version }, `${binary} available`);
  } else {
    logger.warn({ binary, command, error: result.error, hint }, `${binary} not available`);
  }
}
