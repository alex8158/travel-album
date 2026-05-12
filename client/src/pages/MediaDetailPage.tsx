// Media detail page v1 (P3.T6).
//
// Mounted at /media/:id. Reached from Gallery cards (TripDetailPage)
// via the Link wrapping each MediaCard.
//
// What it renders, in order:
//   1. Back link to the owning Trip (uses media.tripId).
//   2. Hero image — preview.webp if available (via /storage), else a
//      typed placeholder (matches Gallery card visual language).
//   3. Basic info table: type, status, MIME, extension, dimensions,
//      file size, uploaded / updated timestamps, storage paths
//      (original / preview / thumbnail).
//   4. Versions section: every `media_versions` row carried in the
//      detail bundle (version_type, file_path, dimensions, size).
//   5. EXIF section: rendered from the `metadata` version's `params`
//      JSON if present. Missing / empty / unparseable metadata
//      surfaces a clear empty state — never a crash.
//
// Three lifecycle states:
//   * loading
//   * error (404 from missing / soft-deleted id surfaces here)
//   * loaded
//
// Scope (P3.T6 v1 — strictly read-only display):
//   * No editing.
//   * No delete affordance.
//   * No "reprocess" button (P3.T7).
//   * No version switching (P8.T4 / P10.T5).
//   * Original is shown as a download link, not inlined — at full
//     resolution it would be wasteful to load just for visual
//     identification, and the preview already serves that purpose.

import { Link, useParams } from "react-router-dom";

import type { MediaItem, MediaVersion } from "../api/media";
import { useMediaDetail } from "../hooks/useMediaDetail";

