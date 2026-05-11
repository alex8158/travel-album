// Upload page (P2.T6).
//
// Mounted at /trips/:id/upload (App.tsx). Reached from TripDetailPage
// via the "Upload media" header button and the "Upload your first
// media" Gallery-placeholder CTA — both already wired by P1.T6.
//
// Trip selection: the trip id comes from the URL path parameter. The
// user has already navigated through the trip list / detail flow to
// reach this page, so there is no in-page trip picker — keeping the
// selection in the URL also means a refresh / share works naturally.
// `useTrip(id)` is reused so the page renders the trip title and 404s
// cleanly on missing / soft-deleted trips, mirroring TripDetailPage.
//
// Three lifecycle states:
//   1. trip loading        — fetching the trip via GET /api/trips/:id
//   2. trip error / missing — show the error and a Back link
//   3. trip loaded          — render the upload form
//
// Upload flow:
//   - <input type="file" multiple accept=...> populates the staged
//     file list. The `accept` attribute hints at the supported
//     formats (requirements §7.2 functional req 3–4), but the backend
//     classifier (P2.T3) remains the source of truth for what's
//     actually allowed; users can still submit anything and per-file
//     errors come back in the results array.
//   - Submit is disabled when no files are staged or while a request
//     is in flight (prevents duplicate POSTs).
//   - On success the `results[]` array is rendered below the form so
//     the user sees per-file status (accepted / rejected_unknown /
//     failed) + reason. No auto-navigation to the gallery — that's
//     P2.T7 territory.
//   - On a whole-request failure (trip 404, malformed payload) the
//     error.message bubbles up into a single inline alert.
//
// Out of scope (P2.T7+ / later phases):
//   - Drag-and-drop (P2.T6 scope only mentions multi-select, which
//     <input multiple> already provides).
//   - Per-file progress bars (no upload progress API used here; would
//     need XHR or chunked uploads — explicit non-goal per task spec).
//   - Gallery rendering, media previews, delete flows, retry / cancel.

import { useState, type ChangeEvent, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";

import { uploadMedia, type UploadItem } from "../api/media";
import { useTrip } from "../hooks/useTrip";

// Hint set for the native file picker. Includes both MIME prefixes
// and explicit extensions because OS-level MIME detection for HEIC /
// MOV varies across browsers. requirements §7.2 functional req 3-4:
//   image: JPG, JPEG, PNG, WEBP, HEIC
//   video: MP4, MOV, M4V, AVI, MKV
const ACCEPT_ATTR = "image/*,video/*,.jpg,.jpeg,.png,.webp,.heic,.mp4,.mov,.m4v,.avi,.mkv";

export default function UploadPage() {
  const { id } = useParams<{ id: string }>();
  const { trip, loading: tripLoading, error: tripError } = useTrip(id);

  const [files, setFiles] = useState<readonly File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [results, setResults] = useState<readonly UploadItem[] | null>(null);

  function onFileChange(e: ChangeEvent<HTMLInputElement>): void {
    const list = e.target.files;
    setFiles(list ? Array.from(list) : []);
    // Clear any prior result / error when the user re-selects files —
    // the staged list and the prior results are no longer the same set.
    setResults(null);
    setSubmitError(null);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!trip || files.length === 0 || uploading) return;
    setUploading(true);
    setSubmitError(null);
    setResults(null);
    try {
      const response = await uploadMedia(trip.id, files);
      setResults(response.results);
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  // ---- Trip lifecycle render branches -------------------------------------

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

  if (trip === null) {
    // Defensive: should not be reachable when !loading && !error.
    return null;
  }

  // ---- Form ---------------------------------------------------------------

  const submitDisabled = files.length === 0 || uploading;
  const successCount = results?.filter((r) => r.status === "accepted").length ?? 0;
  const rejectedCount = results?.filter((r) => r.status === "rejected_unknown").length ?? 0;
  const failedCount = results?.filter((r) => r.status === "failed").length ?? 0;

  return (
    <main>
      <header className="page-header">
        <div className="page-header-text">
          <Link to={`/trips/${trip.id}`} className="back-link">
            ← Back to trip
          </Link>
          <h1>Upload media</h1>
          <p>
            Adding to <strong>{trip.title}</strong>. Supported formats: JPG, PNG, WEBP, HEIC, MP4,
            MOV, M4V, AVI, MKV.
          </p>
        </div>
        <Link to={`/trips/${trip.id}`} className="btn-secondary">
          Cancel
        </Link>
      </header>

      <form className="upload-form" onSubmit={onSubmit} noValidate>
        <label className="form-row">
          <span className="form-label">
            Choose files <span className="form-required">*</span>
          </span>
          <input
            type="file"
            multiple
            accept={ACCEPT_ATTR}
            onChange={onFileChange}
            disabled={uploading}
          />
        </label>

        {files.length > 0 && (
          <section className="upload-section">
            <h2>Selected files ({files.length})</h2>
            <ul className="upload-file-list">
              {files.map((file, i) => (
                <li key={`${file.name}-${i}`}>
                  <span className="upload-file-name">{file.name}</span>
                  <span className="upload-file-meta">
                    {file.type || "(unknown type)"} · {formatBytes(file.size)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {submitError !== null && (
          <p className="form-error" role="alert">
            {submitError}
          </p>
        )}

        <div className="form-actions">
          <button type="submit" className="btn-primary" disabled={submitDisabled}>
            {uploading
              ? "Uploading…"
              : files.length === 0
                ? "Upload"
                : `Upload ${files.length} file${files.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </form>

      {results !== null && (
        <section className="upload-section" aria-live="polite">
          <h2>Upload results</h2>
          <p className="upload-result-summary">
            {successCount} accepted · {rejectedCount} rejected · {failedCount} failed
          </p>
          <ul className="upload-result-list">
            {results.map((item, i) => (
              <li
                key={`${item.originalFilename}-${i}`}
                data-status={item.status}
                className="upload-result"
              >
                <span className="upload-result-name">{item.originalFilename}</span>
                <span className="upload-result-status">{formatStatusLine(item)}</span>
                <span className="upload-result-reason">{item.reason}</span>
              </li>
            ))}
          </ul>
          <p className="status-text">
            Processing of accepted files runs asynchronously. The gallery (P2.T7) will surface
            thumbnails and processing status once those tasks land.
          </p>
        </section>
      )}
    </main>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatStatusLine(item: UploadItem): string {
  switch (item.status) {
    case "accepted":
      return `Accepted as ${item.type} · queued job: ${item.jobType}`;
    case "rejected_unknown":
      return "Rejected — file format not recognised";
    case "failed":
      return `Failed (${item.error.code})`;
  }
}
