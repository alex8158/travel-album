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

import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import {
  aiRefineMedia,
  enhanceMedia,
  reprocessMedia,
  selectMediaVersion,
  softDeleteMedia,
  type AiRefineMediaResult,
  type EnhanceMediaResult,
  type MediaActiveVersionType,
  type MediaAnalysisProjection,
  type MediaItem,
  type MediaVersion,
  type MediaVersionView,
  type MediaVersionsView,
  type ReprocessResult,
  type SelectVersionResult,
} from "../api/media";
import { setTripCover } from "../api/trips";
import { useHealth } from "../hooks/useHealth";
import { useMediaDetail } from "../hooks/useMediaDetail";
import { useMediaVersions } from "../hooks/useMediaVersions";

export default function MediaDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { detail, loading, error, refetch } = useMediaDetail(id);
  // P8.T5 — user-facing version list (original + enhanced + future
  // ai_refined). Separate from `detail.versions` (the technical
  // listing of ALL media_versions rows including thumbnail /
  // preview / metadata). The two are kept in parallel: detail.versions
  // for the technical "what files exist" section near the bottom of
  // the page, and `versionsView` here for the user-facing "which one
  // am I looking at" comparison block. The variable is named
  // `versionsView` so it doesn't shadow `detail.versions` (which is
  // destructured a few lines below as `versions`).
  const {
    data: versionsView,
    loading: versionsLoading,
    error: versionsError,
    refetch: refetchVersions,
  } = useMediaVersions(id);

  // P3.T7 reprocess state — local to the page, never persisted.
  // `feedback` carries the last call's outcome and is rendered as
  // an aria-live region under the header until the user takes
  // another action.
  const [reprocessing, setReprocessing] = useState(false);
  const [feedback, setFeedback] = useState<ReprocessFeedback | null>(null);
  // P6.T7 — "Set as cover" affordance. Local state only; success
  // shows a transient confirmation, error reuses the same banner
  // shape so the user always sees an aria-live message.
  const [pinningCover, setPinningCover] = useState(false);
  const [coverFeedback, setCoverFeedback] = useState<CoverFeedback | null>(null);

  // P7.T1 — soft-delete affordance. Modal-confirm flow mirrors the
  // trip soft-delete modal in TripDetailPage so the wording /
  // styling stays consistent. On success we navigate back to the
  // owning trip with `replace: true` so a Back tap doesn't
  // resurrect a now-404 detail page.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // P8.T5 — Enhancement section state. Three independent operations
  // (Adopt / Use original / Re-enhance) each track their own pending
  // flag so one in-flight call doesn't disable the others. A single
  // `enhanceFeedback` banner carries the most recent action's
  // outcome (success / error) until the next click — same shape as
  // the existing Reprocess feedback above.
  const [enhancePending, setEnhancePending] = useState(false);
  const [selectPending, setSelectPending] = useState<MediaActiveVersionType | null>(null);
  const [enhanceFeedback, setEnhanceFeedback] = useState<EnhanceFeedback | null>(null);

  // P10.T6 — AI Refine state. We track three things separately so a
  // pending /ai-refine call doesn't block the user from also doing
  // the (much cheaper) /enhance, and so the confirmation modal can
  // open/close idempotently. The confirmation modal is mandatory
  // per the prompt (AI is paid + slow); the user explicitly
  // acknowledges before we POST.
  const [aiRefinePending, setAiRefinePending] = useState(false);
  const [aiRefineConfirmOpen, setAiRefineConfirmOpen] = useState(false);
  // `aiRefineFeedback` is folded into the shared `enhanceFeedback`
  // banner via a discriminated union so the user only sees one
  // banner under the section header (not three competing rows).
  // The discriminant `kind` carries the "which action" identity.

  // P10.T6 — Health snapshot (used to grey out the AI Refine button
  // when AI_ENABLED=false at the server). Failure-soft: any error
  // surfaces in `health.error` but we still render the page.
  const health = useHealth();
  const aiEnabledOnServer = health.data?.capabilities.aiEnabled ?? false;

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
    if (id === undefined || detail === null || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await softDeleteMedia(id);
      navigate(`/trips/${detail.media.tripId}`, { replace: true });
    } catch (err: unknown) {
      setDeleteError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
    }
  }

  async function handleReprocess(): Promise<void> {
    if (id === undefined || reprocessing) return;
    setReprocessing(true);
    setFeedback(null);
    try {
      const result = await reprocessMedia(id);
      setFeedback({ kind: "success", result });
      // Pull a fresh detail bundle so the user sees the updated
      // job status (e.g. resets show up as `pending` in DB).
      refetch();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setFeedback({ kind: "error", message });
    } finally {
      setReprocessing(false);
    }
  }

  async function handleSetAsCover(): Promise<void> {
    if (id === undefined || detail === null || pinningCover) return;
    setPinningCover(true);
    setCoverFeedback(null);
    try {
      await setTripCover(detail.media.tripId, id);
      setCoverFeedback({ kind: "success" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setCoverFeedback({ kind: "error", message });
    } finally {
      setPinningCover(false);
    }
  }

  // P8.T5 — Re-trigger enhance (P8.T1 backend). Always idempotent
  // on the server side; we just refresh feedback + versions after.
  async function handleEnhance(): Promise<void> {
    if (id === undefined || enhancePending) return;
    setEnhancePending(true);
    setEnhanceFeedback(null);
    try {
      const result = await enhanceMedia(id);
      setEnhanceFeedback({ kind: "enhance-success", result });
      // The job runs asynchronously; refetch versions after a beat
      // so a newly-created enhanced row surfaces without a manual
      // page reload. The hook's stale-while-revalidate keeps the
      // previous list visible during the fetch.
      refetchVersions();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setEnhanceFeedback({ kind: "error", op: "enhance", message });
    } finally {
      setEnhancePending(false);
    }
  }

  // P8.T5 — Switch the active version (P8.T4 backend). Used by both
  // "Adopt enhanced" and "Use original" buttons. After the write we
  // refetch both the detail bundle (so `media.activeVersionType`
  // updates) and the versions view (so `isActive` flags refresh).
  async function handleSelectVersion(versionType: MediaActiveVersionType): Promise<void> {
    if (id === undefined || selectPending !== null) return;
    setSelectPending(versionType);
    setEnhanceFeedback(null);
    try {
      const result = await selectMediaVersion(id, versionType);
      setEnhanceFeedback({ kind: "select-success", result });
      refetch();
      refetchVersions();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setEnhanceFeedback({ kind: "error", op: "select", message });
    } finally {
      setSelectPending(null);
    }
  }

  // P10.T6 — open the confirmation modal. The actual POST happens
  // only after the user clicks "Run AI Refine" inside the modal.
  function openAiRefineConfirm(): void {
    setEnhanceFeedback(null);
    setAiRefineConfirmOpen(true);
  }
  function closeAiRefineConfirm(): void {
    if (aiRefinePending) return; // don't close mid-submit
    setAiRefineConfirmOpen(false);
  }

  // P10.T6 — POST /api/media/:id/ai-refine after the user confirmed
  // the cost / wait dialog. The handler:
  //   * Bails if no id or a refine call is already in flight (the
  //     button is also disabled, this is defence-in-depth).
  //   * Lifts the server's error message into the banner verbatim
  //     so 501 AI_NOT_CONFIGURED, 429 AI_QUOTA_EXCEEDED, 400 / 404
  //     all surface with the server's text (which includes the
  //     "X/Y used (daily)" or "X/Y used (trip)" hint for 429).
  //   * Refetches versions on success — the P10.T5 worker runs
  //     asynchronously on the image channel, so the `ai_refined`
  //     row appears on the next poll once the worker drains.
  async function handleAiRefineConfirmed(): Promise<void> {
    if (id === undefined || aiRefinePending) return;
    setAiRefinePending(true);
    setEnhanceFeedback(null);
    try {
      const result = await aiRefineMedia(id);
      setEnhanceFeedback({ kind: "ai-refine-success", result });
      setAiRefineConfirmOpen(false);
      // Schedule a versions refetch so the freshly-created
      // ai_refined row surfaces once the P10.T5 worker drains. The
      // hook's stale-while-revalidate keeps the previous list
      // visible during the fetch.
      refetchVersions();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setEnhanceFeedback({ kind: "error", op: "ai-refine", message });
      // Keep the modal open on error so the user sees the cause
      // inline; only close on success.
    } finally {
      setAiRefinePending(false);
    }
  }

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
        <div className="page-header-actions">
          {media.type === "video" && (
            // P9.T9 — only video-typed media own video_segments rows.
            // Link surfaces here as a Link (not a button) so right-
            // click "open in new tab" works for power users.
            <Link
              to={`/videos/${media.id}/segments`}
              className="btn-secondary"
              title="View video segments + per-segment quality scores"
            >
              View segments
            </Link>
          )}
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              void handleSetAsCover();
            }}
            disabled={pinningCover || media.type !== "image"}
            title={
              media.type !== "image"
                ? "Only image media can serve as a trip cover"
                : "Pin this image as the trip's cover (auto-cover stops overwriting it)"
            }
          >
            {pinningCover ? "Setting…" : "Set as cover"}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              void handleReprocess();
            }}
            disabled={reprocessing || media.type !== "image"}
            title={
              media.type !== "image"
                ? "Reprocess is only supported for image media in P3.T7"
                : undefined
            }
          >
            {reprocessing ? "Reprocessing…" : "Reprocess"}
          </button>
          <button
            type="button"
            className="btn-danger"
            onClick={openDelete}
            disabled={deleting}
            title="Soft-delete this media (move to trash; files stay on disk)"
          >
            Delete
          </button>
        </div>
      </header>

      {coverFeedback !== null && <CoverFeedbackBanner feedback={coverFeedback} />}
      {feedback !== null && <FeedbackBanner feedback={feedback} />}

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

      {media.type === "image" ? (
        <EnhancementSection
          media={media}
          versions={versionsView}
          versionsLoading={versionsLoading}
          versionsError={versionsError}
          enhancePending={enhancePending}
          selectPending={selectPending}
          feedback={enhanceFeedback}
          aiRefinePending={aiRefinePending}
          aiEnabledOnServer={aiEnabledOnServer}
          healthLoading={health.loading}
          onEnhance={() => {
            void handleEnhance();
          }}
          onSelect={(t) => {
            void handleSelectVersion(t);
          }}
          onAiRefineClick={openAiRefineConfirm}
        />
      ) : null}

      {media.type === "image" ? <QualityAnalysisSection media={media} /> : null}

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

      {deleteOpen && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-media-title"
          aria-describedby="delete-media-body"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeDelete();
          }}
        >
          <div className="modal-card">
            <h2 id="delete-media-title">Delete this photo?</h2>
            <p id="delete-media-body">
              This photo will be moved to the trash. The first version of the app does only soft
              delete, so the original file stays on disk and the photo can be restored later. The
              trip&apos;s cover will be auto-updated if needed.
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
                {deleting ? "Deleting…" : "Delete photo"}
              </button>
            </div>
          </div>
        </div>
      )}

      {aiRefineConfirmOpen && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="ai-refine-title"
          aria-describedby="ai-refine-body"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeAiRefineConfirm();
          }}
        >
          <div className="modal-card">
            <h2 id="ai-refine-title">Run AI Refine?</h2>
            <p id="ai-refine-body">
              This sends the image to the configured AI provider for refinement. It counts
              against your daily / per-trip quota and may incur provider cost. The refine
              runs asynchronously on the image worker — the new <code>ai_refined</code>{" "}
              version will appear in the Versions block once the worker completes (refresh
              the page or wait a moment).
            </p>
            <p id="ai-refine-body-2" className="status-text">
              Your original file is never modified. You can switch back to it any time using
              the <strong>Use original</strong> button.
            </p>
            {enhanceFeedback?.kind === "error" && enhanceFeedback.op === "ai-refine" && (
              <p className="form-error" role="alert">
                {enhanceFeedback.message}
              </p>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={closeAiRefineConfirm}
                disabled={aiRefinePending}
                autoFocus
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  void handleAiRefineConfirmed();
                }}
                disabled={aiRefinePending}
              >
                {aiRefinePending ? "Submitting…" : "Run AI Refine"}
              </button>
            </div>
          </div>
        </div>
      )}
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

