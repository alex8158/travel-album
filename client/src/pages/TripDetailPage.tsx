// Trip detail page skeleton (P1.T6 + P1.T7 + P2.T6 + P2.T7).
//
// Mounted at /trips/:id. Shows the single trip and acts as the IA
// anchor that the rest of the system grows from:
//
//   - Edit affordance     (P1.T5 form, already wired)
//   - Upload entry point  (P2.T6 → /trips/:id/upload)
//   - Delete affordance   (P1.T7 — modal confirmation, soft delete)
//   - Counts strip        (P2.T7 wires photos / videos to the real
//                          media list; duplicate / cleanup counts
//                          stay at 0 until P5 / P6 land)
//   - Gallery grid        (P2.T7 — renders MediaCards from
//                          GET /api/trips/:tripId/media, with manual
//                          refresh and empty / loading / error
//                          states. Inline images / video tags are
//                          deliberately omitted because no static
//                          file route exists yet; each card surfaces
//                          metadata + storage path for now.)
//
// Three render states for the trip itself:
//   1. loading      — initial fetch in flight
//   2. error        — fetch failed (404 for missing/soft-deleted ids
//                     surfaces here as "Failed to load trip: …")
//   3. trip loaded  — full skeleton renders, with the inline delete
//                     dialog rendered conditionally on top.
//
// The gallery has its own loading / error / empty / loaded branches
// inside the trip-loaded state — they are local to the Gallery
// section so a media fetch failure does not blank the rest of the
// page.
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
import { runDedupRun } from "../api/dedup";
import type { MediaItem } from "../api/media";
import { deleteTrip } from "../api/trips";
import { useTrip } from "../hooks/useTrip";
import { useTripMedia } from "../hooks/useTripMedia";

