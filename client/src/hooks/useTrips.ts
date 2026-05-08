// useTrips hook (P1.T4).
//
// Fires once on mount, reports `loading` / `error` / `trips` as a
// three-state result. Aborts the in-flight request on unmount so a
// strict-mode double-mount does not race with itself.

import { useEffect, useState } from "react";
import { fetchTrips, type Trip } from "../api/trips";

export interface UseTripsResult {
  readonly trips: Trip[] | null;
  readonly loading: boolean;
  readonly error: string | null;
}

export function useTrips(): UseTripsResult {
  const [trips, setTrips] = useState<Trip[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetchTrips(controller.signal)
      .then((data) => {
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
  }, []);

  return { trips, loading, error };
}
