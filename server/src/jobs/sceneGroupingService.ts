// sceneGroupingService.ts — P12.T4 baseline scene-grouping service.
//
// Scope (deliberately narrow per the P12.T4 prompt):
//   * Pure service layer. No job handler registration, no enqueue, no
//     orchestrator — those belong to P12.T9 (curation orchestrator).
//   * Reads existing data only: `media_items`, `media_analysis` (via
//     the JOIN that MediaRepository.list already does), and
//     `media_versions(version_type='metadata').params` for EXIF dates.
//     NEVER touches raw image / video bytes (CLAUDE.md §2.1 / §2.2).
//   * Writes ONLY `scene_groups` + `scene_group_items` in a single
//     transaction (design.md §7.8.3 — L2 must be atomic; if either
//     write fails the run rolls back and no half-written groups
//     remain).
//   * Image-only. Videos are excluded per scene_group_items header:
//     "No video members; P12 curation pipeline is image-only".
//   * Code algorithm only. AI embedding refinement is a future P12
//     subtask (request_type=`scene_embedding`); we expose a typed
//     `SceneEmbeddingProvider` hook so the orchestrator can later
//     pass an enrichment provider WITHOUT changing this service's
//     public shape. Baseline never invokes the provider.
//
// Idempotency:
//   * The unit of idempotency is `(tripId, selectionRound)`.
//   * Inside the transaction we first DELETE FROM scene_groups WHERE
//     trip_id=? AND selection_round=? (which CASCADES into
//     scene_group_items per migration 020), then INSERT the freshly
//     computed groups + items. Re-running the service for the same
//     (trip, round) produces identical schema content; only the
//     UUIDs of the new rows change (the algorithm is deterministic
//     in shape — group boundaries, members, ranks — but IDs are
//     freshly generated each call).
//   * This matches the P12.T4 prompt's "重复执行不会重复写入" + "事务
//     失败可回滚" + "保持可重复执行、可覆盖、可回滚".
//
// Round semantics (design.md §7.8.4):
//   * `selection_round >= 1`. round=0 is reserved for user
//     pin/unpin overrides in `curated_selections` and is NOT a
//     legal value for `scene_groups` writes by an AI / Code worker.
//   * We CHECK this at the service boundary; the schema allows
//     round=0 (CHECK selection_round >= 0) only because the round=0
//     concept is shared with curated_selections.
//
// Algorithm baseline (`code-time-1.0`):
//   1. Resolve candidates: image media in the trip, not soft-deleted,
//      not failed. status ∈ {uploaded, processing, processed,
//      archived} — we tolerate not-yet-finalised media so a
//      curation_run triggered before the quality finalize completes
//      still groups them by time (it will just lack quality_score).
//   2. For each candidate, resolve captured_at:
//      a. Parse JSON `media_versions.params` from the row whose
//         version_type='metadata'. The image_metadata worker writes
//         `DateTimeOriginal` as an ISO-8601 string via the
//         `exifReplacer` in `imageMetadataWorker.ts`.
//      b. Fallback to `media_items.created_at` (upload time) when no
//         metadata row or no DateTimeOriginal field is present.
//   3. Sort by capturedAt ASC, id ASC (deterministic tie-break).
//   4. Split into groups: open a new group whenever the gap to the
//      previous member exceeds `timeGapSeconds` (default 900s = 15
//      minutes; tunable via settings).
//   5. Per group:
//      * representative_media_id = highest quality_score (NULLs
//        last) → id ASC tie-break.
//      * rank_in_group = 0 for representative; remaining ranks in
//        the same order (quality_score DESC NULLs LAST, id ASC).
//      * group_score = the member's quality_score (or null).
//      * similarity_score = null (no embedding in baseline).
//      * captured_at_start / end = first / last member's resolved
//        captured_at.
//      * gps_center_lat / lon = null. Existing imageMetadataWorker
//        deliberately disables GPS parse (CLAUDE.md §5.3 privacy);
//        until that's reconciled with an opt-in mechanism, GPS is
//        not available to this layer. `algorithm_version` therefore
//        omits the `gps` qualifier ("code-time-1.0", not
//        "code-time-gps-1.0").
//      * reason on each item is "code-time-gap" so a later UI can
//        explain "why was this in this scene".
//
// Future enrichment seam:
//   * Pass `embeddingProvider` to use AI scene embeddings to
//     refine (or override) the time-gap baseline. Not wired here —
//     this service only reads the provider's `isAvailable()` once
//     for the algorithm_version suffix, never calls
//     `computeEmbeddings`.

