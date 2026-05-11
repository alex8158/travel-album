// Job domain types (P2.T4 scope).
//
// Mirrors the columns of server/migrations/004_create_processing_jobs.sql.
// As with mediaTypes.ts, only the writer-facing surface is needed today
// — the Worker / scheduler / retry / state-machine helpers land in P4.
//
// `JobStatus` is the closed set fixed by CLAUDE.md §4.2; the schema
// already CHECKs it. The transition graph (pending → running, etc.)
// is NOT enforced at the schema level and is NOT enforced here —
// P4.T1 owns the state-machine guard.
//
// `job_type` is intentionally typed as `string` because the vocabulary
// keeps growing across P3 / P5 / P9 / P10; the upload path only ever
// emits `image_thumbnail` or `video_metadata` (per design.md §6.2),
// constants for which live in UploadService.

export type JobStatus = "pending" | "running" | "success" | "failed" | "retrying" | "cancelled";

/**
 * Required fields when Upload_Manager seeds the initial pending job
 * after a successful upload.
 *
 * - `status` defaults to `pending` (matches the column default).
 * - `payload` defaults to NULL — the upload path has no payload to
 *   pass; later tasks (e.g. P3.T2 metadata) may persist parameters
 *   here.
 * - `progress`, `retryCount`, `nextRunAt`, `startedAt`, `finishedAt`,
 *   and `errorMessage` are intentionally NOT in this shape: they fall
 *   to their DB defaults (`0` / `0` / `NULL` / `NULL` / `NULL` /
 *   `NULL`) and only the Worker pool (P4) touches them.
 */
export interface JobInsertData {
  readonly id: string;
  readonly mediaId: string;
  readonly jobType: string;
  readonly status?: JobStatus;
  readonly payload?: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Read projection of a `processing_jobs` row, returned by the
 * repository to the executor (P3.T2). Mirrors every column in
 * server/migrations/004_create_processing_jobs.sql exactly so the
 * executor and handlers can branch on whatever they need without an
 * extra DB round-trip.
 */
export interface ProcessingJob {
  readonly id: string;
  readonly mediaId: string;
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
