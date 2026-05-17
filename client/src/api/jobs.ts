// Job API client (P4.T6).
//
// Mirrors the server's Job API surface (P4.T4):
//
//   GET    /api/jobs              — list + filters + pagination
//   GET    /api/jobs/:id          — single
//   POST   /api/jobs/:id/retry    — flip terminal-ish → 'retrying'
//   POST   /api/jobs/:id/cancel   — flip non-terminal → 'cancelled'
//
// Kept in sync by hand with `server/src/jobs/jobTypes.ts → JobView` and
// `server/src/jobs/jobSchemas.ts → listJobsQuerySchema`. An auto-
// generated OpenAPI client is a later concern (R-14 in P1 risks).
//
// Errors are surfaced as plain `Error` instances whose `.message` is
// lifted from the unified error envelope (`error.message`) the
// backend renders via the global error middleware (P0.T6).

/**
 * Lifecycle states from `processing_jobs.status` (CLAUDE.md §4.2).
 * Identical to the server-side `JobStatus` literal union.
 */
export type JobStatus = "pending" | "running" | "success" | "failed" | "retrying" | "cancelled";

/** All status values, in a list-friendly order (for filter chips). */
export const ALL_JOB_STATUSES: readonly JobStatus[] = [
  "pending",
  "running",
  "retrying",
  "success",
  "failed",
  "cancelled",
];

/**
 * Read projection returned by every Job API endpoint. Mirrors the
 * server-side `JobView` (server/src/jobs/jobTypes.ts), which extends
 * `ProcessingJob` with a `tripId` resolved via LEFT JOIN.
 */
export interface JobView {
  readonly id: string;
  readonly mediaId: string;
  readonly tripId: string | null;
  readonly jobType: string;
  readonly status: JobStatus;
  readonly progress: number;
  readonly errorMessage: string | null;
  readonly retryCount: number;
  readonly payload: string | null;
  readonly nextRunAt: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ListJobsResponse {
  jobs: JobView[];
}

interface SingleJobResponse {
  job: JobView;
}

interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId?: string;
    details?: unknown;
  };
}

/**
 * Filter knobs accepted by `GET /api/jobs`. All optional. The server
 * caps `limit` at 100 and defaults `offset` to 0. Single-value
 * filters; multi-value / IN-list support is a later concern.
 */
export interface FetchJobsOptions {
  readonly status?: JobStatus;
  readonly jobType?: string;
  readonly mediaId?: string;
  readonly tripId?: string;
  readonly limit?: number;
  readonly offset?: number;
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const envelope = (await res.json()) as ApiErrorEnvelope | null;
    if (envelope?.error?.message) return envelope.error.message;
  } catch {
    // Non-JSON error body; fall through.
  }
  return `HTTP ${res.status}`;
}

/**
 * Fetch the filtered + paginated job list. Throws on any non-2xx
 * response with the error envelope's message lifted to `.message`.
 *
 * Use case: the Jobs page (P4.T6) calls this with the active status
 * filter selected by the user.
 */
export async function fetchJobs(
  options: FetchJobsOptions = {},
  signal?: AbortSignal,
): Promise<JobView[]> {
  const params = new URLSearchParams();
  if (options.status !== undefined) params.set("status", options.status);
  if (options.jobType !== undefined) params.set("jobType", options.jobType);
  if (options.mediaId !== undefined) params.set("mediaId", options.mediaId);
  if (options.tripId !== undefined) params.set("tripId", options.tripId);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.offset !== undefined) params.set("offset", String(options.offset));
  const query = params.toString();
  const url = `/api/jobs${query ? `?${query}` : ""}`;

  const init: RequestInit = { headers: { Accept: "application/json" } };
  if (signal) init.signal = signal;

  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  const body = (await res.json()) as ListJobsResponse;
  return body.jobs;
}

/**
 * Fetch a single job by id. Throws on 4xx/5xx — 404 for missing,
 * 400 for malformed id.
 */
export async function getJobById(id: string, signal?: AbortSignal): Promise<JobView> {
  const init: RequestInit = { headers: { Accept: "application/json" } };
  if (signal) init.signal = signal;

  const res = await fetch(`/api/jobs/${encodeURIComponent(id)}`, init);
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  const body = (await res.json()) as SingleJobResponse;
  return body.job;
}

/**
 * Manual retry. Server-side rules (P4.T4 JobService):
 *   * Allowed from: failed / success / cancelled / retrying.
 *   * Rejected (400 INVALID_STATE_TRANSITION) from: pending / running.
 *
 * Retry is a pure DB flip → JobQueue claims on its next tick. The
 * client never invokes a handler directly. Returns the post-mutation
 * row so the caller can update its local state without a re-fetch.
 */
export async function retryJob(id: string): Promise<JobView> {
  const res = await fetch(`/api/jobs/${encodeURIComponent(id)}/retry`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  const body = (await res.json()) as SingleJobResponse;
  return body.job;
}

/**
 * Manual cancel. Server-side rules (P4.T4 JobService):
 *   * Allowed from: pending / retrying / running.
 *   * Rejected (400 INVALID_STATE_TRANSITION) from: success / failed / cancelled.
 *
 * For `running` rows the server does NOT kill the live handler —
 * cancellation is a status flag, and the handler's eventual
 * markSuccess/markFailed becomes a no-op via the `WHERE status =
 * 'running'` guard.
 */
export async function cancelJob(id: string): Promise<JobView> {
  const res = await fetch(`/api/jobs/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  const body = (await res.json()) as SingleJobResponse;
  return body.job;
}
