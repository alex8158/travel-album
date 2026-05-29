// aiBlurCheckService.ts — P12.T5 baseline AI second-pass blur check.
//
// Scope (deliberately narrow per the P12.T5 prompt):
//   * Pure service layer. No JobHandler registration, no enqueue
//     wrapper, no orchestrator wiring — those are P12.T9.
//   * Reads existing data only: `media_items`, `media_versions` (the
//     thumbnail / preview / original chain), `ai_invocations` for the
//     cost-cache lookup. NEVER touches raw image bytes beyond reading
//     them through `LocalStorageProvider`.
//   * Writes ONLY two tables, both through their repositories:
//       * `media_analysis.ai_blur_class` + `ai_blur_reason`
//         (migration 026 columns; `upsertAiBlurAnalysis` leaves every
//          other media_analysis column untouched — the Code Laplacian
//          verdict and the AI verdict coexist per migration 026
//          header).
//       * `ai_invocations` rows via the new `insertWithTargets`
//         method (migration 024 columns: trip_id / target_type /
//         target_id / input_hash).
//   * Image-only. Videos are excluded by the same media_type filter
//     P12.T4 uses (image-only curation pipeline).
//   * Source byte resolution order, smallest-first to match the
//     P12.T5 prompt's "preview / optimized 优先；没有则 fallback 到
//     original":
//        thumbnail → preview → ai_refined → enhanced → original
//     The AI provider stub's classification is deterministic by
//     SHA256(inputBytes), so a different version (different bytes)
//     could produce a different `class`. We prefer thumbnail when
//     present because it matches the P12.T5 task spec ("输入单张
//     media 的缩略图 (≤ 512 px)") and keeps the input_hash cache
//     key stable across re-runs of the worker on the same media.
//
// AI off / unsupported / unavailable → GRACEFUL SKIP. The service
// returns an `outcome` of `skipped_ai_*` WITHOUT writing
// media_analysis or ai_invocations rows. This matches CLAUDE.md
// §2.8 ("AI 调用默认关闭。未配置 AI 时，全部基础功能必须仍可用")
// and the P12.T5 red line "§2.8 AI off worker 直接 skip 不入队".
// The trip-level batch sees one bad media as one `skipped_*`
// outcome and proceeds to the next; nothing throws.
//
// Cost cache (input_hash):
//   * `input_hash` = `SHA256(sourceBytes).hex` (the AI input bytes
//     verbatim — no extra params for ai_blur_check). Cached against
//     the partial UNIQUE on
//       `(trip_id, request_type, target_type, target_id, input_hash)
//        WHERE status='success'`
//     (migration 024 / P12.T3). Before invoking the provider the
//     service calls `aiInvocationsRepo.findSuccessfulCached(...)`;
//     a hit short-circuits with `outcome='cache_hit'` and reuses
//     the prior verdict that's already on disk in `media_analysis`.
//   * If the previous successful row's response_summary parses, we
//     return the cached class + reason. If parsing fails we fall
//     through to a fresh AI invocation rather than throwing — the
//     cache is a hint, not an invariant.
//
// Idempotency:
//   * media_analysis writes use `ON CONFLICT(media_id) DO UPDATE` on
//     ai_blur_class + ai_blur_reason only (migration 026 columns).
//     Same media, same input → same verdict → same row.
//   * ai_invocations: a 2nd run with the same input_hash hits the
//     cost-cache and writes no new audit row.
//   * Trip-level: each per-media call is independent — one failure
//     does not affect siblings (P12 §3.7 isolation red line).
//
// Failure boundary:
//   * `runAiBlurCheckForMedia` NEVER throws on per-media errors —
//     every outcome (success / cache_hit / failed_* / skipped_*) is
//     a structured `MediaResult`. The caller (trip-level loop or
//     the future P12.T9 orchestrator) decides whether to escalate.
//   * Programmer / environment errors (missing repo / DB closed)
//     still bubble up.

import { createHash, randomUUID } from "node:crypto";
import type { Readable } from "node:stream";

