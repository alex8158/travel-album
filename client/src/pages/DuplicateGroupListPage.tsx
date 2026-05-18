// Duplicate group list page (P5.T6).
//
// Mounted at /trips/:tripId/duplicates. Shows every duplicate group
// for one trip, ordered newest-first (server-side). Read-only view —
// keep/remove decisions and user confirmation belong to P5.T7.
//
// Render branches:
//   1. loading       — initial fetch in flight
//   2. error         — fetch failed (4xx / 5xx envelope message)
//   3. empty         — trip has no duplicate groups; show "Find
//                      duplicates" call to action
//   4. groups loaded — grid of group cards

import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  runDedupRun,
  type DuplicateGroupItemView,
  type DuplicateGroupType,
  type DuplicateGroupView,
} from "../api/dedup";
import { useDuplicateGroupsForTrip } from "../hooks/useDuplicateGroupsForTrip";

export default function DuplicateGroupListPage() {
  const { tripId } = useParams<{ tripId: string }>();
  const navigate = useNavigate();
  const { groups, loading, error, refetch } = useDuplicateGroupsForTrip(tripId);

  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<string | null>(null);

  async function handleRun(): Promise<void> {
    if (!tripId || running) return;
    setRunning(true);
    setRunError(null);
    setLastRun(null);
    try {
      const result = await runDedupRun(tripId);
      const total = result.exact.groupsCreated + result.similar.groupsCreated;
      setLastRun(
        `Exact: ${result.exact.groupsCreated} created, ${Object.values(result.exact.cohortsSkippedByReason).reduce((a, b) => a + b, 0)} skipped. ` +
          `Similar: ${result.similar.groupsCreated} created (threshold ${result.similar.hammingThreshold}), ${Object.values(result.similar.cohortsSkippedByReason).reduce((a, b) => a + b, 0)} skipped. ` +
          `Total new groups: ${total}.`,
      );
      refetch();
    } catch (err: unknown) {
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  if (!tripId) {
    return (
      <main>
        <p className="status-text status-error" role="alert">
          Missing trip id in URL.
        </p>
      </main>
    );
  }

  return (
    <main>
      <header className="page-header">
        <div className="page-header-text">
          <Link to={`/trips/${tripId}`} className="back-link">
            ← Back to trip
          </Link>
          <h1>Duplicate groups</h1>
          <p>Images grouped by file-level or visual similarity, scoped to this trip.</p>
        </div>
        <div className="page-header-actions">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => refetch()}
            disabled={loading || running}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          <button type="button" className="btn-primary" onClick={handleRun} disabled={running}>
            {running ? "Finding…" : "Find duplicates"}
          </button>
        </div>
      </header>

      {runError !== null && (
        <p className="status-text status-error" role="alert">
          Failed to run duplicate detection: {runError}
        </p>
      )}
      {lastRun !== null && (
        <p className="status-text" aria-live="polite">
          {lastRun}
        </p>
      )}

      {loading && groups.length === 0 ? (
        <p className="status-text">Loading duplicate groups…</p>
      ) : error !== null ? (
        <p className="status-text status-error" role="alert">
          Failed to load duplicate groups: {error}
        </p>
      ) : groups.length === 0 ? (
        <section className="empty-state" aria-live="polite">
          <h2>No duplicate groups yet</h2>
          <p>Run duplicate detection to find images that share the same file or look similar.</p>
          <button type="button" className="btn-primary" onClick={handleRun} disabled={running}>
            {running ? "Finding…" : "Find duplicates"}
          </button>
        </section>
      ) : (
        <ul className="duplicate-group-grid">
          {groups.map((g) => (
            <DuplicateGroupCard
              key={g.id}
              group={g}
              onNavigate={(id) => navigate(`/duplicate-groups/${id}`)}
            />
          ))}
        </ul>
      )}
    </main>
  );
}

function DuplicateGroupCard({
  group,
  onNavigate,
}: {
  group: DuplicateGroupView;
  onNavigate: (id: string) => void;
}): JSX.Element {
  const preview = group.items.slice(0, 4);
  return (
    <li className="duplicate-group-card">
      <button
        type="button"
        className="duplicate-group-card-button"
        onClick={() => onNavigate(group.id)}
        aria-label={`Open duplicate group ${group.id}`}
      >
        <div className="duplicate-group-card-thumbs">
          {preview.map((item) => (
            <ItemThumbnail key={item.id} item={item} />
          ))}
          {group.items.length > preview.length && (
            <div className="duplicate-group-card-thumb-more">
              +{group.items.length - preview.length}
            </div>
          )}
        </div>
        <div className="duplicate-group-card-body">
          <div className="duplicate-group-card-header">
            <span className={`group-type-badge group-type-${group.groupType}`}>
              {labelForType(group.groupType)}
            </span>
            <span className="duplicate-group-card-count">
              {group.items.length} {group.items.length === 1 ? "item" : "items"}
            </span>
          </div>
          <dl className="duplicate-group-card-meta">
            <div>
              <dt>Confidence</dt>
              <dd>{formatScore(group.confidence)}</dd>
            </div>
            <div>
              <dt>Similarity</dt>
              <dd>{formatScore(group.similarityScore)}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{group.userConfirmed ? "Confirmed" : "Undecided"}</dd>
            </div>
            <div>
              <dt>Recommended</dt>
              <dd>{group.recommendedMediaId ? "Selected" : "Not recommended"}</dd>
            </div>
          </dl>
        </div>
      </button>
    </li>
  );
}

function ItemThumbnail({ item }: { item: DuplicateGroupItemView }): JSX.Element {
  const m = item.media;
  if (m === null) {
    return <div className="duplicate-group-card-thumb thumb-missing">(missing media)</div>;
  }
  if (m.thumbnailPath) {
    return (
      <img
        src={`/storage/${m.thumbnailPath}`}
        alt=""
        className="duplicate-group-card-thumb"
        loading="lazy"
        width={120}
        height={120}
      />
    );
  }
  const label = m.type === "image" ? "IMG" : m.type === "video" ? "VID" : "?";
  return (
    <div className={`duplicate-group-card-thumb thumb-placeholder thumb-${m.type}`}>{label}</div>
  );
}

function formatScore(value: number | null): string {
  if (value === null) return "—";
  return value.toFixed(2);
}

function labelForType(t: DuplicateGroupType): string {
  switch (t) {
    case "exact":
      return "Exact match";
    case "similar":
      return "Similar";
    case "candidate":
      return "Candidate";
  }
}
