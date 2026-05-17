// JobService — domain layer behind the public Job API (P4.T4).
//
// Responsibilities:
//   * Validate ids and list filters via the shared `parseOrThrow`
//     adapter so the HTTP layer just hands `req.params` / `req.query`
//     through.
//   * Translate "row not found" into NotFoundError, "illegal state
//     for action" into BadRequestError with a stable error code
//     (INVALID_STATE_TRANSITION).
//   * Funnel all writes through existing JobRepository methods so the
//     CLAUDE.md §4.3 state-transition graph is observed end-to-end:
//       - retry: `failed / success / cancelled / retrying → retrying`
//                (resets retry_count to 0; reuses `resetToRetrying`).
//       - cancel: `pending / retrying / running → cancelled`
//                 (new `cancelJob` method; does NOT kill a live
//                 handler — the running row just changes status,
//                 the next markSuccess/markFailed becomes a no-op).
//
// What this service is NOT:
//   * Not a polling loop / scheduler — JobQueue (P4.T1) owns claim
//     and dispatch. Retry / cancel only manipulate the row; the
//     scheduler picks up the retrying row on its next tick.
//   * Not a media-status updater — that's P4.T5.
//   * Not a frontend-facing renderer — controllers shape the JSON.

import { AppError, NotFoundError } from "../errors/AppError.js";
import { ERROR_CODES } from "../errors/errorCodes.js";
import { entityIdSchema } from "../trips/index.js";
import { parseOrThrow } from "../util/zodParse.js";

import type { JobRepository } from "./jobRepository.js";
import { listJobsQuerySchema } from "./jobSchemas.js";
import type { JobStatus, JobView } from "./jobTypes.js";

/** Subset of statuses from which a manual retry is allowed. */
const RETRYABLE_STATUSES: ReadonlySet<JobStatus> = new Set([
  "failed",
  "success",
  "cancelled",
  "retrying",
]);

/** Subset of statuses from which a manual cancel is allowed. */
const CANCELLABLE_STATUSES: ReadonlySet<JobStatus> = new Set(["pending", "retrying", "running"]);

export class JobService {
  constructor(private readonly repo: JobRepository) {}

  /** GET /api/jobs/:id — returns the row with `tripId` resolved. */
  getJobById(idInput: unknown): JobView {
    const id = parseOrThrow(entityIdSchema, idInput, "id");
    const view = this.repo.findJobView(id);
    if (view === null) {
      throw new NotFoundError(`Job not found: ${id}`, { id });
    }
    return view;
  }

  /**
   * GET /api/jobs — list with optional filters. The route layer has
   * already parsed `req.query` with `listJobsQuerySchema`, but we
   * accept `unknown` and re-validate so non-HTTP callers (CLI, future
   * worker introspection) get the same contract.
   */
  listJobs(queryInput: unknown): JobView[] {
    const filter = parseOrThrow(listJobsQuerySchema, queryInput, "query parameters");
    // The schema's `.default(...)` makes limit / offset always
    // present at runtime, but zod 3's inferred output type still
    // marks them optional under exactOptionalPropertyTypes. Coalesce
    // to the same defaults for TS while runtime is unchanged.
    const repoFilter: {
      status?: JobStatus;
      jobType?: string;
      mediaId?: string;
      tripId?: string;
      limit: number;
      offset: number;
    } = { limit: filter.limit ?? 50, offset: filter.offset ?? 0 };
    if (filter.status !== undefined) repoFilter.status = filter.status;
    if (filter.jobType !== undefined) repoFilter.jobType = filter.jobType;
    if (filter.mediaId !== undefined) repoFilter.mediaId = filter.mediaId;
    if (filter.tripId !== undefined) repoFilter.tripId = filter.tripId;
    return this.repo.listJobs(repoFilter);
  }