export default function MediaDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const { detail, loading, error } = useMediaDetail(id);

  if (loading) {
    return (
      <main>
        <p className="status-text">Loading media…</p>
      </main>
    );
  }

  if (error !== null) {
    return (
      <main>
        <p className="status-text status-error" role="alert">
          Failed to load media: {error}
        </p>
        <Link to="/" className="btn-secondary">
          Back to trips
        </Link>
      </main>
    );
  }

  if (detail === null) {
    // Defensive — shouldn't be reachable when !loading && !error.
    return null as unknown as JSX.Element;
  }

  const { media, versions } = detail;
  const previewVersion = versions.find((v) => v.versionType === "preview");
  const metadataVersion = versions.find((v) => v.versionType === "metadata");
  const exifEntries = parseExifEntries(metadataVersion?.params ?? null);
  const heroSrc = pickHeroSrc(media, previewVersion);

  return (
    <main>
      <header className="page-header">
        <div className="page-header-text">
          <Link to={`/trips/${media.tripId}`} className="back-link">
            ← Back to trip
          </Link>
          <h1>{filenameFromPath(media.originalPath) ?? `Media ${truncateId(media.id)}`}</h1>
          <p className="trip-detail-meta">
            <span className="trip-detail-meta-label">Type:</span> {labelType(media.type)} ·{" "}
            <span className="trip-detail-meta-label">Status:</span> {media.status}
          </p>
        </div>
      </header>

      <section className="media-detail-hero" data-type={media.type}>
        {heroSrc !== null ? (
          <img
            className="media-detail-hero-img"
            src={heroSrc}
            alt={filenameFromPath(media.originalPath) ?? `Media ${truncateId(media.id)} preview`}
            loading="lazy"
          />
        ) : (
          <div className="media-detail-hero-placeholder">
            <span className="media-detail-hero-emoji" aria-hidden="true">
              {media.type === "image" ? "🖼️" : media.type === "video" ? "🎞️" : "📄"}
            </span>
            <p>No preview available yet.</p>
            <p>
              Preview / thumbnail derivatives are generated asynchronously by the image-channel
              worker. Refresh after a moment if you just uploaded this file.
            </p>
          </div>
        )}
      </section>

      <section className="trip-detail-section">
        <h2>Basics</h2>
        <dl className="media-detail-info">
          <Field label="Media ID" value={<code className="mono">{media.id}</code>} />
          <Field
            label="Trip"
            value={
              <Link to={`/trips/${media.tripId}`} className="mono">
                {truncateId(media.tripId)}
              </Link>
            }
          />
          <Field label="Type" value={labelType(media.type)} />
          <Field label="Status" value={media.status} />
          <Field label="MIME" value={media.mimeType ?? "—"} />
          <Field label="Extension" value={media.extension ?? "—"} />
          <Field label="Dimensions" value={formatDimensions(media.width, media.height)} />
          <Field label="Duration" value={formatDuration(media.duration)} />
          <Field
            label="File size"
            value={media.fileSize !== null ? formatBytes(media.fileSize) : "—"}
          />
          <Field label="User decision" value={media.userDecision} />
          <Field label="Uploaded" value={formatTimestamp(media.createdAt)} />
          <Field label="Updated" value={formatTimestamp(media.updatedAt)} />
          <Field
            label="Original path"
            value={
              media.originalPath !== null ? (
                <a className="mono" href={`/storage/${media.originalPath}`}>
                  {media.originalPath}
                </a>
              ) : (
                "—"
              )
            }
          />
          <Field label="Preview path" value={renderStorageLink(media.previewPath)} />
          <Field label="Thumbnail path" value={renderStorageLink(media.thumbnailPath)} />
        </dl>
      </section>

      <section className="trip-detail-section">
        <h2>Versions ({versions.length})</h2>
        {versions.length === 0 ? (
          <p className="status-text">
            No derived versions yet. Thumbnail / preview / metadata land here once the image-channel
            worker has run.
          </p>
        ) : (
          <ul className="media-detail-versions">
            {versions.map((v) => (
              <li key={v.id} className="media-detail-version">
                <div className="media-detail-version-head">
                  <span className="media-detail-version-type">{v.versionType}</span>
                  <span className="media-card-status" data-status={v.status}>
                    {v.status}
                  </span>
                </div>
                <dl className="media-card-meta">
                  <div>
                    <dt>Path</dt>
                    <dd>{renderStorageLink(v.filePath)}</dd>
                  </div>
                  <div>
                    <dt>MIME</dt>
                    <dd>{v.mimeType ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Dimensions</dt>
                    <dd>{formatDimensions(v.width, v.height)}</dd>
                  </div>
                  <div>
                    <dt>Size</dt>
                    <dd>{v.fileSize !== null ? formatBytes(v.fileSize) : "—"}</dd>
                  </div>
                  {v.modelName !== null && (
                    <div>
                      <dt>Model</dt>
                      <dd>{v.modelName}</dd>
                    </div>
                  )}
                </dl>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="trip-detail-section">
        <h2>EXIF / camera metadata</h2>
        {exifEntries === null ? (
          <p className="status-text">No metadata version present yet.</p>
        ) : exifEntries.length === 0 ? (
          <p className="status-text">
            Metadata worker ran, but the source file carried no EXIF data (e.g. a screenshot or a
            re-encoded JPEG with stripped tags).
          </p>
        ) : (
          <dl className="media-detail-info">
            {exifEntries.map(([key, value]) => (
              <Field key={key} label={key} value={<span className="mono">{value}</span>} />
            ))}
          </dl>
        )}
      </section>
    </main>
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function Field({ label, value }: { label: string; value: React.ReactNode }): JSX.Element {
  return (
    <div className="media-detail-field">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * Prefer the preview row's storage path; fall back to media_items.previewPath
 * (which the thumbnail worker caches there too); fall back to thumbnailPath;
 * give up otherwise. Returns a `/storage/...` URL or null.
 */
function pickHeroSrc(media: MediaItem, previewVersion: MediaVersion | undefined): string | null {
  if (previewVersion !== undefined) return `/storage/${previewVersion.filePath}`;
  if (media.previewPath !== null) return `/storage/${media.previewPath}`;
  if (media.thumbnailPath !== null) return `/storage/${media.thumbnailPath}`;
  return null;
}

function renderStorageLink(p: string | null): React.ReactNode {
  if (p === null) return "—";
  return (
    <a className="mono" href={`/storage/${p}`}>
      {p}
    </a>
  );
}

/**
 * Parse the metadata version's `params` JSON into a flat list of
 * [key, displayValue] pairs. Returns:
 *   * null  — when no metadata version exists at all (different from empty)
 *   * []    — when metadata version exists but params is `{}` / null /
 *             empty / unparseable (no EXIF data on this image)
 *   * [...] — sorted alphabetically by key, values stringified for display
 */
function parseExifEntries(paramsJson: string | null): [string, string][] | null {
  // `null` parameter means "no metadata version row exists at all"
  // (the caller passes metadataVersion?.params, which is undefined →
  // null when the version is missing).
  if (paramsJson === null) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(paramsJson);
  } catch {
    return [];
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return [];
  const entries = Object.entries(obj as Record<string, unknown>)
    .filter(([key]) => key.length > 0)
    .map(([key, value]) => [key, stringifyExifValue(value)] as [string, string]);
  // Stable display order — alphabetical on key.
  entries.sort(([a], [b]) => a.localeCompare(b));
  return entries;
}

function stringifyExifValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // Arrays / objects: compact JSON so the table stays one-line per row.
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function labelType(t: MediaItem["type"]): string {
  if (t === "image") return "Image";
  if (t === "video") return "Video";
  return "Unknown";
}

function filenameFromPath(p: string | null): string | null {
  if (p === null || p.length === 0) return null;
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function truncateId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDimensions(w: number | null, h: number | null): string {
  if (w === null && h === null) return "—";
  if (w === null) return `?×${h ?? "?"}`;
  if (h === null) return `${w}×?`;
  return `${w}×${h}`;
}

function formatDuration(d: number | null): string {
  if (d === null) return "—";
  if (d < 60) return `${d.toFixed(1)}s`;
  const m = Math.floor(d / 60);
  const s = Math.round(d - m * 60);
  return `${m}m ${s}s`;
}

function formatTimestamp(iso: string): string {
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z")
      .replace("T", " ");
  } catch {
    return iso;
  }
}
