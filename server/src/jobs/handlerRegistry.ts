// Job handler registry (P3.T2).
//
// Tiny `Map<jobType, JobHandler>` indirection so the executor doesn't
// have to know about specific job types and so each handler (P3.T4
// thumbnail, P3.T5 metadata, future P5 hash / P6 quality, etc.) can
// be wired in at boot time without touching the executor.
//
// Scope is intentionally bounded:
//   * No middleware, no priorities, no per-handler concurrency limits.
//   * No automatic registration / discovery — callers explicitly
//     `register()` each handler. Visible at boot for code review.
//   * The handler API is the smallest thing that can plausibly do
//     real work later: a single Promise-returning function taking
//     the full `ProcessingJob` row.
//
// P4.T1 will reuse this registry verbatim and keep the same handler
// signature. The polished worker pool will swap out only the
// scheduling layer (channels / retry / zombie / Job API), not the
// handler contract.

import type { ProcessingJob } from "./jobTypes.js";

/**
 * Single job handler. Resolves on success, rejects on failure.
 *
 * The executor catches a rejection and marks the job `failed` with
 * the error message; a clean resolve marks it `success`. Throwing
 * synchronously is also fine — the executor's try/catch is around
 * `await handler(job)` either way.
 *
 * Handlers should be:
 *   * idempotent under at-least-once execution (the stub does NOT
 *     have retry, but P4 will — and a handler that double-writes a
 *     thumbnail because P4 retried it is a P3.T4 / P3.T5 concern,
 *     not a P3.T2 concern).
 *   * scoped to one media id (`job.mediaId`); no cross-row updates.
 *   * tolerant of being called with the job already partially
 *     processed (e.g. re-running a thumbnail handler should re-create
 *     the file, not corrupt the existing one).
 */
export type JobHandler = (job: ProcessingJob) => Promise<void>;

export class JobHandlerRegistry {
  private readonly handlers = new Map<string, JobHandler>();

  /**
   * Register (or replace) the handler for a job type. Replacement is
   * allowed so tests / smokes can swap a real handler for a stub.
   * Production boot code should register each type exactly once.
   */
  register(jobType: string, handler: JobHandler): void {
    if (jobType.length === 0) {
      throw new Error("jobType must not be empty");
    }
    this.handlers.set(jobType, handler);
  }

  /** Returns the handler for `jobType`, or `null` when none is registered. */
  get(jobType: string): JobHandler | null {
    return this.handlers.get(jobType) ?? null;
  }

  /** Whether a handler is registered for `jobType`. */
  has(jobType: string): boolean {
    return this.handlers.has(jobType);
  }

  /** All registered job types, primarily for diagnostics / smokes. */
  list(): string[] {
    return [...this.handlers.keys()];
  }
}
