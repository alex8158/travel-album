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
// restore / admin callers can request the COMBINED set (active +
// soft-deleted) — the public read endpoint deliberately does NOT
// expose this knob.
//
// `onlyDeleted` (P7.T4) is the "recycle bin" filter. When true the
// list returns ONLY soft-deleted rows; the regular `deleted_at IS
// NULL` predicate is inverted. Mutually exclusive with
// `includeDeleted=true` semantically (you either want everything or
// just the deleted slice), but we don't enforce that at the schema
// level — the repository picks `onlyDeleted` first, then
// `includeDeleted`. Route layer exposes `onlyDeleted` so the
// frontend recycle-bin page can query without extra ceremony.

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
    onlyDeleted: z.coerce.boolean().default(false),
  })
  .strict();

export type ListMediaInput = z.infer<typeof listMediaOptionsSchema>;
