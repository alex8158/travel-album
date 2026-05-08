// Zod input schemas for the Trip domain (P1.T2).
//
// Three independent layers of validation cooperate:
//   1. THIS file (zod) — first line of defence on every public Service
//      call. Catches malformed types, regex mismatches, calendar errors,
//      and the start/end date ordering rule when both are supplied.
//   2. The trips DB schema (server/migrations/001_create_trips.sql) —
//      catches violations that slip through the application layer
//      (e.g. partial date updates that flip the order). The repository
//      surfaces these as zod-style errors translated by the service.
//   3. The storage layer's pathUtils (server/src/storage/pathUtils.ts)
//      — once the trip id is used as a directory name, an even
//      stricter pass runs there. The id pattern below is intentionally
//      identical to that pass so an id that survives the service is
//      guaranteed to survive storage too.

import { z } from "zod";

/** Same regex used by the storage layer for tripId / mediaId. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** YYYY-MM-DD with capture groups for the calendar-validity check. */
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_DESTINATION_LENGTH = 200;

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/**
 * Round-trip a YYYY-MM-DD string through `Date.UTC` so that calendar
 * impossibilities (e.g. 2024-02-30, 2025-13-01) are rejected. JS's
 * `Date` constructor silently rolls those over otherwise.
 */
function isValidISODate(s: string): boolean {
  const m = ISO_DATE_PATTERN.exec(s);
  if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) {
    return false;
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** Used for both trip id and cover_media_id (any reference to an entity id). */
export const entityIdSchema = z
  .string()
  .regex(ID_PATTERN, "id must match /^[A-Za-z0-9_-]{1,128}$/");

export const isoDateSchema = z
  .string()
  .regex(ISO_DATE_PATTERN, "expected YYYY-MM-DD")
  .refine(isValidISODate, "invalid calendar date");

const titleSchema = z
  .string()
  .transform((s) => s.trim())
  .pipe(
    z
      .string()
      .min(1, "title must not be blank")
      .max(MAX_TITLE_LENGTH, `title must be ≤ ${MAX_TITLE_LENGTH} chars`),
  );

const descriptionSchema = z
  .string()
  .max(MAX_DESCRIPTION_LENGTH, `description must be ≤ ${MAX_DESCRIPTION_LENGTH} chars`);

const destinationSchema = z
  .string()
  .max(MAX_DESTINATION_LENGTH, `destination must be ≤ ${MAX_DESTINATION_LENGTH} chars`);

function dateOrderRefine(
  v: { startDate?: string | undefined; endDate?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (typeof v.startDate === "string" && typeof v.endDate === "string" && v.endDate < v.startDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endDate"],
      message: "endDate must be greater than or equal to startDate",
    });
  }
}

const baseTripFields = {
  title: titleSchema,
  description: descriptionSchema.optional(),
  destination: destinationSchema.optional(),
  startDate: isoDateSchema.optional(),
  endDate: isoDateSchema.optional(),
  coverMediaId: entityIdSchema.optional(),
} as const;

export const createTripSchema = z.object(baseTripFields).strict().superRefine(dateOrderRefine);

export const updateTripSchema = z
  .object(baseTripFields)
  .strict()
  .partial()
  .superRefine(dateOrderRefine);

export const listTripsOptionsSchema = z
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

export type CreateTripInput = z.infer<typeof createTripSchema>;
export type UpdateTripInput = z.infer<typeof updateTripSchema>;
export type ListTripsInput = z.infer<typeof listTripsOptionsSchema>;
