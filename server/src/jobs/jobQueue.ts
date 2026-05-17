// JobQueue scheduler (P4.T1 + P4.T2 + P4.T3).
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
// NOT block the others. Handler errors trigger the P4.T2 retry
// path: `running → retrying` with exponential backoff in
// `next_run_at`, finally `running → failed` only after the retry
// budget is exhausted. The §4.3-canonical transition graph is
// strictly observed.
//
// P4.T3 adds zombie recovery: at `start()` time (before polling
// fires), any row stuck in `running` past `zombieTimeoutMs` is
// routed back through the retry-budget judge — `running → retrying`
// if budget remains, otherwise `running → failed`. This covers
// process crashes, kill -9, OOM, and the small window in P4.T2
// where `markRetrying` itself can SQL-fail and leave the row
// stranded in `running`.
//
// What this module covers as of P4.T3:
//   * Stable JobQueue abstraction with start / stop lifecycle.
//   * Per-channel concurrency limit.
//   * State machine: pending → running → success / retrying
//                    retrying → running → success / failed
//                    running(zombie) → retrying / failed
//   * Failure retry with exponential backoff (cap'd) configured
//     via JobQueueRetryConfig.
//   * Zombie scan-and-recover at start(), reusing markRetrying /
//     markFailed; cutoff configurable via `zombieTimeoutMs`.
//   * Handler contract unchanged: `(job) => Promise<void>`.
//   * Structural placeholder for video / ai channels (no handlers
//     registered today — they exist as channels but never claim).
//
// What this module does NOT cover (deferred):
//   * Job API: GET / retry / cancel HTTP routes (P4.T4).
//   * Media-status linkage uploaded → processing → processed (P4.T5).
//   * Heartbeat / live-zombie detection during execution.
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

/**
 * Failure-retry policy (P4.T2). Backoff is
 *   `delay = min(baseDelayMs * 2^retry_count, maxDelayMs)`
 * where `retry_count` is the count BEFORE this retry is scheduled
 * (so the 1st retry fires after `baseDelayMs`, the 2nd after
 * `2*baseDelayMs`, etc.). `maxRetries` is the maximum number of
 * retries scheduled before a final `failed`. With maxRetries=3,
 * total attempts = 4.
 *
 * `maxRetries=0` disables retry — the catch path falls through to
 * `markFailed` directly (preserves the P4.T1 behaviour for smokes
 * that never opted into retry config).
 */
export interface JobQueueRetryConfig {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

const DEFAULT_RETRY_CONFIG: JobQueueRetryConfig = {
  maxRetries: 0,
  baseDelayMs: 0,
  maxDelayMs: 0,
};

export interface JobQueueDeps {
  readonly jobRepo: JobRepository;
  readonly logger: Logger;
  readonly channels: readonly JobQueueChannelConfig[];
  /**
   * Optional. When omitted (or `maxRetries=0`), handler failures
   * go straight to `failed` — same as P4.T1. Production boot in
   * `server/src/index.ts` opts in with values from config.
   */
  readonly retryConfig?: JobQueueRetryConfig;
  /**
   * P4.T3: max wall-clock duration a row may stay in `running`
   * before it is considered a zombie (process crashed, kill -9,
   * OOM, etc.) and reset back through the retry-budget judge.
   *
   * Default = 30 min. Set `0` to disable the scan (the start()
   * call will simply skip it). Smokes pass small values so the
   * cutoff is observable; production boot uses
   * `config.workers.zombieTimeoutMs` (env `ZOMBIE_TIMEOUT_MS`).
   */
  readonly zombieTimeoutMs?: number;
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
const DEFAULT_ZOMBIE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min

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

/**
 * P4.T3 zombie-recovery result. Returned by `recoverZombies()` and
 * exposed so smokes can assert on counts deterministically.
 *   * `recovered` — rows that landed in `retrying`.
 *   * `failed` — rows that landed in final `failed` (budget exhausted).
 *   * `skipped` — rows that were no longer `running` at UPDATE time
 *                 (raced with another transition; very rare).
 */
export interface ZombieRecoveryResult {
  readonly scanned: number;
  readonly recovered: number;
  readonly failed: number;
  readonly skipped: number;
}

export class JobQueue {
  private state: JobQueueState = "idle";
  private readonly channels: Map<JobQueueChannelName, ChannelRuntime>;
  private readonly retryConfig: JobQueueRetryConfig;
  private readonly zombieTimeoutMs: number;

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
    const cfg = deps.retryConfig ?? DEFAULT_RETRY_CONFIG;
    if (cfg.maxRetries < 0) {
      throw new Error(`JobQueue: retryConfig.maxRetries < 0 (${cfg.maxRetries})`);
    }
    if (cfg.maxRetries > 0) {
      if (cfg.baseDelayMs <= 0) {
        throw new Error(`JobQueue: retryConfig.baseDelayMs must be > 0 when maxRetries > 0`);
      }
      if (cfg.maxDelayMs < cfg.baseDelayMs) {
        throw new Error(
          `JobQueue: retryConfig.maxDelayMs (${cfg.maxDelayMs}) < baseDelayMs (${cfg.baseDelayMs})`,
        );
      }
    }
    this.retryConfig = cfg;

