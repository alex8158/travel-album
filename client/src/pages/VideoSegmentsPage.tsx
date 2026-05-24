// Video segments page (P9.T9).
//
// Mounted at /videos/:mediaId/segments. Reached from a "View segments"
// button on the media detail page (P3.T6 / P9.T9 link addition) — the
// MediaDetailPage surfaces it only for video-typed media.
//
// What it renders, in order:
//   1. Back link to the owning media detail page.
//   2. Header with the media's id + duration + total segments + a
//      "Re-analyse" + "Re-analyse from scratch" pair of buttons. The
//      second button (force=true) goes through a confirmation modal
//      that explicitly warns about wiping `user_decision`.
//   3. aria-live feedback banner for the last PATCH / process call.
//   4. A keyframe strip: the P9.T5 manifest summary inlined in the
//      list response. Each thumbnail is /storage/... and lazy-loads.
//   5. A list of segment cards. Per segment:
//        * time range (start → end, duration)
//        * waste_type pill + quality / blur badges
//        * keyframes that fall inside the segment's time interval
//        * "保留 / 删除 / 重置" buttons → PATCH /user-decision
//        * "Show reason" toggle reveals the worker's reason string +
//          the segment's stored file path (download link).
//
// Three lifecycle states:
//   * loading
//   * error (404 / 400 from API surface here with a clear banner)
//   * loaded (empty segments[] is a valid "pipeline not yet run" state
//     — we render a clear empty card with a CTA to click "Re-analyse")
//
// Scope (P9.T9 — read + user_decision write + process enqueue, only):
//   * No video player / scrubber. The keyframe strip is the V1
//     visualization; a future task can layer a real player on top.
//   * No batch operations (multi-select keep/remove). Per-segment
//     buttons only.
//   * No segment editing (re-cropping a segment's time range, etc.).
//   * No AI-driven re-rank. The API only writes user_decision; system
//     scores are read-only from this UI's POV.
//   * No clipping / export. design.md §8.3 defers that to a later phase.