import { randomUUID } from "node:crypto";

import type { SqliteDatabase } from "../db/connection.js";
import type { Logger } from "../logger.js";
import type {
  SceneGroupInsertData,
  SceneGroupsRepository,
} from "../media/sceneGroupsRepository.js";
import type {
  SceneGroupItemInsertData,
  SceneGroupItemsRepository,
} from "../media/sceneGroupItemsRepository.js";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** `processing_jobs.job_type` for the scene_grouping orchestrator step
 * (design.md §7.8.1 / §7.8.3). Exported so the future orchestrator
 * (P12.T9) can enqueue this job without re-typing the literal. */
export const SCENE_GROUPING_JOB_TYPE = "scene_grouping";

/** Algorithm-version string written into `scene_groups.algorithm_version`
 * by the Code-only baseline path. AI-embedding enrichment will bump to
 * `code-time-1.0+scene_embedding-1.0` (literal computed at write time
 * based on `embeddingProvider.isAvailable()`). */
export const SCENE_GROUPING_ALGORITHM_VERSION_CODE_TIME = "code-time-1.0";

/** Default time-gap (seconds) for "same scene". 15 minutes is the
 * informal "one shot session" boundary used by most photo apps. */
export const DEFAULT_SCENE_GROUPING_TIME_GAP_SECONDS = 900;

/** Hard cap on candidates considered per call. Mirrors design.md §7.8 by
 * keeping the worker bounded; if a trip exceeds this, the run aborts
 * with an explicit error rather than silently truncating. */
export const SCENE_GROUPING_MAX_CANDIDATES = 5_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SceneGroupingSettings {
  /** Gap above which two consecutive members are split into separate
   * scene groups. Must be > 0. */
  readonly timeGapSeconds: number;
}

export const DEFAULT_SCENE_GROUPING_SETTINGS: SceneGroupingSettings = {
  timeGapSeconds: DEFAULT_SCENE_GROUPING_TIME_GAP_SECONDS,
};

/**
 * AI embedding hook. Defined for forward-compat with the P12.T6 /
 * P12.T9 AI scene-embedding refinement. The baseline path never
 * invokes `computeEmbeddings` — only `isAvailable()` for the
 * algorithm_version stamp. Implementations live in a separate
 * provider module; baseline callers leave `embeddingProvider`
 * undefined.
 */
export interface SceneEmbeddingProvider {
  /** Synchronous cheap check — used by this service ONLY for the
   * algorithm_version suffix; never as a gate around the actual AI
   * call (the future orchestrator owns AI quota / cost decisions). */
  isAvailable(): boolean;
  /** Reserved for future use. Baseline does not call this. */
  computeEmbeddings(mediaIds: readonly string[]): Promise<Map<string, Float32Array>>;
}

export interface SceneGroupingDeps {
  readonly db: SqliteDatabase;
  readonly sceneGroupsRepo: SceneGroupsRepository;
  readonly sceneGroupItemsRepo: SceneGroupItemsRepository;
  readonly logger: Logger;
  readonly settings?: SceneGroupingSettings;
  /** Optional AI enrichment seam — not invoked by the baseline. */
  readonly embeddingProvider?: SceneEmbeddingProvider;
}

export interface SceneGroupingRequest {
  readonly tripId: string;
  /** Must be >= 1. round=0 is reserved for the user override layer in
   * curated_selections and is not a legal AI / Code group write. */
  readonly selectionRound: number;
  /** When true, the service computes the plan but does NOT write
   * scene_groups / scene_group_items. Used by smoke + future CLI
   * dry-run preview. */
  readonly dryRun?: boolean;
}

/** One planned scene-group member. UUIDs are pre-generated so the plan
 * is the same object that would be written on a non-dryRun call. */
export interface SceneGroupingPlanMember {
  readonly sceneGroupItemId: string;
  readonly mediaId: string;
  readonly rankInGroup: number;
  readonly groupScore: number | null;
  readonly similarityScore: number | null;
  readonly reason: string;
}

/** One planned scene group. */
export interface SceneGroupingPlanGroup {
  readonly sceneGroupId: string;
  readonly groupIndex: number;
  readonly capturedAtStart: string | null;
  readonly capturedAtEnd: string | null;
  readonly gpsCenterLat: number | null;
  readonly gpsCenterLon: number | null;
  readonly representativeMediaId: string | null;
  readonly members: readonly SceneGroupingPlanMember[];
}

