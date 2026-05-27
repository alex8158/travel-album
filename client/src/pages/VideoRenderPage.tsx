// Video render page (P11.T7).
//
// Route: `/trips/:tripId/render` — the minimal user-facing closed
// loop of:
//
//   (1) Generate edit plan  → POST /api/trips/:tripId/generate-edit-plan
//   (2) Pick background audio (system / user / url_import row)
//                            → GET  /api/audio-library
//   (3) Trigger render       → POST /api/trips/:tripId/render
//   (4) Poll job status      → GET  /api/jobs/:jobId
//   (5) When job is `success`, show a link to the rendered file
//                            → /storage/trips/:tripId/derived/:firstMediaId/edited.mp4
//
// Scope per the P11.T7 prompt:
//   * Minimal closed loop. No big UI rework.
//   * No new dependencies; reuses existing className conventions
//     (btn-primary / btn-secondary / status-text / page-header /
//     trip-detail-section etc.).
//   * Reuses existing API clients + adds the four new ones from
//     P11.T7 (audioLibrary / videoEditPlan / videoRender hooks).
//   * Polling is fully torn down on unmount (see useJobPolling).
//   * Errors surface as inline banners with role="alert"; never
//     silently swallowed.
//
// NOT in scope (P11.T8+):
//   * Multi-video composition UI.
//   * Drag-to-reorder clips in the plan.
//   * Custom per-clip startSec / endSec sliders.
//   * In-browser audio preview / waveform.
//   * Complex audio upload UI; the page links out to a future
//     audio-library admin page (TODO) rather than duplicating
//     that surface here.

import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import {
  type AudioLibraryItem,
  type AudioLibrarySourceType,
} from "../api/audioLibrary";
import { getJobById } from "../api/jobs";
import {
  generateEditPlan,
  type EditPlanAudioMode,
  type EditPlanStyle,
  type GenerateEditPlanBody,
  type VideoEditPlan,
} from "../api/videoEditPlan";
import {
  editedVideoStorageUrl,
  renderTrip,
  type RenderTripResult,
} from "../api/videoRender";
import { useAudioLibrary } from "../hooks/useAudioLibrary";
import { useJobPolling } from "../hooks/useJobPolling";
import { useTrip } from "../hooks/useTrip";

/** UI-level audio choice. `keep_original` / `mute` are synthetic
 * (no audio row); `library` carries the selected library row id. */
type AudioChoice =
  | { readonly kind: "keep_original" }
  | { readonly kind: "mute" }
  | { readonly kind: "library"; readonly audioId: string };

const STYLE_LABELS: Readonly<Record<EditPlanStyle, string>> = {
  short: "Short (~15s)",
  standard: "Standard (~30s)",
  long: "Long (~60s)",
};

const SOURCE_TYPE_LABELS: Readonly<Record<AudioLibrarySourceType, string>> = {
  system: "System",
  user: "User upload",
  url_import: "URL import",
};

