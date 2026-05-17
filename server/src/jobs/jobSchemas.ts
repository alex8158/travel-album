// Zod schemas for the public Job API (P4.T4).
//
// Scope:
//   * Path / query validation only — JobService is responsible for
//     domain rules (allowed-state-for-retry, allowed-state-for-cancel).
//   * `JobStatus` mirrors the CHECK enum on `processing_jobs.status`.
//   * `entityIdSchema` is reused for trip / media / job ids (same
//     pattern as Trip / Media routes).
//   * Pagination is capped at limit ∈ [1, 100] / offset ≥ 0 to match
//     the surface of `GET /api/trips` and `GET /api/trips/:id/media`.
//
// Unknown query keys are silently dropped (default zod `strip`) so
// future cache-busters / instrumentation params don't break the API.

import { z } from "zod";

import { entityIdSchema } from "../trips/index.js";

export const jobStatusSchema = z.enum([
  "pending",
  "running",
  "success",
  "failed",
  "retrying",
  "cancelled",
]);

/**
 * Free-form `job_type` is intentionally a permissive string — the
 * vocabulary grows across P3 / P5 / P9 / P10. We cap length and
 * pattern only enough to reject obviously-malformed input from
 * passing through to a `WHERE j.job_type = ?` clause.
 */
const jobTypeSchema = z
  .string()
  .min(1, "jobType must not be empty")
  .max(64, "jobType must be <= 64 chars")
  .regex(/^[A-Za-z0-9_:.-]+$/, "jobType has unexpected characters");

export const listJobsQuerySchema = z.object({
  status: jobStatusSchema.optional(),
  jobType: jobTypeSchema.optional(),
  mediaId: entityIdSchema.optional(),
  tripId: entityIdSchema.optional(),
  limit: z.coerce
    .number({ invalid_type_error: "limit must be a number" })
    .int("limit must be an integer")
    .min(1, "limit must be >= 1")
    .max(100, "limit must be <= 100")
    .default(50),
  offset: z.coerce
    .number({ invalid_type_error: "offset must be a number" })
    .int("offset must be an integer")
    .nonnegative("offset must be >= 0")
    .default(0),
});

export type ListJobsQuery = z.infer<typeof listJobsQuerySchema>;