  /**
   * POST /api/jobs/:id/retry — manual retry.
   *
   * Allowed source statuses: failed / success / cancelled / retrying.
   * pending / running are rejected with a 400 + INVALID_STATE_TRANSITION
   * because they are already on the runnable path or in-flight.
   *
   * Reuses `JobRepository.resetToRetrying` which also resets
   * `retry_count=0` + `next_run_at=now`. That semantic — "start
   * over, give it the full budget again" — matches the user
   * intent of clicking a "retry" button: the previous attempts
   * are explicitly discarded.
   *
   * The action is purely DB-side; the actual handler invocation
   * happens on the next JobQueue tick. The API never directly
   * invokes a handler — keeps the §4.3 transition graph intact and
   * leaves concurrency control to JobQueue.
   */
  retryJob(idInput: unknown): JobView {
    const id = parseOrThrow(entityIdSchema, idInput, "id");
    const current = this.repo.findJobView(id);
    if (current === null) {
      throw new NotFoundError(`Job not found: ${id}`, { id });
    }
    if (!RETRYABLE_STATUSES.has(current.status)) {
      throw new AppError(
        ERROR_CODES.INVALID_STATE_TRANSITION,
        `cannot retry job in status '${current.status}'`,
        {
          statusCode: 400,
          details: {
            id,
            currentStatus: current.status,
            allowedFrom: [...RETRYABLE_STATUSES],
          },
        },
      );
    }
    const changes = this.repo.resetToRetrying(id);
    if (changes === 0) {
      // Status flipped between our read and the UPDATE — re-fetch
      // and surface the actual final state so the client can decide.
      const after = this.repo.findJobView(id);
      if (after === null) {
        throw new NotFoundError(`Job not found: ${id}`, { id });
      }
      throw new AppError(
        ERROR_CODES.INVALID_STATE_TRANSITION,
        `job state changed during retry; current status is '${after.status}'`,
        { statusCode: 409, details: { id, currentStatus: after.status } },
      );
    }
    const updated = this.repo.findJobView(id);
    if (updated === null) {
      // Row vanished between UPDATE and SELECT — should be impossible
      // (FK CASCADE only fires on media delete, not job delete).
      throw new NotFoundError(`Job not found after retry: ${id}`, { id });
    }
    return updated;
  }

  /**
   * POST /api/jobs/:id/cancel — manual cancel.
   *
   * Allowed source statuses: pending / retrying / running.
   * success / failed / cancelled are rejected with a 400 +
   * INVALID_STATE_TRANSITION (already terminal — nothing to cancel).
   *
   * For `running` rows we deliberately do NOT touch the live
   * handler. Cancellation is a status flag: when the handler later
   * tries markSuccess / markFailed / markRetrying, those statements
   * carry `WHERE status = 'running'` guards and become no-ops,
   * preserving the cancellation.
   */
  cancelJob(idInput: unknown): JobView {
    const id = parseOrThrow(entityIdSchema, idInput, "id");
    const current = this.repo.findJobView(id);
    if (current === null) {
      throw new NotFoundError(`Job not found: ${id}`, { id });
    }
    if (!CANCELLABLE_STATUSES.has(current.status)) {
      throw new AppError(
        ERROR_CODES.INVALID_STATE_TRANSITION,
        `cannot cancel job in status '${current.status}'`,
        {
          statusCode: 400,
          details: {
            id,
            currentStatus: current.status,
            allowedFrom: [...CANCELLABLE_STATUSES],
          },
        },
      );
    }
    const changes = this.repo.cancelJob(id);
    if (changes === 0) {
      const after = this.repo.findJobView(id);
      if (after === null) {
        throw new NotFoundError(`Job not found: ${id}`, { id });
      }
      throw new AppError(
        ERROR_CODES.INVALID_STATE_TRANSITION,
        `job state changed during cancel; current status is '${after.status}'`,
        { statusCode: 409, details: { id, currentStatus: after.status } },
      );
    }
    const updated = this.repo.findJobView(id);
    if (updated === null) {
      throw new NotFoundError(`Job not found after cancel: ${id}`, { id });
    }
    return updated;
  }
}
