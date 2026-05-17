// JobQueue scheduler (P4.T1).
//
// Multi-channel polling scheduler that supersedes the P3.T2
// `ImageChannelExecutor` stub in production. Each channel
// (image / video / ai) owns:
//   * a closed Map of registered handlers (job_type → JobHandler)
//   * its own concurrency cap (read from config at boot)
//   * its own poll interval + setInterval handle
//   * its own inflight Set<Promise>
//
// The channels run independently — saturation in one channel does
// NOT block the others. handler errors are caught, marked as
// `failed` in the DB, and the channel keeps draining.
//
// What this task IS (P4.T1):
//   * Stable JobQueue abstraction with start / stop lifecycle.
//   * Per-channel concurrency limit (basic).
//   * State machine: pending → running → success / failed.
//   * Handler contract unchanged: `(job) => Promise<void>`.
//   * Structural placeholder for video / ai channels (no handlers
//     registered today — they exist as channels but never claim).
//
// What this task is NOT (deferred):
//   * Retry / backoff (P4.T2).
//   * Zombie-job recovery (P4.T3).
//   * Job API: GET / retry / cancel HTTP routes (P4.T4).
//   * Media-status linkage uploaded → processing → processed (P4.T5).
//   * FFmpeg subprocess gating, distributed locks, dead-letter
//     queues, priority routing.
//   * `image_metadata` auto-enqueue from upload flow (R-41 — held
//     for a later P4 task).
//
// The `ImageChannelExecutor` from P3.T2 is intentionally retained
// in the codebase: smokes added in P3 (smoke:image-channel-executor,
// smoke:image-thumbnail, smoke:image-metadata, smoke:media-reprocess)
// use it as a deterministic single-concurrency harness for handler
// testing. JobQueue replaces it ONLY in `server/src/index.ts` —
// production boot wires the multi-channel scheduler.

import type { Logger } from "../logger.js";

import type { JobHandler } from "./handlerRegistry.js";
import type { JobRepository } from "./jobRepository.js";
import type { ProcessingJob } from "./jobTypes.js";

/**
 * The three job-channel namespaces named in docs/design.md §1.2 /
 * §9.2. Each must be present in the JobQueue constructor input
 * (even if its handler Map is empty) so the structure is visible
 * and the channel can be activated later without a code change.
 */
export type JobQueueChannelName = "image" | "video" | "ai";

export interface JobQueueChannelConfig {
  readonly name: JobQueueChannelName;
  /** Max simultaneously-running handlers for this channel. >= 1. */
  readonly concurrency: number;
  /**
   * job_type → handler. Empty map → channel exists but never claims.
   * Map is captured by reference at construction; mutating it after
   * `start()` is undefined behaviour.
   */
  readonly handlers: ReadonlyMap<string, JobHandler>;
  /** Defaults to 1500 ms when omitted. Smoke tests pass much larger
   * values + drive ticks manually for determinism. */
  readonly pollIntervalMs?: number | undefined;
}

export interface JobQueueDeps {
  readonly jobRepo: JobRepository;
  readonly logger: Logger;
  readonly channels: readonly JobQueueChannelConfig[];
}

/**
 * Lifecycle (mirrors ImageChannelExecutor):
 *   * "idle"     — constructed, polling NOT active. `tickChannel()`
 *                  is permitted (used by smokes).
 *   * "running"  — `start()` engaged the polling timers.
 *   * "stopping" — `stop()` is awaiting in-flight handlers.
 *   * "stopped"  — drain complete; reuse not supported.
 */
export type JobQueueState = "idle" | "running" | "stopping" | "stopped";

const DEFAULT_POLL_INTERVAL_MS = 1500;

interface ChannelRuntime {
  readonly cfg: JobQueueChannelConfig;
  readonly inflight: Set<Promise<void>>;
  intervalHandle: NodeJS.Timeout | null;
}

export interface TickChannelResult {
  readonly channel: JobQueueChannelName;
  /** Jobs claimed and dispatched this tick. Empty when idle / saturated. */
  readonly claimed: readonly { readonly jobId: string; readonly jobType: string }[];
  /**
   * True iff the channel was already at its concurrency cap before
   * this tick (i.e. no claim attempts were made). Helpful for tests
   * asserting back-pressure.
   */
  readonly saturatedBefore: boolean;
}

