// Trip recycle-bin page (P7.T4).
//
// Mounted at /trips/:id/recycle-bin. Lists soft-deleted media for one
// trip and exposes a per-row Restore action. The page deliberately
// keeps the surface tiny — no permanent delete, no batch restore, no
// filtering / pagination UI beyond what the API already provides
// (requirements §7.18 + this task's hard scope).
//
// Data flow:
//   * Trip resolution via `useTrip(id)` — same hook the detail page
//     uses, so 404 / loading / error states render identically.
//   * Media list via `useTripMedia(id, 100, /* onlyDeleted */ true)`
//     → GET /api/trips/:id/media?onlyDeleted=true. The server side
//     branches into the `listByTripDeletedOnlyStmt` prepared
//     statement (P7.T4 server half) which orders by `deleted_at
//     DESC, id DESC` — the most-recently-deleted item appears
//     first, which is the right default for "undo what I just did".
//   * Restore is a per-row POST /api/media/:id/restore (the P7.T2
//     endpoint). On success we drop the restored id from the local
//     list (`restoredIds` Set) so the user gets immediate feedback
//     even before the implicit `quality_selector_run` job lands.
//
// Hard constraints honoured:
//   * Default gallery still hides deleted media (this page is the
//     opt-in surface; nothing in the default gallery path is
//     touched).
//   * No new mutation endpoints — restore reuses the P7.T2 API.
//   * No permanent delete affordance.
//   * No batch restore — each row has its own button.
//   * No new migration — schema already has `media_items.deleted_at`.

import { useState, type ReactElement } from "react";
import { Link, useParams } from "react-router-dom";

import { restoreMedia, type MediaItem } from "../api/media";
import { useTrip } from "../hooks/useTrip";
import { useTripMedia } from "../hooks/useTripMedia";

