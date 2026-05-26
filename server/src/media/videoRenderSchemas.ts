// Zod schema for the P11.T5 `POST /api/trips/:tripId/render`
// request body. All fields optional — empty body `{}` means
// "render the trip's latest plan in final mode without overwrite".
//
// `.strict()` rejects unknown body keys (consistent with the rest
// of the project's API surface).

import { z } from "zod";

/** Closed mode enum. V1 treats both modes identically at the
 * ffmpeg layer (recorded as a known limit in progress.md); the
 * field is preserved so future P11.T5+ polish can branch on it
 * without an API change. */
export const renderModeSchema = z.enum(["preview", "final"]);

export const renderTripBodySchema = z
  .object({
    /** When provided, use this exact plan. When omitted, the
     * render service falls back to the trip's most-recent plan
     * (`editPlansRepo.findLatestByTripId`). */
    planId: z.string().min(1).optional(),
    /** Default `'final'`. Preview vs final is informational in
     * V1 (see header). */
    mode: renderModeSchema.optional(),
    /** When true, the render service inserts a fresh `video_render`
     * job even when a prior one exists in a terminal state; lets
     * an operator force a re-render. Default false — the
     * idempotency layer reuses the existing job (created / reset /
     * skipped semantics). */
    overwrite: z.boolean().optional(),
  })
  .strict();

export type RenderTripInput = z.infer<typeof renderTripBodySchema>;