// ---------------------------------------------------------------------------
// Enhancement section (P8.T5)
// ---------------------------------------------------------------------------

/**
 * The P8.T5 "compare original vs enhanced + action buttons" block.
 *
 * Renders a small grid where each cell is one user-selectable
 * version (original always present; enhanced shown when a
 * media_versions row of that type exists). The currently-active
 * cell is highlighted with a "✓ Active" pill. Three buttons live
 * under the grid:
 *   * Adopt enhanced  — visible only when enhanced exists; disabled
 *                       when it's already active.
 *   * Use original    — disabled when original is already active.
 *   * Re-enhance      — always enabled (re-enqueues the worker;
 *                       server outcome is created / reset / skipped).
 *
 * Lifecycle states (parallel to other sections on the page):
 *   * versionsLoading + no data → "Loading versions…"
 *   * versionsError              → inline error + Re-enhance still
 *                                  available (manual retry)
 *   * versions loaded            → grid + buttons
 *
 * Failure modes (per button):
 *   * enhance / select calls bubble up as `feedback` banners; the
 *     section itself never crashes on a thrown promise.
 */
interface EnhancementSectionProps {
  readonly media: MediaItem;
  readonly versions: MediaVersionsView | null;
  readonly versionsLoading: boolean;
  readonly versionsError: string | null;
  readonly enhancePending: boolean;
  readonly selectPending: MediaActiveVersionType | null;
  readonly feedback: EnhanceFeedback | null;
  /** P10.T6 — async POST /ai-refine in flight. Disables AI Refine
   * button + "Adopt AI refined" button while true. */
  readonly aiRefinePending: boolean;
  /** P10.T6 — server's `AI_ENABLED` flag, read from /api/health.
   * False ⇒ grey out the AI Refine button + tooltip "AI is not
   * configured". The server still 501s on the actual POST as a
   * second line of defence. */
  readonly aiEnabledOnServer: boolean;
  /** P10.T6 — true on the very first render before /api/health
   * has resolved. Used to disable the AI Refine button while we
   * don't yet know the server's stance. */
  readonly healthLoading: boolean;
  readonly onEnhance: () => void;
  readonly onSelect: (versionType: MediaActiveVersionType) => void;
  /** P10.T6 — open the confirm-cost modal. The actual POST only
   * fires after the user clicks "Run AI Refine" inside that modal. */
  readonly onAiRefineClick: () => void;
}

