// useDuplicateGroupsForTrip hook (P5.T6).
//
// Mirrors useTripMedia: fetches GET /api/trips/:tripId/duplicate-groups
// and returns { groups, loading, error, refetch }. Aborts the
// in-flight request on unmount / id change / refetch.

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchDuplicateGroupsForTrip, type DuplicateGroupView } from "../api/dedup";

export interface UseDuplicateGroupsResult {
  readonly groups: readonly DuplicateGroupView[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly refetch: () => void;
}

export function useDuplicateGroupsForTrip(tripId: string | undefined): UseDuplicateGroupsResult {
  const [groups, setGroups] = useState<readonly DuplicateGroupView[]>([]);
  const [loading, setLoading] = useState<boolean>(tripId !== undefined);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const previousTripIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (tripId === undefined) {
      setGroups([]);
      setLoading(false);
      setError(null);
      previousTripIdRef.current = undefined;
      return;
    }

    const differentTrip = previousTripIdRef.current !== tripId;
    previousTripIdRef.current = tripId;

    const controller = new AbortController();
    if (differentTrip) setGroups([]);
    setLoading(true);
    setError(null);

    fetchDuplicateGroupsForTrip(tripId, controller.signal)
      .then((list) => {
        if (controller.signal.aborted) return;
        setGroups(list);
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
  }, [tripId, reloadTick]);

  const refetch = useCallback(() => {
    setReloadTick((n) => n + 1);
  }, []);

  return { groups, loading, error, refetch };
}
