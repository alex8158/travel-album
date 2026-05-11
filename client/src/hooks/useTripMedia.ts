// useTripMedia hook (P2.T7).
//
// Lists active media for a trip via GET /api/trips/:tripId/media. The
// hook returns the same four-field shape as useTrip / useTrips
// ({ media, loading, error, refetch }) so consumers can branch on the
// usual loading / error / empty / loaded states.
//
// Behaviour notes:
//   * Aborts the in-flight request on unmount, tripId change, or
//     refetch — React 18 strict-mode double mounts and rapid trip
//     navigation cannot race past each other.
//   * Passing `undefined` for tripId short-circuits into the
//     "no trip / not loading / empty list" state without firing a
//     request. Callers decide whether that should render an error
//     (e.g. malformed URL) or a placeholder.
//   * On tripId change the previous list is cleared so a stale trip's
//     media does not flash before the new fetch completes. On a
//     same-trip refetch the previous list stays visible while the new
//     fetch is in flight (stale-while-revalidate, matches useTrip).
//   * `limit` is a primitive prop (not an options object) so the
//     effect's dependency array stays primitive-typed and the
//     react-hooks/exhaustive-deps rule has nothing to complain about.
//     Pagination beyond a single page is out of scope for P2.T7; the
//     hook still accepts the prop so a future "load more" UI can
//     bump it without changing the surface.

import { useCallback, useEffect, useRef, useState } from "react";

import { fetchTripMedia, type MediaItem } from "../api/media";

export interface UseTripMediaResult {
  readonly media: readonly MediaItem[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly refetch: () => void;
}

export function useTripMedia(tripId: string | undefined, limit = 100): UseTripMediaResult {
  const [media, setMedia] = useState<readonly MediaItem[]>([]);
  const [loading, setLoading] = useState<boolean>(tripId !== undefined);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const previousTripIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (tripId === undefined) {
      setMedia([]);
      setLoading(false);
      setError(null);
      previousTripIdRef.current = undefined;
      return;
    }

    const isDifferentTrip = previousTripIdRef.current !== tripId;
    previousTripIdRef.current = tripId;

    const controller = new AbortController();
    if (isDifferentTrip) setMedia([]);
    setLoading(true);
    setError(null);

    fetchTripMedia(tripId, { limit }, controller.signal)
      .then((m) => {
        if (controller.signal.aborted) return;
        setMedia(m);
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
  }, [tripId, reloadTick, limit]);

  const refetch = useCallback(() => {
    setReloadTick((n) => n + 1);
  }, []);

  return { media, loading, error, refetch };
}
