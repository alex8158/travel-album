// Jobs page (P4.T6).
//
// Route: /jobs. Backed by the public Job API surface (P4.T4):
//
//   GET    /api/jobs              list + filters
//   POST   /api/jobs/:id/retry    flip terminal-ish → 'retrying'
//   POST   /api/jobs/:id/cancel   flip non-terminal → 'cancelled'
//
// What it renders:
//   * Header with manual Refresh button.
//   * Status filter chips (All + each enum value). The "active"
//     chip drives the API filter; clicking another chip re-fetches.
//   * Job table with: id (truncated), type, status badge, retry
//     count, next_run_at, media / trip links, error message,
//     created / updated timestamps, action buttons (Retry / Cancel).
//   * Empty state when 0 jobs.
//   * Error banner for list-fetch failures.
//   * Per-row feedback line under the actions: success or error
//     message from the last retry/cancel call.
//
// Lifecycle:
//   * loading       — initial fetch (or in-flight refetch)
//   * error         — fetch rejected; user can click Refresh
//   * empty         — fetch ok but no rows matched the filter
//   * loaded        — rows rendered
//
// Per-action rules (mirroring server-side JobService):
//   * Retry is rendered only for {failed, success, cancelled, retrying};
//     pending / running rows show a disabled placeholder.
//   * Cancel is rendered only for {pending, retrying, running};
//     terminal rows show a disabled placeholder.
//   * Both buttons are disabled while a request for THAT row is in
//     flight to avoid double-clicks.
//
// After a successful retry/cancel: refetch the list so the user sees
// the new aggregate state (status flip + any cascaded media-status
// change is server-side; we just re-render from the source of truth).

import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import {
  ALL_JOB_STATUSES,
  cancelJob as apiCancelJob,
  retryJob as apiRetryJob,
  type JobStatus,
  type JobView,
} from "../api/jobs";
import { useJobs } from "../hooks/useJobs";

const RETRYABLE: ReadonlySet<JobStatus> = new Set(["failed", "success", "cancelled", "retrying"]);
const CANCELLABLE: ReadonlySet<JobStatus> = new Set(["pending", "retrying", "running"]);

interface RowFeedback {
  readonly kind: "success" | "error";
  readonly message: string;
}