export default function TripDetailPage() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { trip, loading, error, refetch } = useTrip(id);
  // P2.T7: pull media for this trip. The hook short-circuits when id
  // is undefined and refetches when id changes (e.g. via Back/Forward).
  // The same `id` is used for both fetches so a 404 on the trip
  // generally implies a 404 on its media too; we render based on the
  // trip's lifecycle state first so the media error never reaches the
  // user in that case.
  const {
    media,
    loading: mediaLoading,
    error: mediaError,
    refetch: refetchMedia,
  } = useTripMedia(id);

  // Pull fresh data whenever the user navigates back here — for
  // example after saving an edit at /trips/:id/edit or returning from
  // the upload page where new media may have landed. In the current
  // routing setup the page also remounts on each navigation (so the
  // hook mount effects are enough), but watching location.key keeps
  // the contract correct for flows that mutate state without
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
      refetchMedia();
    }
  }, [location.key, refetch, refetchMedia]);

  // ---- Delete confirmation state (P1.T7) ----------------------------------

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // ---- Find duplicates state (P5.T6) --------------------------------------
  // POST .../dedup/run and navigate to the duplicate group list on
  // success. Failures surface inline so the rest of the page keeps
  // working.
  const [finding, setFinding] = useState(false);
  const [findError, setFindError] = useState<string | null>(null);

  async function handleFindDuplicates(): Promise<void> {
    if (!trip || finding) return;
    setFinding(true);
    setFindError(null);
    try {
      await runDedupRun(trip.id);
      navigate(`/trips/${trip.id}/duplicates`);
    } catch (err: unknown) {
      setFindError(err instanceof Error ? err.message : String(err));
    } finally {
      setFinding(false);
    }
  }

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
  // Counts come straight from the loaded media list. Anything not yet
  // fetched / errored shows 0 — that's accurate for the UI ("we have
  // 0 confirmed photos") and matches the empty-state copy below. P5 /
  // P6 will fill in duplicate / cleanup counts once those workers
  // land.
  const photoCount = media.filter((m) => m.type === "image").length;
  const videoCount = media.filter((m) => m.type === "video").length;

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
          <button
            type="button"
            className="btn-secondary"
            onClick={handleFindDuplicates}
            disabled={finding}
          >
            {finding ? "Finding…" : "Find duplicates"}
          </button>
          <Link to={`/trips/${trip.id}/duplicates`} className="btn-secondary">
            View duplicates
          </Link>
          {/* P7.T4 recycle-bin entry point: lists soft-deleted media of
              this trip with a per-row Restore action. The page reuses
              the same media list endpoint with ?onlyDeleted=true so
              the default gallery still hides deleted rows. */}
          <Link to={`/trips/${trip.id}/recycle-bin`} className="btn-secondary">
            Recycle bin
          </Link>
          {/* P11.T7 — render entry point: generate plan + pick audio
              + trigger ffmpeg render. The page itself owns plan
              generation; we link instead of inlining to keep this
              header tight. */}
          <Link to={`/trips/${trip.id}/render`} className="btn-secondary">
            Render video
          </Link>
          <button type="button" className="btn-danger" onClick={openDelete}>
            Delete
          </button>
        </div>
      </header>

      {findError !== null && (
        <p className="status-text status-error" role="alert">
          Failed to find duplicates: {findError}
        </p>
      )}

      {trip.description && (
        <section className="trip-detail-section">
          <p className="trip-detail-description">{trip.description}</p>
        </section>
      )}

      <section className="trip-detail-section">
        <h2>Overview</h2>
        <dl className="counts-grid">
          <CountCard label="Photos" value={photoCount} />
          <CountCard label="Videos" value={videoCount} />
          <CountCard label="Duplicate groups" value={0} />
          <CountCard label="Cleanup candidates" value={0} />
        </dl>
        <p className="status-text">
          Duplicate / cleanup counts will populate once dedup (P5) and quality (P6) workers land.
        </p>
      </section>

      <section className="trip-detail-section">
        <div className="trip-detail-section-header">
          <h2>Gallery</h2>
          <button
            type="button"
            className="btn-secondary"
            onClick={refetchMedia}
            disabled={mediaLoading}
          >
            {mediaLoading ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        {mediaLoading && media.length === 0 ? (
          <p className="status-text">Loading media…</p>
        ) : mediaError !== null ? (
          <p className="status-text status-error" role="alert">
            Failed to load media: {mediaError}
          </p>
        ) : media.length === 0 ? (
          <div className="gallery-placeholder">
            <p>No media uploaded yet.</p>
            <p>Upload images or videos to populate this gallery.</p>
            <Link to={`/trips/${trip.id}/upload`} className="btn-primary">
              Upload your first media
            </Link>
          </div>
        ) : (
          <>
            <ul className="media-grid">
              {media.map((item) => (
                <MediaCard key={item.id} item={item} />
              ))}
            </ul>
            {media.length >= 100 && (
              <p className="status-text">
                Showing the most recent 100 items. Pagination UI is out of scope for P2.T7.
              </p>
            )}
          </>
        )}
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

// ---------------------------------------------------------------------------
// Gallery card (P2.T7)
// ---------------------------------------------------------------------------

/**
 * Single media card. P2.T7 introduced the card as metadata-only
 * (no inline image because the static route hadn't landed yet).
 * P3.T6 wraps the card in a `<Link>` to `/media/:id` so the whole
 * tile is clickable — matches the TripCard pattern from P1.T4. The
 * P3.T4 thumbnail is now also usable as the card visual when
 * present; falls back to the typed emoji placeholder otherwise.
 */
function MediaCard({ item }: { item: MediaItem }): JSX.Element {
  const filename = filenameFromPath(item.originalPath);
  const typeLabel = item.type === "image" ? "Image" : item.type === "video" ? "Video" : "Unknown";
  const thumbSrc = item.thumbnailPath !== null ? `/storage/${item.thumbnailPath}` : null;
  // Only surface quality badges for images — videos have no
  // `media_analysis` writer yet, so showing "待分析" forever would be
  // misleading.
  const qualityBadges = item.type === "image" ? buildQualityBadges(item) : [];
  return (
    <li className="media-card" data-type={item.type} data-status={item.status}>
      <Link to={`/media/${item.id}`} className="media-card-link">
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
          {qualityBadges.length > 0 ? (
            <div className="media-card-quality">
              {qualityBadges.map((b) => (
                <span
                  key={b.key}
                  className="quality-pill"
                  data-tone={b.tone}
                  title={b.tooltip ?? undefined}
                >
                  {b.label}
                </span>
              ))}
            </div>
          ) : null}
          <dl className="media-card-meta">
            <div>
              <dt>File</dt>
              <dd className="media-card-mono" title={item.originalPath ?? ""}>
                {filename ?? "—"}
              </dd>
            </div>
            <div>
              <dt>MIME</dt>
              <dd>{item.mimeType ?? "—"}</dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>{item.fileSize !== null ? formatBytes(item.fileSize) : "—"}</dd>
            </div>
            <div>
              <dt>Uploaded</dt>
              <dd>{formatTimestamp(item.createdAt)}</dd>
            </div>
          </dl>
        </div>
      </Link>
    </li>
  );
}

/**
 * Thresholds for the gallery-card recommendation pill. Quality_score
 * is composed by the finalize worker into [0, 1]; we route the band
 * into three high-level audiences:
 *   * ≥ 0.75 → "推荐"   (sharp + well-exposed + balanced colour)
 *   * < 0.50 → "不推荐" (probably wants removing — blurry / bad
 *                       exposure / wildly out-of-balance colour)
 *   * 0.50..0.75 → no recommendation pill — the photo is "fine" and
 *                  doesn't need a UI nudge either way.
 *
 * `null` quality_score (analysis row missing or finalize not yet
 * run) shows the muted "待分析" placeholder instead, so the user can
 * tell "not yet analysed" apart from "analysed and middling".
 */
const QUALITY_RECOMMEND_THRESHOLD = 0.75;
const QUALITY_DISCOURAGE_THRESHOLD = 0.5;

interface QualityBadge {
  readonly key: string;
  readonly label: string;
  /** Drives the colour via `[data-tone=...]` in index.css. */
  readonly tone: "positive" | "neutral" | "warning" | "negative";
  readonly tooltip?: string | null;
}

/**
 * Materialise the badge set for one media card from its
 * `media_analysis` projection. Order in the returned array is the
 * render order, left-to-right:
 *   1. recommendation pill (推荐 / 不推荐 / 待分析)
 *   2. blur pill (模糊 / 疑似模糊)
 *
 * Returns an empty array for a fully-clean processed image (e.g.
 * quality 0.55 + sharp) — we deliberately keep the card visually
 * quiet for the "nothing notable" case.
 */
function buildQualityBadges(item: MediaItem): QualityBadge[] {
  const out: QualityBadge[] = [];
  const a = item.analysis ?? null;
  const reason = a?.reason ?? null;
  if (a === null) {
    // No analysis row at all — the per-dimension workers haven't run.
    out.push({ key: "pending", label: "待分析", tone: "neutral" });
  } else if (a.qualityScore !== null) {
    if (a.qualityScore >= QUALITY_RECOMMEND_THRESHOLD) {
      out.push({ key: "recommend", label: "推荐", tone: "positive", tooltip: reason });
    } else if (a.qualityScore < QUALITY_DISCOURAGE_THRESHOLD) {
      out.push({ key: "discourage", label: "不推荐", tone: "negative", tooltip: reason });
    }
  } else {
    // analysis row exists but finalize hasn't run → still "待分析"
    // (we have signals but no composite verdict yet).
    out.push({ key: "pending", label: "待分析", tone: "neutral" });
  }

  // Blur signal is independent of the composite recommendation —
  // a "推荐" photo never gets a "模糊" badge in practice, but the
  // boolean check is cheap and the rendering rules are simpler when
  // the two axes are independent.
  if (a !== null) {
    if (a.isBlurry === 1) {
      out.push({ key: "blurry", label: "模糊", tone: "warning", tooltip: reason });
    } else if (a.isBlurry === null && a.labels !== null && a.labels.includes("maybe-blurry")) {
      out.push({ key: "maybe-blurry", label: "疑似模糊", tone: "warning", tooltip: reason });
    }
  }

  return out;
}

function filenameFromPath(p: string | null): string | null {
  if (p === null || p.length === 0) return null;
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatTimestamp(iso: string): string {
  // Best-effort: trim trailing fractional seconds + Z for readability.
  // Falls back to the raw value if parsing fails.
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
