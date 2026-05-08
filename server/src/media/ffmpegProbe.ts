// ffmpeg / ffprobe binary probe (P0.T8).
//
// `probeBinary` runs `<command> <args>` as a subprocess (NOT through a
// shell, so user-controlled `command` cannot inject extra commands)
// and reports either the captured first stdout line or a structured
// reason for failure. It never rejects: callers always receive a
// `ProbeResult` they can route to log fields directly.
//
// Used by runtime/capabilities.ts at startup to detect whether the
// host provides ffmpeg / ffprobe (design.md §8.4). Worker code that
// runs FFmpeg later should not re-probe — read the cached snapshot
// from the Capabilities object instead.

import { spawn } from "node:child_process";

export interface ProbeResult {
  /** True iff the binary exited with code 0 within the timeout. */
  readonly available: boolean;
  /** First stdout line, trimmed, when available; null otherwise. */
  readonly version: string | null;
  /**
   * Diagnostic string when `available` is false: which signal / exit
   * code we saw, or "timed out", or the spawn error message. Null when
   * the probe succeeded.
   */
  readonly error: string | null;
}

export interface ProbeOptions {
  /** Either an absolute path or a name to look up in PATH. */
  readonly command: string;
  readonly args: readonly string[];
  /** Hard cap on the subprocess; default 3 000 ms. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_BUFFERED_BYTES = 64 * 1024;

export function probeBinary(opts: ProbeOptions): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<ProbeResult>((resolveResult) => {
    let settled = false;
    const settle = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };

    let stdoutBuf = "";
    let stderrBuf = "";

    let child;
    try {
      child = spawn(opts.command, [...opts.args], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // Important: no shell. opts.command is treated as a single executable.
      });
    } catch (err) {
      settle({
        available: false,
        version: null,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* the child may already have exited */
      }
      settle({
        available: false,
        version: null,
        error: `timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);
    timer.unref();

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBuf.length < MAX_BUFFERED_BYTES) {
        stdoutBuf += chunk.toString("utf8");
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBuf.length < MAX_BUFFERED_BYTES) {
        stderrBuf += chunk.toString("utf8");
      }
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      settle({
        available: false,
        version: null,
        error: err.code ? `${err.code}: ${err.message}` : err.message,
      });
    });

    child.on("close", (code, signal) => {
      if (signal) {
        settle({
          available: false,
          version: null,
          error: `killed by signal ${signal}`,
        });
        return;
      }
      if (code === 0) {
        settle({
          available: true,
          version: extractVersionLine(stdoutBuf),
          error: null,
        });
        return;
      }
      const tail = (stderrBuf || stdoutBuf).trim().slice(-200);
      settle({
        available: false,
        version: null,
        error: `exit code ${code}${tail ? `: ${tail}` : ""}`,
      });
    });
  });
}

function extractVersionLine(stdout: string): string | null {
  const firstLine = stdout.split("\n", 1)[0]?.trim();
  return firstLine && firstLine.length > 0 ? firstLine : null;
}
