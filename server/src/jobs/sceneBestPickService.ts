// sceneBestPickService.ts — P12.T6 baseline L4 scene-best-pick service.
//
// Scope (deliberately narrow per the P12.T6 prompt):
//   * Pure service layer. No JobHandler registration, no orchestrator
//     wiring — those are P12.T9.
//   * Reads existing data only: `scene_groups`, `scene_group_items`,
//     `media_items` (active-filter via mediaRepo), `media_analysis`
//     (for quality_score / ai_blur_class / is_blurry / is_duplicate),
//     and `ai_invocations` for the cost-cache lookup. NEVER reads
//     `curated_selections.user_decision` — that is the user-override
//     layer (round=0); finalize (P12.T9) merges it per design.md
//     §7.8.4. This worker is strictly an AI-layer (round >= 1)
//     producer.
//   * Writes ONLY two tables, both through their repositories:
//       * `curated_selections` rows for the AI layer
//         (selection_round >= 1, is_current=0 draft, no
//         user_decision). The best media in each group gets
//         included=1; the rest of the top-K K-1 get included=0 with
//         reason='not_best_in_group'. Items outside the top-K are
//         not written — they don't participate in this round's
//         finalize.
//       * `ai_invocations` rows via `insertWithTargets`
//         (target_type='scene_group', target_id=sceneGroupId,
//         input_hash=SHA256(canonicalCandidatesJson)) for audit +
//         cost cache. Cache hit on identical input → reuse the
//         prior verdict.
//   * Image-only. The scene_group_items header documents this
//     ("No video members; P12 curation pipeline is image-only").
//   * Strict layer discipline (design.md §7.8.4):
//       - Never writes `is_current=1` (P12.T9 finalize owns that
//         flag transition).
//       - Never writes `user_decision` (the SQL CHECK
//         `curated_selections_round0_requires_decision` would
//         reject it; CLAUDE.md §3.9 user decisions override AI).
//       - `selectionRound >= 1` is invariant.
//
// AI provider gate:
//   * provider.available=false OR !supports.has('scene_best_pick')
//     → Code top-1 fallback path. The worker still writes the
//     curated_selections draft + an ai_invocations row (status
//     'success', model_name='<provider>-code-fallback') so the
//     audit trail is complete; the verdict came from Code instead
//     of AI.
//   * Single-member group → no AI call, single row gets included=1
//     with reason 'single-member-group'.
//
// Idempotency:
//   * Per (trip, round, sceneGroupId): inside one DB transaction we
//     first `curatedSelectionsRepo.deleteDraftsForGroup(...)` to
//     wipe any prior draft rows for THIS group only (round=0 and
//     other groups in the same round are protected by the WHERE
//     clause), then `insertAi` the new top-K rows.
//   * ai_invocations: cache hit on identical input_hash short-
//     circuits with outcome 'cache_hit' and reuses the prior
//     verdict.
//
// Failure boundary:
//   * `runSceneBestPickForGroup` NEVER throws on per-group errors;
//     it returns a structured `GroupResult` with `outcome`. The
//     trip-level batch aggregates these and isolates per-group
//     failures (CLAUDE.md §3.7).
//   * Programmer / environment errors (closed DB, missing repo) do
//     bubble up.

import { createHash, randomUUID } from "node:crypto";

import {
  AIProviderNotConfiguredError,
  AIProviderUnsupportedRequestError,
  type AIProvider,
  type AIRequestType,
  type AiInvocationCacheLookup,
  type AiInvocationsRepository,
} from "../ai/index.js";
import type { SqliteDatabase } from "../db/connection.js";
import type { Logger } from "../logger.js";
import type {
  CuratedSelectionsRepository,
  MediaAnalysisRepository,
  MediaRepository,
  SceneGroupItemsRepository,
  SceneGroupsRepository,
} from "../media/index.js";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** `processing_jobs.job_type` token for the future orchestrator
 * (P12.T9) to enqueue this work on. The service itself does NOT
 * register a handler. */
export const SCENE_BEST_PICK_JOB_TYPE = "scene_best_pick";

/** Closed enum mirror for `ai_invocations.request_type`. */
export const SCENE_BEST_PICK_REQUEST_TYPE: AIRequestType = "scene_best_pick";

/** Target type for the ai_invocations row + (future) processing_jobs
 * row enqueued by the orchestrator. The request is per-scene-group. */
export const SCENE_BEST_PICK_TARGET_TYPE = "scene_group" as const;

/** Default top-K. Per design.md / tasks.md `SCENE_BEST_PICK_TOP_K=5`:
 * we feed the AI K thumbnails, the AI returns the bestMediaId from
 * within those K. */
