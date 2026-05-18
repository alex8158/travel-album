// Zod schemas for the public Dedup API (P5.T5).
//
// Scope:
//   * Path / body validation only — DedupService translates these
//     into engine calls; algorithmic rules live in DedupEngine.
//   * `entityIdSchema` (Trip / Media / Job id format) is reused
//     unchanged from the trips domain.
//   * `hammingThreshold` is bounded by the pHash bit budget [0, 64]
//     — values outside that range are nonsensical (and unsafe for
//     the engine's normalisation: `1 - d/64` would clamp anyway).
//
// Unknown body keys are silently dropped (default zod `strip`) so
// future instrumentation params do not break the API.

import { z } from "zod";

import { HEX16_MAX_BITS } from "./hamming.js";

/**
 * Body schema for `POST /api/trips/:tripId/dedup/similar`.
 * All fields optional — an empty body is valid and yields the
 * engine default (`DEFAULT_SIMILAR_HAMMING_THRESHOLD` = 8).
 */
export const dedupSimilarBodySchema = z.object({
  hammingThreshold: z
    .number({
      invalid_type_error: "hammingThreshold must be a number",
    })
    .int("hammingThreshold must be an integer")
    .min(0, "hammingThreshold must be >= 0")
    .max(HEX16_MAX_BITS, `hammingThreshold must be <= ${HEX16_MAX_BITS} (pHash bit budget)`)
    .optional(),
});
export type DedupSimilarBody = z.infer<typeof dedupSimilarBodySchema>;

/**
 * Body schema for `POST /api/trips/:tripId/dedup/run`. Forwards
 * `hammingThreshold` (if present) to the similar half. The exact
 * half takes no parameters.
 */
export const dedupRunBodySchema = dedupSimilarBodySchema;
export type DedupRunBody = z.infer<typeof dedupRunBodySchema>;
