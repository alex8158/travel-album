// Dedup API client (P5.T6).
//
// Mirrors the server-side response envelopes from
// `server/src/dedup/dedupService.ts` (P5.T5 trigger endpoints +
// P5.T6 read endpoints). Kept in sync by hand; an auto-generated
// client (e.g. openapi-typescript) is a later concern.
//
// Endpoints used:
//   * POST /api/trips/:tripId/dedup/exact
//   * POST /api/trips/:tripId/dedup/similar
//   * POST /api/trips/:tripId/dedup/run
//   * GET  /api/trips/:tripId/duplicate-groups
//   * GET  /api/duplicate-groups/:id

export type DuplicateGroupType = "exact" | "similar" | "candidate";
export type DuplicateDecision = "keep" | "remove" | "undecided";

/** Cohort skip reason — single value today, kept as a string so a
 * future engine variant can introduce new reasons without a client
 * release. */
export type CohortSkippedReason = string;

/** Minimal media projection embedded in each item — drives the
 * thumbnail / placeholder rendering on the list and detail pages. */
export interface DuplicateMediaProjection {
  readonly id: string;
  readonly type: "image" | "video" | "unknown";
  readonly thumbnailPath: string | null;
  readonly previewPath: string | null;
  readonly extension: string | null;
  readonly mimeType: string | null;
  readonly fileSize: number | null;
  readonly width: number | null;
  readonly height: number | null;
}

export interface DuplicateGroupItemView {
  readonly id: string;
  readonly groupId: string;
  readonly mediaId: string;
  readonly similarityScore: number | null;
  readonly qualityScore: number | null;
  readonly recommendation: DuplicateDecision;
  readonly reason: string | null;
  readonly userDecision: DuplicateDecision;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly media: DuplicateMediaProjection | null;
}

export interface DuplicateGroupView {
  readonly id: string;
  readonly tripId: string;
  readonly groupType: DuplicateGroupType;
  readonly recommendedMediaId: string | null;
  readonly confidence: number | null;
  readonly similarityScore: number | null;
  readonly userConfirmed: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly items: readonly DuplicateGroupItemView[];
}

interface ListDuplicateGroupsResponse {
  readonly tripId: string;
  readonly groups: readonly DuplicateGroupView[];
}

interface SingleDuplicateGroupResponse {
  readonly group: DuplicateGroupView;
}

/** Common counters fields shared by exact / similar run responses. */
interface DedupRunResultBase {
  readonly tripId: string;
  readonly mediaScanned: number;
  readonly candidateCohorts: number;
  readonly groupsCreated: number;
  readonly cohortsSkippedByReason: Readonly<Record<string, number>>;
}

export interface DedupExactApiResult extends DedupRunResultBase {
  readonly groupType: "exact";
  readonly hashesScanned: number;
  readonly cohortsSkipped: ReadonlyArray<{
    readonly fileHash: string;
    readonly mediaIds: readonly string[];
    readonly reason: CohortSkippedReason;
  }>;
}

export interface DedupSimilarApiResult extends DedupRunResultBase {
  readonly groupType: "similar";
  readonly hammingThreshold: number;
  readonly mediaSkippedInvalid: number;
  readonly cohortsSkipped: ReadonlyArray<{
    readonly mediaIds: readonly string[];
    readonly reason: CohortSkippedReason;
  }>;
}

export interface DedupRunApiResult {
  readonly tripId: string;
  readonly exact: DedupExactApiResult;
  readonly similar: DedupSimilarApiResult;
}

interface ApiErrorEnvelope {
  error: { code: string; message: string; requestId?: string; details?: unknown };
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const env = (await res.json()) as ApiErrorEnvelope | null;
    if (env?.error?.message) return env.error.message;
  } catch {
    /* non-JSON */
  }
  return `HTTP ${res.status}`;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function fetchDuplicateGroupsForTrip(
  tripId: string,
  signal?: AbortSignal,
): Promise<readonly DuplicateGroupView[]> {
  const init: RequestInit = { headers: { Accept: "application/json" } };
  if (signal) init.signal = signal;
  const res = await fetch(`/api/trips/${encodeURIComponent(tripId)}/duplicate-groups`, init);
  if (!res.ok) throw new Error(await readErrorMessage(res));
  const body = (await res.json()) as ListDuplicateGroupsResponse;
  return body.groups;
}

export async function fetchDuplicateGroupById(
  id: string,
  signal?: AbortSignal,
): Promise<DuplicateGroupView> {
  const init: RequestInit = { headers: { Accept: "application/json" } };
  if (signal) init.signal = signal;
  const res = await fetch(`/api/duplicate-groups/${encodeURIComponent(id)}`, init);
  if (!res.ok) throw new Error(await readErrorMessage(res));
  const body = (await res.json()) as SingleDuplicateGroupResponse;
  return body.group;
}

// ---------------------------------------------------------------------------
// Writes (P5.T5 trigger endpoints)
// ---------------------------------------------------------------------------

export async function runDedupExact(tripId: string): Promise<DedupExactApiResult> {
  const res = await fetch(`/api/trips/${encodeURIComponent(tripId)}/dedup/exact`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(await readErrorMessage(res));
  return (await res.json()) as DedupExactApiResult;
}

export async function runDedupSimilar(
  tripId: string,
  hammingThreshold?: number,
): Promise<DedupSimilarApiResult> {
  const res = await fetch(`/api/trips/${encodeURIComponent(tripId)}/dedup/similar`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(hammingThreshold !== undefined ? { hammingThreshold } : {}),
  });
  if (!res.ok) throw new Error(await readErrorMessage(res));
  return (await res.json()) as DedupSimilarApiResult;
}

export async function runDedupRun(
  tripId: string,
  hammingThreshold?: number,
): Promise<DedupRunApiResult> {
  const res = await fetch(`/api/trips/${encodeURIComponent(tripId)}/dedup/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(hammingThreshold !== undefined ? { hammingThreshold } : {}),
  });
  if (!res.ok) throw new Error(await readErrorMessage(res));
  return (await res.json()) as DedupRunApiResult;
}