export const DEFAULT_SCENE_BEST_PICK_TOP_K = 5;

/** Worker version stamped into ai_invocations.response_summary so
 * later audits can detect drift between baseline runs. Bumped when
 * the scoring formula or write contract changes. */
export const SCENE_BEST_PICK_WORKER_VERSION = "1.0";

// ---------------------------------------------------------------------------
// Scoring formula constants (Code baseline)
// ---------------------------------------------------------------------------

/** Quality score used when media_analysis row is missing or
 * quality_score is NULL. A neutral middle value, NOT 0 — a missing
 * row should still let the candidate compete on blur_class /
 * is_duplicate / tie-break, not be effectively excluded. */
export const SCENE_BEST_PICK_DEFAULT_QUALITY = 0.5;

/** Multipliers applied to `quality_score` based on the blur signal.
 * AI blur (migration 026) takes precedence; Code Laplacian
 * (is_blurry) is the fallback. */
export const SCENE_BEST_PICK_BLUR_MULTIPLIERS = Object.freeze({
  ai_sharp: 1.0,
  ai_maybe_blurry: 0.7,
  ai_blurry: 0.3,
  /** No AI verdict but Code says blurry. */
  code_blurry: 0.5,
  /** No blur signal at all — assume not blurry. */
  unknown: 1.0,
} as const);

/** Subtractive penalty when `media_analysis.is_duplicate=1`. */
export const SCENE_BEST_PICK_DUPLICATE_PENALTY = 0.2;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SceneBestPickSettings {
  /** Stamped into `ai_invocations.response_summary` for traceability. */
  readonly workerVersion: string;
  /** Number of top candidates considered (= AI input candidate count). */
  readonly topK: number;
}

export const DEFAULT_SCENE_BEST_PICK_SETTINGS: SceneBestPickSettings = {
  workerVersion: SCENE_BEST_PICK_WORKER_VERSION,
  topK: DEFAULT_SCENE_BEST_PICK_TOP_K,
};

