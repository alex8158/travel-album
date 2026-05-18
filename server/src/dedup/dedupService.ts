// DedupService — domain layer behind the public Dedup API (P5.T5).
//
// Responsibilities:
//   * Validate path params and request bodies via shared `parseOrThrow`
//     (zod → ValidationError → 400) so the HTTP layer is a thin
//     pass-through.
//   * Verify the trip exists / is not soft-deleted by delegating to
//     `TripService.getTripById` — same convention as
//     `MediaService.listMediaForTrip`. Missing / soft-deleted →
//     NotFoundError (404).
//   * Bind every dedup invocation to a single `tripId` from the URL
//     path. The body has NO trip / media selectors; there is no
//     supported way for a client to escape per-trip scope.
//   * Call the appropriate DedupEngine method and re-shape the
//     result into a stable on-the-wire envelope (adds the
//     `groupType` discriminator + a `cohortsSkippedByReason`
//     aggregate count next to the existing detailed list).
//
// What this service does NOT do:
//   * Recompute quality scores / pick keeper images (P6.T5).
//   * Mutate user-confirmed groups (CLAUDE.md §3.9 — engines never
//     overwrite user decisions; this service is just the adapter).
//   * Schedule async dedup jobs — execution is synchronous from the
//     HTTP perspective. Per-trip scan is < 100 ms at V1 sizes so a
//     synchronous response is honest about the result.

import { entityIdSchema, type TripService } from "../trips/index.js";
import { parseOrThrow } from "../util/zodParse.js";

import type { DedupEngine, RunExactResult, RunSimilarResult } from "./dedupEngine.js";
import { dedupRunBodySchema, dedupSimilarBodySchema } from "./dedupSchemas.js";

/**
 * Result envelope for `POST /api/trips/:tripId/dedup/exact`. The
 * `groupType` field discriminates the union with the similar variant
 * and lets clients route on a single field. Counters mirror
 * `RunExactResult` plus an aggregated skip-reason count for log /
 * UI convenience.
 */
export interface DedupExactApiResult extends RunExactResult {
  readonly groupType: "exact";
  /** Aggregated skip count keyed by reason — easy for UIs to render. */
  readonly cohortsSkippedByReason: Readonly<Record<string, number>>;
}

/**
 * Result envelope for `POST /api/trips/:tripId/dedup/similar`.
 */
export interface DedupSimilarApiResult extends RunSimilarResult {
  readonly groupType: "similar";
  readonly cohortsSkippedByReason: Readonly<Record<string, number>>;
}

/**
 * Result envelope for `POST /api/trips/:tripId/dedup/run` — two
 * sub-results, ordered: exact then similar. The order is meaningful
 * because P5.T4 protection skips any cohort whose members already
 * belong to an exact group (created in the preceding step).
 */
export interface DedupRunApiResult {
  readonly tripId: string;
  readonly exact: DedupExactApiResult;
  readonly similar: DedupSimilarApiResult;
}

export class DedupService {
  constructor(
    private readonly engine: DedupEngine,
    private readonly tripService: TripService,
  ) {}

  /** POST /api/trips/:tripId/dedup/exact */
  runExact(tripIdInput: unknown): DedupExactApiResult {
    const tripId = this.resolveTripId(tripIdInput);
    const r = this.engine.runExactForTrip(tripId);
    return {
      ...r,
      groupType: "exact",
      cohortsSkippedByReason: aggregateBy(r.cohortsSkipped, (c) => c.reason),
    };
  }

  /** POST /api/trips/:tripId/dedup/similar (body: { hammingThreshold? }) */
  runSimilar(tripIdInput: unknown, bodyInput: unknown): DedupSimilarApiResult {
    const tripId = this.resolveTripId(tripIdInput);
    const body = parseOrThrow(dedupSimilarBodySchema, bodyInput ?? {}, "request body");
    const r = this.engine.runSimilarForTrip(
      tripId,
      body.hammingThreshold !== undefined ? { hammingThreshold: body.hammingThreshold } : {},
    );
    return {
      ...r,
      groupType: "similar",
      cohortsSkippedByReason: aggregateBy(r.cohortsSkipped, (c) => c.reason),
    };
  }

  /**
   * POST /api/trips/:tripId/dedup/run — runs exact, then similar.
   *
   * Order matters: `runSimilarForTrip` reads the existing group set
   * before clustering, so any exact group created in this call is
   * automatically protected (member overlap → skip). That preserves
   * the design.md §7.3 #4 "exact 优先" invariant end-to-end across a
   * single HTTP request.
   */
  runAll(tripIdInput: unknown, bodyInput: unknown): DedupRunApiResult {
    const tripId = this.resolveTripId(tripIdInput);
    const body = parseOrThrow(dedupRunBodySchema, bodyInput ?? {}, "request body");
    const exactResult = this.engine.runExactForTrip(tripId);
    const similarResult = this.engine.runSimilarForTrip(
      tripId,
      body.hammingThreshold !== undefined ? { hammingThreshold: body.hammingThreshold } : {},
    );
    return {
      tripId,
      exact: {
        ...exactResult,
        groupType: "exact",
        cohortsSkippedByReason: aggregateBy(exactResult.cohortsSkipped, (c) => c.reason),
      },
      similar: {
        ...similarResult,
        groupType: "similar",
        cohortsSkippedByReason: aggregateBy(similarResult.cohortsSkipped, (c) => c.reason),
      },
    };
  }

  /**
   * Validate the path param and surface 404 if the trip is missing
   * or soft-deleted. Reuses TripService.getTripById so the message
   * and error code match the standard `GET /api/trips/:id` 404.
   */
  private resolveTripId(tripIdInput: unknown): string {
    const tripId = parseOrThrow(entityIdSchema, tripIdInput, "tripId");
    this.tripService.getTripById(tripId);
    return tripId;
  }
}

function aggregateBy<T, K extends string>(
  items: readonly T[],
  keyOf: (item: T) => K,
): Record<K, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const key = keyOf(item);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out as Record<K, number>;
}
