// Zod schema for the P11.T4 `POST /api/trips/:tripId/generate-edit-plan`
// request body. Mirrors the closed enums from `videoEditPlan.ts` so
// the validator and the rule engine stay in lock-step.
//
// `.strict()` is used throughout to reject unknown body keys — the
// frontend / API consumer must not send fields the renderer doesn't
// know about. Compatible with the project-wide convention from
// `videoSchemas.ts` (P9.T8) and `mediaSchemas.ts` (P8.T4).

import { z } from "zod";

/** Allowed style values; must match `EditPlanStyle` in
 * videoEditPlan.ts. Kept literal here instead of importing the
 * union — zod's `z.enum` needs string literals at construction
 * time, not type-level unions. */
export const editPlanStyleSchema = z.enum(["short", "standard", "long"]);

/** Allowed audio modes (request layer). The resolver may degrade
 * `replace_with_library` → `keep_original` with a warning when the
 * background audio id can't be resolved; that's not an input error
 * so all three values are accepted. */
export const editPlanAudioModeSchema = z.enum(["keep_original", "mute", "replace_with_library"]);

export const editPlanAspectRatioSchema = z.enum(["16:9", "9:16", "1:1", "4:5"]);

export const editPlanResolutionSchema = z.enum(["720p", "1080p", "4k"]);

/** Body schema for `POST /api/trips/:tripId/generate-edit-plan`.
 *
 * Field-level decisions:
 *   * Every field is optional — the service falls back to defaults
 *     when a field is missing. An entirely empty body (`{}`) is the
 *     "give me a sensible default plan" request.
 *   * `targetDurationSec` is `int+`. We don't accept fractional
 *     seconds at the request layer to keep call sites simple; the
 *     rule engine may still emit fractional clip durations
 *     internally.
 *   * `targetDurationSec` upper bound 3600s (1 hour) — anything
 *     longer would be a misuse pattern (the renderer's V1 timeout
 *     is also tight; longer plans would just fail at render).
 *   * `style` and `targetDurationSec` are both optional and don't
 *     conflict: if both are provided, `targetDurationSec` wins.
 *     The service documents this; the schema doesn't enforce it
 *     since either combination is valid input.
 *   * `mediaIds` is optional. When provided the service uses
 *     exactly these ids (filtered for video + active); when
 *     omitted the service pulls every video for the trip. Limited
 *     to 50 entries to bound the planner's work.
 *   * `backgroundAudioId` is optional. When set without
 *     `audioMode`, the service infers `audioMode='replace_with_library'`.
 *     UUID-ish shape is enforced upstream by the entity-id pass.
 */
export const generateEditPlanBodySchema = z
  .object({
    targetDurationSec: z
      .number({ invalid_type_error: "targetDurationSec must be a number" })
      .int("targetDurationSec must be an integer")
      .min(1, "targetDurationSec must be >= 1")
      .max(3600, "targetDurationSec must be <= 3600")
      .optional(),
    style: editPlanStyleSchema.optional(),
    mediaIds: z
      .array(z.string().min(1))
      .min(1, "mediaIds must be a non-empty array when present")
      .max(50, "mediaIds is limited to 50 entries per plan")
      .optional(),
    audioMode: editPlanAudioModeSchema.optional(),
    backgroundAudioId: z.string().min(1).optional(),
    aspectRatio: editPlanAspectRatioSchema.optional(),
    resolution: editPlanResolutionSchema.optional(),
  })
  .strict();

export type GenerateEditPlanInput = z.infer<typeof generateEditPlanBodySchema>;