function EnhancementSection(props: EnhancementSectionProps): JSX.Element {
  const {
    media,
    versions,
    versionsLoading,
    versionsError,
    enhancePending,
    selectPending,
    feedback,
    aiRefinePending,
    aiEnabledOnServer,
    healthLoading,
    onEnhance,
    onSelect,
    onAiRefineClick,
  } = props;

  // Active version: prefer the dedicated versions endpoint's value
  // (most recent server state); fall back to media.activeVersionType
  // for the loading window before /versions returns; default to
  // 'original' (the schema default) so an older server response
  // missing the field still renders sensibly.
  const active: MediaActiveVersionType =
    versions?.activeVersionType ?? media.activeVersionType ?? "original";

  const cells = versions?.versions ?? [];
  const original = cells.find((v) => v.versionType === "original") ?? null;
  const enhanced = cells.find((v) => v.versionType === "enhanced") ?? null;
  const aiRefined = cells.find((v) => v.versionType === "ai_refined") ?? null;

  // P10.T6 — pre-flight gate. The button is greyed out when:
  //   * /api/health is still loading (don't show a "click me!"
  //     button while the server hasn't confirmed AI is on)
  //   * AI_ENABLED=false on the server (default)
  //   * an AI-refine call is already in flight
  //   * a version-switch call is in flight (can't switch + queue
  //     simultaneously; matches the enhance button's policy)
  const aiRefineDisabled =
    healthLoading || !aiEnabledOnServer || aiRefinePending || selectPending !== null;
  const aiRefineTooltip = healthLoading
    ? "Checking AI availability…"
    : !aiEnabledOnServer
      ? "AI provider is not configured on this server. Set AI_ENABLED=true + AI_PROVIDER to enable AI Refine."
      : aiRefinePending
        ? "AI Refine submission in flight…"
        : "Run AI Refine on this image. Counts against daily / per-trip AI quota. Original file stays untouched.";

  return (
    <section className="trip-detail-section media-enhance-section">
      <h2>Versions</h2>
      <p className="status-text">
        Compare the original upload with the enhanced version (P8 sharp pipeline). Adopting a
        version switches which one this media uses for downstream display; the original file is
        always preserved on disk.
      </p>

      {feedback !== null && <EnhanceFeedbackBanner feedback={feedback} />}

      {versionsLoading && versions === null ? (
        <p className="status-text">Loading versions…</p>
      ) : versionsError !== null ? (
        <p className="status-text status-error" role="alert">
          Failed to load versions: {versionsError}
        </p>
      ) : (
        <div className="media-enhance-grid">
          <VersionCell
            label="Original"
            cell={original}
            active={active === "original"}
            mediaType={media.type}
          />
          {enhanced !== null ? (
            <VersionCell
              label="Enhanced"
              cell={enhanced}
              active={active === "enhanced"}
              mediaType={media.type}
            />
          ) : (
            <div className="media-enhance-cell media-enhance-cell--empty">
              <div className="media-enhance-cell-head">
                <span className="media-enhance-cell-label">Enhanced</span>
                <span className="quality-pill" data-tone="neutral">
                  Not yet
                </span>
              </div>
              <div className="media-enhance-cell-placeholder" aria-hidden="true">
                ✨
              </div>
              <p className="status-text">
                No enhanced version yet. Click <em>Enhance</em> below to run the sharp pipeline; the
                output lands here when the image-channel worker finishes.
              </p>
            </div>
          )}
          {aiRefined !== null ? (
            <VersionCell
              label="AI refined"
              cell={aiRefined}
              active={active === "ai_refined"}
              mediaType={media.type}
            />
          ) : (
            <div className="media-enhance-cell media-enhance-cell--empty">
              <div className="media-enhance-cell-head">
                <span className="media-enhance-cell-label">AI refined</span>
                <span className="quality-pill" data-tone="neutral">
                  Not yet
                </span>
              </div>
              <div className="media-enhance-cell-placeholder" aria-hidden="true">
                🤖
              </div>
              <p className="status-text">
                No AI-refined version yet. Click <em>AI Refine</em> below
                {aiEnabledOnServer
                  ? " to enqueue the image_ai_refine worker; the output lands here when the P10.T5 worker finishes."
                  : " — available once an operator enables AI on the server."}
              </p>
            </div>
          )}
        </div>
      )}

      <div className="media-enhance-actions">
        <button
          type="button"
          className="btn-primary"
          onClick={() => onSelect("enhanced")}
          disabled={
            enhanced === null || active === "enhanced" || selectPending !== null || enhancePending
          }
          title={
            enhanced === null
              ? "No enhanced version available yet"
              : active === "enhanced"
                ? "Already using the enhanced version"
                : "Switch this media to use the enhanced version"
          }
        >
          {selectPending === "enhanced" ? "Adopting…" : "Adopt enhanced"}
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => onSelect("original")}
          disabled={active === "original" || selectPending !== null || enhancePending}
          title={
            active === "original"
              ? "Already using the original"
              : "Discard the enhanced selection and switch back to the original"
          }
        >
          {selectPending === "original" ? "Switching…" : "Use original"}
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={onEnhance}
          disabled={enhancePending || selectPending !== null}
          title="Re-enqueue the sharp pipeline for this media. Existing original file stays untouched."
        >
          {enhancePending ? "Submitting…" : enhanced === null ? "Enhance" : "Re-enhance"}
        </button>
        {/* P10.T6 — AI Refine controls. The "Adopt AI refined" button
         * appears only when an ai_refined version exists; the
         * "AI Refine" button is always visible but greyed out when
         * the server reports AI_ENABLED=false (the tooltip explains
         * the gate). Clicking "AI Refine" opens a confirmation
         * modal — the actual POST happens after the user
         * acknowledges the cost / wait. */}
        <button
          type="button"
          className="btn-primary"
          onClick={() => onSelect("ai_refined")}
          disabled={
            aiRefined === null ||
            active === "ai_refined" ||
            selectPending !== null ||
            enhancePending ||
            aiRefinePending
          }
          title={
            aiRefined === null
              ? "No AI-refined version available yet"
              : active === "ai_refined"
                ? "Already using the AI-refined version"
                : "Switch this media to use the AI-refined version"
          }
        >
          {selectPending === "ai_refined" ? "Adopting…" : "Adopt AI refined"}
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={onAiRefineClick}
          disabled={aiRefineDisabled}
          title={aiRefineTooltip}
        >
          {aiRefinePending
            ? "Submitting…"
            : aiRefined === null
              ? "AI Refine"
              : "Re-AI-refine"}
        </button>
      </div>
    </section>
  );
}