export interface SceneBestPickDeps {
  readonly db: SqliteDatabase;
  readonly sceneGroupsRepo: SceneGroupsRepository;
  readonly sceneGroupItemsRepo: SceneGroupItemsRepository;
  readonly curatedSelectionsRepo: CuratedSelectionsRepository;
  readonly mediaRepo: MediaRepository;
  readonly mediaAnalysisRepo: MediaAnalysisRepository;
  readonly aiInvocationsRepo: AiInvocationsRepository;
  readonly aiProvider: AIProvider;
  readonly logger: Logger;
  readonly settings?: SceneBestPickSettings;
  /** Override clock for tests / smokes. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

/** Per-group outcome — structurally distinct so the trip-level
 * aggregator can switch on it. */
export type SceneBestPickOutcome =
  | "success"
  | "cache_hit"
  | "code_fallback_single_member"
  | "code_fallback_ai_off"
  | "code_fallback_ai_unsupported"
  | "code_fallback_provider_error"
  | "code_fallback_invalid_response"
  | "code_fallback_invalid_pick"
  | "skipped_group_not_found"
  | "skipped_no_eligible_members"
  | "skipped_round_mismatch";

export interface GroupResult {
  readonly sceneGroupId: string;
  readonly tripId: string | null;
  readonly selectionRound: number;
  readonly outcome: SceneBestPickOutcome;
  readonly bestMediaId: string | null;
  /** Total members the worker considered (after dropping ineligible
   * media); 0 when no candidates were eligible. */
  readonly candidateCount: number;
  /** Number of top-K rows actually written (= K when group has >= K
   * eligible members, or eligible count otherwise). 0 for skip
   * outcomes. */
  readonly writtenCount: number;
  /** Audit row id (success / fallback / cache-hit) or null for skip. */
  readonly auditId: string | null;
  /** AI confidence (success path only); null for fallback / skip. */
  readonly aiConfidence: number | null;
  /** Reason text written to the best row's curated_selections.reason. */
  readonly reason: string | null;
  /** Filled on `code_fallback_*` outcomes for diagnostics; null
   * otherwise. */
  readonly errorMessage: string | null;
}

export interface TripResult {
  readonly tripId: string;
  readonly selectionRound: number;
  readonly groupCount: number;
  readonly successCount: number;
  readonly cacheHitCount: number;
  readonly codeFallbackCount: number;
  readonly skippedCount: number;
  readonly groupResults: readonly GroupResult[];
}

// ---------------------------------------------------------------------------
// Service entry points
// ---------------------------------------------------------------------------

/**
 * Run scene_best_pick on a single scene group. Never throws on per-
 * group errors; returns a structured `GroupResult`.
 */
export async function runSceneBestPickForGroup(
  sceneGroupId: string,
  deps: SceneBestPickDeps,
): Promise<GroupResult> {
  if (sceneGroupId.length === 0) {
    throw new Error("sceneBestPickService: sceneGroupId must be non-empty");
  }
  const settings = deps.settings ?? DEFAULT_SCENE_BEST_PICK_SETTINGS;
  if (!Number.isInteger(settings.topK) || settings.topK < 1) {
    throw new Error(
      `sceneBestPickService: settings.topK must be an integer >= 1 (got ${String(settings.topK)})`,
    );
  }
  const clock = deps.now ?? (() => new Date());

  const group = deps.sceneGroupsRepo.findById(sceneGroupId);
  if (group === null) {
    return skipResult(sceneGroupId, null, 0, "skipped_group_not_found", "scene_group not found");
  }
  if (group.selectionRound < 1) {
    return skipResult(
      sceneGroupId,
      group.tripId,
      group.selectionRound,
      "skipped_round_mismatch",
      `scene_group.selection_round=${group.selectionRound} (must be >= 1)`,
    );
  }

  // 1. Load all group members + per-media analysis projection in one
  //    pass. Keep only image media that is active (deleted_at IS NULL,
  //    status not failed/deleted). Items that are ineligible silently
  //    drop out — the goal is "pick the best from what we have".
  const candidates = loadCandidates(deps, group.id, group.tripId, group.selectionRound);
  if (candidates.length === 0) {
    return skipResult(
      sceneGroupId,
      group.tripId,
      group.selectionRound,
      "skipped_no_eligible_members",
      "no eligible image members in this group",
    );
  }

  // 2. Score + sort. The Code score is also the AI fallback verdict
  //    + the tie-break for "AI returned mediaId outside top-K".
  const scored = scoreCandidates(candidates);

  // 3. Truncate to top-K for AI input.
  const topK = scored.slice(0, settings.topK);

  // 4. Single-member shortcut — no AI call, no cache lookup.
  if (topK.length === 1) {
    return persistGroupResult({
      sceneGroupId,
      group,
      topK,
      best: { mediaId: topK[0]!.mediaId, source: "single-member" },
      aiConfidence: null,
      auditModelName: `${deps.aiProvider.name}-single-member`,
      auditResponseSummary: buildResponseSummary({
        bestMediaId: topK[0]!.mediaId,
        reason: `single-member-group: only member ${topK[0]!.mediaId}`,
        confidence: null,
        topKMediaIds: topK.map((c) => c.mediaId),
        workerVersion: settings.workerVersion,
        provider: deps.aiProvider.name,
        modelName: `${deps.aiProvider.name}-single-member`,
        verdictSource: "single_member",
      }),
      auditStatus: "success",
      auditDurationMs: 0,
      auditCostEstimate: 0,
      auditErrorMessage: null,
      reason: "single-member-group",
      outcome: "code_fallback_single_member",
      now: clock().toISOString(),
      deps,
    });
  }

  // 5. Compute the canonical input hash for the cost cache. The
  //    AI provider sees the candidate mediaId list only (no thumbnail
  //    bytes for LocalMock; the contract per LocalMockProvider's
  //    `scene_best_pick` accepts `params.candidates`). Identical
  //    top-K + same provider → same input_hash → cache hit.
  const inputHash = computeInputHash(topK.map((c) => c.mediaId));

  // 6. Cost-cache lookup.
  const cacheKey: AiInvocationCacheLookup = {
    tripId: group.tripId,
    requestType: SCENE_BEST_PICK_REQUEST_TYPE,
    targetType: SCENE_BEST_PICK_TARGET_TYPE,
    targetId: sceneGroupId,
    inputHash,
  };
  const cached = deps.aiInvocationsRepo.findSuccessfulCached(cacheKey);
  if (cached !== null) {
    const parsedCache = parseBestPickResponse(cached.responseSummary);
    if (parsedCache !== null && topK.some((c) => c.mediaId === parsedCache.bestMediaId)) {
      // We don't re-DELETE + re-INSERT curated_selections on cache
      // hit — the prior successful run already wrote the draft rows
      // and they are still consistent with the same input_hash.
      return {
        sceneGroupId,
        tripId: group.tripId,
        selectionRound: group.selectionRound,
        outcome: "cache_hit",
        bestMediaId: parsedCache.bestMediaId,
        candidateCount: candidates.length,
        writtenCount: topK.length,
        auditId: cached.id,
        aiConfidence: parsedCache.confidence,
        reason: parsedCache.reason,
        errorMessage: null,
      };
    }
    // Stale cache row (parses but bestMediaId no longer in top-K, or
    // unparseable). Fall through to a fresh attempt. The stale row
    // stays; it's not the worker's job to clean up.
    deps.logger.warn(
      { sceneGroupId, auditId: cached.id, inputHash },
      "scene_best_pick: cache row stale (mediaId not in current top-K); falling through to fresh attempt",
    );
  }

  // 7. AI gate. Provider unavailable / unsupported → Code top-1
  //    fallback path. Still writes draft rows + audit row, just with
  //    a model_name reflecting the fallback.
  if (!deps.aiProvider.available) {
    return persistGroupResult({
      sceneGroupId,
      group,
      topK,
      best: { mediaId: topK[0]!.mediaId, source: "code_top_1" },
      aiConfidence: null,
      auditModelName: `${deps.aiProvider.name}-code-fallback`,
      auditResponseSummary: buildResponseSummary({
        bestMediaId: topK[0]!.mediaId,
        reason: `code-top-1 fallback: AI provider '${deps.aiProvider.name}' not available; picked by quality formula`,
        confidence: null,
        topKMediaIds: topK.map((c) => c.mediaId),
        workerVersion: settings.workerVersion,
        provider: deps.aiProvider.name,
        modelName: `${deps.aiProvider.name}-code-fallback`,
        verdictSource: "code_top_1_ai_off",
      }),
      auditStatus: "success",
      auditDurationMs: 0,
      auditCostEstimate: 0,
      auditErrorMessage: null,
      reason: `code-top-1 fallback: AI provider '${deps.aiProvider.name}' not available`,
      outcome: "code_fallback_ai_off",
      now: clock().toISOString(),
      deps,
      inputHash,
    });
  }
  if (!deps.aiProvider.supports.has(SCENE_BEST_PICK_REQUEST_TYPE)) {
    return persistGroupResult({
      sceneGroupId,
      group,
      topK,
      best: { mediaId: topK[0]!.mediaId, source: "code_top_1" },
      aiConfidence: null,
      auditModelName: `${deps.aiProvider.name}-code-fallback`,
      auditResponseSummary: buildResponseSummary({
        bestMediaId: topK[0]!.mediaId,
        reason: `code-top-1 fallback: AI provider '${deps.aiProvider.name}' does not support 'scene_best_pick'`,
        confidence: null,
        topKMediaIds: topK.map((c) => c.mediaId),
        workerVersion: settings.workerVersion,
        provider: deps.aiProvider.name,
        modelName: `${deps.aiProvider.name}-code-fallback`,
        verdictSource: "code_top_1_unsupported",
      }),
      auditStatus: "success",
      auditDurationMs: 0,
      auditCostEstimate: 0,
      auditErrorMessage: null,
      reason: `code-top-1 fallback: AI provider does not support 'scene_best_pick'`,
      outcome: "code_fallback_ai_unsupported",
      now: clock().toISOString(),
      deps,
      inputHash,
    });
  }

  // 8. Invoke AI. The LocalMock contract is
  //    `params.candidates = [{mediaId}, ...]` → output JSON
  //    `{bestMediaId, reason, confidence}`.
  const invokeStartedAt = Date.now();
  let response;
  try {
    response = await deps.aiProvider.invoke({
      requestType: SCENE_BEST_PICK_REQUEST_TYPE,
      params: { candidates: topK.map((c) => ({ mediaId: c.mediaId })) },
    });
  } catch (invokeErr) {
    const durationMs = Date.now() - invokeStartedAt;
    const msg = describeProviderError(invokeErr);
    // Fall back to Code top-1 and persist a `failed` audit row
    // alongside the curated_selections draft so the audit trail
    // explains why we used Code.
    return persistGroupResult({
      sceneGroupId,
      group,
      topK,
      best: { mediaId: topK[0]!.mediaId, source: "code_top_1" },
      aiConfidence: null,
      auditModelName: `${deps.aiProvider.name}-failed`,
      auditResponseSummary: null,
      auditStatus: "failed",
      auditDurationMs: durationMs,
      auditCostEstimate: null,
      auditErrorMessage: msg,
      reason: `code-top-1 fallback: AI provider threw: ${msg}`,
      outcome: "code_fallback_provider_error",
      now: clock().toISOString(),
      deps,
      inputHash,
    });
  }

  if (response.status === "failed") {
    return persistGroupResult({
      sceneGroupId,
      group,
      topK,
      best: { mediaId: topK[0]!.mediaId, source: "code_top_1" },
      aiConfidence: null,
      auditModelName: response.modelName,
      auditResponseSummary: null,
      auditStatus: "failed",
      auditDurationMs: response.durationMs,
      auditCostEstimate: response.costEstimate,
      auditErrorMessage: response.errorMessage,
      reason: `code-top-1 fallback: AI provider returned failure: ${response.errorMessage}`,
      outcome: "code_fallback_provider_error",
      now: clock().toISOString(),
      deps,
      inputHash,
    });
  }

  // 9. Parse outputBytes.
  const parsed = parseBestPickResponse(
    response.outputBytes !== undefined ? response.outputBytes.toString("utf-8") : null,
  );
  if (parsed === null) {
    return persistGroupResult({
      sceneGroupId,
      group,
      topK,
      best: { mediaId: topK[0]!.mediaId, source: "code_top_1" },
      aiConfidence: null,
      auditModelName: response.modelName,
      auditResponseSummary: null,
      auditStatus: "failed",
      auditDurationMs: response.durationMs,
      auditCostEstimate: response.costEstimate,
      auditErrorMessage: "AI provider returned malformed scene_best_pick outputBytes",
      reason: `code-top-1 fallback: AI returned malformed JSON`,
      outcome: "code_fallback_invalid_response",
      now: clock().toISOString(),
      deps,
      inputHash,
    });
  }

  // 10. Validate that the bestMediaId is actually in top-K. If not,
  //     fall back to Code top-1 (defence-in-depth — a hallucinating
  //     provider must not move a media out of the round).
  if (!topK.some((c) => c.mediaId === parsed.bestMediaId)) {
    return persistGroupResult({
      sceneGroupId,
      group,
      topK,
      best: { mediaId: topK[0]!.mediaId, source: "code_top_1" },
      aiConfidence: null,
      auditModelName: response.modelName,
      auditResponseSummary: null,
      auditStatus: "failed",
      auditDurationMs: response.durationMs,
      auditCostEstimate: response.costEstimate,
      auditErrorMessage: `AI returned bestMediaId='${parsed.bestMediaId}' not in top-K`,
      reason: `code-top-1 fallback: AI bestMediaId not in top-K`,
      outcome: "code_fallback_invalid_pick",
      now: clock().toISOString(),
      deps,
      inputHash,
    });
  }

  // 11. AI success path — persist with the AI's bestMediaId, reason
  //     and confidence.
  return persistGroupResult({
    sceneGroupId,
    group,
    topK,
    best: { mediaId: parsed.bestMediaId, source: "ai" },
    aiConfidence: parsed.confidence,
    auditModelName: response.modelName,
    auditResponseSummary: buildResponseSummary({
      bestMediaId: parsed.bestMediaId,
      reason: parsed.reason,
      confidence: parsed.confidence,
      topKMediaIds: topK.map((c) => c.mediaId),
      workerVersion: settings.workerVersion,
      provider: response.provider,
      modelName: response.modelName,
      verdictSource: "ai",
    }),
    auditStatus: "success",
    auditDurationMs: response.durationMs,
    auditCostEstimate: response.costEstimate,
    auditErrorMessage: null,
    reason: parsed.reason,
    outcome: "success",
    now: clock().toISOString(),
    deps,
    inputHash,
  });
}

/**
 * Run scene_best_pick on every scene group in a trip for the given
 * round. Each group is processed independently; per-group failures
 * do not affect siblings (CLAUDE.md §3.7).
 */
export async function runSceneBestPickForTrip(
  tripId: string,
  selectionRound: number,
  deps: SceneBestPickDeps,
): Promise<TripResult> {
  if (tripId.length === 0) {
    throw new Error("sceneBestPickService: tripId must be non-empty");
  }
  if (!Number.isInteger(selectionRound) || selectionRound < 1) {
    throw new Error(
      `sceneBestPickService: selectionRound must be an integer >= 1 (got ${String(selectionRound)})`,
    );
  }

  const groups = deps.sceneGroupsRepo.listByTripRound(tripId, selectionRound);
  const groupResults: GroupResult[] = [];
  for (const g of groups) {
    const result = await runSceneBestPickForGroup(g.id, deps);
    groupResults.push(result);
  }

  const successCount = groupResults.filter((r) => r.outcome === "success").length;
  const cacheHitCount = groupResults.filter((r) => r.outcome === "cache_hit").length;
  const codeFallbackCount = groupResults.filter((r) => r.outcome.startsWith("code_fallback_")).length;
  const skippedCount = groupResults.filter((r) => r.outcome.startsWith("skipped_")).length;

  deps.logger.info(
    {
      tripId,
      selectionRound,
      groupCount: groupResults.length,
      successCount,
      cacheHitCount,
      codeFallbackCount,
      skippedCount,
    },
    "scene_best_pick: trip pass complete",
  );

  return {
    tripId,
    selectionRound,
    groupCount: groupResults.length,
    successCount,
    cacheHitCount,
    codeFallbackCount,
    skippedCount,
    groupResults,
  };
}

// ---------------------------------------------------------------------------
// Internal types / helpers
// ---------------------------------------------------------------------------

interface Candidate {
  readonly mediaId: string;
  readonly rankInGroup: number;
  /** ISO timestamp; tie-break fallback. */
  readonly createdAt: string;
  /** Effective Code score in [0, 1+] (multiplier ≤ 1 so always ≤
   * `quality_score` here, but kept unconstrained for future
   * formula tweaks). */
  readonly score: number;
  /** quality_score value as it appeared in media_analysis (null when
   * missing). */
  readonly rawQualityScore: number | null;
  /** AI blur class or null when absent. */
  readonly aiBlurClass: "sharp" | "maybe_blurry" | "blurry" | "unknown" | null;
  /** Code Laplacian verdict (0 / 1 / null). */
  readonly isBlurry: 0 | 1 | null;
  readonly isDuplicate: 0 | 1 | null;
}

/**
 * Read every member of one scene_group, filter out ineligible
 * media (image-only, not soft-deleted, not failed/deleted), and
 * return the score-ready candidate list.
 */
function loadCandidates(
  deps: SceneBestPickDeps,
  sceneGroupId: string,
  tripId: string,
  selectionRound: number,
): Candidate[] {
  void tripId;
  void selectionRound;
  const items = deps.sceneGroupItemsRepo.listByGroup(sceneGroupId);
  const candidates: Candidate[] = [];
  for (const item of items) {
    const media = deps.mediaRepo.findById(item.mediaId);
    if (media === null) continue; // soft-deleted (mediaRepo.findById defaults active-only)
    if (media.type !== "image") continue;
    if (media.status === "failed" || media.status === "deleted") continue;
    const analysis = deps.mediaAnalysisRepo.findByMediaId(media.id);
    const aiBlurClass = analysis?.aiBlurClass ?? null;
    const isBlurry = analysis?.isBlurry ?? null;
    const isDuplicate = analysis?.isDuplicate ?? null;
    const rawQuality = analysis?.qualityScore ?? null;
    const score = computeScore({
      qualityScore: rawQuality,
      aiBlurClass,
      isBlurry,
      isDuplicate,
    });
    candidates.push({
      mediaId: media.id,
      rankInGroup: item.rankInGroup,
      createdAt: media.createdAt,
      score,
      rawQualityScore: rawQuality,
      aiBlurClass,
      isBlurry,
      isDuplicate,
    });
  }
  return candidates;
}

/**
 * Pure Code scoring function. Exported via the module's re-export so
 * future tasks can unit-test it independently of any DB.
 */
export function computeScore(input: {
  qualityScore: number | null;
  aiBlurClass: "sharp" | "maybe_blurry" | "blurry" | "unknown" | null;
  isBlurry: 0 | 1 | null;
  isDuplicate: 0 | 1 | null;
}): number {
  const base = input.qualityScore ?? SCENE_BEST_PICK_DEFAULT_QUALITY;
  let blurMul: number;
  switch (input.aiBlurClass) {
    case "sharp":
      blurMul = SCENE_BEST_PICK_BLUR_MULTIPLIERS.ai_sharp;
      break;
    case "maybe_blurry":
      blurMul = SCENE_BEST_PICK_BLUR_MULTIPLIERS.ai_maybe_blurry;
      break;
    case "blurry":
      blurMul = SCENE_BEST_PICK_BLUR_MULTIPLIERS.ai_blurry;
      break;
    case "unknown":
    case null:
      blurMul = input.isBlurry === 1
        ? SCENE_BEST_PICK_BLUR_MULTIPLIERS.code_blurry
        : SCENE_BEST_PICK_BLUR_MULTIPLIERS.unknown;
      break;
  }
  const dupPenalty = input.isDuplicate === 1 ? SCENE_BEST_PICK_DUPLICATE_PENALTY : 0;
  return base * blurMul - dupPenalty;
}

/**
 * Sort by `score DESC, rank_in_group ASC, created_at ASC, mediaId ASC`
 * — deterministic tie-break that always agrees with itself on re-run.
 */
function scoreCandidates(candidates: readonly Candidate[]): Candidate[] {
  return [...candidates].sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.rankInGroup !== b.rankInGroup) return a.rankInGroup - b.rankInGroup;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.mediaId < b.mediaId ? -1 : a.mediaId > b.mediaId ? 1 : 0;
  });
}

