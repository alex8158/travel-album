// useJobPolling hook (P11.T7).
//
// Polls `GET /api/jobs/:id` on a fixed interval until the job
// reaches a terminal state (success / failed / cancelled), then
// stops. Polling is reset whenever the `jobId` argument changes
// and torn down completely on unmount (the AbortController +
// interval handle are both cleaned in the effect's cleanup).
//
// Returns `{ job, loading, error }`:
//   * `job`     — the latest snapshot, or null until the first poll resolves.
//   * `loading` — true while the very first fetch is in flight; after
//                 that, additional polls update `job` in place without
//                 flipping `loading` back to true (so UIs don't flash).
//   * `error`   — last poll's error message, or null when the latest
//                 poll succeeded.
//
// Call `useJobPolling(null)` to disable polling (e.g. before the
// caller has a jobId yet); the hook returns the initial empty
// state and skips the effect.

import { useEffect, useState } from "react";
import { getJobById, type JobView } from "../api/jobs";

const DEFAULT_INTERVAL_MS = 2000;

const TERMINAL: ReadonlySet<JobView["status"]> = new Set([
  "success",
  "failed",
  "cancelled",
]);

export interface UseJobPollingOptions {
  /** Polling interval in milliseconds. Default 2000 (2s). */
  readonly intervalMs?: number;
}

export interface UseJobPollingResult {
  readonly job: JobView | null;
  readonly loading: boolean;
  readonly error: string | null;
}

export function useJobPolling(
  jobId: string | null,
  options: UseJobPollingOptions = {},
): UseJobPollingResult {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const [job, setJob] = useState<JobView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (jobId === null) {
      setJob(null);
      setLoading(false);
      setError(null);
      return undefined;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setLoading(true);
    setJob(null);
    setError(null);

    const tick = async (): Promise<void> => {
      try {
        const next = await getJobById(jobId);
        if (cancelled) return;
        setJob(next);
        setError(null);
        setLoading(false);
        if (TERMINAL.has(next.status)) {
          // Polling stops; no further timer scheduled.
          return;
        }
        timer = setTimeout(() => {
          void tick();
        }, intervalMs);
      } catch (err: unknown) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
        // Keep polling: a transient 5xx shouldn't permanently break
        // the page; the user can also reload manually.
        timer = setTimeout(() => {
          void tick();
        }, intervalMs);
      }
    };

    void tick();

    return () => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }, [jobId, intervalMs]);

  return { job, loading, error };
}
