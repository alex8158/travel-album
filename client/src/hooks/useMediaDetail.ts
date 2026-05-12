// useMediaDetail hook (P3.T6).
//
// Single-resource counterpart for the media detail page. Fetches
// GET /api/media/:id and returns `{ detail, loading, error, refetch }`.
// Mirrors useTrip's contract — AbortController on unmount / id change
// / refetch so React 18 strict-mode double mounts and rapid
// navigation cannot race.
//
// Passing `undefined` for the id short-circuits into the "no detail /
// not loading" state without firing a request. The caller (e.g. a
// route component reading `useParams<{id: string}>()`) decides
// whether that should render an error.
//
// Stale-while-revalidate: on a refetch of the same id the previous
// `detail` stays visible while the new fetch is in flight, so the
// page does not blank out. Switching to a different id clears the
// previous detail (no risk of flashing the wrong media).

import { useCallback, useEffect, useRef, useState } from "react";

import { fetchMediaDetail, type MediaDetail } from "../api/media";

export interface UseMediaDetailResult {
  readonly detail: MediaDetail | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refetch: () => void;
}

export function useMediaDetail(id: string | undefined): UseMediaDetailResult {
  const [detail, setDetail] = useState<MediaDetail | null>(null);
  const [loading, setLoading] = useState<boolean>(id !== undefined);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const previousIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (id === undefined) {
      setDetail(null);
      setLoading(false);
      setError(null);
      previousIdRef.current = undefined;
      return;
    }

    const isDifferentId = previousIdRef.current !== id;
    previousIdRef.current = id;

    const controller = new AbortController();
    if (isDifferentId) setDetail(null);
    setLoading(true);
    setError(null);

    fetchMediaDetail(id, controller.signal)
      .then((d) => {
        if (controller.signal.aborted) return;
        setDetail(d);
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

  return { detail, loading, error, refetch };
}