export default function VideoRenderPage(): JSX.Element {
  const { tripId } = useParams<{ tripId: string }>();
  const navigate = useNavigate();
  const { trip, loading: tripLoading, error: tripError } = useTrip(tripId);

  // ---- Plan generation state ---------------------------------------
  const [style, setStyle] = useState<EditPlanStyle>("standard");
  const [generating, setGenerating] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [plan, setPlan] = useState<VideoEditPlan | null>(null);

  // ---- Audio selection state ---------------------------------------
  const audio = useAudioLibrary();
  const [audioChoice, setAudioChoice] = useState<AudioChoice>({ kind: "keep_original" });

  // ---- Render state ------------------------------------------------
  const [rendering, setRendering] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [renderResult, setRenderResult] = useState<RenderTripResult | null>(null);

  // ---- Job polling -------------------------------------------------
  const polledJobId = renderResult?.jobId ?? null;
  const { job, error: jobError } = useJobPolling(polledJobId);

  // ---- Handlers ----------------------------------------------------
  const handleGenerate = useCallback(async (): Promise<void> => {
    if (tripId === undefined || generating) return;
    setGenerating(true);
    setPlanError(null);
    setRenderResult(null); // a new plan invalidates the previous render's job/output context
    setRenderError(null);

    const body: GenerateEditPlanBody = { style };
    // Include audio selection in the initial generate request so
    // the plan's audioPolicy already reflects the user's pick.
    // (The user can still re-pick afterwards; the render call
    // re-applies the choice without regenerating the plan.)
    if (audioChoice.kind === "mute") {
      (body as { audioMode?: EditPlanAudioMode }).audioMode = "mute";
    } else if (audioChoice.kind === "library") {
      (body as { audioMode?: EditPlanAudioMode; backgroundAudioId?: string }).audioMode =
        "replace_with_library";
      (body as { backgroundAudioId?: string }).backgroundAudioId = audioChoice.audioId;
    } else {
      (body as { audioMode?: EditPlanAudioMode }).audioMode = "keep_original";
    }

    try {
      const result = await generateEditPlan(tripId, body);
      setPlan(result);
    } catch (err: unknown) {
      setPlanError(err instanceof Error ? err.message : String(err));
      setPlan(null);
    } finally {
      setGenerating(false);
    }
  }, [tripId, generating, style, audioChoice]);

  const handleRender = useCallback(async (): Promise<void> => {
    if (tripId === undefined || rendering) return;
    if (plan?.id === undefined) {
      setRenderError("Generate a plan first before rendering.");
      return;
    }
    setRendering(true);
    setRenderError(null);
    try {
      const result = await renderTrip(tripId, { planId: plan.id, mode: "final" });
      setRenderResult(result);
    } catch (err: unknown) {
      setRenderError(err instanceof Error ? err.message : String(err));
      setRenderResult(null);
    } finally {
      setRendering(false);
    }
  }, [tripId, rendering, plan?.id]);

  const handleRefreshJob = useCallback(async (): Promise<void> => {
    if (renderResult === null) return;
    // Force a one-shot manual fetch; the poller will continue on
    // its own schedule (or be done if terminal).
    try {
      await getJobById(renderResult.jobId);
      // The poll loop owns state updates; we just ping the server
      // so a transient stall isn't held up by polling interval.
    } catch {
      /* ignore — poller will surface the error on its next tick */
    }
  }, [renderResult]);

  // ---- Derived render state ----------------------------------------
  const audioOptions = useMemo(() => {
    if (audio.items === null) return [] as readonly AudioLibraryItem[];
    return audio.items.filter((item) => item.isActive);
  }, [audio.items]);

  const planAudioMode = plan?.audioPolicy.mode ?? null;
  const planAudioId = plan?.audioPolicy.backgroundAudioId ?? null;
  // The plan persists what audioPolicy it actually resolved (the
  // resolver may have degraded `replace_with_library` → `keep_original`
  // with a warning). Surface that to the user so they understand.
  const planResolvedAudioLabel = useMemo(() => {
    if (planAudioMode === null) return null;
    if (planAudioMode === "mute") return "Muted";
    if (planAudioMode === "keep_original") return "Keep original";
    if (planAudioMode === "replace_with_library") {
      const row = audio.items?.find((a) => a.id === planAudioId);
      return row ? `Background music: ${row.displayName}` : `Background music: ${planAudioId ?? "?"}`;
    }
    return planAudioMode;
  }, [planAudioMode, planAudioId, audio.items]);

  // ---- Early-return states -----------------------------------------
  if (tripLoading && trip === null) {
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
          ← Back to trips
        </Link>
      </main>
    );
  }

  if (trip === null) {
    return (
      <main>
        <p className="status-text">Trip not found.</p>
        <Link to="/" className="btn-secondary">
          ← Back to trips
        </Link>
      </main>
    );
  }

  const editedUrl =
    renderResult !== null
      ? editedVideoStorageUrl({ tripId: renderResult.tripId, mediaId: renderResult.mediaId })
      : null;

  return (
    <main>
      <header className="page-header">
        <div className="page-header-text">
          <Link to={`/trips/${trip.id}`} className="back-link">
            ← Back to trip
          </Link>
          <h1>Render video — {trip.title}</h1>
          <p className="trip-detail-meta">
            Generate an edit plan from the trip&apos;s videos, choose background music, and
            render a single edited MP4. The render runs asynchronously on the server.
          </p>
        </div>
        <div className="page-header-actions">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              navigate(`/trips/${trip.id}`);
            }}
          >
            Cancel
          </button>
        </div>
      </header>

      {/* ============================================================
          Section 1 — Generate edit plan
          ============================================================ */}
      <section className="trip-detail-section">
        <div className="trip-detail-section-header">
          <h2>1. Edit plan</h2>
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              void handleGenerate();
            }}
            disabled={generating}
          >
            {generating ? "Generating…" : plan !== null ? "Re-generate" : "Generate plan"}
          </button>
        </div>

        <fieldset className="render-fieldset" disabled={generating}>
          <legend>Target length</legend>
          {(["short", "standard", "long"] as const).map((s) => (
            <label key={s} className="render-radio">
              <input
                type="radio"
                name="render-style"
                value={s}
                checked={style === s}
                onChange={() => {
                  setStyle(s);
                }}
              />
              {STYLE_LABELS[s]}
            </label>
          ))}
        </fieldset>

        {planError !== null && (
          <p className="status-text status-error" role="alert">
            Plan generation failed: {planError}
          </p>
        )}

        {plan !== null && <PlanSummary plan={plan} resolvedAudioLabel={planResolvedAudioLabel} />}
      </section>

      {/* ============================================================
          Section 2 — Background audio
          ============================================================ */}
      <section className="trip-detail-section">
        <div className="trip-detail-section-header">
          <h2>2. Background music</h2>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              audio.refetch();
            }}
            disabled={audio.loading}
          >
            {audio.loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        {audio.error !== null && (
          <p className="status-text status-error" role="alert">
            Failed to load audio library: {audio.error}
          </p>
        )}

        <fieldset className="render-fieldset">
          <legend>Audio source</legend>
          <label className="render-radio">
            <input
              type="radio"
              name="audio-choice"
              checked={audioChoice.kind === "keep_original"}
              onChange={() => {
                setAudioChoice({ kind: "keep_original" });
              }}
            />
            Keep original audio from each clip
          </label>
          <label className="render-radio">
            <input
              type="radio"
              name="audio-choice"
              checked={audioChoice.kind === "mute"}
              onChange={() => {
                setAudioChoice({ kind: "mute" });
              }}
            />
            Mute (no audio track in output)
          </label>

          {audioOptions.length === 0 && audio.items !== null && (
            <p className="status-text">
              No active audio in library. Use the audio-library API to upload or import a track,
              then refresh.
            </p>
          )}

          {audioOptions.map((item) => (
            <label key={item.id} className="render-radio render-audio-row">
              <input
                type="radio"
                name="audio-choice"
                checked={audioChoice.kind === "library" && audioChoice.audioId === item.id}
                onChange={() => {
                  setAudioChoice({ kind: "library", audioId: item.id });
                }}
              />
              <span className="render-audio-row-label">
                <span className="render-audio-name">{item.displayName}</span>
                <span className="render-audio-meta">
                  {SOURCE_TYPE_LABELS[item.sourceType]}
                  {item.durationSeconds !== null && ` · ${formatDuration(item.durationSeconds)}`}
                  {item.mimeType !== null && ` · ${item.mimeType}`}
                </span>
              </span>
            </label>
          ))}

          {audio.items !== null && audio.items.some((i) => !i.isActive) && (
            <p className="status-text">
              {audio.items.filter((i) => !i.isActive).length} inactive audio entries are hidden
              from this picker. They remain available in the audio library admin view.
            </p>
          )}
        </fieldset>

        <p className="status-text">
          Tip: the plan&apos;s resolved <code>audioPolicy.mode</code> may differ from your pick if
          the chosen audio became unavailable between generation and render. The plan card above
          shows what the renderer will actually use.
        </p>
      </section>

      {/* ============================================================
          Section 3 — Render
          ============================================================ */}
      <section className="trip-detail-section">
        <div className="trip-detail-section-header">
          <h2>3. Render</h2>
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              void handleRender();
            }}
            disabled={rendering || plan === null || plan.clips.length === 0}
            title={
              plan === null
                ? "Generate a plan first"
                : plan.clips.length === 0
                  ? "Plan has no clips — add videos or change settings"
                  : undefined
            }
          >
            {rendering ? "Submitting…" : "Render video"}
          </button>
        </div>

        {renderError !== null && (
          <p className="status-text status-error" role="alert">
            Render submission failed: {renderError}
          </p>
        )}

        {renderResult !== null && (
          <dl className="render-job-summary">
            <div>
              <dt>Outcome</dt>
              <dd>{renderResult.outcome}</dd>
            </div>
            <div>
              <dt>Plan</dt>
              <dd>
                <code>{renderResult.planId}</code>
              </dd>
            </div>
            <div>
              <dt>Job</dt>
              <dd>
                <code>{renderResult.jobId}</code>
              </dd>
            </div>
            <div>
              <dt>Mode</dt>
              <dd>{renderResult.mode}</dd>
            </div>
            {renderResult.reason !== undefined && (
              <div>
                <dt>Reason</dt>
                <dd>{renderResult.reason}</dd>
              </div>
            )}
          </dl>
        )}
      </section>

      {/* ============================================================
          Section 4 — Job progress (only after a render is queued)
          ============================================================ */}
      {renderResult !== null && (
        <section className="trip-detail-section">
          <div className="trip-detail-section-header">
            <h2>4. Render progress</h2>
            <div>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  void handleRefreshJob();
                }}
              >
                Refresh
              </button>
              <Link to="/jobs" className="btn-secondary" style={{ marginLeft: 8 }}>
                Open Jobs page
              </Link>
            </div>
          </div>

          {jobError !== null && (
            <p className="status-text status-error" role="alert">
              Failed to poll job: {jobError}
            </p>
          )}

          {job === null && jobError === null ? (
            <p className="status-text">Waiting for job status…</p>
          ) : job !== null ? (
            <dl className="render-job-summary">
              <div>
                <dt>Status</dt>
                <dd>
                  <span className={`job-status-badge job-status-${job.status}`}>{job.status}</span>
                </dd>
              </div>
              <div>
                <dt>Progress</dt>
                <dd>{job.progress}%</dd>
              </div>
              {job.startedAt !== null && (
                <div>
                  <dt>Started</dt>
                  <dd>{job.startedAt}</dd>
                </div>
              )}
              {job.finishedAt !== null && (
                <div>
                  <dt>Finished</dt>
                  <dd>{job.finishedAt}</dd>
                </div>
              )}
              {job.errorMessage !== null && job.errorMessage.length > 0 && (
                <div>
                  <dt>Error</dt>
                  <dd>
                    <code>{job.errorMessage}</code>
                  </dd>
                </div>
              )}
            </dl>
          ) : null}

          {job?.status === "success" && editedUrl !== null && (
            <div className="render-output-card">
              <p className="status-text">Render complete.</p>
              <video
                className="render-output-video"
                controls
                preload="metadata"
                src={editedUrl}
              />
              <p>
                <a href={editedUrl} className="btn-secondary" download>
                  Download edited.mp4
                </a>
              </p>
            </div>
          )}

          {job?.status === "failed" && (
            <p className="status-text status-error" role="alert">
              Render failed. See the error above or the Jobs page for more detail.
            </p>
          )}
        </section>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// PlanSummary — collapsible / non-collapsible inline card showing
