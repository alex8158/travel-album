// Duplicate group detail page (P5.T6 + P5.T7).
//
// Mounted at /duplicate-groups/:id. Shows one group:
// metadata (id, type, confidence, similarity, status, timestamps) +
// every member (thumbnail, mediaId, recommendation, reason,
// similarity score, user_decision).
//
// P5.T7 adds two user actions:
//   * "Keep this one" — per-item button calling
//     `POST /api/duplicate-groups/:id/recommend`. Sets the group's
//     recommended_media_id without binding the decisions; the picked
//     row gets a "Recommended" badge.
//   * "Confirm group" — header button calling
//     `POST /api/duplicate-groups/:id/confirm` with the current
//     recommendedMediaId. Atomically flips user_confirmed=true and
//     items.user_decision (keep / remove). Disabled when no
//     recommendation is selected; visually shows "Confirmed" once
//     `user_confirmed=true`. The user can change their pick by
//     selecting a different "Keep this one" and confirming again —
//     the server allows that, the UI does not block it.

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  confirmDuplicateGroup,
  recommendDuplicateGroupMedia,
  type DuplicateDecision,
  type DuplicateGroupItemView,
  type DuplicateGroupType,
  type DuplicateGroupView,
} from "../api/dedup";
import { useDuplicateGroupDetail } from "../hooks/useDuplicateGroupDetail";