import {
  AIProviderNotConfiguredError,
  AIProviderUnsupportedRequestError,
  type AIProvider,
  type AIRequestType,
  type AiInvocationCacheLookup,
  type AiInvocationsRepository,
} from "../ai/index.js";
import type { Logger } from "../logger.js";
import type {
  MediaAnalysisRepository,
  MediaRepository,
  MediaVersionsRepository,
} from "../media/index.js";
import type { LocalStorageProvider } from "../storage/index.js";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** `processing_jobs.job_type` token for the future orchestrator
 * (P12.T9) to enqueue this work on. The service itself does NOT
 * register a handler; this constant is published so the orchestrator
 * can refer to it without re-typing the literal. */
export const AI_BLUR_CHECK_JOB_TYPE = "ai_blur_check";

/** Closed enum for `ai_invocations.request_type` (migration 018);
 * mirrors {@link AIRequestType} for type-narrowing without importing
 * the broader union just to refer to this one value. */
export const AI_BLUR_CHECK_REQUEST_TYPE: AIRequestType = "ai_blur_check";

/** `ai_invocations.target_type` enum value (migration 024) we always
 * write for ai_blur_check — the request is per-media. */
export const AI_BLUR_CHECK_TARGET_TYPE = "media" as const;

/** Worker / algorithm version stamped into the response_summary so
 * later audits can detect drift between baseline runs. */
export const AI_BLUR_CHECK_ALGORITHM_VERSION = "1.0";

/**
 * The version_type preference order for source bytes. Smallest first
 * matches the P12.T5 task spec ("输入单张 media 的缩略图 ≤ 512 px");
 * each fallback is an explicit operational choice (e.g. an image with
 * no thumbnail but with a refined version still gets analysed). The
 * `original` slot is in the list but uses `media_items.original_path`
 * (not a media_versions row) because the upload pipeline writes
 * `original_path` directly on the media row.
 */
export const AI_BLUR_CHECK_SOURCE_PREFERENCE = Object.freeze([
  "thumbnail",
  "preview",
  "ai_refined",
  "enhanced",
] as const);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AiBlurCheckSettings {
  /** Stamped into the audit row's response_summary + media_analysis
   * raw reason for traceability. */
  readonly workerVersion: string;
}

export const DEFAULT_AI_BLUR_CHECK_SETTINGS: AiBlurCheckSettings = {
  workerVersion: AI_BLUR_CHECK_ALGORITHM_VERSION,
};