interface VersionCellProps {
  readonly label: string;
  readonly cell: MediaVersionView | null;
  readonly active: boolean;
  readonly mediaType: MediaItem["type"];
}

function VersionCell({ label, cell, active, mediaType }: VersionCellProps): JSX.Element {
  // Synthesize a `/storage/...` URL when the cell has a non-empty
  // file path. The 'original' cell of an unknown-typed media has
  // filePath='' and no bytes on disk; show a placeholder instead of
  // an `<img src="">` that would 404.
  const src = cell !== null && cell.filePath.length > 0 ? `/storage/${cell.filePath}` : null;
  const dimsLabel =
    cell !== null && cell.width !== null && cell.height !== null
      ? `${cell.width}×${cell.height}`
      : "—";
  const sizeLabel = cell !== null && cell.fileSize !== null ? formatBytes(cell.fileSize) : "—";
  return (
    <div className="media-enhance-cell" data-active={active ? "true" : "false"}>
      <div className="media-enhance-cell-head">
        <span className="media-enhance-cell-label">{label}</span>
        {active ? (
          <span className="quality-pill" data-tone="positive">
            ✓ Active
          </span>
        ) : (
          <span className="quality-pill" data-tone="neutral">
            Inactive
          </span>
        )}
      </div>
      {src !== null ? (
        <img
          className="media-enhance-cell-img"
          src={src}
          alt={`${label} version preview`}
          loading="lazy"
        />
      ) : (
        <div className="media-enhance-cell-placeholder" aria-hidden="true">
          {mediaType === "image" ? "🖼️" : mediaType === "video" ? "🎞️" : "📄"}
        </div>
      )}
      <dl className="media-card-meta">
        <div>
          <dt>Dimensions</dt>
          <dd>{dimsLabel}</dd>
        </div>
        <div>
          <dt>Size</dt>
          <dd>{sizeLabel}</dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * Three-shape feedback state for the Enhancement section:
 *   * `enhance-success` — POST /enhance returned (job submitted /
 *     reset / skipped); shown until the next action.
 *   * `select-success`  — POST /select-version returned; carries the
 *     previous + new versionType so the banner can say
 *     "Switched from X to Y" (or "Already X" when idempotent).
 *   * `error`           — banner with `op` discriminator so we can
 *     prefix "Enhance failed" vs "Switch failed" properly.
 */
type EnhanceFeedback =
  | { readonly kind: "enhance-success"; readonly result: EnhanceMediaResult }
  | { readonly kind: "select-success"; readonly result: SelectVersionResult }
  | { readonly kind: "ai-refine-success"; readonly result: AiRefineMediaResult }
  | {
      readonly kind: "error";
      readonly op: "enhance" | "select" | "ai-refine";
      readonly message: string;
    };

function EnhanceFeedbackBanner({ feedback }: { feedback: EnhanceFeedback }): JSX.Element {
  if (feedback.kind === "error") {
    const prefix =
      feedback.op === "enhance"
        ? "Enhance failed"
        : feedback.op === "ai-refine"
          ? "AI Refine failed"
          : "Switch failed";
    return (
      <p className="form-error" role="alert">
        {prefix}: {feedback.message}
      </p>
    );
  }
  if (feedback.kind === "enhance-success") {
    const { outcome, reason } = feedback.result;
    const human =
      outcome === "created"
        ? "Submitted — the sharp pipeline will run on the image channel."
        : outcome === "reset"
          ? "Resubmitted — the previous job will rerun on the image channel."
          : `Skipped — ${reason ?? "an enhance job is already pending or running"}.`;
    return (
      <p className="status-text" aria-live="polite">
        Enhance: {human} Refresh the page after a moment to see the result.
      </p>
    );
  }
  if (feedback.kind === "ai-refine-success") {
    // P10.T6 — surface jobId + outcome + auditId. The user sees
    // exactly what got enqueued; debugging an asynchronous AI call
    // becomes possible without diving into server logs.
    const { outcome, jobId, reason, aiInvocationId } = feedback.result;
    const human =
      outcome === "created"
        ? "Submitted — the AI refine worker will run on the image channel."
        : outcome === "reset"
          ? "Resubmitted — the previous AI refine job will rerun on the image channel."
          : `Skipped — ${reason ?? "an AI refine job is already pending or running"}.`;
    return (
      <p className="status-text" aria-live="polite">
        AI Refine: {human} <span className="mono">job={jobId.slice(0, 8)}…</span>{" "}
        {aiInvocationId !== undefined ? (
          <>
            <span className="mono">audit={aiInvocationId.slice(0, 8)}…</span>{" "}
          </>
        ) : null}
        Refresh the page after a moment to see the <code>ai_refined</code> version.
      </p>
    );
  }
  // select-success
  const { previousVersionType, activeVersionType, alreadyActive } = feedback.result;
  if (alreadyActive) {
    return (
      <p className="status-text" aria-live="polite">
        Already using <strong>{activeVersionType}</strong> — no change.
      </p>
    );
  }
  return (
    <p className="status-text" aria-live="polite">
      Switched from <strong>{previousVersionType}</strong> to <strong>{activeVersionType}</strong>.
    </p>
  );
}

// ---------------------------------------------------------------------------
// Quality analysis section (P6.T6)
// ---------------------------------------------------------------------------

/**
 * Renders the `media_analysis` projection. Always renders (so users
 * can see "待分析" for media that hasn't been processed yet) but
 * tolerates every sub-field being null. Each sub-score is shown
 * with two decimal places when present and a dash otherwise.
 */
function QualityAnalysisSection({ media }: { media: MediaItem }): JSX.Element {
  const a = media.analysis ?? null;
  const verdict = computeVerdict(a);
  return (
    <section className="trip-detail-section">
      <h2>Quality analysis</h2>
      {a === null ? (
        <p className="status-text">
          No analysis yet. The per-dimension workers (blur / exposure / colour) populate this once
          they finish on the image channel.
        </p>
      ) : (
        <>
          <p className="media-detail-quality-verdict">
            <span className="quality-pill" data-tone={verdict.tone}>
              {verdict.label}
            </span>
            {a.reason !== null ? (
              <span className="media-detail-quality-reason">{a.reason}</span>
            ) : null}
          </p>
          <dl className="media-detail-info">
            <Field label="Quality score" value={formatScore(a.qualityScore)} />
            <Field label="Sharpness" value={formatScore(a.sharpnessScore)} />
            <Field label="Exposure" value={formatScore(a.exposureScore)} />
            <Field label="Colour" value={formatScore(a.colorScore)} />
            <Field label="Blur verdict" value={describeBlurry(a.isBlurry, a.labels)} />
            <Field label="Labels" value={describeLabels(a.labels)} />
          </dl>
        </>
      )}
    </section>
  );
}

interface QualityVerdict {
  readonly label: string;
  readonly tone: "positive" | "neutral" | "warning" | "negative";
}

/**
 * Map the composite quality_score onto one of four UI buckets. Thresholds
 * mirror the gallery-card pill (TripDetailPage). Returning a neutral
 * "待判断" for the middle band keeps the verdict honest — the worker
 * didn't flag the photo either way.
 */
function computeVerdict(a: MediaAnalysisProjection | null): QualityVerdict {
  if (a === null || a.qualityScore === null) {
    return { label: "待分析", tone: "neutral" };
  }
  if (a.qualityScore >= 0.75) return { label: "推荐保留", tone: "positive" };
  if (a.qualityScore < 0.5) return { label: "建议删除", tone: "negative" };
  return { label: "待判断", tone: "neutral" };
}

function formatScore(v: number | null): string {
  if (v === null) return "—";
  return v.toFixed(3);
}

function describeBlurry(isBlurry: 0 | 1 | null, labels: readonly string[] | null): string {
  if (isBlurry === 1) return "模糊";
  if (isBlurry === 0) return "清晰";
  if (labels !== null && labels.includes("maybe-blurry")) return "疑似模糊";
  return "—";
}

function describeLabels(labels: readonly string[] | null): React.ReactNode {
  if (labels === null || labels.length === 0) return "—";
  return labels.join("，");
}

// ---------------------------------------------------------------------------
// Reprocess feedback (P3.T7)
// ---------------------------------------------------------------------------

type ReprocessFeedback =
  | { readonly kind: "success"; readonly result: ReprocessResult }
  | { readonly kind: "error"; readonly message: string };

function FeedbackBanner({ feedback }: { feedback: ReprocessFeedback }): JSX.Element {
  if (feedback.kind === "error") {
    return (
      <p className="form-error" role="alert">
        Reprocess failed: {feedback.message}
      </p>
    );
  }
  const summary = feedback.result.results
    .map((r) => `${r.jobType}=${r.outcome}${r.reason !== undefined ? ` (${r.reason})` : ""}`)
    .join(" · ");
  return (
    <p className="status-text" aria-live="polite">
      Reprocess queued — {summary}. The image-channel worker picks them up on its next tick; refresh
      the page after a moment to see updated statuses.
    </p>
  );
}

// P6.T7 — "Set as cover" feedback. Mirrors the FeedbackBanner shape
// so the user always sees an aria-live confirmation; the success
// case has no result payload (the server returns the updated trip
// but the user doesn't need it on this page).
type CoverFeedback =
  | { readonly kind: "success" }
  | { readonly kind: "error"; readonly message: string };

function CoverFeedbackBanner({ feedback }: { feedback: CoverFeedback }): JSX.Element {
  if (feedback.kind === "error") {
    return (
      <p className="form-error" role="alert">
        Could not set as cover: {feedback.message}
      </p>
    );
  }
  return (
    <p className="status-text" aria-live="polite">
      Set as cover — this image is now pinned. The auto-cover selector won&apos;t overwrite it.
    </p>
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
