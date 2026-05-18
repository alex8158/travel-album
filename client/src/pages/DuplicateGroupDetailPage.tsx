// Duplicate group detail page (P5.T6).
//
// Mounted at /duplicate-groups/:id. Read-only view of one group:
// group metadata (id, type, confidence, similarity, status,
// timestamps) + every member item (thumbnail / preview, mediaId,
// recommendation, reason, similarity score, user_decision).
//
// Keep/remove writes and user confirmation are P5.T7.

import { Link, useParams } from "react-router-dom";
import type { DuplicateDecision, DuplicateGroupItemView, DuplicateGroupType } from "../api/dedup";
import { useDuplicateGroupDetail } from "../hooks/useDuplicateGroupDetail";

export default function DuplicateGroupDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const { group, loading, error, refetch } = useDuplicateGroupDetail(id);

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
  if (group === null) {
    return null as unknown as JSX.Element;
  }

  return (
    <main>
      <header className="page-header">
        <div className="page-header-text">
          <Link to={`/trips/${group.tripId}/duplicates`} className="back-link">
            ← Back to duplicate groups
          </Link>
          <h1>{labelForType(group.groupType)} duplicate group</h1>
          <p className="trip-detail-meta">
            <span className="trip-detail-meta-label">Group id:</span> {group.id}
          </p>
        </div>
        <div className="page-header-actions">
          <button type="button" className="btn-secondary" onClick={refetch}>
            Refresh
          </button>
        </div>
      </header>

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
              <MemberRow key={it.id} item={it} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function MemberRow({ item }: { item: DuplicateGroupItemView }): JSX.Element {
  const m = item.media;
  return (
    <li className="duplicate-detail-member">
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
  // Server stores ISO-8601 timestamps with millisecond precision.
  // Render with the locale's default; fall back to the raw string on
  // any parse problem.
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
