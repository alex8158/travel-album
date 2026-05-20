// useMediaVersions hook (P8.T5).
//
// Wraps `GET /api/media/:id/versions`. Returns the same shape every
// other resource hook uses (`{ data, loading, error, refetch }`)
// so the MediaDetailPage's Enhancement section can branch on the
// usual loading / error / loaded states.
//
// Lifecycle parallel to `useMediaDetail`:
//   * Aborts the in-flight request on unmount, id change, or refetch
//     so React 18 strict-mode double-mounts and rapid navigation
//     cannot race past each other.
//   * Passing `undefined` for id short-circuits into the
//     "no data / not loading" state without firing a request.
//   * Switching to a different id clears the previous data so a
//     stale media's version list doesn't flash before the new
//     fetch completes.
//   * Same-id refetches keep the previous data visible while the
//     new fetch is in flight (stale-while-revalidate).

import { useCallback, useEffect, useRef, useState } from "react";

import { fetchMediaVersions, type MediaVersionsView } from "../api/media";

export interface UseMediaVersionsResult {
  readonly data: MediaVersionsView | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refetch: () => void;
}

export function useMediaVersions(id: string | undefined): UseMediaVersionsResult {
  const [data, setData] = useState<MediaVersionsView | null>(null);
  const [loading, setLoading] = useState<boolean>(id !== undefined);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const previousIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (id === undefined) {
      setData(null);
      setLoading(false);
      setError(null);
      previousIdRef.current = undefined;
      return;
    }

    const isDifferentId = previousIdRef.current !== id;
    previousIdRef.current = id;

    const controller = new AbortController();
    if (isDifferentId) setData(null);
    setLoading(true);
    setError(null);

    fetchMediaVersions(id, controller.signal)
      .then((d) => {
        if (controller.signal.aborted) return;
        setData(d);
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

  return { data, loading, error, refetch };
}
