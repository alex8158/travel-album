// useJobs hook (P4.T6).
//
// Mirrors the shape of `useTrips`: fires on mount and on every
// subsequent `refetch()` call. Reports `loading` / `error` / `jobs`
// as a three-state result plus a stable `refetch` function. Aborts
// the in-flight request on unmount, refetch, or strict-mode double
// mount.
//
// Re-fires whenever the supplied filter object's serialised form
// changes. Callers pass a stable filter (e.g. memoised) to avoid
// fetching on every render.

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchJobs, type FetchJobsOptions, type JobView } from "../api/jobs";

export interface UseJobsResult {
  readonly jobs: JobView[] | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refetch: () => void;
}

export function useJobs(options: FetchJobsOptions = {}): UseJobsResult {
  const [jobs, setJobs] = useState<JobView[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  // Serialise the filter object so the effect dep array can compare
  // by value, not reference. Stable order keys → stable string for
  // unchanged filters.
  const filterKey = useMemo(() => stableFilterKey(options), [options]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetchJobs(options, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setJobs(data);
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
    // We deliberately depend on the serialised key + reloadTick. The
    // `options` value is read inside the effect; eslint-react-hooks
    // can't see that, but the closure captures the latest object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, reloadTick]);

  const refetch = useCallback(() => {
    setReloadTick((n) => n + 1);
  }, []);

  return { jobs, loading, error, refetch };
}

function stableFilterKey(o: FetchJobsOptions): string {
  return JSON.stringify({
    status: o.status ?? null,
    jobType: o.jobType ?? null,
    mediaId: o.mediaId ?? null,
    tripId: o.tripId ?? null,
    limit: o.limit ?? null,
    offset: o.offset ?? null,
  });
}
