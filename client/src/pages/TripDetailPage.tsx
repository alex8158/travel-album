// Trip detail page skeleton (P1.T6 + P1.T7 delete confirmation).
//
// Mounted at /trips/:id. Shows the single trip and acts as the IA
// anchor that the rest of the system grows from:
//
//   - Edit affordance     (P1.T5 form, already wired)
//   - Upload entry point  (P2.T6 will land /trips/:id/upload)
//   - Delete affordance   (P1.T7 — modal confirmation, soft delete)
//   - Counts strip        (hard-coded 0 today; populates once the
//                          media tables exist starting at P2.T1)
//   - Gallery placeholder (P2.T7 will render the real media grid)
//
// Three render states:
//   1. loading      — initial fetch in flight
//   2. error        — fetch failed (404 for missing/soft-deleted ids
//                     surfaces here as "Failed to load trip: …")
//   3. trip loaded  — full skeleton renders, with the inline delete
//                     dialog rendered conditionally on top.
//
// Delete flow (P1.T7):
//   - User clicks the danger Delete button in the header.
//   - A modal asks for confirmation and explains that soft-deleted
//     trips can be restored later (design.md §4.3, CLAUDE.md §2.4).
//   - Cancel / Escape / overlay click close the modal (disabled while
//     the request is in flight).
//   - Confirm calls DELETE /api/trips/:id; on success we navigate to
//     "/" with replace:true so Back does not return to the now-404
//     detail URL. The list page remounts and useTrips picks up the
//     fresh server state automatically.

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { deleteTrip } from "../api/trips";
import { useTrip } from "../hooks/useTrip";

export default function TripDetailPage() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { trip, loading, error, refetch } = useTrip(id);

  // Pull fresh data whenever the user navigates back here — for
  // example after saving an edit at /trips/:id/edit. In the current
  // routing setup the page also remounts on each navigation (so
  // useTrip's mount effect is enough), but watching location.key keeps
  // the contract correct for flows that mutate the trip without
  // unmounting (e.g. the delete confirmation below). Skipping the very
  // first render avoids a duplicate fetch on the initial mount.
  const lastSeenKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastSeenKeyRef.current === null) {
      lastSeenKeyRef.current = location.key;
      return;
    }
    if (lastSeenKeyRef.current !== location.key) {
      lastSeenKeyRef.current = location.key;
      refetch();
    }
  }, [location.key, refetch]);

  // ---- Delete confirmation state (P1.T7) ----------------------------------

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  function openDelete(): void {
    setDeleteError(null);
    setDeleteOpen(true);
  }

  function closeDelete(): void {
    if (deleting) return;
    setDeleteOpen(false);
    setDeleteError(null);
  }

  async function confirmDelete(): Promise<void> {
    if (!trip || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteTrip(trip.id);
      // Replace the history entry so Back does not return to the
      // soft-deleted detail page (which would 404).
      navigate("/", { replace: true });
    } catch (err: unknown) {
      setDeleteError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
    }
  }

  // Escape closes the dialog (unless we're mid-request). Bound only
  // while the dialog is open so we don't leak a global listener.
  useEffect(() => {
    if (!deleteOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !deleting) {
        setDeleteOpen(false);
        setDeleteError(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteOpen, deleting]);

  function onOverlayClick(e: ReactMouseEvent<HTMLDivElement>): void {
    // Only close on direct overlay clicks, not bubbled clicks from
    // inside the modal card.
    if (e.target === e.currentTarget) closeDelete();
  }

  // ---- Lifecycle render branches ------------------------------------------

  if (loading) {
    return (
      <main>
        <p className="status-text">Loading trip…</p>
      </main>
    );
  }

  if (error !== null) {
    return (
      <main>
        <p className="status-text status-error" role="alert">
          Failed to load trip: {error}
        </p>
        <Link to="/" className="btn-secondary">
          Back to trips
        </Link>
      </main>
    );
  }

  if (trip === null) {
    // Defensive: should not be reachable when !loading && !error.
    return null;
  }

  const dateRange = formatDateRange(trip.startDate, trip.endDate);

  return (
    <main>
      <header className="page-header">
        <div className="page-header-text">
          <Link to="/" className="back-link">
            ← Back to trips
          </Link>
          <h1>{trip.title}</h1>
          {trip.destination && (
            <p className="trip-detail-meta">
              <span className="trip-detail-meta-label">Destination:</span> {trip.destination}
            </p>
          )}
          {dateRange && (
            <p className="trip-detail-meta">
              <span className="trip-detail-meta-label">Dates:</span> {dateRange}
            </p>
          )}
        </div>
        <div className="page-header-actions">
          <Link to={`/trips/${trip.id}/edit`} className="btn-secondary">
            Edit
          </Link>
          <Link to={`/trips/${trip.id}/upload`} className="btn-primary">
            Upload media
          </Link>
          <button type="button" className="btn-danger" onClick={openDelete}>
            Delete
          </button>
        </div>
      </header>

      {trip.description && (
        <section className="trip-detail-section">
          <p className="trip-detail-description">{trip.description}</p>
        </section>
      )}

      <section className="trip-detail-section">
        <h2>Overview</h2>
        <dl className="counts-grid">
          <CountCard label="Photos" value={0} />
          <CountCard label="Videos" value={0} />
          <CountCard label="Duplicate groups" value={0} />
          <CountCard label="Cleanup candidates" value={0} />
        </dl>
        <p className="status-text">
          Counts will populate once media tables and analyses land starting at P2.T1.
        </p>
      </section>

      <section className="trip-detail-section">
        <h2>Gallery</h2>
        <div className="gallery-placeholder">
          <p>No media uploaded yet.</p>
          <p>The gallery (P2.T7) will render the photo grid and video cards here.</p>
          <Link to={`/trips/${trip.id}/upload`} className="btn-primary">
            Upload your first media
          </Link>
        </div>
      </section>

      {deleteOpen && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-trip-title"
          aria-describedby="delete-trip-body"
          onClick={onOverlayClick}
        >
          <div className="modal-card">
            <h2 id="delete-trip-title">Delete this trip?</h2>
            <p id="delete-trip-body">
              <strong>{trip.title}</strong> will be moved to the recycle bin. The first version of
              the app does only soft delete, so this trip can be restored later — no media or
              database records are permanently removed at this stage.
            </p>
            {deleteError !== null && (
              <p className="form-error" role="alert">
                {deleteError}
              </p>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={closeDelete}
                disabled={deleting}
                autoFocus
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-danger"
                onClick={() => {
                  void confirmDelete();
                }}
                disabled={deleting}
              >
                {deleting ? "Deleting…" : "Delete trip"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function CountCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="count-card">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function formatDateRange(start: string | null, end: string | null): string | null {
  if (start && end) return `${start} → ${end}`;
  if (start) return `from ${start}`;
  if (end) return `until ${end}`;
  return null;
}
