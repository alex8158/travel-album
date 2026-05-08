// useTrip hook (P1.T6 + follow-up: explicit refetch).
//
// Single-resource counterpart to useTrips. Fetches GET /api/trips/:id
// and returns a four-field result ({ trip, loading, error, refetch }).
// Aborts the in-flight request on unmount, id change, or refetch so
// React 18 strict-mode double mounts and rapid navigation do not race.
//
// Pass `undefined` for the id (e.g. when the URL param is missing) to
// short-circuit into the "no trip / not loading" state without firing
// a request. The caller decides whether that should render an error.
//
// Refetch behaviour:
//   - `refetch()` bumps an internal counter that is part of the effect
//     deps; the effect re-fires and a fresh GET goes out.
//   - On an id change the previous `trip` is cleared so a different
//     trip's stale data does not flash. On a same-id refetch we keep
//     the previous `trip` visible and only flip `loading` (a small
//     stale-while-revalidate so the page does not blank out).
//   - The returned `refetch` is wrapped in useCallback for a stable
//     identity, so callers can safely list it in their own effect deps.

import { useCallback, useEffect, useRef, useState } from "react";
import { getTripById, type Trip } from "../api/trips";

export interface UseTripResult {
  readonly trip: Trip | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refetch: () => void;
}

export function useTrip(id: string | undefined): UseTripResult {
  const [trip, setTrip] = useState<Trip | null>(null);
  const [loading, setLoading] = useState<boolean>(id !== undefined);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  // Track the id the previous effect run saw so we can distinguish
  // "navigated to a different trip" (where we want to clear the
  // previous data) from "refetch of the same trip" (where we keep it).
  const previousIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (id === undefined) {
      setTrip(null);
      setLoading(false);
      setError(null);
      previousIdRef.current = undefined;
      return;
    }

    const isDifferentId = previousIdRef.current !== id;
    previousIdRef.current = id;

    const controller = new AbortController();
    if (isDifferentId) {
      setTrip(null);
    }
    setLoading(true);
    setError(null);

    getTripById(id, controller.signal)
      .then((t) => {
        if (controller.signal.aborted) return;
        setTrip(t);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [id, reloadTick]);

  const refetch = useCallback(() => {
    setReloadTick((n) => n + 1);
  }, []);

  return { trip, loading, error, refetch };
}