export class JobQueue {
  private state: JobQueueState = "idle";
  private readonly channels: Map<JobQueueChannelName, ChannelRuntime>;

  constructor(private readonly deps: JobQueueDeps) {
    this.channels = new Map();
    for (const cfg of deps.channels) {
      if (this.channels.has(cfg.name)) {
        throw new Error(`JobQueue: duplicate channel '${cfg.name}'`);
      }
      if (cfg.concurrency < 1) {
        throw new Error(
          `JobQueue: channel '${cfg.name}' has invalid concurrency ${cfg.concurrency} (must be >= 1)`,
        );
      }
      this.channels.set(cfg.name, {
        cfg,
        inflight: new Set(),
        intervalHandle: null,
      });
    }
  }

  /**
   * Engage polling for every channel. Idempotent — calling on a
   * running queue is a no-op. Refuses to start from `stopping` or
   * `stopped` (construct a fresh queue for a fresh start).
   *
   * Each channel fires an immediate first tick so pre-existing
   * pending rows do not have to wait a full interval. The interval
   * handles are `unref()`'d so they do not by themselves keep the
   * event loop alive.
   */
  start(): void {
    if (this.state === "running") return;
    if (this.state !== "idle") {
      throw new Error(`JobQueue: cannot start from state '${this.state}'`);
    }
    this.state = "running";
    for (const ch of this.channels.values()) {
      const interval = ch.cfg.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
      ch.intervalHandle = setInterval(() => {
        void this.fillChannel(ch);
      }, interval);
      ch.intervalHandle.unref();
      // Eager first poll.
      void this.fillChannel(ch);
    }
  }

  /**
   * Stop polling and await every in-flight handler across every
   * channel. Idempotent. After resolution the queue is fully
   * quiesced and `tickChannel()` will short-circuit.
   *
   * Works from any of {idle, running, stopping} — even an `idle`
   * queue may have inflight handlers from a manual `tickChannel`
   * call (used by smokes that drive the scheduler without
   * `start()`), so we always go through the drain path.
   */
  async stop(): Promise<void> {
    if (this.state === "stopped") return;
    this.state = "stopping";
    for (const ch of this.channels.values()) {
      if (ch.intervalHandle !== null) {
        clearInterval(ch.intervalHandle);
        ch.intervalHandle = null;
      }
    }
    const pending: Promise<void>[] = [];
    for (const ch of this.channels.values()) {
      for (const p of ch.inflight) pending.push(p);
    }
    await Promise.allSettled(pending);
    this.state = "stopped";
  }

  /**
   * Claim up to (channel.concurrency - inflight) jobs and dispatch
   * them asynchronously. Returns immediately with the list of
   * claimed jobs; handler completion is async — callers can
   * `await awaitInflight(name)` to block.
   *
   * Smoke tests use this method directly to drive the queue without
   * waiting for setInterval. The polling loop also calls the
   * underlying `fillChannel` private.
   */
  async tickChannel(name: JobQueueChannelName): Promise<TickChannelResult> {
    const ch = this.channels.get(name);
    if (ch === undefined) {
      throw new Error(`JobQueue: unknown channel '${name}'`);
    }
    if (this.state === "stopping" || this.state === "stopped") {
      return { channel: name, claimed: [], saturatedBefore: false };
    }
    const saturatedBefore = ch.inflight.size >= ch.cfg.concurrency;
    const claimed = await this.fillChannel(ch);
    return { channel: name, claimed, saturatedBefore };
  }

  /**
   * Tick every channel once (in declaration order) and return the
   * per-channel results. Convenience wrapper around `tickChannel`.
   */
  async tickAll(): Promise<TickChannelResult[]> {
    const results: TickChannelResult[] = [];
    for (const name of this.channels.keys()) {
      results.push(await this.tickChannel(name));
    }
    return results;
  }

