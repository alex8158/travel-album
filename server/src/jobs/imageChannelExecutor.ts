// Minimal image-channel job executor (P3.T2 — stub for P4.T1).
//
// Scope per docs/tasks.md P3.T2 and this turn's user prompt:
//   * Polls the DB on an interval; claims one pending `image_*` job
//     per tick; runs the registered handler; marks success or failed.
//   * Strictly single-concurrency: at most one job in flight per
//     executor instance at any time.
//   * Graceful shutdown: `stop()` stops scheduling new ticks and
//     awaits the in-flight handler (if any) so the row's status
//     stabilises before the process exits.
//   * Handler exceptions are caught and surface as `failed` in the
//     DB; the executor never crashes the process.
//
// Explicitly NOT in scope (deferred to P4.T1 ~ P4.T7):
//   * Multi-channel (video / AI / generic) scheduling.
//   * Retry / exponential backoff.
//   * Zombie-job recovery (long-running rows with no heartbeat).
//   * Cancellation (in-flight job interruption).
//   * Job API (GET / retry / cancel HTTP routes).
//   * Media-status linkage (uploaded → processing → processed).
//   * Distributed locking / multi-process claim.
//   * Configurable concurrency / channel split.
//
// The seam this leaves for P4.T1 is intentional: handlers register
// through `JobHandlerRegistry` (a stable contract), and the runOneTick
// loop here is what P4.T1 will replace with channel-aware scheduling.
// Handlers themselves do not need to change.

import type { JobRepository } from "./jobRepository.js";
import type { JobHandlerRegistry } from "./handlerRegistry.js";
import type { Logger } from "../logger.js";

const DEFAULT_POLL_INTERVAL_MS = 1500;

/**
 * Outcome of a single tick — exported so smoke tests can branch on
 * it without round-tripping through the DB. Production callers
 * (`start()`) discard the value.
 */
export type TickOutcome =
  | "idle" // no pending image_* job to claim
  | "success" // handler resolved, job marked success
  | "failed" // handler rejected, job marked failed
  | "no-handler" // pending job exists but no handler registered
  | "stopped" // tick refused because the executor is stopping/stopped
  | "skipped-inflight" // another tick already in flight (single concurrency)
  | "tick-error"; // unexpected error (e.g. DB failure during claim)

export interface TickResult {
  readonly outcome: TickOutcome;
  readonly jobId?: string;
  readonly jobType?: string;
  readonly error?: string;
}

export interface ImageChannelExecutorDeps {
  readonly jobRepo: JobRepository;
  readonly registry: JobHandlerRegistry;
  readonly logger: Logger;
  /**
   * Poll cadence in milliseconds. Defaults to 1500. Smoke tests pass
   * a much smaller value (or call `tick()` directly).
   */
  readonly pollIntervalMs?: number;
}

/**
 * Lifecycle:
 *   * "idle"     — freshly constructed; never started. `tick()` is
 *                  permitted (smokes / tests call it directly) but
 *                  the polling loop is not active.
 *   * "running"  — `start()` has begun the polling loop. `tick()` is
 *                  permitted.
 *   * "stopping" — `stop()` has been called and is draining the
 *                  in-flight tick. New `tick()` calls bail.
 *   * "stopped"  — drain complete. `tick()` bails.
 *
 * Separating "idle" from "stopped" is important: production boot
 * calls `start()` once, while smokes drive `tick()` synchronously
 * without ever calling `start()`. A unified initial-stopped state
 * would silently break the smokes.
 */
type ExecutorState = "idle" | "running" | "stopping" | "stopped";

export class ImageChannelExecutor {
  private state: ExecutorState = "idle";
  private intervalHandle: NodeJS.Timeout | null = null;
  /** Promise of the currently-running tick, or null when idle. */
  private currentTick: Promise<TickResult> | null = null;
  /** Cheap mutex; true between the bail-checks and the finally clause. */
  private inflight = false;

  private readonly pollIntervalMs: number;