export interface AiBlurCheckDeps {
  readonly storage: LocalStorageProvider;
  readonly mediaRepo: MediaRepository;
  readonly mediaVersionsRepo: MediaVersionsRepository;
  readonly mediaAnalysisRepo: MediaAnalysisRepository;
  readonly aiInvocationsRepo: AiInvocationsRepository;
  readonly aiProvider: AIProvider;
  readonly logger: Logger;
  readonly settings?: AiBlurCheckSettings;
  /** Override clock for tests / smokes. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

/** Per-media outcome. Each variant is structurally distinct so the
 * caller / smoke can switch on `outcome` without inspecting strings. */
export type AiBlurCheckOutcome =
  | "success"
  | "cache_hit"
  | "skipped_media_not_eligible"
  | "skipped_no_source"
  | "skipped_ai_unavailable"
  | "skipped_ai_unsupported"
  | "failed_provider_error"
  | "failed_invalid_response";

export interface MediaResult {
  readonly mediaId: string;
  readonly outcome: AiBlurCheckOutcome;
  readonly aiBlurClass: "sharp" | "maybe_blurry" | "blurry" | null;
  readonly aiBlurReason: string | null;
  /**
   * For success / cache_hit: the source version_type the worker used
   * (`thumbnail` / `preview` / etc., or `original` when nothing else
   * was available).
   *
   * For skipped_no_source: null (no source was readable).
   */
  readonly sourceVersionType: string | null;
  /** SHA256 hex of the source bytes; null when no bytes were read. */
  readonly inputHash: string | null;
  /**
   * The ai_invocations row id written during this call (success or
   * failed), or the prior row's id on `cache_hit`. `null` for any
   * `skipped_*` outcome (no audit row was written).
   */
  readonly auditId: string | null;
  /** Filled on failed_* outcomes; null otherwise. */
  readonly errorMessage: string | null;
}

export interface TripResult {
  readonly tripId: string;
  readonly totalCandidates: number;
  readonly successCount: number;
  readonly cacheHitCount: number;
  readonly skippedCount: number;
  readonly failedCount: number;
  readonly results: readonly MediaResult[];
}

// ---------------------------------------------------------------------------
// Service entry points
// ---------------------------------------------------------------------------

/**
 * Run the AI blur check on a single media row. Never throws on per-
 * media errors; the return shape carries the verdict.
 *
 * The function performs ALL the steps for one media: provider
 * gate → source resolution → input_hash → cache lookup → AI
 * invoke → media_analysis write → ai_invocations write.
 */
export async function runAiBlurCheckForMedia(
  mediaId: string,
  deps: AiBlurCheckDeps,
): Promise<MediaResult> {
  if (mediaId.length === 0) {
    throw new Error("aiBlurCheckService: mediaId must be non-empty");
  }
  const settings = deps.settings ?? DEFAULT_AI_BLUR_CHECK_SETTINGS;
  const clock = deps.now ?? (() => new Date());

  // ---- 1. Resolve media (active-only) ------------------------------------
  const media = deps.mediaRepo.findById(mediaId);
  if (media === null) {
    return skipResult(mediaId, "skipped_media_not_eligible", "media not found or soft-deleted");
  }
  if (media.type !== "image") {
    return skipResult(
      mediaId,
      "skipped_media_not_eligible",
      `media type='${media.type}' (image-only)`,
    );
  }
  if (media.status === "failed" || media.status === "deleted") {
    return skipResult(
      mediaId,
      "skipped_media_not_eligible",
      `media status='${media.status}'`,
    );
  }

  // ---- 2. AI provider gate ----------------------------------------------
  // §2.8 / §3.7 — AI off → graceful skip (no audit row, no analysis row).
  if (!deps.aiProvider.available) {
    return skipResult(
      mediaId,
      "skipped_ai_unavailable",
      `AI provider '${deps.aiProvider.name}' not available`,
    );
  }
  if (!deps.aiProvider.supports.has(AI_BLUR_CHECK_REQUEST_TYPE)) {
    return skipResult(
      mediaId,
      "skipped_ai_unsupported",
      `AI provider '${deps.aiProvider.name}' does not support 'ai_blur_check'`,
    );
  }

  // ---- 3. Resolve source bytes ------------------------------------------
  const sourceInfo = await resolveSourceBytes(media.id, media.originalPath, deps);
  if (sourceInfo === null) {
    return {
      mediaId,
      outcome: "skipped_no_source",
      aiBlurClass: null,
      aiBlurReason: null,
      sourceVersionType: null,
      inputHash: null,
      auditId: null,
      errorMessage: "no readable source version (thumbnail / preview / original all missing)",
    };
  }
  const { sourceBytes, sourceVersionType } = sourceInfo;
  const inputHash = createHash("sha256").update(sourceBytes).digest("hex");

  // ---- 4. Cost-cache lookup ---------------------------------------------
  const cacheKey: AiInvocationCacheLookup = {
    tripId: media.tripId,
    requestType: AI_BLUR_CHECK_REQUEST_TYPE,
    targetType: AI_BLUR_CHECK_TARGET_TYPE,
    targetId: mediaId,
    inputHash,
  };
  const cached = deps.aiInvocationsRepo.findSuccessfulCached(cacheKey);
  if (cached !== null) {
    const parsedCache = parseBlurResponse(cached.responseSummary);
    if (parsedCache !== null) {
      // Cache HIT — return the prior verdict without invoking AI.
      // media_analysis was already written on the prior successful
      // call, so we don't re-upsert; the row is up to date.
      return {
        mediaId,
        outcome: "cache_hit",
        aiBlurClass: parsedCache.class,
        aiBlurReason: parsedCache.reason,
        sourceVersionType,
        inputHash,
        auditId: cached.id,
        errorMessage: null,
      };
    }
    // Cache row exists but its response_summary doesn't parse — fall
    // through to a fresh invocation. The stale row is left in place
    // (no DELETE; the cost-cache UNIQUE will still suppress duplicate
    // success rows by the next insert).
    deps.logger.warn(
      { mediaId, auditId: cached.id, inputHash },
      "ai_blur_check: cache row response_summary did not parse; falling through to fresh invoke",
    );
  }

  // ---- 5. Invoke AI provider --------------------------------------------
  const invokeStartedAt = Date.now();
  let response;
  try {
    response = await deps.aiProvider.invoke({
      requestType: AI_BLUR_CHECK_REQUEST_TYPE,
      mediaId: media.id,
      inputBytes: sourceBytes,
    });
  } catch (invokeErr) {
    const durationMs = Date.now() - invokeStartedAt;
    const msg = describeProviderError(invokeErr);
    const auditId = writeFailedAudit(deps, {
      tripId: media.tripId,
      mediaId,
      inputHash,
      errorMessage: msg,
      durationMs,
      now: clock().toISOString(),
    });
    return {
      mediaId,
      outcome: "failed_provider_error",
      aiBlurClass: null,
      aiBlurReason: null,
      sourceVersionType,
      inputHash,
      auditId,
      errorMessage: msg,
    };
  }

  if (response.status === "failed") {
    const auditId = writeFailedAudit(deps, {
      tripId: media.tripId,
      mediaId,
      inputHash,
      errorMessage: response.errorMessage,
      durationMs: response.durationMs,
      now: clock().toISOString(),
    });
    return {
      mediaId,
      outcome: "failed_provider_error",
      aiBlurClass: null,
      aiBlurReason: null,
      sourceVersionType,
      inputHash,
      auditId,
      errorMessage: response.errorMessage,
    };
  }

  // ---- 6. Parse response -------------------------------------------------
  const parsed = parseBlurResponse(
    response.outputBytes !== undefined ? response.outputBytes.toString("utf-8") : null,
  );
  if (parsed === null) {
    const msg = "AI provider returned malformed ai_blur_check outputBytes";
    const auditId = writeFailedAudit(deps, {
      tripId: media.tripId,
      mediaId,
      inputHash,
      errorMessage: msg,
      durationMs: response.durationMs,
      now: clock().toISOString(),
    });
    return {
      mediaId,
      outcome: "failed_invalid_response",
      aiBlurClass: null,
      aiBlurReason: null,
      sourceVersionType,
      inputHash,
      auditId,
      errorMessage: msg,
    };
  }

  // ---- 7. Persist analysis + audit (single logical write) ----------------
  // We do NOT wrap these in a single SQL transaction — the two
  // writes are independent rows in independent tables, and putting
  // them in one transaction would mean an UNIQUE-violating
  // ai_invocations insert (extremely unlikely thanks to the cache
  // lookup above, but possible in a parallel-worker race) rolls
  // back the media_analysis update too. We accept that the audit
  // row may briefly trail the analysis row instead — the analysis
  // is the truth the rest of the pipeline reads.
  const nowIso = clock().toISOString();
  const responseSummary = buildResponseSummary(parsed, {
    workerVersion: settings.workerVersion,
    provider: response.provider,
    modelName: response.modelName,
    sourceVersionType,
    inputHash,
  });

  // Audit row first. If it raises (e.g. UNIQUE violation from a race
  // we lost), fall back to "another worker won the cache race; treat
  // this as cache_hit using the row that beat us".
  const auditId = randomUUID();
  try {
    deps.aiInvocationsRepo.insertWithTargets({
      id: auditId,
      mediaId: media.id,
      tripId: media.tripId,
      jobId: null,
      provider: response.provider,
      modelName: response.modelName,
      requestType: AI_BLUR_CHECK_REQUEST_TYPE,
      targetType: AI_BLUR_CHECK_TARGET_TYPE,
      targetId: mediaId,
      inputHash,
      status: "success",
      requestParams: null,
      responseSummary,
      costEstimate: response.costEstimate,
      durationMs: response.durationMs,
      errorMessage: null,
      now: nowIso,
    });
  } catch (auditErr) {
    // The cost-cache UNIQUE WHERE status='success' may have been
    // satisfied by a concurrent writer in the same race. Re-check
    // the cache and if we find a row, treat as cache_hit.
    const racedHit = deps.aiInvocationsRepo.findSuccessfulCached(cacheKey);
    if (racedHit !== null) {
      const parsedRace = parseBlurResponse(racedHit.responseSummary);
      if (parsedRace !== null) {
        deps.logger.info(
          { mediaId, raceWinnerAuditId: racedHit.id, inputHash },
          "ai_blur_check: lost cache race; using winner's verdict",
        );
        return {
          mediaId,
          outcome: "cache_hit",
          aiBlurClass: parsedRace.class,
          aiBlurReason: parsedRace.reason,
          sourceVersionType,
          inputHash,
          auditId: racedHit.id,
          errorMessage: null,
        };
      }
    }
    // Not a cache race — re-raise (audit write failure is a real
    // problem, surface it).
    throw auditErr;
  }

  // Now the analysis row — this is the actual "AI thinks this is
  // {sharp/maybe_blurry/blurry}" verdict the rest of the pipeline
  // reads.
  deps.mediaAnalysisRepo.upsertAiBlurAnalysis({
    id: randomUUID(),
    mediaId: media.id,
    aiBlurClass: parsed.class,
    aiBlurReason: parsed.reason,
    updatedAt: nowIso,
  });

  return {
    mediaId,
    outcome: "success",
    aiBlurClass: parsed.class,
    aiBlurReason: parsed.reason,
    sourceVersionType,
    inputHash,
    auditId,
    errorMessage: null,
  };
}

/**
 * Run the AI blur check on every eligible image in a trip. Each
 * media is processed independently — a per-media failure or skip
 * does not affect siblings (P12 §3.7 isolation red line).
 */
export async function runAiBlurCheckForTrip(
  tripId: string,
  deps: AiBlurCheckDeps,
): Promise<TripResult> {
  if (tripId.length === 0) {
    throw new Error("aiBlurCheckService: tripId must be non-empty");
  }

  // Page through every active media via the existing
  // `MediaRepository.list` (which already filters
  // `deleted_at IS NULL`) and post-filter on type / status. Image-only;
  // failed / deleted status excluded by the per-media gate inside
  // `runAiBlurCheckForMedia`, but we short-circuit here too to skip
  // the per-media findById round-trip on ineligible rows.
  const results: MediaResult[] = [];
  const BATCH = 200;
  for (let offset = 0; ; offset += BATCH) {
    const page = deps.mediaRepo.list(tripId, { limit: BATCH, offset });
    if (page.length === 0) break;
    for (const m of page) {
      if (m.type !== "image") continue;
      if (m.status === "failed" || m.status === "deleted") continue;
      const result = await runAiBlurCheckForMedia(m.id, deps);
      results.push(result);
    }
    if (page.length < BATCH) break;
  }

  const successCount = results.filter((r) => r.outcome === "success").length;
  const cacheHitCount = results.filter((r) => r.outcome === "cache_hit").length;
  const skippedCount = results.filter((r) => r.outcome.startsWith("skipped_")).length;
  const failedCount = results.filter((r) => r.outcome.startsWith("failed_")).length;

  deps.logger.info(
    {
      tripId,
      totalCandidates: results.length,
      successCount,
      cacheHitCount,
      skippedCount,
      failedCount,
    },
    "ai_blur_check: trip pass complete",
  );

  return {
    tripId,
    totalCandidates: results.length,
    successCount,
    cacheHitCount,
    skippedCount,
    failedCount,
    results,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SourceInfo {
  readonly sourceBytes: Buffer;
  readonly sourceVersionType: string;
}

/**
 * Walk {@link AI_BLUR_CHECK_SOURCE_PREFERENCE} looking for a readable
 * version. If none of the listed versions exist (or all fail to read),
 * fall back to `media_items.original_path`. Returns null when no
 * readable source is available at all.
 */
async function resolveSourceBytes(
  mediaId: string,
  originalPath: string | null,
  deps: AiBlurCheckDeps,
): Promise<SourceInfo | null> {
  const versions = deps.mediaVersionsRepo.listByMediaId(mediaId);
  const byType = new Map<string, string>();
  for (const v of versions) {
    if (!byType.has(v.versionType)) byType.set(v.versionType, v.filePath);
  }

  for (const versionType of AI_BLUR_CHECK_SOURCE_PREFERENCE) {
    const filePath = byType.get(versionType);
    if (filePath === undefined) continue;
    const bytes = await tryReadBytes(deps.storage, filePath);
    if (bytes !== null && bytes.length > 0) {
      return { sourceBytes: bytes, sourceVersionType: versionType };
    }
  }

  // Fallback: original.
  if (originalPath !== null) {
    const bytes = await tryReadBytes(deps.storage, originalPath);
    if (bytes !== null && bytes.length > 0) {
      return { sourceBytes: bytes, sourceVersionType: "original" };
    }
  }
  return null;
}

async function tryReadBytes(
  storage: LocalStorageProvider,
  logicalPath: string,
): Promise<Buffer | null> {
  try {
    const stream = await storage.read(logicalPath);
    return await streamToBuffer(stream);
  } catch {
    return null;
  }
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

/**
 * Parse the AI provider's ai_blur_check response. The LocalMock stub
 * (P12.T1) returns:
 *   `{ requestType, algorithmVersion, class, reason }`
 * Future real providers MUST match the same shape (closed enum class).
 * Anything else → null (caller emits `failed_invalid_response`).
 */
function parseBlurResponse(
  raw: string | null,
): { class: "sharp" | "maybe_blurry" | "blurry"; reason: string } | null {
  if (raw === null || raw.length === 0) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (json === null || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;
  const cls = obj["class"];
  const reason = obj["reason"];
  if (
    cls !== "sharp" &&
    cls !== "maybe_blurry" &&
    cls !== "blurry"
  ) {
    return null;
  }
  if (typeof reason !== "string" || reason.length === 0) {
    return null;
  }
  return { class: cls, reason };
}

/**
 * Build the JSON we store in `ai_invocations.response_summary`. Has
 * to round-trip cleanly through `parseBlurResponse` so a future
 * cache hit can reuse it. We include extra audit-only fields under
 * keys not read by the parser.
 */
function buildResponseSummary(
  parsed: { class: "sharp" | "maybe_blurry" | "blurry"; reason: string },
  audit: {
    workerVersion: string;
    provider: string;
    modelName: string;
    sourceVersionType: string;
    inputHash: string;
  },
): string {
  return JSON.stringify({
    class: parsed.class,
    reason: parsed.reason,
    workerVersion: audit.workerVersion,
    provider: audit.provider,
    modelName: audit.modelName,
    sourceVersionType: audit.sourceVersionType,
    inputHash: audit.inputHash,
  });
}

function describeProviderError(err: unknown): string {
  if (err instanceof AIProviderNotConfiguredError) {
    return `AI provider threw AI_NOT_CONFIGURED: ${err.message}`;
  }
  if (err instanceof AIProviderUnsupportedRequestError) {
    return `AI provider does not support 'ai_blur_check': ${err.message}`;
  }
  if (err instanceof Error) {
    return `AI provider invoke threw: ${err.name}: ${err.message}`;
  }
  return `AI provider invoke threw: ${String(err)}`;
}

function writeFailedAudit(
  deps: AiBlurCheckDeps,
  args: {
    tripId: string;
    mediaId: string;
    inputHash: string;
    errorMessage: string;
    durationMs: number | null;
    now: string;
  },
): string {
  const auditId = randomUUID();
  try {
    deps.aiInvocationsRepo.insertWithTargets({
      id: auditId,
      mediaId: args.mediaId,
      tripId: args.tripId,
      jobId: null,
      provider: deps.aiProvider.name,
      modelName: `${deps.aiProvider.name}-ai-blur-check-failed`,
      requestType: AI_BLUR_CHECK_REQUEST_TYPE,
      targetType: AI_BLUR_CHECK_TARGET_TYPE,
      targetId: args.mediaId,
      inputHash: args.inputHash,
      status: "failed",
      requestParams: null,
      responseSummary: null,
      costEstimate: null,
      durationMs: args.durationMs,
      errorMessage: args.errorMessage,
      now: args.now,
    });
  } catch (auditErr) {
    // Audit-row writes for FAILED state cannot fail the partial
    // UNIQUE (it's `WHERE status='success'`). Any other DB error
    // here is a real DB problem; log and rethrow so the caller
    // sees it.
    deps.logger.error(
      {
        mediaId: args.mediaId,
        auditId,
        originalError: args.errorMessage,
        auditError: auditErr instanceof Error ? auditErr.message : String(auditErr),
      },
      "ai_blur_check: failed-audit insert itself threw",
    );
    throw auditErr;
  }
  return auditId;
}

function skipResult(
  mediaId: string,
  outcome: AiBlurCheckOutcome,
  errorMessage: string,
): MediaResult {
  return {
    mediaId,
    outcome,
    aiBlurClass: null,
    aiBlurReason: null,
    sourceVersionType: null,
    inputHash: null,
    auditId: null,
    errorMessage,
  };
}