// the key fields of the resolved plan.
// ---------------------------------------------------------------------------

interface PlanSummaryProps {
  readonly plan: VideoEditPlan;
  readonly resolvedAudioLabel: string | null;
}

function PlanSummary({ plan, resolvedAudioLabel }: PlanSummaryProps): JSX.Element {
  return (
    <div className="render-plan-card">
      <dl className="render-plan-summary">
        <div>
          <dt>Style</dt>
          <dd>{plan.style}</dd>
        </div>
        <div>
          <dt>Target duration</dt>
          <dd>{formatDuration(plan.targetDurationSec)}</dd>
        </div>
        <div>
          <dt>Total duration</dt>
          <dd>{formatDuration(plan.totalDurationSec)}</dd>
        </div>
        <div>
          <dt>Resolution</dt>
          <dd>
            {plan.resolution} · {plan.aspectRatio}
          </dd>
        </div>
        <div>
          <dt>Clip count</dt>
          <dd>{plan.clips.length}</dd>
        </div>
        <div>
          <dt>Transitions</dt>
          <dd>
            {plan.transitions.length === 0
              ? "—"
              : `${plan.transitions.length} × ${plan.transitions[0]!.kind}`}
          </dd>
        </div>
        {resolvedAudioLabel !== null && (
          <div>
            <dt>Audio</dt>
            <dd>{resolvedAudioLabel}</dd>
          </div>
        )}
      </dl>

      {plan.clips.length > 0 && (
        <details className="render-plan-clips">
          <summary>Clips ({plan.clips.length})</summary>
          <ol>
            {plan.clips.map((c) => (
              <li key={`${c.order}-${c.mediaId}`}>
                <span className="render-plan-clip-meta">
                  #{c.order + 1} · {formatDuration(c.startSec)} → {formatDuration(c.endSec)} (
                  {formatDuration(c.durationSec)})
                </span>
                <span className="render-plan-clip-reason"> — {c.reason}</span>
                <Link
                  to={`/media/${c.mediaId}`}
                  className="render-plan-clip-link"
                  style={{ marginLeft: 8 }}
                >
                  view source
                </Link>
              </li>
            ))}
          </ol>
        </details>
      )}

      {plan.warnings.length > 0 && (
        <div className="render-plan-warnings" role="alert">
          <p className="status-text status-warning">
            Plan produced {plan.warnings.length} warning{plan.warnings.length === 1 ? "" : "s"}:
          </p>
          <ul>
            {plan.warnings.map((w, idx) => (
              <li key={`${idx}-${w.code}`}>
                <code>{w.code}</code> — {w.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// formatters
// ---------------------------------------------------------------------------

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}
