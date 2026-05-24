// Zod input schemas for the Video API (P9.T8).
//
// Conventions:
//   * `.strict()` everywhere — an unknown body key trips a 400 so
//     a future drift forces an explicit schema update.
//   * Enum values match the closed sets enforced by migration 011
//     CHECK constraints (`video_segments.user_decision`). Keeping
//     the route enum identical to the DB enum guards against the
//     "API accepts a value the DB then rejects" footgun.

import { z } from "zod";

import type { VideoSegmentUserDecision } from "./videoSegmentTypes.js";

/**
 * Body schema for `PATCH /api/video-segments/:segmentId/user-decision`.
 *
 * The enum mirrors `video_segments_user_decision_enum` from
 * migration 011. CLAUDE.md §3.9 makes this column the user's
 * source-of-truth — the API never overwrites a manual choice
 * during system rescoring (R-107 closed by P9.T7).
 */
export const updateUserDecisionBodySchema = z
  .object({
    userDecision: z.enum(["keep", "remove", "undecided"], {
      errorMap: () => ({
        message: "userDecision must be one of: keep, remove, undecided",
      }),
    }),
  })
  .strict();

// The zod-derived type lines up with the DB enum (TypeScript
// will surface a drift here if the column-level enum and the
// schema-level enum get out of sync).
const _typeAlignCheck: VideoSegmentUserDecision =
  null as unknown as z.infer<typeof updateUserDecisionBodySchema>["userDecision"];
void _typeAlignCheck;

export type UpdateUserDecisionInput = z.infer<typeof updateUserDecisionBodySchema>;

/**
 * Body schema for `POST /api/media/:mediaId/process-video-segments`.
 *
 * Body is optional from the client's POV (an empty `{}` is fine),
 * but unknown keys still 400 thanks to `.strict()`. The single
 * accepted field is `force`:
 *
 *   * `false` (default / omitted) — re-run the pipeline; the
 *     segments worker preserves any non-`undecided` user_decision
 *     via time-overlap mapping (R-107 default behaviour).
 *   * `true` — operator explicitly requests a clean reanalysis;
 *     `user_decision` is wiped along with the old rows.
 */
export const processVideoSegmentsBodySchema = z
  .object({
    force: z.boolean().optional(),
  })
  .strict();

export type ProcessVideoSegmentsInput = z.infer<typeof processVideoSegmentsBodySchema>;