import { useCallback, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

import type {
  KeyframeEntry,
  ProcessVideoSegmentsResponse,
  UpdateUserDecisionResponse,
  VideoSegment,
  VideoSegmentUserDecision,
  VideoSegmentWasteType,
} from "../api/video";
import { processVideoSegments, updateSegmentUserDecision } from "../api/video";
import { useVideoSegments } from "../hooks/useVideoSegments";

const USER_DECISIONS: readonly VideoSegmentUserDecision[] = ["keep", "remove", "undecided"];

export default function VideoSegmentsPage(): JSX.Element {
  const { mediaId } = useParams<{ mediaId: string }>();
  const { data, loading, error, refetch } = useVideoSegments(mediaId);

  // Local state for write operations. The hook is stale-while-
  // revalidate, but PATCHes touch one row at a time and we want the
  // UI to flip the button instantly without waiting for refetch —
  // so each PATCH optimistically merges the server's returned row
  // into a local override map keyed by segment id.
  const [decisionOverrides, setDecisionOverrides] = useState<
    Record<string, VideoSegmentUserDecision>
  >({});
  const [decisionPending, setDecisionPending] = useState<Record<string, boolean>>({});

  const [processing, setProcessing] = useState(false);
  const [processFeedback, setProcessFeedback] = useState<ProcessFeedback | null>(null);
  const [decisionFeedback, setDecisionFeedback] = useState<DecisionFeedback | null>(null);

  const [forceModalOpen, setForceModalOpen] = useState(false);

  const handleDecision = useCallback(
    async (segmentId: string, userDecision: VideoSegmentUserDecision) => {
      if (decisionPending[segmentId]) return;
      setDecisionPending((prev) => ({ ...prev, [segmentId]: true }));
      setDecisionFeedback(null);
      try {
        const result = await updateSegmentUserDecision(segmentId, userDecision);
        setDecisionOverrides((prev) => ({ ...prev, [segmentId]: result.userDecision }));
        setDecisionFeedback({ kind: "success", result });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        setDecisionFeedback({ kind: "error", message, segmentId });
      } finally {
        setDecisionPending((prev) => {
          const next = { ...prev };
          delete next[segmentId];
          return next;
        });
      }
    },
    [decisionPending],
  );

  const handleProcess = useCallback(
    async (force: boolean) => {
      if (mediaId === undefined || processing) return;
      setProcessing(true);
      setProcessFeedback(null);
      try {
        const result = await processVideoSegments(mediaId, force);
        setProcessFeedback({ kind: "success", result });
        // Clear optimistic decision overrides — the server may have
        // wiped (force=true) or remapped (force=false via R-107
        // overlap mapping) `user_decision` on the next worker tick.
        // We can't predict the outcome here, so we drop the cache
        // and let `refetch` repopulate from the source of truth
        // once the worker drains.
        setDecisionOverrides({});
        refetch();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        setProcessFeedback({ kind: "error", message });
      } finally {
        setProcessing(false);
      }
    },
    [mediaId, processing, refetch],
  );

  const handleForceConfirm = useCallback(() => {
    setForceModalOpen(false);
    void handleProcess(true);
  }, [handleProcess]);

  if (loading) {
    return (
      <main>
        <p className="status-text" aria-live="polite">
          Loading segments…
        </p>
      </main>
    );
  }

  if (error !== null) {
    return (
      <main>
        <header className="page-header">
          <div className="page-header-text">
            <Link to={mediaId ? `/media/${mediaId}` : "/"} className="back-link">
              ← Back to media
            </Link>
            <h1>Video segments</h1>
          </div>
        </header>
        <p className="status-text status-error" role="alert">
          Failed to load segments: {error}
        </p>
      </main>
    );
  }

  if (data === null || mediaId === undefined) {
    // Defensive — unreachable when !loading && !error.
    return null as unknown as JSX.Element;
  }

  const segments = data.segments;
  const keyframes = data.keyframes;

  return (
    <main>
      <header className="page-header">
        <div className="page-header-text">
          <Link to={`/media/${mediaId}`} className="back-link">
            ← Back to media
          </Link>
          <h1>Video segments</h1>
          <p className="trip-detail-meta">
            <span className="trip-detail-meta-label">Media:</span>{" "}
            <span className="mono">{truncateId(mediaId)}</span> ·{" "}
            <span className="trip-detail-meta-label">Duration:</span>{" "}
            {formatSeconds(data.mediaDurationSec)} ·{" "}
            <span className="trip-detail-meta-label">Segments:</span> {segments.length}
            {keyframes !== null && (
              <>
                {" "}
                · <span className="trip-detail-meta-label">Keyframes:</span>{" "}
                {keyframes.frameCount}
              </>
            )}
          </p>
        </div>
        <div className="page-header-actions">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              void handleProcess(false);
            }}
            disabled={processing}
            title="Re-run the video segmenter + keyframe extractor + quality scorer. Your manual keep/remove choices are preserved when the new segment boundaries overlap the old ones by ≥ 50%."
          >
            {processing ? "Submitting…" : "Re-analyse"}
          </button>
          <button
            type="button"
            className="btn-danger"
            onClick={() => setForceModalOpen(true)}
            disabled={processing}
            title="Wipe all manual keep/remove choices and re-run from scratch."
          >
            Re-analyse from scratch
          </button>
        </div>
      </header>

      {processFeedback !== null && <ProcessFeedbackBanner feedback={processFeedback} />}
      {decisionFeedback !== null && <DecisionFeedbackBanner feedback={decisionFeedback} />}

      {keyframes !== null && keyframes.frames.length > 0 && (
        <KeyframeStrip keyframes={keyframes.frames} totalDurationSec={data.mediaDurationSec} />
      )}

      <section className="video-segments-list-wrap">
        <h2 className="video-segments-section-h">Segments</h2>
        {segments.length === 0 ? (
          <p className="status-text">
            No segments yet. Click <strong>Re-analyse</strong> above to run the video pipeline.
          </p>
        ) : (
          <ul className="video-segments-list" aria-label="Video segments">
            {segments.map((segment) => (
              <SegmentCard
                key={segment.id}
                segment={segment}
                keyframes={keyframes?.frames ?? []}
                effectiveDecision={decisionOverrides[segment.id] ?? segment.userDecision}
                decisionPending={Boolean(decisionPending[segment.id])}
                onDecide={handleDecision}
              />
            ))}
          </ul>
        )}
      </section>

      {forceModalOpen && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="force-process-title"
          aria-describedby="force-process-body"
          onClick={(e) => {
            if (e.target === e.currentTarget && !processing) setForceModalOpen(false);
          }}
        >
          <div className="modal-card">
            <h2 id="force-process-title">Re-analyse from scratch?</h2>
            <p id="force-process-body">
              This will wipe all manual <strong>keep</strong> / <strong>remove</strong>{" "}
              choices on this video&apos;s segments before re-running the pipeline. Quality
              scores will also be recomputed. Use the regular <strong>Re-analyse</strong>{" "}
              button instead if you want to keep your existing choices (they are remapped to
              whichever new segment overlaps each old one by at least 50%).
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setForceModalOpen(false)}
                disabled={processing}
                autoFocus
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-danger"
                onClick={handleForceConfirm}
                disabled={processing}
              >
                {processing ? "Submitting…" : "Wipe & re-analyse"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Keyframe strip
// ---------------------------------------------------------------------------

interface KeyframeStripProps {
  readonly keyframes: readonly KeyframeEntry[];
  readonly totalDurationSec: number | null;
}

function KeyframeStrip({ keyframes, totalDurationSec }: KeyframeStripProps): JSX.Element {
  void totalDurationSec;
  return (
    <section className="video-keyframe-strip-wrap" aria-label="Keyframe timeline">
      <h2 className="video-segments-section-h">Keyframes</h2>
      <ol className="video-keyframe-strip">
        {keyframes.map((frame) => (
          <li key={frame.index} className="video-keyframe-strip-item">
            <img
              className="video-keyframe-img"
              src={`/storage/${frame.filePath}`}
              alt={`Keyframe ${frame.index} at ${formatSeconds(frame.timestampSec)}`}
              loading="lazy"
              width={frame.width}
              height={frame.height}
            />
            <span className="video-keyframe-time">{formatSeconds(frame.timestampSec)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Segment card
// ---------------------------------------------------------------------------

interface SegmentCardProps {
  readonly segment: VideoSegment;
  readonly keyframes: readonly KeyframeEntry[];
  /** May be the optimistic override OR the server's stored value. */
  readonly effectiveDecision: VideoSegmentUserDecision;
  readonly decisionPending: boolean;
  readonly onDecide: (segmentId: string, decision: VideoSegmentUserDecision) => void;
}

function SegmentCard({
  segment,
  keyframes,
  effectiveDecision,
  decisionPending,
  onDecide,
}: SegmentCardProps): JSX.Element {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const inSegmentKeyframes = useMemo(
    () =>
      keyframes.filter(
        (f) => f.timestampSec >= segment.startTime && f.timestampSec < segment.endTime,
      ),
    [keyframes, segment.startTime, segment.endTime],
  );
  const wasteLabel = labelWasteType(segment.wasteType);
  const wasteTone = toneForWasteType(segment.wasteType);
  return (
    <li
      className="video-segment-card"
      data-waste-type={segment.wasteType}
      data-user-decision={effectiveDecision}
      data-recommended={segment.isRecommended ? "true" : "false"}
    >
      <header className="video-segment-card-head">
        <div className="video-segment-card-time">
          <span className="video-segment-card-range">
            {formatSeconds(segment.startTime)} – {formatSeconds(segment.endTime)}
          </span>
          <span className="video-segment-card-duration">
            ({formatSeconds(segment.duration)})
          </span>
        </div>
        <div className="video-segment-card-badges">
          <span className="quality-pill" data-tone={wasteTone} title={`waste_type=${segment.wasteType}`}>
            {wasteLabel}
          </span>
          {segment.isRecommended && (
            <span className="quality-pill" data-tone="positive" title="System recommends keeping this segment">
              ★ Recommended
            </span>
          )}
          {segment.qualityScore !== null && (
            <span
              className="quality-pill"
              data-tone={toneForScore(segment.qualityScore)}
              title="Composite quality_score = blur_score × (1 − blackRatio)"
            >
              Q {segment.qualityScore.toFixed(2)}
            </span>
          )}
          {segment.blurScore !== null && (
            <span
              className="quality-pill"
              data-tone="neutral"
              title="Normalised sharpness — higher = sharper"
            >
              Blur {segment.blurScore.toFixed(2)}
            </span>
          )}
          {segment.stabilityScore !== null && (
            <span className="quality-pill" data-tone="neutral" title="stability_score">
              Stab {segment.stabilityScore.toFixed(2)}
            </span>
          )}
        </div>
      </header>

      {inSegmentKeyframes.length > 0 && (
        <ol className="video-segment-card-frames" aria-label="Keyframes inside this segment">
          {inSegmentKeyframes.map((frame) => (
            <li key={frame.index} className="video-segment-card-frame">
              <img
                src={`/storage/${frame.filePath}`}
                alt={`Keyframe ${frame.index} at ${formatSeconds(frame.timestampSec)}`}
                loading="lazy"
                width={frame.width}
                height={frame.height}
              />
            </li>
          ))}
        </ol>
      )}

      <div className="video-segment-card-decisions" role="group" aria-label="User decision">
        {USER_DECISIONS.map((decision) => {
          const active = effectiveDecision === decision;
          return (
            <button
              key={decision}
              type="button"
              className={active ? "btn-primary" : "btn-secondary"}
              aria-pressed={active}
              disabled={decisionPending}
              onClick={() => {
                onDecide(segment.id, decision);
              }}
              data-decision={decision}
            >
              {decisionLabel(decision)}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        className="video-segment-card-disclosure"
        aria-expanded={detailsOpen}
        onClick={() => setDetailsOpen((v) => !v)}
      >
        {detailsOpen ? "▾ Hide details" : "▸ Show details"}
      </button>
      {detailsOpen && (
        <dl className="video-segment-card-details">
          <div>
            <dt>Segment id</dt>
            <dd className="mono">{segment.id}</dd>
          </div>
          <div>
            <dt>File</dt>
            <dd>
              <a className="mono" href={`/storage/${segment.filePath}`}>
                {segment.filePath}
              </a>
            </dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{segment.updatedAt}</dd>
          </div>
          <div>
            <dt>Reason</dt>
            <dd>{segment.reason ?? "—"}</dd>
          </div>
        </dl>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// feedback banners
// ---------------------------------------------------------------------------

type ProcessFeedback =
  | { readonly kind: "success"; readonly result: ProcessVideoSegmentsResponse }
  | { readonly kind: "error"; readonly message: string };

function ProcessFeedbackBanner({ feedback }: { feedback: ProcessFeedback }): JSX.Element {
  if (feedback.kind === "error") {
    return (
      <p className="form-error" role="alert">
        Re-analyse failed: {feedback.message}
      </p>
    );
  }
  const { force, results } = feedback.result;
  const slotSummary = results.map((r) => `${r.jobType}=${r.outcome}`).join(", ");
  const headline = force
    ? "Forced re-analyse submitted. user_decision has been wiped on the next worker tick."
    : "Re-analyse submitted. Your manual keep/remove choices will be preserved on overlapping segments.";
  return (
    <p className="status-text" role="status" aria-live="polite">
      {headline} <span className="mono">({slotSummary})</span>
    </p>
  );
}

type DecisionFeedback =
  | { readonly kind: "success"; readonly result: UpdateUserDecisionResponse }
  | { readonly kind: "error"; readonly message: string; readonly segmentId: string };

function DecisionFeedbackBanner({ feedback }: { feedback: DecisionFeedback }): JSX.Element {
  if (feedback.kind === "error") {
    return (
      <p className="form-error" role="alert">
        Decision update failed for segment {truncateId(feedback.segmentId)}: {feedback.message}
      </p>
    );
  }
  const { previousUserDecision, userDecision, alreadyApplied } = feedback.result;
  if (alreadyApplied) {
    return (
      <p className="status-text" role="status" aria-live="polite">
        Segment already marked as <strong>{decisionLabel(userDecision)}</strong>.
      </p>
    );
  }
  return (
    <p className="status-text" role="status" aria-live="polite">
      Segment changed from <strong>{decisionLabel(previousUserDecision)}</strong> to{" "}
      <strong>{decisionLabel(userDecision)}</strong>.
    </p>
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function formatSeconds(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  const total = Math.max(0, seconds);
  const mins = Math.floor(total / 60);
  const secs = total - mins * 60;
  // Show one decimal so sub-second slices remain legible.
  return `${String(mins).padStart(2, "0")}:${secs.toFixed(1).padStart(4, "0")}`;
}

function truncateId(id: string): string {
  if (id.length <= 8) return id;
  return `${id.slice(0, 8)}…`;
}

function labelWasteType(t: VideoSegmentWasteType): string {
  switch (t) {
    case "black":
      return "⬛ Black";
    case "blurry":
      return "🌫 Blurry";
    case "unstable":
      return "📳 Unstable";
    case "silence":
      return "🔇 Silence";
    case "none":
    default:
      return "Clean";
  }
}

function toneForWasteType(t: VideoSegmentWasteType): "positive" | "neutral" | "warning" | "negative" {
  switch (t) {
    case "black":
    case "blurry":
      return "negative";
    case "unstable":
    case "silence":
      return "warning";
    case "none":
    default:
      return "positive";
  }
}

function toneForScore(score: number): "positive" | "neutral" | "warning" | "negative" {
  if (score >= 0.7) return "positive";
  if (score >= 0.4) return "neutral";
  if (score >= 0.2) return "warning";
  return "negative";
}

function decisionLabel(decision: VideoSegmentUserDecision): string {
  switch (decision) {
    case "keep":
      return "Keep";
    case "remove":
      return "Remove";
    case "undecided":
    default:
      return "Undecided";
  }
}
