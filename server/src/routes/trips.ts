// Trip API routes (P1.T3).
//
// Mounted at /api/trips. The router is intentionally thin:
//   - id parameters and PATCH "non-empty body" rules are checked here
//     because they are HTTP-shape concerns;
//   - everything else (per-field validation, business rules,
//     date-order, NOT_FOUND translation) is delegated to TripService
//     so non-HTTP callers (CLI, future workers) get the same checks.
//
// All handlers go through asyncHandler so a thrown AppError — whether
// raised here, in TripService, or in TripRepository — flows into the
// global error middleware (P0.T6) and renders as the project-standard
// `{ error: { code, message, requestId, ... } }` envelope.

import { Router } from "express";
import { z } from "zod";

import { ValidationError } from "../errors/AppError.js";
import type { Logger } from "../logger.js";
import type { MediaRepository } from "../media/index.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import {
  autoSelectCoverForTrip,
  deriveCoverUrl,
  entityIdSchema,
  type Trip,
  type TripRepository,
  type TripService,
} from "../trips/index.js";
import { parseOrThrow } from "../util/zodParse.js";

export interface TripsRouterDeps {
  readonly service: TripService;
  /**
   * Needed by `deriveCoverUrl` (P3.T8) to look up the pinned cover
   * media's thumbnail and to find the oldest thumbnailed image in
   * the trip when no pin is set + P6.T7 `findBestCoverCandidate`.
   * Read-only from the route layer.
   */
  readonly mediaRepo: MediaRepository;
  /**
   * P6.T7 — `autoSelectCoverForTrip` works against the trip
   * repository directly (read trip + write cover), bypassing the
   * Service's zod-input layer. Service does not own a TripRepository
   * field publicly, so the route is wired with a separate
   * TripRepository handle.
   */
  readonly tripRepo: TripRepository;
  readonly logger: Logger;
}

const setCoverBodySchema = z
  .object({
    coverMediaId: entityIdSchema,
  })
  .strict();

/**
 * Route-level query schema for GET /api/trips. Stricter than the
 * Service-level `listTripsOptionsSchema` (which caps limit at 200) —
 * the public HTTP surface holds page sizes to 1..100 to keep responses
 * predictable. Unknown query keys are silently dropped (default zod
 * `strip`) so future cache-busters / instrumentation params don't
 * trigger 400s here.
 */
const listQuerySchema = z.object({
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

export function makeTripsRouter(deps: TripsRouterDeps): Router {
  const router = Router();
  const { service, mediaRepo, tripRepo, logger } = deps;

  // P3.T8: shallow response wrapper that adds the derived `coverUrl`
  // field to a trip object. POST / PATCH / DELETE / cover responses
  // intentionally do NOT use this — only the two GET endpoints carry
  // `coverUrl`, per the P3.T8 user spec. Client consumers handle the
  // optional field accordingly.
  function withCoverUrl(trip: Trip): Trip & { coverUrl: string } {
    return { ...trip, coverUrl: deriveCoverUrl(trip, mediaRepo) };
  }

  // POST /api/trips — create
  router.post(
    "/",
    asyncHandler((req, res) => {
      const trip = service.createTrip(req.body);
      res.status(201).json({ trip });
    }),
  );

  // GET /api/trips — list (default deleted_at IS NULL).
  // Pagination is enforced HERE rather than in the Service, so the public
  // HTTP cap (1..100) is independent of the Service contract.
  //
  // P3.T8: each trip is enriched with `coverUrl` derived in the
  // response layer (no DB write).
  router.get(
    "/",
    asyncHandler((req, res) => {
      const query = parseOrThrow(listQuerySchema, req.query, "query parameters");
      const trips = service.listTrips(query).map(withCoverUrl);
      res.json({ trips });
    }),
  );

  // GET /api/trips/:id — read one (P3.T8: enriched with coverUrl).
  router.get(
    "/:id",
    asyncHandler((req, res) => {
      const trip = withCoverUrl(service.getTripById(getIdParam(req.params)));
      res.json({ trip });
    }),
  );

  // PATCH /api/trips/:id — partial update
  router.patch(
    "/:id",
    asyncHandler((req, res) => {
      requireNonEmptyBody(req.body);
      const trip = service.updateTrip(getIdParam(req.params), req.body);
      res.json({ trip });
    }),
  );

  // DELETE /api/trips/:id — soft delete
  router.delete(
    "/:id",
    asyncHandler((req, res) => {
      service.softDeleteTrip(getIdParam(req.params));
      res.json({ deleted: true });
    }),
  );

  // POST /api/trips/:id/cover — user-initiated cover pin.
  // P6.T7: flips `cover_set_by_user = 1` alongside the cover
  // assignment so the auto-cover selector after Quality_Selector
  // skips this trip on its next run. Manual covers via the legacy
  // PATCH /api/trips/:id path (which does NOT flip the flag) are
  // still possible for admin / script callers.
  router.post(
    "/:id/cover",
    asyncHandler((req, res) => {
      const body = parseOrThrow(setCoverBodySchema, req.body, "cover request body");
      const trip = service.setCoverByUser(getIdParam(req.params), body.coverMediaId);
      res.json({ trip });
    }),
  );

  // POST /api/trips/:id/cover/reset — release the user-pin and
  // immediately recompute the auto cover (P6.T7). Composition of two
  // ops:
  //   1. clearUserCoverFlag → sets cover_set_by_user = 0 (still keeps
  //      whatever cover is currently there).
  //   2. autoSelectCoverForTrip → picks the best candidate (highest
  //      quality_score, non-blurry, has thumbnail) and writes it.
  // The response carries the FINAL trip state (post auto-select)
  // plus an `outcome` field describing what the auto-selector did so
  // callers can tell the difference between "we picked a new one",
  // "kept the existing one", and "no eligible candidate".
  router.post(
    "/:id/cover/reset",
    asyncHandler((req, res) => {
      const id = getIdParam(req.params);
      service.clearUserCoverFlag(id);
      const outcome = autoSelectCoverForTrip({ tripRepo, mediaRepo, logger }, id);
      // Re-read so the response shows the post-auto state.
      const trip = service.getTripById(id);
      res.json({ trip, outcome });
    }),
  );

  return router;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Pull `id` out of `req.params` while satisfying noUncheckedIndexedAccess.
 * The route definition guarantees `:id` is present, but TypeScript does not
 * know that — coalesce to "" so the value is always a string. TripService's
 * entityIdSchema rejects "" (regex requires at least one char) so callers
 * still see a clean VALIDATION_FAILED.
 */
function getIdParam(params: Record<string, string | undefined>): string {
  return params.id ?? "";
}

function requireNonEmptyBody(body: unknown): asserts body is Record<string, unknown> {
  if (
    body === null ||
    body === undefined ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body as Record<string, unknown>).length === 0
  ) {
    throw new ValidationError("request body must include at least one field", {
      issues: [{ path: "(root)", message: "empty or non-object body" }],
    });
  }
}