  /** Block until the channel's in-flight set drains. */
  async awaitInflight(name: JobQueueChannelName): Promise<void> {
    const ch = this.channels.get(name);
    if (ch === undefined) return;
    while (ch.inflight.size > 0) {
      await Promise.allSettled([...ch.inflight]);
    }
  }

  /** Current in-flight count for a channel — diagnostics + smokes. */
  inflightCount(name: JobQueueChannelName): number {
    return this.channels.get(name)?.inflight.size ?? 0;
  }

  getState(): JobQueueState {
    return this.state;
  }

  /** Channel names this queue was constructed with. */
  channelNames(): readonly JobQueueChannelName[] {
    return [...this.channels.keys()];
  }

  // -------------------------------------------------------------------------
  // private
  // -------------------------------------------------------------------------

  /**
   * Claim and dispatch as many jobs as remaining capacity permits.
   * The returned promise resolves once *claiming* is done — each
   * dispatched handler runs async and is tracked in `ch.inflight`.
   */
  private async fillChannel(
    ch: ChannelRuntime,
  ): Promise<readonly { readonly jobId: string; readonly jobType: string }[]> {
    const claimed: { jobId: string; jobType: string }[] = [];
    // Channels with no handlers never claim — keeps a registered-
    // but-empty video / ai channel from stealing jobs another worker
    // is expected to handle later.
    if (ch.cfg.handlers.size === 0) return claimed;
    // After `stop()` initiated, refuse new claims.
    if (this.state === "stopping" || this.state === "stopped") return claimed;

    while (ch.inflight.size < ch.cfg.concurrency) {
      const job = this.claimOne(ch);
      if (job === null) break;
      claimed.push({ jobId: job.id, jobType: job.jobType });
      const dispatched = this.runHandler(ch, job);
      ch.inflight.add(dispatched);
      // Cleanup. Use `.finally` so the cleanup runs regardless of
      // handler outcome — `runHandler` swallows handler errors
      // internally, but defensive against future changes.
      void dispatched.finally(() => {
        ch.inflight.delete(dispatched);
      });
    }
    return claimed;
  }

  private claimOne(ch: ChannelRuntime): ProcessingJob | null {
    const types = [...ch.cfg.handlers.keys()];
    if (types.length === 0) return null;
    try {
      return this.deps.jobRepo.claimNextPendingByJobTypes(types);
    } catch (err) {
      this.deps.logger.error(
        { err: serializeErr(err), channel: ch.cfg.name },
        "JobQueue: claim failed (channel keeps polling)",
      );
      return null;
    }
  }

  private async runHandler(ch: ChannelRuntime, job: ProcessingJob): Promise<void> {
    const correlation = {
      channel: ch.cfg.name,
      jobId: job.id,
      jobType: job.jobType,
      mediaId: job.mediaId,
    };
    const handler = ch.cfg.handlers.get(job.jobType);
    if (handler === undefined) {
      // Should not happen — `claimOne` only requests known types —
      // but guard so a stale row can't break the channel.
      const message = `no handler in channel '${ch.cfg.name}' for job_type='${job.jobType}'`;
      this.markFailedSafely(job.id, message, correlation);
      this.deps.logger.warn(correlation, `JobQueue: ${message}`);
      return;
    }
    try {
      await handler(job);
      const changes = this.deps.jobRepo.markSuccess(job.id);
      if (changes === 0) {
        this.deps.logger.warn(
          correlation,
          "JobQueue: markSuccess affected 0 rows (job no longer running)",
        );
      } else {
        this.deps.logger.info(correlation, "JobQueue: job succeeded");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.markFailedSafely(job.id, message, correlation);
      this.deps.logger.warn({ ...correlation, error: message }, "JobQueue: handler failed");
    }
  }

  private markFailedSafely(
    jobId: string,
    message: string,
    correlation: Record<string, unknown>,
  ): void {
    try {
      this.deps.jobRepo.markFailed(jobId, message);
    } catch (err) {
      this.deps.logger.error(
        { ...correlation, err: serializeErr(err) },
        "JobQueue: markFailed itself failed (job will appear stuck in 'running')",
      );
    }
  }
}

function serializeErr(err: unknown): unknown {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return err;
}