export default function JobsPage(): JSX.Element {
  // `null` here means "no status filter" → show all.
  const [statusFilter, setStatusFilter] = useState<JobStatus | null>(null);

  // Memoise the filter object so useJobs' effect only refires when
  // the selected value actually changes (the hook also serialises
  // defensively, but this avoids a redundant identity churn).
  const fetchOptions = useMemo(
    () => (statusFilter ? { status: statusFilter } : {}),
    [statusFilter],
  );
  const { jobs, loading, error, refetch } = useJobs(fetchOptions);

  // Per-row mutation state, keyed by jobId. The Map is updated
  // immutably via `new Map` so React detects the change.
  const [busyRows, setBusyRows] = useState<ReadonlyMap<string, "retry" | "cancel">>(new Map());
  const [rowFeedback, setRowFeedback] = useState<ReadonlyMap<string, RowFeedback>>(new Map());

  const setBusy = useCallback((jobId: string, kind: "retry" | "cancel" | null) => {
    setBusyRows((prev) => {
      const next = new Map(prev);
      if (kind === null) next.delete(jobId);
      else next.set(jobId, kind);
      return next;
    });
  }, []);

  const setFeedback = useCallback((jobId: string, feedback: RowFeedback | null) => {
    setRowFeedback((prev) => {
      const next = new Map(prev);
      if (feedback === null) next.delete(jobId);
      else next.set(jobId, feedback);
      return next;
    });
  }, []);

  const handleRetry = useCallback(
    async (job: JobView) => {
      if (busyRows.has(job.id)) return;
      setBusy(job.id, "retry");
      setFeedback(job.id, null);
      try {
        await apiRetryJob(job.id);
        setFeedback(job.id, {
          kind: "success",
          message: "Retry queued — status set to 'retrying'.",
        });
        refetch();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        setFeedback(job.id, { kind: "error", message });
      } finally {
        setBusy(job.id, null);
      }
    },
    [busyRows, refetch, setBusy, setFeedback],
  );

  const handleCancel = useCallback(
    async (job: JobView) => {
      if (busyRows.has(job.id)) return;
      setBusy(job.id, "cancel");
      setFeedback(job.id, null);
      try {
        await apiCancelJob(job.id);
        setFeedback(job.id, { kind: "success", message: "Cancelled — status set to 'cancelled'." });
        refetch();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        setFeedback(job.id, { kind: "error", message });
      } finally {
        setBusy(job.id, null);
      }
    },
    [busyRows, refetch, setBusy, setFeedback],
  );

  return (
    <main>
      <header className="page-header">
        <div className="page-header-text">
          <Link to="/" className="back-link">
            ← All trips
          </Link>
          <h1>Background jobs</h1>
          <p>
            Monitor processing tasks. Manual retry / cancel actions reuse the same state machine the
            workers follow — they never invoke a handler directly.
          </p>
        </div>
        <div className="page-header-actions">
          <button type="button" className="btn-secondary" onClick={refetch} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      <section className="jobs-filters" aria-label="Filter by status">
        <FilterChip
          label="All"
          active={statusFilter === null}
          onClick={() => setStatusFilter(null)}
        />
        {ALL_JOB_STATUSES.map((s) => (
          <FilterChip
            key={s}
            label={s}
            active={statusFilter === s}
            onClick={() => setStatusFilter(s)}
          />
        ))}
      </section>

      {error && (
        <p className="status-text status-error" role="alert">
          Failed to load jobs: {error}
        </p>
      )}

      {jobs !== null && !loading && !error && jobs.length === 0 && (
        <section className="empty-state" aria-live="polite">
          <h2>No jobs found</h2>
          <p>
            {statusFilter === null
              ? "No background jobs exist yet — upload some media to seed image-channel jobs."
              : `No jobs are currently in status '${statusFilter}'.`}
          </p>
        </section>
      )}

      {jobs !== null && jobs.length > 0 && (
        <div className="jobs-table-wrapper">
          <table className="jobs-table">
            <thead>
              <tr>
                <th scope="col">Job</th>
                <th scope="col">Type</th>
                <th scope="col">Status</th>
                <th scope="col">Retries</th>
                <th scope="col">Next run</th>
                <th scope="col">Media / Trip</th>
                <th scope="col">Created / Updated</th>
                <th scope="col">Error</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  busy={busyRows.get(job.id) ?? null}
                  feedback={rowFeedback.get(job.id) ?? null}
                  onRetry={handleRetry}
                  onCancel={handleCancel}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={active ? "filter-chip filter-chip-active" : "filter-chip"}
      onClick={onClick}
      aria-pressed={active}
    >
      {label}
    </button>
  );
}

interface JobRowProps {
  readonly job: JobView;
  readonly busy: "retry" | "cancel" | null;
  readonly feedback: RowFeedback | null;
  readonly onRetry: (job: JobView) => void;
  readonly onCancel: (job: JobView) => void;
}

function JobRow({ job, busy, feedback, onRetry, onCancel }: JobRowProps): JSX.Element {
  const canRetry = RETRYABLE.has(job.status);
  const canCancel = CANCELLABLE.has(job.status);
  return (
    <tr className="jobs-row" data-status={job.status}>
      <td className="jobs-cell-id">
        <code title={job.id}>{job.id.slice(0, 8)}</code>
      </td>
      <td>
        <code>{job.jobType}</code>
      </td>
      <td>
        <span className={`status-badge status-badge-${job.status}`}>{job.status}</span>
      </td>
      <td className="jobs-cell-number">{job.retryCount}</td>
      <td className="jobs-cell-time">{formatTimestamp(job.nextRunAt)}</td>
      <td className="jobs-cell-links">
        <Link to={`/media/${encodeURIComponent(job.mediaId)}`} title={job.mediaId}>
          media
        </Link>
        {job.tripId && (
          <>
            {" · "}
            <Link to={`/trips/${encodeURIComponent(job.tripId)}`} title={job.tripId}>
              trip
            </Link>
          </>
        )}
      </td>
      <td className="jobs-cell-time-stack">
        <span title={`created at ${job.createdAt}`}>{formatTimestamp(job.createdAt)}</span>
        <span className="jobs-cell-time-secondary" title={`updated at ${job.updatedAt}`}>
          {formatTimestamp(job.updatedAt)}
        </span>
      </td>
      <td className="jobs-cell-error">
        {job.errorMessage ? (
          <span title={job.errorMessage}>{job.errorMessage}</span>
        ) : (
          <span className="jobs-cell-empty">—</span>
        )}
      </td>
      <td className="jobs-cell-actions">
        <button
          type="button"
          className="btn-secondary jobs-action-btn"
          onClick={() => onRetry(job)}
          disabled={!canRetry || busy !== null}
          title={canRetry ? "Reset retry_count and re-queue" : `Cannot retry from '${job.status}'`}
        >
          {busy === "retry" ? "…" : "Retry"}
        </button>
        <button
          type="button"
          className="btn-danger jobs-action-btn"
          onClick={() => onCancel(job)}
          disabled={!canCancel || busy !== null}
          title={canCancel ? "Mark as cancelled" : `Cannot cancel from '${job.status}'`}
        >
          {busy === "cancel" ? "…" : "Cancel"}
        </button>
        {feedback && (
          <p
            className={
              feedback.kind === "success"
                ? "jobs-row-feedback jobs-row-feedback-success"
                : "jobs-row-feedback jobs-row-feedback-error"
            }
            role={feedback.kind === "error" ? "alert" : undefined}
          >
            {feedback.message}
          </p>
        )}
      </td>
    </tr>
  );
}

/**
 * Render an ISO-8601 timestamp into a short local-time label. Falls
 * back to "—" when the value is null (e.g. `next_run_at` on a row
 * that never scheduled a retry).
 */
function formatTimestamp(iso: string | null): string {
  if (iso === null) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}