  constructor(private readonly deps: ImageChannelExecutorDeps) {
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  /**
   * Begin polling. Idempotent — calling on an already-running
   * executor is a no-op. The first tick fires immediately so a
   * cold-start with pre-existing pending jobs does not wait a full
   * interval before draining.
   *
   * Refuses to restart after `stop()`; construct a fresh instance.
   */
  start(): void {
    if (this.state === "running") return;
    if (this.state !== "idle") {
      throw new Error(`ImageChannelExecutor cannot start from state '${this.state}'`);
    }
    this.state = "running";
    // unref() so the interval does not by itself keep the event loop
    // alive after the HTTP server is closed — the bootstrap's
    // shutdown path explicitly stops us.
    this.intervalHandle = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    this.intervalHandle.unref();
    // Fire one tick immediately too.
    void this.tick();
  }

  /**
   * Stop the polling loop and wait for any in-flight tick to finish.
   * After `stop()` resolves, the executor is fully quiesced: no
   * further `tick()` calls will claim or run anything.
   *
   * Idempotent. A `stop()` on an `idle` executor simply marks it
   * `stopped` without draining (nothing to drain).
   */
  async stop(): Promise<void> {
    if (this.state === "stopped") return;
    if (this.state === "idle") {
      this.state = "stopped";
      return;
    }
    this.state = "stopping";
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    // If a tick is mid-handler, await it so the row's status
    // transitions land in the DB before the process exits.
    const inflightTick = this.currentTick;
    if (inflightTick !== null) {
      try {
        await inflightTick;
      } catch {
        // Tick already wraps handler errors. Reaching here implies a
        // bug in tick() itself; the executor still settles to stopped.
      }
    }
    this.state = "stopped";
  }

  /**
   * Run one cycle of "claim → run → mark". Public so smoke tests can
   * call it deterministically without waiting for setInterval. The
   * polling loop also calls this. Either way the single-concurrency
   * guard `this.inflight` prevents two concurrent runs.
   *
   * Never rejects: all errors are caught inside and surfaced via the
   * returned `TickResult.outcome`.
   */
  async tick(): Promise<TickResult> {
    if (this.state === "stopped" || this.state === "stopping") {
      return { outcome: "stopped" };
    }
    if (this.inflight) {
      return { outcome: "skipped-inflight" };
    }
    this.inflight = true;
    const tickPromise = this.runOneTick();
    this.currentTick = tickPromise;
    try {
      return await tickPromise;
    } finally {
      this.inflight = false;
      this.currentTick = null;
    }
  }

  // -------------------------------------------------------------------------
  // private
  // -------------------------------------------------------------------------

  private async runOneTick(): Promise<TickResult> {
    let job;
    try {
      job = this.deps.jobRepo.claimNextPendingImageJob();
    } catch (err) {
      // DB-side failure during claim. Log and bail; the next tick
      // will retry. This is deliberately defensive — the only
      // realistic cause is the connection being closed during
      // shutdown.
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger.error({ err: serializeError(err) }, "image-channel executor: claim failed");
      return { outcome: "tick-error", error: message };
    }

    if (job === null) {
      return { outcome: "idle" };
    }

    const handler = this.deps.registry.get(job.jobType);
    if (handler === null) {
      const message = `no handler registered for job_type='${job.jobType}'`;
      this.markFailedSafely(job.id, message);
      this.deps.logger.warn(
        { jobId: job.id, jobType: job.jobType, mediaId: job.mediaId },
        `image-channel executor: ${message}`,
      );
      return { outcome: "no-handler", jobId: job.id, jobType: job.jobType, error: message };
    }

    try {
      await handler(job);
      const changes = this.deps.jobRepo.markSuccess(job.id);
      if (changes === 0) {
        // The row was not in 'running' anymore — only possible if a
        // parallel process / future P4 cancelled it. Log loudly so a
        // human notices; the row's actual final status wins.
        this.deps.logger.warn(
          { jobId: job.id, jobType: job.jobType },
          "image-channel executor: markSuccess affected 0 rows (job no longer running)",
        );
      }
      return { outcome: "success", jobId: job.id, jobType: job.jobType };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.markFailedSafely(job.id, message);
      this.deps.logger.warn(
        {
          jobId: job.id,
          jobType: job.jobType,
          mediaId: job.mediaId,
          err: serializeError(err),
        },
        "image-channel executor: handler failed",
      );
      return { outcome: "failed", jobId: job.id, jobType: job.jobType, error: message };
    }
  }

  /**
   * Wrap `jobRepo.markFailed` so a DB-level failure during the
   * status update itself does not crash the executor loop.
   */
  private markFailedSafely(jobId: string, errorMessage: string): void {
    try {
      this.deps.jobRepo.markFailed(jobId, errorMessage);
    } catch (err) {
      this.deps.logger.error(
        { jobId, err: serializeError(err) },
        "image-channel executor: markFailed itself failed (job will appear stuck in 'running')",
      );
    }
  }
}

function serializeError(err: unknown): unknown {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return err;
}
