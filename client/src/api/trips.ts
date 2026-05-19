// Trip API client (P1.T4).
//
// Mirrors the server's Trip shape from server/src/trips/tripTypes.ts.
// Currently kept in sync by hand; an auto-generated client (e.g. via
// openapi-typescript) is a later concern. fetchTrips reads `/api/trips`
// over a same-origin path — the Vite dev server proxies the prefix to
// the backend, and a same-origin production deployment serves the API
// from the same root.

export interface Trip {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly destination: string | null;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly coverMediaId: string | null;
  /**
   * P6.T7 — `true` when the cover was pinned by a user action
   * (POST /api/trips/:id/cover). The server's auto-cover selector
   * refuses to overwrite a user-pinned cover. Optional on the wire
   * because older cached responses pre-date the flag.
   */
  readonly coverSetByUser?: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  /**
   * Derived response-layer field (P3.T8). Present on GET /api/trips
   * and GET /api/trips/:id responses only; POST / PATCH / DELETE
   * responses do NOT carry it (server contract). Always a string when
   * present: a `/storage/<path>` URL when a cover can be derived, or
   * the static placeholder (`/placeholder-cover.svg`) otherwise.
   *
   * Optional in the type because the same `Trip` shape is used by the
   * mutation endpoints' responses too.
   */
  readonly coverUrl?: string;
}

interface ListTripsResponse {
  trips: Trip[];
}

interface SingleTripResponse {
  trip: Trip;
}

interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId?: string;
    details?: unknown;
  };
}

/**
 * Body shape accepted by POST /api/trips. Mirrors the server's
 * createTripSchema (server/src/trips/tripSchemas.ts). All optional
 * fields stay optional here so callers can omit them; supply
 * "YYYY-MM-DD" for dates.
 */
export interface CreateTripInput {
  readonly title: string;
  readonly description?: string;
  readonly destination?: string;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly coverMediaId?: string;
}

/**
 * Body shape accepted by PATCH /api/trips/:id. The server requires at
 * least one field; an empty body returns 400. Title can be present
 * but must still be non-blank when sent.
 */
export type UpdateTripInput = Partial<CreateTripInput>;

/**
 * Fetch the active Trip list from the backend.
 *
 * Pagination defaults to limit=50 / offset=0 server-side; the page
 * does not expose query controls yet (P1.T4 scope).
 */
export async function fetchTrips(signal?: AbortSignal): Promise<Trip[]> {
  const init: RequestInit = {
    headers: { Accept: "application/json" },
  };
  if (signal) init.signal = signal;

  const res = await fetch("/api/trips", init);

  if (!res.ok) {
    const message = await readErrorMessage(res);
    throw new Error(message);
  }
  const body = (await res.json()) as ListTripsResponse;
  return body.trips;
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const envelope = (await res.json()) as ApiErrorEnvelope | null;
    if (envelope?.error?.message) return envelope.error.message;
  } catch {
    // Non-JSON error body; fall through.
  }
  return `HTTP ${res.status}`;
}

/**
 * Create a new trip. Throws on any non-2xx response with the message
 * lifted from the unified error envelope when available.
 */
export async function createTrip(input: CreateTripInput): Promise<Trip> {
  const res = await fetch("/api/trips", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  const body = (await res.json()) as SingleTripResponse;
  return body.trip;
}

/**
 * Fetch a single trip by id. Throws when the trip does not exist
 * (the server returns 404 for soft-deleted rows too) or when the id
 * is malformed (server returns 400). Pass an AbortSignal to allow the
 * caller (e.g. useTrip on unmount) to cancel the request.
 */
export async function getTripById(id: string, signal?: AbortSignal): Promise<Trip> {
  const init: RequestInit = { headers: { Accept: "application/json" } };
  if (signal) init.signal = signal;

  const res = await fetch(`/api/trips/${encodeURIComponent(id)}`, init);
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  const body = (await res.json()) as SingleTripResponse;
  return body.trip;
}

/**
 * Patch an existing trip with the given partial fields. The server
 * rejects empty bodies with 400, so callers must pass at least one
 * field. Refreshed `updatedAt` is returned in the response trip.
 */
export async function updateTrip(id: string, patch: UpdateTripInput): Promise<Trip> {
  const res = await fetch(`/api/trips/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  const body = (await res.json()) as SingleTripResponse;
  return body.trip;
}

/**
 * P6.T7 — pin a media as the trip's cover (POST /api/trips/:id/cover).
 * Server flips `cover_set_by_user = true` so the auto-cover selector
 * after Quality_Selector refuses to overwrite this pin.
 */
export async function setTripCover(tripId: string, coverMediaId: string): Promise<Trip> {
  const res = await fetch(`/api/trips/${encodeURIComponent(tripId)}/cover`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ coverMediaId }),
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  const body = (await res.json()) as SingleTripResponse;
  return body.trip;
}

/**
 * P6.T7 — release the user pin and immediately recompute the auto
 * cover. The server's response is `{ trip, outcome }`; we return the
 * trip and surface the outcome status as a tagged enum so callers
 * can distinguish "we picked a new cover" from "no eligible
 * candidate" etc.
 */
export interface ResetTripCoverResult {
  readonly trip: Trip;
  readonly outcomeStatus:
    | "applied"
    | "unchanged"
    | "skipped-user-pinned"
    | "skipped-no-candidate"
    | "missing-trip";
}

export async function resetTripCover(tripId: string): Promise<ResetTripCoverResult> {
  const res = await fetch(`/api/trips/${encodeURIComponent(tripId)}/cover/reset`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  const body = (await res.json()) as {
    trip: Trip;
    outcome: { status: ResetTripCoverResult["outcomeStatus"] };
  };
  return { trip: body.trip, outcomeStatus: body.outcome.status };
}

/**
 * Soft-delete a trip. The server marks `deleted_at` and returns
 * `{ deleted: true }`; we discard the body. The trip remains in the
 * database (recoverable) but disappears from default list / detail
 * queries — design.md §4.3, CLAUDE.md §2.4.
 */
export async function deleteTrip(id: string): Promise<void> {
  const res = await fetch(`/api/trips/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
}
