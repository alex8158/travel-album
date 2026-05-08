// TripService: business rules + validation on top of TripRepository
// (P1.T2).
//
// Every public method takes `unknown` input so the surrounding code
// (route handlers, smoke scripts) cannot accidentally bypass the zod
// pass. Successful returns are always the public Trip shape; failures
// always raise an AppError subclass so the global error handler from
// P0.T6 can render a unified response without per-route try/catch.
//
// Service responsibilities:
//   1. zod-validate every input.
//   2. Generate the trip id (UUID v4) and the timestamps.
//   3. Translate repository nulls / falses into AppError.
//   4. Translate SQLite CHECK violations into ValidationError so cross-
//      field DB constraints (date order applied to the patched row)
//      surface to clients with the same vocabulary as zod issues.

import { randomUUID } from "node:crypto";

import { NotFoundError, ValidationError } from "../errors/AppError.js";
import { parseOrThrow } from "../util/zodParse.js";
import { TripRepository } from "./tripRepository.js";
import {
  createTripSchema,
  entityIdSchema,
  listTripsOptionsSchema,
  updateTripSchema,
} from "./tripSchemas.js";
import type { Trip, TripUpdateData } from "./tripTypes.js";

export class TripService {
  constructor(private readonly repo: TripRepository) {}

  createTrip(input: unknown): Trip {
    const data = parseOrThrow(createTripSchema, input);
    const id = randomUUID();
    const now = nowIso();
    return this.repo.create({
      id,
      title: data.title,
      description: data.description ?? null,
      destination: data.destination ?? null,
      startDate: data.startDate ?? null,
      endDate: data.endDate ?? null,
      coverMediaId: data.coverMediaId ?? null,
      createdAt: now,
      updatedAt: now,
    });
  }

  listTrips(options: unknown = {}): Trip[] {
    const opts = parseOrThrow(listTripsOptionsSchema, options);
    return this.repo.list(opts);
  }

  getTripById(id: unknown): Trip {
    const safeId = parseOrThrow(entityIdSchema, id);
    const trip = this.repo.findById(safeId);
    if (!trip) {
      throw new NotFoundError(`Trip not found: ${safeId}`, { id: safeId });
    }
    return trip;
  }

  updateTrip(id: unknown, patch: unknown): Trip {
    const safeId = parseOrThrow(entityIdSchema, id);
    const safePatch = parseOrThrow(updateTripSchema, patch);

    const dbPatch: TripUpdateData = {};
    if (safePatch.title !== undefined) dbPatch.title = safePatch.title;
    if (safePatch.description !== undefined) dbPatch.description = safePatch.description;
    if (safePatch.destination !== undefined) dbPatch.destination = safePatch.destination;
    if (safePatch.startDate !== undefined) dbPatch.startDate = safePatch.startDate;
    if (safePatch.endDate !== undefined) dbPatch.endDate = safePatch.endDate;
    if (safePatch.coverMediaId !== undefined) dbPatch.coverMediaId = safePatch.coverMediaId;

    let updated: Trip | null;
    try {
      updated = this.repo.update(safeId, dbPatch, nowIso());
    } catch (err) {
      // Translate SQLite CHECK / NOT NULL failures into ValidationError so
      // partial updates that flip the date order (only one of start/end
      // patched) reach the client with the same shape as zod issues.
      throw translateDbConstraintError(err);
    }

    if (!updated) {
      throw new NotFoundError(`Trip not found: ${safeId}`, { id: safeId });
    }
    return updated;
  }

  softDeleteTrip(id: unknown): void {
    const safeId = parseOrThrow(entityIdSchema, id);
    const ok = this.repo.softDelete(safeId, nowIso());
    if (!ok) {
      throw new NotFoundError(`Trip not found: ${safeId}`, { id: safeId });
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function translateDbConstraintError(err: unknown): unknown {
  if (
    err instanceof Error &&
    /CHECK constraint failed|NOT NULL constraint failed/.test(err.message)
  ) {
    return new ValidationError("Validation failed at database layer", {
      cause: err.message,
    });
  }
  return err;
}
