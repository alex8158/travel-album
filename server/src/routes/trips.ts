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
import { asyncHandler } from "../middleware/asyncHandler.js";
import { entityIdSchema, type TripService } from "../trips/index.js";
import { parseOrThrow } from "../util/zodParse.js";

export interface TripsRouterDeps {
  readonly service: TripService;
}

const setCoverBodySchema = z
  .object({
    coverMediaId: entityIdSchema,
  })
  .strict();

export function makeTripsRouter(deps: TripsRouterDeps): Router {
  const router = Router();
  const { service } = deps;

  // POST /api/trips — create
  router.post(
    "/",
    asyncHandler((req, res) => {
      const trip = service.createTrip(req.body);
      res.status(201).json({ trip });
    }),
  );

  // GET /api/trips — list (default deleted_at IS NULL)
  router.get(
    "/",
    asyncHandler((req, res) => {
      const trips = service.listTrips(req.query);
      res.json({ trips });
    }),
  );

  // GET /api/trips/:id — read one
  router.get(
    "/:id",
    asyncHandler((req, res) => {
      const trip = service.getTripById(getIdParam(req.params));
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

  // POST /api/trips/:id/cover — set the cover_media_id (format-only check)
  router.post(
    "/:id/cover",
    asyncHandler((req, res) => {
      const body = parseOrThrow(setCoverBodySchema, req.body, "cover request body");
      const trip = service.updateTrip(getIdParam(req.params), {
        coverMediaId: body.coverMediaId,
      });
      res.json({ trip });
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
