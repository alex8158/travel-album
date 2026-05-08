// useTrips hook (P1.T4 + P1.T7 follow-up: refetch).
//
// Fires on mount and on every subsequent `refetch()` call. Reports
// `loading` / `error` / `trips` as a three-state result plus a stable
// `refetch` function (useCallback). Aborts the in-flight request on
// unmount, refetch, or strict-mode double mount so React 18 does not
// race with itself.
//
// Refetch behaviour mirrors useTrip:
//   - We do NOT reset `trips` to null while a refresh is in flight,
//     so the list stays visible during background revalidation.
//   - All in-flight requests are cancelled when a new one starts.

import { useCallback, useEffect, useState } from "react";
import { fetchTrips, type Trip } from "../api/trips";

export interface UseTripsResult {
  readonly trips: Trip[] | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refetch: () => void;
}

export function useTrips(): UseTripsResult {
  const [trips, setTrips] = useState<Trip[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetchTrips(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setTrips(data);
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
  }, [reloadTick]);

  const refetch = useCallback(() => {
    setReloadTick((n) => n + 1);
  }, []);

  return { trips, loading, error, refetch };
}
