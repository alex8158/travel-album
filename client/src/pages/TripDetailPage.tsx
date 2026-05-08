// Trip detail page skeleton (P1.T6).
//
// Mounted at /trips/:id. Shows the single trip and acts as the IA
// anchor that the rest of the system grows from:
//
//   - Edit affordance     (P1.T5 form, already wired)
//   - Upload entry point  (P2.T6 will land /trips/:id/upload)
//   - Delete affordance   (P1.T7 — not in this task)
//   - Counts strip        (hard-coded 0 today; populates once the
//                          media tables exist starting at P2.T1)
//   - Gallery placeholder (P2.T7 will render the real media grid)
//
// Three render states:
//   1. loading      — initial fetch in flight
//   2. error        — fetch failed (404 for missing/soft-deleted ids
//                     surfaces here as "Failed to load trip: …")
//   3. trip loaded  — full skeleton renders

import { useEffect, useRef } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { useTrip } from "../hooks/useTrip";

export default function TripDetailPage() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const { trip, loading, error, refetch } = useTrip(id);

  // Pull fresh data whenever the user navigates back here — for
  // example after saving an edit at /trips/:id/edit. In the current
  // routing setup the page also remounts on each navigation (so
  // useTrip's mount effect is enough), but watching location.key keeps
  // the contract correct for future flows where the detail page may
  // stay mounted across mutations (e.g. delete confirmation modals
  // arriving in P1.T7). Skipping the very first render avoids a
  // duplicate fetch on the initial mount.
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
