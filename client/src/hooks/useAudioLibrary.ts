// useAudioLibrary hook (P11.T7).
//
// Mirrors the shape of useJobs / useTrips: fires on mount + every
// refetch(); reports `items` / `loading` / `error` / `refetch`.
// Aborts the in-flight request on unmount / refetch / strict-mode
// double-mount to avoid setState-after-unmount warnings.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listAudioLibrary,
  type AudioLibraryItem,
  type ListAudioLibraryOptions,
} from "../api/audioLibrary";

export interface UseAudioLibraryResult {
  readonly items: AudioLibraryItem[] | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refetch: () => void;
}

export function useAudioLibrary(options: ListAudioLibraryOptions = {}): UseAudioLibraryResult {
  const [items, setItems] = useState<AudioLibraryItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  // Serialise the filter so changing reference-identical values
  // doesn't cause refetches; mirrors useJobs convention.
  const filterKey = useMemo(
    () =>
      JSON.stringify({
        sourceType: options.sourceType ?? null,
        includeInactive: options.includeInactive ?? null,
      }),
    [options.sourceType, options.includeInactive],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    listAudioLibrary(options, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setItems(data);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, reloadTick]);

  const refetch = useCallback(() => {
    setReloadTick((n) => n + 1);
  }, []);

  return { items, loading, error, refetch };
}
