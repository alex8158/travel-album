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
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

interface ListTripsResponse {
  trips: Trip[];
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