export default function TripRecycleBinPage(): ReactElement | null {
  const { id } = useParams<{ id: string }>();
  const { trip, loading: tripLoading, error: tripError } = useTrip(id);
  // `onlyDeleted=true` flips the server's read into recycle-bin mode.
  const {
    media,
    loading: mediaLoading,
    error: mediaError,
    refetch: refetchMedia,
  } = useTripMedia(id, 100, true);

  // Track per-row restore lifecycle so multiple buttons can be in
  // flight at once without stepping on each other. We keep two
  // parallel Sets:
  //   * `pendingIds` — restore POST is in flight; button shows
  //                     "Restoring…" and is disabled.
  //   * `restoredIds` — POST already returned OK; we hide the row
  //                     from the visible list locally so the page
  //                     reflects the action without another fetch.
  // Errors land in `errorById` and surface inline on the offending
  // row so a single failure cannot blank the whole page.
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());
  const [restoredIds, setRestoredIds] = useState<ReadonlySet<string>>(new Set());
  const [errorById, setErrorById] = useState<ReadonlyMap<string, string>>(new Map());

  async function handleRestore(mediaId: string): Promise<void> {
    if (pendingIds.has(mediaId) || restoredIds.has(mediaId)) return;
    setPendingIds((prev) => addToSet(prev, mediaId));
    setErrorById((prev) => removeFromMap(prev, mediaId));
    try {
      await restoreMedia(mediaId);
      setRestoredIds((prev) => addToSet(prev, mediaId));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setErrorById((prev) => addToMap(prev, mediaId, message));
    } finally {
      setPendingIds((prev) => removeFromSet(prev, mediaId));
    }
  }

  // ---- Lifecycle render branches (mirror TripDetailPage) ----------

  if (tripLoading) {
    return (
      <main>
        <p className="status-text">Loading trip…</p>
      </main>
    );
  }

  if (tripError !== null) {
    return (
      <main>
        <p className="status-text status-error" role="alert">
          Failed to load trip: {tripError}
        </p>
        <Link to="/" className="btn-secondary">
          Back to trips
        </Link>
      </main>
    );
  }

  if (trip === null) return null;

  // Filter out anything the user has already restored in this session
  // so the row disappears immediately on success. A page refresh would
  // hit the server again and exclude them naturally because they no
  // longer satisfy `deleted_at IS NOT NULL`.
  const visibleMedia = media.filter((m) => !restoredIds.has(m.id));

  return (
    <main>
      <header className="page-header">
        <div className="page-header-text">
          <Link to={`/trips/${trip.id}`} className="back-link">
            ← Back to trip
          </Link>
          <h1>Recycle bin · {trip.title}</h1>
          <p className="trip-detail-meta">
            Soft-deleted media for this trip. Restore brings an item back into the gallery and
            re-runs the quality selector + auto-cover refresh.
          </p>
        </div>
        <div className="page-header-actions">
          <button
            type="button"
            className="btn-secondary"
            onClick={refetchMedia}
            disabled={mediaLoading}
          >
            {mediaLoading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      <section className="trip-detail-section">
        {mediaLoading && media.length === 0 ? (
          <p className="status-text">Loading deleted media…</p>
        ) : mediaError !== null ? (
          <p className="status-text status-error" role="alert">
            Failed to load deleted media: {mediaError}
          </p>
        ) : visibleMedia.length === 0 ? (
          <div className="gallery-placeholder">
            <p>Recycle bin is empty.</p>
            <p>
              Soft-deleted media will land here. Permanent deletion is intentionally not exposed in
              V1 — items can always be restored from this page.
            </p>
            <Link to={`/trips/${trip.id}`} className="btn-primary">
              Back to gallery
            </Link>
          </div>
        ) : (
          <ul className="media-grid">
            {visibleMedia.map((item) => (
              <RecycleBinCard
                key={item.id}
                item={item}
                pending={pendingIds.has(item.id)}
                error={errorById.get(item.id) ?? null}
                onRestore={() => {
                  void handleRestore(item.id);
                }}
              />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

/**
 * Recycle-bin card. Visually mirrors the gallery `MediaCard` (same
 * `media-card` shell, thumbnail / typed-emoji fallback) so the layout
 * stays familiar. Differences:
 *   * No `<Link>` wrapper — the media detail page 404s for
 *     soft-deleted ids today (P3.T6 reads default to active-only),
 *     so a tile-wide link would be a dead end. Restoring first
 *     re-enables detail navigation.
 *   * Adds a "Deleted" timestamp row (sourced from
 *     `media_items.deleted_at`) so users can tell which items they
 *     deleted most recently.
 *   * Adds a Restore action row at the bottom.
 */
function RecycleBinCard(props: {
  item: MediaItem;
  pending: boolean;
  error: string | null;
  onRestore: () => void;
}): ReactElement {
  const { item, pending, error, onRestore } = props;
  const filename = filenameFromPath(item.originalPath);
  const typeLabel = item.type === "image" ? "Image" : item.type === "video" ? "Video" : "Unknown";
  const thumbSrc = item.thumbnailPath !== null ? `/storage/${item.thumbnailPath}` : null;
  return (
    <li className="media-card" data-type={item.type} data-status={item.status}>
      <div className="media-card-thumb" aria-hidden="true">
        {thumbSrc !== null ? (
          <img className="media-card-thumb-img" src={thumbSrc} alt="" loading="lazy" />
        ) : item.type === "image" ? (
          "🖼️"
        ) : item.type === "video" ? (
          "🎞️"
        ) : (
          "📄"
        )}
      </div>
      <div className="media-card-body">
        <div className="media-card-title">
          <span className="media-card-type">{typeLabel}</span>
          <span className="media-card-status" data-status={item.status}>
            {item.status}
          </span>
        </div>
        <dl className="media-card-meta">
          <div>
            <dt>File</dt>
            <dd className="media-card-mono" title={item.originalPath ?? ""}>
              {filename ?? "—"}
            </dd>
          </div>
          <div>
            <dt>Uploaded</dt>
            <dd>{formatTimestamp(item.createdAt)}</dd>
          </div>
          <div>
            <dt>Deleted</dt>
            <dd>{item.deletedAt !== null ? formatTimestamp(item.deletedAt) : "—"}</dd>
          </div>
        </dl>
        {error !== null && (
          <p className="status-text status-error" role="alert">
            Restore failed: {error}
          </p>
        )}
        <div className="duplicate-detail-member-actions">
          <button
            type="button"
            className="btn-primary"
            onClick={onRestore}
            disabled={pending}
            aria-label={`Restore media ${item.id}`}
          >
            {pending ? "Restoring…" : "Restore"}
          </button>
        </div>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// helpers — immutable Set / Map updates so React picks up changes
// ---------------------------------------------------------------------------

function addToSet<T>(prev: ReadonlySet<T>, value: T): ReadonlySet<T> {
  if (prev.has(value)) return prev;
  const next = new Set(prev);
  next.add(value);
  return next;
}

function removeFromSet<T>(prev: ReadonlySet<T>, value: T): ReadonlySet<T> {
  if (!prev.has(value)) return prev;
  const next = new Set(prev);
  next.delete(value);
  return next;
}

function addToMap<K, V>(prev: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> {
  const next = new Map(prev);
  next.set(key, value);
  return next;
}

function removeFromMap<K, V>(prev: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> {
  if (!prev.has(key)) return prev;
  const next = new Map(prev);
  next.delete(key);
  return next;
}

function filenameFromPath(p: string | null): string | null {
  if (p === null || p.length === 0) return null;
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z")
      .replace("T", " ");
  } catch {
    return iso;
  }
}