/**
 * Compute the cost-cache key. Canonicalises the top-K mediaIds in
 * presented order (the AI sees them in this order — different order
 * could legitimately produce a different result, so the order is
 * part of the key).
 */
function computeInputHash(orderedMediaIds: readonly string[]): string {
  const canonical = JSON.stringify({
    requestType: SCENE_BEST_PICK_REQUEST_TYPE,
    candidates: orderedMediaIds.map((m) => ({ mediaId: m })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

interface PersistGroupArgs {
  readonly sceneGroupId: string;
  readonly group: { id: string; tripId: string; selectionRound: number };
  readonly topK: readonly Candidate[];
  readonly best: { mediaId: string; source: "ai" | "code_top_1" | "single-member" };
  readonly aiConfidence: number | null;
  readonly auditModelName: string;
  readonly auditResponseSummary: string | null;
  readonly auditStatus: "success" | "failed";
  readonly auditDurationMs: number;
  readonly auditCostEstimate: number | null;
  readonly auditErrorMessage: string | null;
  readonly reason: string;
  readonly outcome: SceneBestPickOutcome;
  readonly now: string;
  readonly deps: SceneBestPickDeps;
  readonly inputHash?: string;
}

/**
 * Single funnel that writes curated_selections draft rows + the
 * ai_invocations audit row. Used by every terminal path of
 * `runSceneBestPickForGroup` (success / code-fallback /
 * single-member).
 *
 * The curated_selections write is wrapped in `db.transaction`:
 *   1. DELETE prior draft rows for this group / round / trip (only
 *      AI rows; round=0 and other groups protected).
 *   2. INSERT new top-K rows.
 *
 * The audit row is written SEPARATELY (not inside the curated TX) —
 * a failed audit insert (cost-cache UNIQUE race) does not roll back
 * the analysis-equivalent (curated rows). Same trade-off as P12.T5:
 * curated rows are the truth, audit is the audit.
 */
function persistGroupResult(args: PersistGroupArgs): GroupResult {
  const { deps, group, topK, auditStatus, inputHash, now } = args;
  // 1. Write the audit row first. If it raises on cost-cache UNIQUE,
  //    the parallel-worker race winner is already in the cache; we
  //    can convert to cache_hit IF the winner row also matches the
  //    current top-K (rare; for baseline we just rethrow).
  const auditId = randomUUID();
  try {
    deps.aiInvocationsRepo.insertWithTargets({
      id: auditId,
      mediaId: null,
      tripId: group.tripId,
      jobId: null,
      provider: deps.aiProvider.name,
      modelName: args.auditModelName,
      requestType: SCENE_BEST_PICK_REQUEST_TYPE,
      targetType: SCENE_BEST_PICK_TARGET_TYPE,
      targetId: group.id,
      inputHash: inputHash ?? null,
      status: auditStatus,
      requestParams: null,
      responseSummary: args.auditResponseSummary,
      costEstimate: args.auditCostEstimate,
      durationMs: args.auditDurationMs,
      errorMessage: args.auditErrorMessage,
      now,
    });
  } catch (err) {
    // Cost-cache race or other DB error. Re-check cache; if a winner
    // exists with a top-K-compatible verdict, convert.
    if (inputHash !== undefined) {
      const raced = deps.aiInvocationsRepo.findSuccessfulCached({
        tripId: group.tripId,
        requestType: SCENE_BEST_PICK_REQUEST_TYPE,
        targetType: SCENE_BEST_PICK_TARGET_TYPE,
        targetId: group.id,
        inputHash,
      });
      if (raced !== null) {
        const parsedRace = parseBestPickResponse(raced.responseSummary);
        if (parsedRace !== null && topK.some((c) => c.mediaId === parsedRace.bestMediaId)) {
          deps.logger.info(
            { sceneGroupId: group.id, raceWinnerAuditId: raced.id, inputHash },
            "scene_best_pick: lost cache race; using winner's verdict",
          );
          // Persist curated rows below using the winner's verdict.
          const winnerArgs: PersistGroupArgs = {
            ...args,
            best: { mediaId: parsedRace.bestMediaId, source: "ai" },
            aiConfidence: parsedRace.confidence,
            reason: parsedRace.reason,
            outcome: "cache_hit",
          };
          return persistCuratedThenReturn(winnerArgs, raced.id);
        }
      }
    }
    // Real DB error — let it bubble.
    throw err;
  }

  // 2. Now write curated_selections rows.
  return persistCuratedThenReturn(args, auditId);
}

/**
 * Helper: write the curated_selections draft rows inside a
 * transaction (DELETE-then-INSERT-top-K) and assemble the GroupResult.
 */
function persistCuratedThenReturn(
  args: PersistGroupArgs,
  auditId: string,
): GroupResult {
  const { deps, group, topK, best, reason, aiConfidence, outcome } = args;
  deps.db.transaction(() => {
    deps.curatedSelectionsRepo.deleteDraftsForGroup(
      group.tripId,
      group.selectionRound,
      group.id,
    );
    for (const c of topK) {
      const isBest = c.mediaId === best.mediaId;
      deps.curatedSelectionsRepo.insertAi({
        id: randomUUID(),
        tripId: group.tripId,
        mediaId: c.mediaId,
        sceneGroupId: group.id,
        selectionRound: group.selectionRound,
        included: isBest ? 1 : 0,
        isCurrent: 0, // draft only — never 1, finalize owns is_current
        reason: isBest ? reason : "not_best_in_group",
        aiConfidence: isBest ? aiConfidence : null,
        refinementParams: null,
      });
    }
  })();

  return {
    sceneGroupId: group.id,
    tripId: group.tripId,
    selectionRound: group.selectionRound,
    outcome,
    bestMediaId: best.mediaId,
    candidateCount: topK.length, // candidateCount in the result is the size of the top-K we actually wrote
    writtenCount: topK.length,
    auditId,
    aiConfidence,
    reason,
    errorMessage: args.auditErrorMessage,
  };
}

/**
 * Parse the AI provider's scene_best_pick response. LocalMock (P12.T1)
 * returns `{requestType, algorithmVersion, bestMediaId, reason, confidence}`.
 * Anything else → null.
 */
function parseBestPickResponse(
  raw: string | null,
): { bestMediaId: string; reason: string; confidence: number | null } | null {
  if (raw === null || raw.length === 0) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (json === null || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;
  const bestMediaId = obj["bestMediaId"];
  const reason = obj["reason"];
  const confidence = obj["confidence"];
  if (typeof bestMediaId !== "string" || bestMediaId.length === 0) return null;
  if (typeof reason !== "string" || reason.length === 0) return null;
  if (confidence !== null && confidence !== undefined && typeof confidence !== "number") {
    return null;
  }
  return {
    bestMediaId,
    reason,
    confidence:
      typeof confidence === "number" && Number.isFinite(confidence) ? confidence : null,
  };
}

/**
 * Build the JSON we persist in `ai_invocations.response_summary`. The
 * shape round-trips cleanly through `parseBestPickResponse` so a
 * future cache hit can reuse it.
 */
function buildResponseSummary(args: {
  bestMediaId: string;
  reason: string;
  confidence: number | null;
  topKMediaIds: readonly string[];
  workerVersion: string;
  provider: string;
  modelName: string;
  verdictSource: string;
}): string {
  return JSON.stringify({
    bestMediaId: args.bestMediaId,
    reason: args.reason,
    confidence: args.confidence,
    topKMediaIds: args.topKMediaIds,
    workerVersion: args.workerVersion,
    provider: args.provider,
    modelName: args.modelName,
    verdictSource: args.verdictSource,
  });
}

function describeProviderError(err: unknown): string {
  if (err instanceof AIProviderNotConfiguredError) {
    return `AI provider threw AI_NOT_CONFIGURED: ${err.message}`;
  }
  if (err instanceof AIProviderUnsupportedRequestError) {
    return `AI provider does not support 'scene_best_pick': ${err.message}`;
  }
  if (err instanceof Error) {
    return `AI provider invoke threw: ${err.name}: ${err.message}`;
  }
  return `AI provider invoke threw: ${String(err)}`;
}

function skipResult(
  sceneGroupId: string,
  tripId: string | null,
  selectionRound: number,
  outcome: SceneBestPickOutcome,
  errorMessage: string,
): GroupResult {
  return {
    sceneGroupId,
    tripId,
    selectionRound,
    outcome,
    bestMediaId: null,
    candidateCount: 0,
    writtenCount: 0,
    auditId: null,
    aiConfidence: null,
    reason: null,
    errorMessage,
  };
}
