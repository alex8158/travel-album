// useDuplicateGroupDetail hook (P5.T6).
//
// Fetches GET /api/duplicate-groups/:id and returns
// { group, loading, error, refetch }. Aborts in-flight requests on
// unmount / id change / refetch.

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchDuplicateGroupById, type DuplicateGroupView } from "../api/dedup";

export interface UseDuplicateGroupDetailResult {
  readonly group: DuplicateGroupView | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refetch: () => void;
}

export function useDuplicateGroupDetail(id: string | undefined): UseDuplicateGroupDetailResult {
  const [group, setGroup] = useState<DuplicateGroupView | null>(null);
  const [loading, setLoading] = useState<boolean>(id !== undefined);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const previousIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (id === undefined) {
      setGroup(null);
      setLoading(false);
      setError(null);
      previousIdRef.current = undefined;
      return;
    }
    const differentId = previousIdRef.current !== id;
    previousIdRef.current = id;
    const controller = new AbortController();
    if (differentId) setGroup(null);
    setLoading(true);
    setError(null);
    fetchDuplicateGroupById(id, controller.signal)
      .then((g) => {
        if (controller.signal.aborted) return;
        setGroup(g);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => controller.abort();
  }, [id, reloadTick]);

  const refetch = useCallback(() => {
    setReloadTick((n) => n + 1);
  }, []);

  return { group, loading, error, refetch };
}
