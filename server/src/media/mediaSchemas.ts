// Zod input schemas for the Media read API (P2.T5).
//
// The trip / media id pattern is shared with the storage layer and
// the trip domain, so we re-use `entityIdSchema` from there — adding
// a separate "mediaIdSchema" alias would be a synonym, not extra
// validation.
//
// `listMediaOptionsSchema` is the Service-level shape (limit 1..200,
// offset ≥ 0). The route layer (routes/media.ts) wraps it with a
// stricter limit (1..100) so the public HTTP cap is independent of
// the Service contract — same split that P1.T3 uses for trips list.
//
// `includeDeleted` is accepted by the Service schema so future
// restore / admin callers can request soft-deleted rows. The route
// layer deliberately does NOT expose it; the public read endpoint
// only ever shows active rows.

import { z } from "zod";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

export const listMediaOptionsSchema = z
  .object({
    limit: z.coerce
      .number()
      .int("limit must be an integer")
      .positive("limit must be > 0")
      .max(MAX_LIST_LIMIT, `limit must be ≤ ${MAX_LIST_LIMIT}`)
      .default(DEFAULT_LIST_LIMIT),
    offset: z.coerce
      .number()
      .int("offset must be an integer")
      .nonnegative("offset must be ≥ 0")
      .default(0),
    includeDeleted: z.coerce.boolean().default(false),
  })
  .strict();

export type ListMediaInput = z.infer<typeof listMediaOptionsSchema>;
