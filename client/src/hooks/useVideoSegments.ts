// useVideoSegments hook (P9.T9).
//
// Single-resource counterpart for the video segments page. Mirrors
// `useMediaDetail`'s shape:
//   * AbortController on unmount / id change / refetch — React 18
//     strict-mode double mounts and rapid navigation can't race.
//   * Stale-while-revalidate on `refetch()` of the same mediaId:
//     previous `data` stays visible while a new fetch is in flight
//     so the page doesn't blank out.
//   * Switching to a different mediaId clears `data` (no flashing
//     the wrong media's segments).
//   * Passing `undefined` for mediaId short-circuits to the "no data
//     / not loading" state without firing a request.

import { useCallback, useEffect, useRef, useState } from "react";

import { fetchVideoSegments, type ListVideoSegmentsResponse } from "../api/video";

export interface UseVideoSegmentsResult {
  readonly data: ListVideoSegmentsResponse | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refetch: () => void;
}

export function useVideoSegments(mediaId: string | undefined): UseVideoSegmentsResult {
  const [data, setData] = useState<ListVideoSegmentsResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(mediaId !== undefined);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const previousIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (mediaId === undefined) {
      setData(null);
      setLoading(false);
      setError(null);
      previousIdRef.current = undefined;
      return;
    }

    const isDifferentId = previousIdRef.current !== mediaId;
    previousIdRef.current = mediaId;

    const controller = new AbortController();
    if (isDifferentId) setData(null);
    setLoading(true);
    setError(null);

    fetchVideoSegments(mediaId, controller.signal)
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
  }, [mediaId, reloadTick]);

  const refetch = useCallback(() => {
    setReloadTick((n) => n + 1);
  }, []);

  return { data, loading, error, refetch };
}