export interface SceneGroupingResult {
  readonly tripId: string;
  readonly selectionRound: number;
  readonly algorithmVersion: string;
  readonly sceneGroupCount: number;
  readonly sceneItemCount: number;
  readonly dryRun: boolean;
  readonly skippedReason: "no_candidates" | null;
  readonly plan: readonly SceneGroupingPlanGroup[];
}

// ---------------------------------------------------------------------------
// Internal candidate type (post-resolution of capturedAt)
// ---------------------------------------------------------------------------

interface Candidate {
  readonly mediaId: string;
  /** Resolved capturedAt ISO string. Never null because we fall back
   * to media_items.created_at when EXIF DateTimeOriginal is missing. */
  readonly capturedAt: string;
  /** Source of the capturedAt value, kept for the reason text. */
  readonly capturedAtSource: "exif" | "created_at";
  readonly qualityScore: number | null;
}

interface CandidateRow {
  media_id: string;
  created_at: string;
  exif_params: string | null;
  quality_score: number | null;
}

// ---------------------------------------------------------------------------
// Service entry point
// ---------------------------------------------------------------------------

/**
 * Run the baseline scene-grouping algorithm for one (trip, round).
 *
 * Pure function — all side effects (DB writes) flow through the
 * injected repositories. Throws on invariant violation (round < 1 /
 * candidate cap exceeded); returns a result describing the plan + the
 * counts that were actually written.
 *
 * Concurrency: better-sqlite3 is single-threaded per connection; the
 * service assumes the caller does not race a second `runSceneGrouping
 * ForTrip` call on the same connection for the same (trip, round).
 */
