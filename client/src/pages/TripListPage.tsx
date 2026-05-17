// Trip list page (P1.T4).
//
// Default route ("/"), per docs/design.md §2.2. Renders the active
// trips returned by GET /api/trips as a card grid. Trips already come
// back ordered by created_at DESC, so the page does not re-sort.
//
// Three render states cover the lifecycle:
//   1. loading       — initial fetch in flight
//   2. error         — fetch rejected; retry by reloading
//   3. trips loaded  — empty-state CTA when [], grid otherwise
//
// Cards link to /trips/:id (P1.T6) and the header CTA links to
// /trips/new (P1.T5). Both targets currently 404 — the links are
// forward-looking placeholders so the IA is in place when those tasks
// land.

import { Link } from "react-router-dom";
import type { Trip } from "../api/trips";
import { useTrips } from "../hooks/useTrips";

export default function TripListPage() {
  const { trips, loading, error } = useTrips();

  return (
    <main>
      <header className="page-header">
        <div className="page-header-text">
          <h1>Travel Album Site V2</h1>
          <p>Organise your travel photos and videos by trip.</p>
        </div>
        <div className="page-header-actions">
          <Link to="/jobs" className="btn-secondary">
            Jobs
          </Link>
          <Link to="/trips/new" className="btn-primary">
            + New trip
          </Link>
        </div>
      </header>

      {loading && <p className="status-text">Loading trips…</p>}

      {error && (
        <p className="status-text status-error" role="alert">
          Failed to load trips: {error}
        </p>
      )}

      {trips !== null && !loading && !error && trips.length === 0 && (
        <section className="empty-state" aria-live="polite">
          <h2>No trips yet</h2>
          <p>Create your first trip to start uploading photos and videos.</p>
          <Link to="/trips/new" className="btn-primary">
            Create a trip
          </Link>
        </section>
      )}

      {trips !== null && trips.length > 0 && (
        <ul className="trip-grid">
          {trips.map((trip) => (
            <TripCard key={trip.id} trip={trip} />
          ))}
        </ul>
      )}
    </main>
  );
}

function TripCard({ trip }: { trip: Trip }) {
  const dateRange = formatDateRange(trip.startDate, trip.endDate);
  // P3.T8: server now returns a derived `coverUrl`. It's a `/storage/...`
  // path when a thumbnail-bearing image exists for this trip, otherwise
  // the placeholder. Fall back to the placeholder for any older / cached
  // response that lacks the field.
  const coverSrc = trip.coverUrl ?? "/placeholder-cover.svg";
  return (
    <li className="trip-card">
      <Link to={`/trips/${trip.id}`} className="trip-card-link">
        <img src={coverSrc} alt="" className="trip-card-cover" width={600} height={400} />
        <div className="trip-card-body">
          <h3 className="trip-card-title">{trip.title}</h3>
          {trip.destination && <p className="trip-card-meta">{trip.destination}</p>}
          {dateRange && <p className="trip-card-meta">{dateRange}</p>}
          {trip.description && <p className="trip-card-description">{trip.description}</p>}
        </div>
      </Link>
    </li>
  );
}

function formatDateRange(start: string | null, end: string | null): string | null {
  if (start && end) return `${start} → ${end}`;
  if (start) return `from ${start}`;
  if (end) return `until ${end}`;
  return null;
}