    // P4.T3 zombie timeout. Negative is rejected outright; 0 is the
    // documented "disable" sentinel; > 0 is the cutoff.
    const zt = deps.zombieTimeoutMs ?? DEFAULT_ZOMBIE_TIMEOUT_MS;
    if (!Number.isFinite(zt) || zt < 0) {
      throw new Error(`JobQueue: invalid zombieTimeoutMs (${zt}) — must be a finite number >= 0`);
    }
    this.zombieTimeoutMs = zt;
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
    // P4.T3: run zombie recovery BEFORE polling fires. At this
    // moment no channel has dispatched anything yet — inflight is
    // empty across the board — so there is no live handler we could
    // race with. Any row currently in `running` is either:
    //   * a zombie from a prior process (started_at is old → caught
    //     by the cutoff), or
    //   * a row some other process is mid-flight on (out of scope
    //     for V1, single-instance deploy).
    // We deliberately do this synchronously so logs land before the
    // first tick claims new work.
    this.recoverZombies();
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

  /** P4.T3 config introspection — used by smokes / diagnostics. */
  getZombieTimeoutMs(): number {
    return this.zombieTimeoutMs;
  }

  /**
   * P4.T3 zombie recovery. Scans every `running` row whose
   * `started_at` is older than `now - zombieTimeoutMs` and routes
   * each one back through the P4.T2 retry-budget judge:
   *   * `retry_count < maxRetries` → `markRetrying` with exponential
   *     backoff (same formula as `handleFailure`).
   *   * otherwise → `markFailed` (final, no further retries).
   *
   * Called automatically once from `start()`. Also public so smokes
   * (and a future "manual maintenance" CLI) can drive it on demand.
   * Returns counters so callers can assert deterministically.
   *
   * Disabled when `zombieTimeoutMs === 0`. The cutoff is computed
   * from the caller-supplied `now` (defaulting to wall-clock) so
   * deterministic tests can pass a fixed timestamp.
   *
   * Errors per-row are caught and logged; one bad row does not
   * abort the scan.
   */
  recoverZombies(now: Date = new Date()): ZombieRecoveryResult {
    if (this.zombieTimeoutMs <= 0) {
      return { scanned: 0, recovered: 0, failed: 0, skipped: 0 };
    }
    const cutoffMs = now.getTime() - this.zombieTimeoutMs;
    const cutoffIso = new Date(cutoffMs).toISOString();
    const nowIsoStr = now.toISOString();
    let zombies: readonly ProcessingJob[];
    try {
      zombies = this.deps.jobRepo.findZombieRunningJobs(cutoffIso);
    } catch (err) {
      this.deps.logger.error(
        { err: serializeErr(err), cutoffIso, zombieTimeoutMs: this.zombieTimeoutMs },
        "JobQueue: zombie scan SQL failed (no rows recovered)",
      );
      return { scanned: 0, recovered: 0, failed: 0, skipped: 0 };
    }
    if (zombies.length === 0) {
      return { scanned: 0, recovered: 0, failed: 0, skipped: 0 };
    }
    this.deps.logger.warn(
      { count: zombies.length, cutoffIso, zombieTimeoutMs: this.zombieTimeoutMs },
      "JobQueue: zombie scan found stuck 'running' rows; routing through retry-budget judge",
    );
    let recovered = 0;
    let failed = 0;
    let skipped = 0;
    for (const job of zombies) {
      const outcome = this.recoverOneZombie(job, now, nowIsoStr);
      if (outcome === "retrying") recovered += 1;
      else if (outcome === "failed") failed += 1;
      else skipped += 1;
    }
    return { scanned: zombies.length, recovered, failed, skipped };
  }

  // -------------------------------------------------------------------------
  // private
  // -------------------------------------------------------------------------