export function runSceneGroupingForTrip(
  request: SceneGroupingRequest,
  deps: SceneGroupingDeps,
): SceneGroupingResult {
  if (!Number.isInteger(request.selectionRound) || request.selectionRound < 1) {
    throw new Error(
      `sceneGroupingService: selectionRound must be an integer >= 1 (round=0 is reserved for user overrides); got ${String(request.selectionRound)}`,
    );
  }
  if (request.tripId.length === 0) {
    throw new Error("sceneGroupingService: tripId must be non-empty");
  }

  const settings = deps.settings ?? DEFAULT_SCENE_GROUPING_SETTINGS;
  if (!Number.isFinite(settings.timeGapSeconds) || settings.timeGapSeconds <= 0) {
    throw new Error(
      `sceneGroupingService: settings.timeGapSeconds must be > 0; got ${String(settings.timeGapSeconds)}`,
    );
  }

  const dryRun = request.dryRun === true;
  const algorithmVersion = resolveAlgorithmVersion(deps.embeddingProvider);

  // --- 1. Load candidates --------------------------------------------------
  const candidates = loadCandidates(deps.db, request.tripId);

  if (candidates.length > SCENE_GROUPING_MAX_CANDIDATES) {
    throw new Error(
      `sceneGroupingService: too many candidates for trip=${request.tripId} (${candidates.length} > ${SCENE_GROUPING_MAX_CANDIDATES}); refusing to run`,
    );
  }

  if (candidates.length === 0) {
    deps.logger.info(
      {
        tripId: request.tripId,
        selectionRound: request.selectionRound,
        algorithmVersion,
        dryRun,
      },
      "scene_grouping: no candidates — skipping write",
    );
    // Empty trip is a valid success state. We still clear any
    // pre-existing rows for (tripId, round) so a previously-curated
    // trip whose media were all soft-deleted gets a clean slate.
    if (!dryRun) {
      clearExistingRound(deps.db, request.tripId, request.selectionRound);
    }
    return {
      tripId: request.tripId,
      selectionRound: request.selectionRound,
      algorithmVersion,
      sceneGroupCount: 0,
      sceneItemCount: 0,
      dryRun,
      skippedReason: "no_candidates",
      plan: [],
    };
  }

  // --- 2. Build plan -------------------------------------------------------
  const plan = buildPlan(candidates, settings.timeGapSeconds);

  // --- 3. Persist (unless dryRun) -----------------------------------------
  if (!dryRun) {
    persistPlan(deps, request.tripId, request.selectionRound, algorithmVersion, plan);
  }

  const sceneItemCount = plan.reduce((sum, g) => sum + g.members.length, 0);
  deps.logger.info(
    {
      tripId: request.tripId,
      selectionRound: request.selectionRound,
      algorithmVersion,
      dryRun,
      candidateCount: candidates.length,
      sceneGroupCount: plan.length,
      sceneItemCount,
      timeGapSeconds: settings.timeGapSeconds,
    },
    "scene_grouping: plan computed",
  );

  return {
    tripId: request.tripId,
    selectionRound: request.selectionRound,
    algorithmVersion,
    sceneGroupCount: plan.length,
    sceneItemCount,
    dryRun,
    skippedReason: null,
    plan,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compose algorithm_version. Baseline = `code-time-1.0`. When a
 * SceneEmbeddingProvider is wired and reports available, append a
 * suffix so re-curate runs can detect drift. Even with the provider
 * present, the baseline NEVER calls computeEmbeddings — it only flags
 * the upgrade in the version stamp so a future task can light it up. */
function resolveAlgorithmVersion(provider?: SceneEmbeddingProvider): string {
  if (provider !== undefined && provider.isAvailable()) {
    return `${SCENE_GROUPING_ALGORITHM_VERSION_CODE_TIME}+scene_embedding-pending`;
  }
  return SCENE_GROUPING_ALGORITHM_VERSION_CODE_TIME;
}

/**
 * Single query that joins media_items + media_analysis (for
 * quality_score) + media_versions(version_type='metadata') (for the
 * EXIF JSON blob). Status filter excludes 'failed' / 'deleted'.
 * deleted_at IS NULL filters soft-deleted rows. Image-only.
 */
function loadCandidates(db: SqliteDatabase, tripId: string): Candidate[] {
  const rows = db
    .prepare(
      `
      SELECT
        m.id                AS media_id,
        m.created_at        AS created_at,
        mv.params           AS exif_params,
        ma.quality_score    AS quality_score
      FROM media_items m
      LEFT JOIN media_analysis ma
        ON ma.media_id = m.id
      LEFT JOIN media_versions mv
        ON mv.media_id = m.id AND mv.version_type = 'metadata'
      WHERE
        m.trip_id = ?
        AND m.deleted_at IS NULL
        AND m.type = 'image'
        AND m.status NOT IN ('failed', 'deleted')
      `,
    )
    .all(tripId) as CandidateRow[];

  return rows.map((row) => {
    const exif = parseExifCapturedAt(row.exif_params);
    const capturedAt = exif ?? row.created_at;
    return {
      mediaId: row.media_id,
      capturedAt,
      capturedAtSource: exif !== null ? "exif" : "created_at",
      qualityScore: row.quality_score,
    } satisfies Candidate;
  });
}

/**
 * Parse the JSON `media_versions(version_type='metadata').params` blob
 * and return DateTimeOriginal as an ISO-8601 string if present and
 * parseable; null otherwise. The image_metadata worker already
 * normalises Date values to ISO strings via its `exifReplacer`
 * (imageMetadataWorker.ts), so a successful parse here is just a JSON
 * read of an already-stringified ISO date. We are intentionally
 * defensive: malformed JSON, missing field, or unparseable date → null
 * (fall back to created_at).
 */
function parseExifCapturedAt(rawParams: string | null): string | null {
  if (rawParams === null || rawParams.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawParams);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const candidate = (parsed as Record<string, unknown>).DateTimeOriginal;
  if (typeof candidate !== "string" || candidate.length === 0) return null;
  // Validate it's a parseable ISO date — the exifReplacer would have
  // stamped a valid ISO; this is a final guardrail.
  const ms = Date.parse(candidate);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * Build the per-group plan. Sort by (capturedAt ASC, id ASC), split on
 * time gaps, then compute representative / ranks within each group.
 */
function buildPlan(
  candidates: readonly Candidate[],
  timeGapSeconds: number,
): SceneGroupingPlanGroup[] {
  // 1. Deterministic sort.
  const sorted = [...candidates].sort((a, b) => {
    if (a.capturedAt !== b.capturedAt) {
      return a.capturedAt < b.capturedAt ? -1 : 1;
    }
    return a.mediaId < b.mediaId ? -1 : a.mediaId > b.mediaId ? 1 : 0;
  });

  // 2. Bucketise by time gap.
  const buckets: Candidate[][] = [];
  const gapMs = timeGapSeconds * 1000;
  for (const c of sorted) {
    if (buckets.length === 0) {
      buckets.push([c]);
      continue;
    }
    const lastBucket = buckets[buckets.length - 1]!;
    const lastMember = lastBucket[lastBucket.length - 1]!;
    const delta = Date.parse(c.capturedAt) - Date.parse(lastMember.capturedAt);
    if (delta > gapMs) {
      buckets.push([c]);
    } else {
      lastBucket.push(c);
    }
  }

  // 3. Per-bucket: representative + ranks.
  return buckets.map((members, groupIndex) => {
    const ranked = rankMembers(members);
    const representativeMediaId = ranked.length > 0 ? ranked[0]!.mediaId : null;
    const capturedAtStart = members[0]!.capturedAt;
    const capturedAtEnd = members[members.length - 1]!.capturedAt;

    const planMembers: SceneGroupingPlanMember[] = ranked.map((m, rank) => ({
      sceneGroupItemId: randomUUID(),
      mediaId: m.mediaId,
      rankInGroup: rank,
      groupScore: m.qualityScore,
      similarityScore: null,
      reason: `code-time-gap (capturedAt source=${m.capturedAtSource}${
        m.qualityScore !== null ? `, quality_score=${m.qualityScore.toFixed(3)}` : ", quality_score=null"
      })`,
    }));

    return {
      sceneGroupId: randomUUID(),
      groupIndex,
      capturedAtStart,
      capturedAtEnd,
      gpsCenterLat: null,
      gpsCenterLon: null,
      representativeMediaId,
      members: planMembers,
    } satisfies SceneGroupingPlanGroup;
  });
}

/**
 * Rank members within a bucket by quality_score DESC (NULLs LAST), then
 * by media id ASC for deterministic tie-break. Representative =
 * rank 0.
 */
function rankMembers(members: readonly Candidate[]): Candidate[] {
  return [...members].sort((a, b) => {
    const aHas = a.qualityScore !== null;
    const bHas = b.qualityScore !== null;
    if (aHas && bHas) {
      if (a.qualityScore !== b.qualityScore) {
        return (b.qualityScore as number) - (a.qualityScore as number);
      }
    } else if (aHas !== bHas) {
      // NULLs last.
      return aHas ? -1 : 1;
    }
    return a.mediaId < b.mediaId ? -1 : a.mediaId > b.mediaId ? 1 : 0;
  });
}

/**
 * DELETE FROM scene_groups WHERE trip_id=? AND selection_round=? —
 * CASCADES into scene_group_items per migration 020's FK. Used as the
 * idempotency primitive: clear before re-insert.
 *
 * Lives outside the main persistPlan transaction wrapper because the
 * empty-trip branch wants to clear without entering the insert path.
 * better-sqlite3 wraps single statements in their own implicit
 * transaction so this DELETE is itself atomic.
 */
function clearExistingRound(db: SqliteDatabase, tripId: string, selectionRound: number): number {
  const info = db
    .prepare(`DELETE FROM scene_groups WHERE trip_id = ? AND selection_round = ?`)
    .run(tripId, selectionRound);
  return info.changes;
}

/**
 * The single-transaction L2 write (design.md §7.8.3): delete any
 * existing rows for (tripId, round), then insert the new groups +
 * items. Any error during the writes aborts the transaction and
 * leaves the table in its pre-call state — matching the spec's
 * "L2 自身失败 → 整个事务回滚，已写的两表行一并消失".
 */
function persistPlan(
  deps: SceneGroupingDeps,
  tripId: string,
  selectionRound: number,
  algorithmVersion: string,
  plan: readonly SceneGroupingPlanGroup[],
): void {
  deps.db.transaction(() => {
    clearExistingRound(deps.db, tripId, selectionRound);

    for (const group of plan) {
      const insertGroup: SceneGroupInsertData = {
        id: group.sceneGroupId,
        tripId,
        selectionRound,
        groupIndex: group.groupIndex,
        capturedAtStart: group.capturedAtStart,
        capturedAtEnd: group.capturedAtEnd,
        gpsCenterLat: group.gpsCenterLat,
        gpsCenterLon: group.gpsCenterLon,
        representativeMediaId: group.representativeMediaId,
        memberCount: group.members.length,
        algorithmVersion,
      };
      deps.sceneGroupsRepo.insert(insertGroup);

      const itemRows: SceneGroupItemInsertData[] = group.members.map((m) => ({
        id: m.sceneGroupItemId,
        sceneGroupId: group.sceneGroupId,
        mediaId: m.mediaId,
        selectionRound,
        groupScore: m.groupScore,
        similarityScore: m.similarityScore,
        rankInGroup: m.rankInGroup,
        reason: m.reason,
      }));
      // insertMany internally wraps in its own db.transaction; nested
      // transactions in better-sqlite3 reuse the outer SAVEPOINT, so
      // this is safe.
      deps.sceneGroupItemsRepo.insertMany(itemRows);
    }
  })();
}
