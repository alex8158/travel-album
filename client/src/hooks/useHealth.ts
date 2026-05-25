// useHealth hook (P10.T6).
//
// Reads `GET /api/health` once on mount + on `refetch()`. The
// capabilities snapshot rarely changes during a session (the server
// freezes it at boot), so the hook does NOT poll — a user-initiated
// refresh or a tab focus event would re-read it via `refetch()`.
//
// Failure-soft design: on any HTTP error or network problem the
// hook surfaces `error` but does NOT throw. The component decides
// whether to grey out AI affordances (default-safe: treat unknown
// as "AI off"). This matches CLAUDE.md §2.8 — base features must
// work without AI; if /api/health itself is down the rest of the
// page should still render.

import { useCallback, useEffect, useState } from "react";

import { fetchHealth, type HealthResponse } from "../api/health";

export interface UseHealthResult {
  readonly data: HealthResponse | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refetch: () => void;
}

export function useHealth(): UseHealthResult {
  const [data, setData] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchHealth(controller.signal)
      .then((h) => {
        if (controller.signal.aborted) return;
        setData(h);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        // failure-soft: keep the existing `data` (might be from a
        // prior load) but surface the error message.
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

  return { data, loading, error, refetch };
}