  /**
   * Per-row zombie recovery: pick retry vs. final-fail based on the
   * job's current `retry_count` and the configured `maxRetries`,
   * then call the matching repository method. All errors are
   * swallowed (logged + skipped) so a single bad row does not
   * abort the whole scan.
   */
  private recoverOneZombie(
    job: ProcessingJob,
    now: Date,
    nowIsoStr: string,
  ): "retrying" | "failed" | "skipped" {
    const startedAtMs = job.startedAt ? Date.parse(job.startedAt) : Number.NaN;
    const ageMs = Number.isFinite(startedAtMs) ? now.getTime() - startedAtMs : null;
    const correlation = {
      channel: this.channelNameForJobType(job.jobType),
      jobId: job.id,
      jobType: job.jobType,
      mediaId: job.mediaId,
      retryCount: job.retryCount,
      ageMs,
      zombieTimeoutMs: this.zombieTimeoutMs,
    };
    const message =
      ageMs !== null
        ? `zombie: stuck in 'running' for ${Math.round(ageMs / 1000)}s (>${Math.round(
            this.zombieTimeoutMs / 1000,
          )}s timeout)`
        : `zombie: 'running' with null started_at (recovered by P4.T3 scan)`;

    const { maxRetries, baseDelayMs, maxDelayMs } = this.retryConfig;
    if (job.retryCount < maxRetries) {
      const delayMs = Math.min(baseDelayMs * Math.pow(2, job.retryCount), maxDelayMs);
      const nextRunAt = new Date(now.getTime() + delayMs).toISOString();
      const newRetryCount = job.retryCount + 1;
      try {
        const changes = this.deps.jobRepo.markRetrying(
          job.id,
          message,
          nextRunAt,
          newRetryCount,
          nowIsoStr,
        );
        if (changes === 0) {
          this.deps.logger.warn(
            { ...correlation },
            "JobQueue: zombie no longer 'running' at UPDATE time (skipped)",
          );
          return "skipped";
        }
        this.deps.logger.warn(
          { ...correlation, newRetryCount, maxRetries, delayMs, nextRunAt },
          "JobQueue: zombie recovered → retrying",
        );
        return "retrying";
      } catch (err) {
        this.deps.logger.error(
          { ...correlation, err: serializeErr(err) },
          "JobQueue: markRetrying threw during zombie recovery (skipped)",
        );
        return "skipped";
      }
    }
    // Budget exhausted: final fail.
    try {
      const changes = this.deps.jobRepo.markFailed(job.id, message, nowIsoStr);
      if (changes === 0) {
        this.deps.logger.warn(
          { ...correlation },
          "JobQueue: zombie no longer 'running' at UPDATE time (skipped)",
        );
        return "skipped";
      }
      this.deps.logger.warn(
        { ...correlation, maxRetries },
        "JobQueue: zombie has no retries remaining → failed",
      );
      return "failed";
    } catch (err) {
      this.deps.logger.error(
        { ...correlation, err: serializeErr(err) },
        "JobQueue: markFailed threw during zombie recovery (skipped)",
      );
      return "skipped";
    }
  }

  /**
   * Best-effort reverse lookup: which channel owns this jobType?
   * Used only for correlation logging. Returns the channel name or
   * `"unknown"` if no channel has a handler for it (e.g. a row
   * whose handler was deregistered between runs).
   */
  private channelNameForJobType(jobType: string): JobQueueChannelName | "unknown" {
    for (const [name, ch] of this.channels) {
      if (ch.cfg.handlers.has(jobType)) return name;
    }
    return "unknown";
  }

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
      this.handleFailure(job, message, correlation);
    }
  }

  /**
   * P4.T2 retry-budget decision: if the job has retries left, schedule
   * a `retrying` transition with exponential backoff; otherwise this is
   * the final attempt and we transition straight to `failed`.
   *
   * The "retries left" check uses the CURRENT `retry_count` on the job
   * row (read once at claim time and snapshotted into `job`). Backoff
   * delay is computed from that same pre-increment value — so the
   * first retry fires after `baseDelayMs`, the second after
   * `2*baseDelayMs`, etc. The post-increment value (retryCount + 1)
   * is what gets persisted on the row.
   */
  private handleFailure(
    job: ProcessingJob,
    message: string,
    correlation: Record<string, unknown>,
  ): void {
    const { maxRetries, baseDelayMs, maxDelayMs } = this.retryConfig;
    if (job.retryCount >= maxRetries) {
      // Retry budget exhausted (covers both maxRetries=0 "no retry"
      // and "we already retried N times"). Final fail.
      this.markFailedSafely(job.id, message, correlation);
      this.deps.logger.warn(
        { ...correlation, error: message, retryCount: job.retryCount },
        "JobQueue: handler failed (no retries remaining)",
      );
      return;
    }
    const delayMs = Math.min(baseDelayMs * Math.pow(2, job.retryCount), maxDelayMs);
    const nextRunAt = new Date(Date.now() + delayMs).toISOString();
    const newRetryCount = job.retryCount + 1;
    try {
      const changes = this.deps.jobRepo.markRetrying(job.id, message, nextRunAt, newRetryCount);
      if (changes === 0) {
        // Row not in `running` anymore — fall back to final fail
        // logging; we deliberately don't try a second UPDATE since
        // we'd be guessing at the actual current status.
        this.deps.logger.warn(
          { ...correlation, error: message, retryCount: job.retryCount },
          "JobQueue: markRetrying affected 0 rows (job no longer running)",
        );
        return;
      }
      this.deps.logger.warn(
        {
          ...correlation,
          error: message,
          retryCount: newRetryCount,
          maxRetries,
          delayMs,
          nextRunAt,
        },
        "JobQueue: handler failed, scheduled retry",
      );
    } catch (err) {
      this.deps.logger.error(
        { ...correlation, err: serializeErr(err) },
        "JobQueue: markRetrying itself failed (job may appear stuck in 'running')",
      );
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
