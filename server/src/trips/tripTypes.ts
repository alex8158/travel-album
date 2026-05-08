// Trip domain types (P1.T2).
//
// `Trip`               — public, camelCase shape returned by TripService.
//                        deletedAt is included so admin / restore flows
//                        can see soft-deletion state; default queries
//                        in TripService never expose deleted rows.
// `TripCreateData`     — TripRepository.create() input (camelCase).
//                        TripService is responsible for filling id +
//                        timestamps before calling.
// `TripUpdateData`     — TripRepository.update() input. Every field is
//                        optional; only the keys that are present get
//                        written. The repository refreshes updated_at
//                        regardless.
// `ListTripsOptions`   — limit / offset (pagination kept simple in
//                        the first version) and an opt-in to include
//                        soft-deleted rows for restore views.
//
// `TripRow` (internal) — the raw row shape better-sqlite3 hands back
//                        from a SELECT against the trips table. Lives
//                        in tripRepository.ts because nobody outside
//                        the repository should depend on it.

export interface Trip {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly destination: string | null;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly coverMediaId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

export interface TripCreateData {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly destination: string | null;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly coverMediaId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Partial update payload. A key being absent means "do not touch this
 * column"; passing a string sets it. Null clearing is intentionally not
 * supported in the first version — see tripSchemas.ts.
 */
export interface TripUpdateData {
  title?: string | undefined;
  description?: string | undefined;
  destination?: string | undefined;
  startDate?: string | undefined;
  endDate?: string | undefined;
  coverMediaId?: string | undefined;
}

export interface ListTripsOptions {
  /** Max rows to return. Default 50, hard-capped at 200 in the schema. */
  readonly limit?: number | undefined;
  /** Rows to skip. Default 0. */
  readonly offset?: number | undefined;
  /**
   * When true, include rows whose deleted_at is not null. Default false.
   * Reserved for future restore / recycle-bin views.
   */
  readonly includeDeleted?: boolean | undefined;
}