export default function DuplicateGroupDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const { group: serverGroup, loading, error, refetch } = useDuplicateGroupDetail(id);

  // Local mutation state. The hook's `group` is the source of truth
  // until the user takes an action; after a recommend/confirm
  // response, `localGroup` overrides so the UI updates without
  // waiting for a refetch.
  const [localGroup, setLocalGroup] = useState<DuplicateGroupView | null>(null);
  const [recommendingMediaId, setRecommendingMediaId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Whenever the server re-fetches (initial load, refetch, id change),
  // reset the local override so the freshly-loaded server state shows.
  useEffect(() => {
    setLocalGroup(null);
    setActionError(null);
  }, [serverGroup?.id]);

  const group = localGroup ?? serverGroup;

  async function handleKeepThisOne(mediaId: string): Promise<void> {
    if (!group || recommendingMediaId !== null || confirming) return;
    setRecommendingMediaId(mediaId);
    setActionError(null);
    try {
      const updated = await recommendDuplicateGroupMedia(group.id, mediaId);
      setLocalGroup(updated);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setRecommendingMediaId(null);
    }
  }

  async function handleConfirm(): Promise<void> {
    if (!group || !group.recommendedMediaId || confirming || recommendingMediaId !== null) {
      return;
    }
    setConfirming(true);
    setActionError(null);
    try {
      const updated = await confirmDuplicateGroup(group.id, group.recommendedMediaId);
      setLocalGroup(updated);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setConfirming(false);
    }
  }

  function handleRefresh(): void {
    setLocalGroup(null);
    setActionError(null);
    refetch();
  }

  if (loading) {
    return (
      <main>
        <p className="status-text">Loading duplicate group…</p>
      </main>
    );
  }
  if (error !== null) {
    return (
      <main>
        <p className="status-text status-error" role="alert">
          Failed to load duplicate group: {error}
        </p>
      </main>
    );
  }
  if (!group) {
    return null as unknown as JSX.Element;
  }

  const confirmDisabled =
    confirming || recommendingMediaId !== null || group.recommendedMediaId === null;
  const confirmReason = group.userConfirmed
    ? "Already confirmed — pick a different image and click Confirm again to change."
    : group.recommendedMediaId === null
      ? "Pick an image with 'Keep this one' first."
      : null;

  return (
    <main>
      <header className="page-header">
        <div className="page-header-text">
          <Link to={`/trips/${group.tripId}/duplicates`} className="back-link">
            ← Back to duplicate groups
          </Link>
          <h1>
            {labelForType(group.groupType)} duplicate group
            {group.userConfirmed && <span className="confirmed-pill">Confirmed</span>}
          </h1>
          <p className="trip-detail-meta">
            <span className="trip-detail-meta-label">Group id:</span> {group.id}
          </p>
        </div>
        <div className="page-header-actions">
          <button type="button" className="btn-secondary" onClick={handleRefresh}>
            Refresh
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={handleConfirm}
            disabled={confirmDisabled}
            title={confirmReason ?? undefined}
          >
            {confirming
              ? "Confirming…"
              : group.userConfirmed
                ? "Re-confirm group"
                : "Confirm group"}
          </button>
        </div>
      </header>

      {actionError !== null && (
        <p className="status-text status-error" role="alert">
          {actionError}
        </p>
      )}

      <section className="trip-detail-section">
        <h2>Overview</h2>
        <dl className="counts-grid">
          <Stat label="Items" value={String(group.items.length)} />
          <Stat label="Group type" value={labelForType(group.groupType)} />
          <Stat label="Confidence" value={formatScore(group.confidence)} />
          <Stat label="Similarity" value={formatScore(group.similarityScore)} />
          <Stat label="Status" value={group.userConfirmed ? "Confirmed" : "Undecided"} />
          <Stat
            label="Recommendation"
            value={group.recommendedMediaId ? short(group.recommendedMediaId) : "—"}
          />
          <Stat label="Created" value={formatDateTime(group.createdAt)} />
          <Stat label="Updated" value={formatDateTime(group.updatedAt)} />
        </dl>
      </section>

      <section className="trip-detail-section">
        <h2>Members</h2>
        {group.items.length === 0 ? (
          <p className="status-text">This group has no items.</p>
        ) : (
          <ul className="duplicate-detail-member-list">
            {group.items.map((it) => (
              <MemberRow
                key={it.id}
                item={it}
                isRecommended={it.mediaId === group.recommendedMediaId}
                recommendInFlight={recommendingMediaId === it.mediaId}
                anyActionInFlight={recommendingMediaId !== null || confirming}
                onKeep={handleKeepThisOne}
              />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function MemberRow({
  item,
  isRecommended,
  recommendInFlight,
  anyActionInFlight,
  onKeep,
}: {
  item: DuplicateGroupItemView;
  isRecommended: boolean;
  recommendInFlight: boolean;
  anyActionInFlight: boolean;
  onKeep: (mediaId: string) => void;
}): JSX.Element {
  const m = item.media;
  // "Keep this one" button — disabled while ANY action is in flight,
  // and also disabled when this item is already the recommended one
  // (clicking again is a no-op; clearer to surface "Recommended").
  const keepDisabled = anyActionInFlight || isRecommended;
  return (
    <li className={`duplicate-detail-member${isRecommended ? " member-recommended" : ""}`}>
      <div className="duplicate-detail-member-thumb">
        {m === null ? (
          <div className="duplicate-group-card-thumb thumb-missing">(missing)</div>
        ) : m.thumbnailPath ? (
          <img src={`/storage/${m.thumbnailPath}`} alt="" loading="lazy" width={160} height={160} />
        ) : (
          <div className={`duplicate-group-card-thumb thumb-placeholder thumb-${m.type}`}>
            {m.type === "image" ? "IMG" : m.type === "video" ? "VID" : "?"}
          </div>
        )}
      </div>
      <div className="duplicate-detail-member-body">
        <div className="duplicate-detail-member-header">
          {m !== null ? (
            <Link to={`/media/${item.mediaId}`} className="duplicate-detail-member-link">
              {labelForMedia(m)}
            </Link>
          ) : (
            <span>{short(item.mediaId)}</span>
          )}
          {isRecommended && <span className="recommended-pill">Recommended</span>}
          <span className={`decision-badge decision-${item.recommendation}`}>
            {labelForDecision("Recommendation", item.recommendation)}
          </span>
          <span className={`decision-badge decision-${item.userDecision}`}>
            {labelForDecision("User", item.userDecision)}
          </span>
        </div>
        <dl className="duplicate-detail-member-meta">
          <div>
            <dt>Media id</dt>
            <dd>{item.mediaId}</dd>
          </div>
          <div>
            <dt>Similarity</dt>
            <dd>{formatScore(item.similarityScore)}</dd>
          </div>
          <div>
            <dt>Quality</dt>
            <dd>{formatScore(item.qualityScore)}</dd>
          </div>
        </dl>
        {item.reason && <p className="duplicate-detail-member-reason">{item.reason}</p>}
        <div className="duplicate-detail-member-actions">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => onKeep(item.mediaId)}
            disabled={keepDisabled}
            aria-pressed={isRecommended}
          >
            {recommendInFlight ? "Selecting…" : isRecommended ? "Recommended" : "Keep this one"}
          </button>
        </div>
      </div>
    </li>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="count-card">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function formatScore(value: number | null): string {
  if (value === null) return "—";
  return value.toFixed(3);
}

function formatDateTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function short(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
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

function labelForDecision(prefix: string, d: DuplicateDecision): string {
  switch (d) {
    case "keep":
      return `${prefix}: keep`;
    case "remove":
      return `${prefix}: remove`;
    case "undecided":
      return `${prefix}: undecided`;
  }
}

function labelForMedia(m: {
  type: "image" | "video" | "unknown";
  extension: string | null;
  fileSize: number | null;
  width: number | null;
  height: number | null;
}): string {
  const bits: string[] = [m.type];
  if (m.extension) bits.push(m.extension);
  if (m.width !== null && m.height !== null) bits.push(`${m.width}×${m.height}`);
  if (m.fileSize !== null) bits.push(formatBytes(m.fileSize));
  return bits.join(" · ");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
