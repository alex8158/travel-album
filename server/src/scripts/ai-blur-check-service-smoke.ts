// Manual smoke test for aiBlurCheckService (P12.T5 baseline).
//
// Usage: npm run smoke:ai-blur-check-service
//
// Coverage (matches the P12.T5 prompt's test requirements):
//   * empty trip → no error, zero results
//   * single image happy path → media_analysis.ai_blur_class /
//     ai_blur_reason written; ai_invocations row written with the
//     P12 column set (trip_id / target_type='media' / target_id /
//     input_hash) and status='success'
//   * missing source (no thumbnail / preview / original on disk)
//     → graceful skip (skipped_no_source); no media_analysis write,
//     no ai_invocations write
//   * AI off (NoopProvider) → skipped_ai_unavailable; no writes
//   * AI provider that supports nothing → skipped_ai_unsupported
//   * source-version preference: thumbnail > preview > original
//   * cost-cache: 2nd run on the same media with same bytes → cache_hit;
//     no new ai_invocations row; no fresh AI invocation
//   * cache invalidation on different bytes: changing the source
//     thumbnail bytes → fresh invoke + new audit row
//   * idempotency on media_analysis: 3rd run still leaves exactly one
//     media_analysis row with the same verdict
//   * provider returns malformed JSON → failed_invalid_response;
//     ai_invocations row written with status='failed' + error_message
//   * provider invoke throws → failed_provider_error; ai_invocations
//     row written with status='failed'
//   * trip-level batch: 3 media → aggregate counts + per-media results
//   * trip-level isolation: 1 media with missing source + 1 happy →
//     both processed independently
//   * non-image / soft-deleted / failed-status are filtered out
//   * public constants
//
// The smoke uses the LocalMockProvider (P12.T1) for AI calls — no
// network, no secrets, deterministic by input bytes.

import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AiInvocationsRepository, LocalMockProvider, NoopProvider } from "../ai/index.js";
import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import {
  AI_BLUR_CHECK_JOB_TYPE,
  AI_BLUR_CHECK_REQUEST_TYPE,
  AI_BLUR_CHECK_SOURCE_PREFERENCE,
  AI_BLUR_CHECK_TARGET_TYPE,
  runAiBlurCheckForMedia,
  runAiBlurCheckForTrip,
  type AiBlurCheckDeps,
} from "../jobs/index.js";
import { createLogger } from "../logger.js";
import {
  MediaAnalysisRepository,
  MediaRepository,
  MediaVersionsRepository,
} from "../media/index.js";
import { LocalStorageProvider } from "../storage/index.js";

interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}
const results: CheckResult[] = [];

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`[smoke][${ok ? "PASS" : "FAIL"}] ${name}: ${detail}`);
}
function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

// ---------------------------------------------------------------------------
// Seeding helpers
// ---------------------------------------------------------------------------

function seedTrip(db: SqliteDatabase, title: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO trips (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
    id,
    title,
    now,
    now,
  );
  return id;
}

interface SeedMediaOptions {
  readonly type?: string;
  readonly status?: string;
  readonly softDeleted?: boolean;
  /** When set, writes original bytes to disk under this relpath. */
  readonly originalBytes?: Buffer;
  /** When set, writes a media_versions(version_type) row + bytes on disk. */
  readonly versionBytes?: Record<string, Buffer>;
}

async function seedMedia(
  db: SqliteDatabase,
  storage: LocalStorageProvider,
  tripId: string,
  opts: SeedMediaOptions = {},
): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const status = opts.status ?? "processed";
  const type = opts.type ?? "image";
  const deletedAt = opts.softDeleted ? now : null;
  const originalRel = opts.originalBytes !== undefined ? `trips/${tripId}/originals/${id}.jpg` : null;

  db.prepare(
    `INSERT INTO media_items
       (id, trip_id, type, original_path, mime_type, extension, file_size,
        status, user_decision, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, 'image/jpeg', 'jpg', 4096,
             ?, 'undecided', ?, ?, ?)`,
  ).run(id, tripId, type, originalRel, status, now, now, deletedAt);

  if (opts.originalBytes !== undefined && originalRel !== null) {
    await storage.putOriginal({
      tripId,
      mediaId: id,
      data: opts.originalBytes,
      extension: "jpg",
    });
  }

  if (opts.versionBytes !== undefined) {
    for (const [versionType, bytes] of Object.entries(opts.versionBytes)) {
      const relPath = `trips/${tripId}/derived/${id}/${versionType}.jpg`;
      await storage.putDerived({
        tripId,
        mediaId: id,
        relPath: `${versionType}.jpg`,
        data: bytes,
        overwrite: true,
      });
      db.prepare(
        `INSERT INTO media_versions
           (id, media_id, version_type, file_path, mime_type, file_size, status)
         VALUES (?, ?, ?, ?, 'image/jpeg', ?, 'ready')`,
      ).run(randomUUID(), id, versionType, relPath, bytes.length);
    }
  }
  return id;
}

// Smoke-only loose typing — the smoke constructs ad-hoc providers
// whose `invoke` signature doesn't match `(req: AIRequest) => ...`
// exactly. The runtime contract is what matters here.
type SmokeProviderLike = {
  readonly name: string;
  readonly available: boolean;
  readonly supports: ReadonlySet<unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly invoke: (req: any) => Promise<any>;
};

function makeDeps(
  db: SqliteDatabase,
  storage: LocalStorageProvider,
  provider: SmokeProviderLike,
): AiBlurCheckDeps {
  return {
    storage,
    mediaRepo: new MediaRepository(db),
    mediaVersionsRepo: new MediaVersionsRepository(db),
    mediaAnalysisRepo: new MediaAnalysisRepository(db),
    aiInvocationsRepo: new AiInvocationsRepository(db),
    aiProvider: provider as unknown as AiBlurCheckDeps["aiProvider"],
    logger: createLogger({ nodeEnv: "test", level: "fatal" }),
  };
}

function countAiInvocations(db: SqliteDatabase, mediaId: string): number {
  return (db
    .prepare(`SELECT COUNT(*) n FROM ai_invocations WHERE media_id = ?`)
    .get(mediaId) as { n: number }).n;
}

function countAiInvocationsByStatus(db: SqliteDatabase, mediaId: string, status: string): number {
  return (db
    .prepare(`SELECT COUNT(*) n FROM ai_invocations WHERE media_id = ? AND status = ?`)
    .get(mediaId, status) as { n: number }).n;
}

function getAiBlurFromAnalysis(
  db: SqliteDatabase,
  mediaId: string,
): { aiBlurClass: string | null; aiBlurReason: string | null } | null {
  const row = db
    .prepare(`SELECT ai_blur_class, ai_blur_reason FROM media_analysis WHERE media_id = ?`)
    .get(mediaId) as { ai_blur_class: string | null; ai_blur_reason: string | null } | undefined;
  if (row === undefined) return null;
  return { aiBlurClass: row.ai_blur_class, aiBlurReason: row.ai_blur_reason };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-ai-blur-check-"));
  const dbPath = path.join(tmpRoot, "smoke.db");
  const storageRoot = path.join(tmpRoot, "storage");
  console.log(`[smoke] tmpRoot=${tmpRoot}`);

  const dbHandle = openDatabase(dbPath);
  try {
    runMigrations(dbHandle.db);
    const db = dbHandle.db;
    const storage = LocalStorageProvider.create(storageRoot);
    const mockProvider = new LocalMockProvider();

    // -----------------------------------------------------------------------
    // CASE 1: empty trip → trip-level returns zero results
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "Empty Trip");
      const deps = makeDeps(db, storage, mockProvider);
      const res = await runAiBlurCheckForTrip(tripId, deps);
      record(
        "empty trip: totalCandidates=0, zero counts, no error",
        res.totalCandidates === 0 &&
          res.successCount === 0 &&
          res.cacheHitCount === 0 &&
          res.skippedCount === 0 &&
          res.failedCount === 0,
        `total=${res.totalCandidates} s=${res.successCount} c=${res.cacheHitCount} sk=${res.skippedCount} f=${res.failedCount}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 2: single image happy path with thumbnail version
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "Happy");
      const bytes = Buffer.from("fake-thumbnail-bytes-case-2");
      const expectedHash = createHash("sha256").update(bytes).digest("hex");
      const mediaId = await seedMedia(db, storage, tripId, {
        originalBytes: Buffer.from("fake-original-bytes-case-2"),
        versionBytes: { thumbnail: bytes },
      });
      const deps = makeDeps(db, storage, mockProvider);
      const res = await runAiBlurCheckForMedia(mediaId, deps);
      record(
        "happy: outcome=success",
        res.outcome === "success",
        `outcome=${res.outcome} err=${String(res.errorMessage)}`,
      );
      record(
        "happy: aiBlurClass ∈ {sharp,maybe_blurry,blurry}",
        res.aiBlurClass === "sharp" || res.aiBlurClass === "maybe_blurry" || res.aiBlurClass === "blurry",
        `aiBlurClass=${String(res.aiBlurClass)}`,
      );
      record(
        "happy: sourceVersionType='thumbnail' (smallest in preference order)",
        res.sourceVersionType === "thumbnail",
        `sourceVersionType=${String(res.sourceVersionType)}`,
      );
      record(
        "happy: inputHash = SHA256(thumbnail bytes)",
        res.inputHash === expectedHash,
        `inputHash=${String(res.inputHash)?.slice(0, 16)}... expected=${expectedHash.slice(0, 16)}...`,
      );
      const stored = getAiBlurFromAnalysis(db, mediaId);
      record(
        "happy: media_analysis.ai_blur_class persisted",
        stored !== null && stored.aiBlurClass === res.aiBlurClass,
        `stored=${String(stored?.aiBlurClass)} got=${String(res.aiBlurClass)}`,
      );
      record(
        "happy: media_analysis.ai_blur_reason persisted (non-empty)",
        stored?.aiBlurReason !== null && (stored?.aiBlurReason ?? "").length > 0,
        `reason=${String(stored?.aiBlurReason)?.slice(0, 60)}`,
      );

      // ai_invocations row written with full P12 column set.
      const aiRow = db
        .prepare(
          `SELECT id, media_id, trip_id, target_type, target_id, input_hash, status, provider, model_name, response_summary
           FROM ai_invocations WHERE media_id = ?`,
        )
        .get(mediaId) as {
          id: string;
          media_id: string;
          trip_id: string | null;
          target_type: string;
          target_id: string | null;
          input_hash: string | null;
          status: string;
          provider: string;
          model_name: string;
          response_summary: string | null;
        };
      record(
        "happy: ai_invocations row has correct P12 columns",
        aiRow !== undefined &&
          aiRow.trip_id === tripId &&
          aiRow.target_type === "media" &&
          aiRow.target_id === mediaId &&
          aiRow.input_hash === expectedHash &&
          aiRow.status === "success",
        `trip_id==tripId=${aiRow.trip_id === tripId} target_type=${aiRow.target_type} target_id==mediaId=${aiRow.target_id === mediaId} input_hash==expected=${aiRow.input_hash === expectedHash} status=${aiRow.status}`,
      );
      record(
        "happy: ai_invocations.id matches result.auditId",
        aiRow.id === res.auditId,
        `auditId=${String(res.auditId)?.slice(0, 8)} dbId=${aiRow.id.slice(0, 8)}`,
      );
      record(
        "happy: ai_invocations.provider='local-mock'",
        aiRow.provider === "local-mock",
        `provider=${aiRow.provider}`,
      );
      record(
        "happy: ai_invocations.response_summary parses as JSON with 'class' field",
        (() => {
          try {
            const j = JSON.parse(aiRow.response_summary ?? "null") as Record<string, unknown>;
            return j.class === res.aiBlurClass;
          } catch {
            return false;
          }
        })(),
        `summary=${aiRow.response_summary?.slice(0, 60)}...`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 3: missing source → graceful skip
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "NoSource");
      // No originalBytes, no versionBytes — the media row exists but
      // no readable file on disk.
      const mediaId = await seedMedia(db, storage, tripId);
      const deps = makeDeps(db, storage, mockProvider);
      const res = await runAiBlurCheckForMedia(mediaId, deps);
      record(
        "no-source: outcome=skipped_no_source",
        res.outcome === "skipped_no_source",
        `outcome=${res.outcome}`,
      );
      record(
        "no-source: no media_analysis row written",
        getAiBlurFromAnalysis(db, mediaId) === null,
        `analysis=${JSON.stringify(getAiBlurFromAnalysis(db, mediaId))}`,
      );
      record(
        "no-source: no ai_invocations row written",
        countAiInvocations(db, mediaId) === 0,
        `n=${countAiInvocations(db, mediaId)}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 4: AI provider unavailable (NoopProvider)
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "NoAI");
      const bytes = Buffer.from("bytes-case-4");
      const mediaId = await seedMedia(db, storage, tripId, {
        originalBytes: bytes,
        versionBytes: { thumbnail: bytes },
      });
      const noop = new NoopProvider();
      const deps = makeDeps(db, storage, noop);
      const res = await runAiBlurCheckForMedia(mediaId, deps);
      record(
        "ai-off: outcome=skipped_ai_unavailable",
        res.outcome === "skipped_ai_unavailable",
        `outcome=${res.outcome}`,
      );
      record(
        "ai-off: no media_analysis row written",
        getAiBlurFromAnalysis(db, mediaId) === null,
        `analysis=${JSON.stringify(getAiBlurFromAnalysis(db, mediaId))}`,
      );
      record(
        "ai-off: no ai_invocations row written",
        countAiInvocations(db, mediaId) === 0,
        `n=${countAiInvocations(db, mediaId)}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 5: provider exists but doesn't support ai_blur_check
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "Unsupported");
      const bytes = Buffer.from("bytes-case-5");
      const mediaId = await seedMedia(db, storage, tripId, {
        originalBytes: bytes,
        versionBytes: { thumbnail: bytes },
      });
      const limitedProvider = {
        name: "limited",
        available: true,
        supports: new Set(["image_ai_refine"] as const),
        invoke: async () => {
          throw new Error("should not be invoked");
        },
      };
      const deps = makeDeps(db, storage, limitedProvider);
      const res = await runAiBlurCheckForMedia(mediaId, deps);
      record(
        "unsupported: outcome=skipped_ai_unsupported",
        res.outcome === "skipped_ai_unsupported",
        `outcome=${res.outcome}`,
      );
      record(
        "unsupported: no media_analysis row + no ai_invocations row",
        getAiBlurFromAnalysis(db, mediaId) === null && countAiInvocations(db, mediaId) === 0,
        `analysis=${JSON.stringify(getAiBlurFromAnalysis(db, mediaId))} ai=${countAiInvocations(db, mediaId)}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 6: source-version preference — thumbnail wins over preview/original
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "PreferThumbnail");
      const tBytes = Buffer.from("THUMB-prefer");
      const pBytes = Buffer.from("PREVIEW-prefer");
      const oBytes = Buffer.from("ORIGINAL-prefer");
      const mediaId = await seedMedia(db, storage, tripId, {
        originalBytes: oBytes,
        versionBytes: { thumbnail: tBytes, preview: pBytes },
      });
      const expectedThumbHash = createHash("sha256").update(tBytes).digest("hex");
      const deps = makeDeps(db, storage, mockProvider);
      const res = await runAiBlurCheckForMedia(mediaId, deps);
      record(
        "prefer-thumb: sourceVersionType=thumbnail & inputHash=SHA256(thumb)",
        res.sourceVersionType === "thumbnail" && res.inputHash === expectedThumbHash,
        `sv=${String(res.sourceVersionType)} hash_match=${res.inputHash === expectedThumbHash}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 7: source-version fallback — only preview present → preview wins
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "FallbackPreview");
      const pBytes = Buffer.from("PREVIEW-fallback");
      const oBytes = Buffer.from("ORIGINAL-fallback");
      const mediaId = await seedMedia(db, storage, tripId, {
        originalBytes: oBytes,
        versionBytes: { preview: pBytes },
      });
      const expectedPreviewHash = createHash("sha256").update(pBytes).digest("hex");
      const deps = makeDeps(db, storage, mockProvider);
      const res = await runAiBlurCheckForMedia(mediaId, deps);
      record(
        "fallback-preview: chose preview (no thumbnail present)",
        res.sourceVersionType === "preview" && res.inputHash === expectedPreviewHash,
        `sv=${String(res.sourceVersionType)} hash_match=${res.inputHash === expectedPreviewHash}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 8: original-only fallback
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "FallbackOriginal");
      const oBytes = Buffer.from("ORIGINAL-only");
      const mediaId = await seedMedia(db, storage, tripId, { originalBytes: oBytes });
      const expectedOrigHash = createHash("sha256").update(oBytes).digest("hex");
      const deps = makeDeps(db, storage, mockProvider);
      const res = await runAiBlurCheckForMedia(mediaId, deps);
      record(
        "fallback-original: chose original (no version rows)",
        res.sourceVersionType === "original" && res.inputHash === expectedOrigHash,
        `sv=${String(res.sourceVersionType)} hash_match=${res.inputHash === expectedOrigHash}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 9: cost cache — 2nd run on same media + same bytes = cache_hit
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "Cache");
      const bytes = Buffer.from("CACHE-stable-bytes");
      const mediaId = await seedMedia(db, storage, tripId, {
        originalBytes: bytes,
        versionBytes: { thumbnail: bytes },
      });
      const deps = makeDeps(db, storage, mockProvider);

      const first = await runAiBlurCheckForMedia(mediaId, deps);
      record("cache: 1st call = success", first.outcome === "success", `outcome=${first.outcome}`);
      const firstAuditId = first.auditId;
      const firstClass = first.aiBlurClass;
      const firstReason = first.aiBlurReason;

      const second = await runAiBlurCheckForMedia(mediaId, deps);
      record(
        "cache: 2nd call = cache_hit (with the same auditId)",
        second.outcome === "cache_hit" && second.auditId === firstAuditId,
        `outcome=${second.outcome} same_audit=${second.auditId === firstAuditId}`,
      );
      record(
        "cache: 2nd call returns the same class + reason",
        second.aiBlurClass === firstClass && second.aiBlurReason === firstReason,
        `class:${second.aiBlurClass}==${firstClass} reason_match=${second.aiBlurReason === firstReason}`,
      );
      record(
        "cache: total ai_invocations rows for this media = 1 (no new audit row)",
        countAiInvocations(db, mediaId) === 1,
        `n=${countAiInvocations(db, mediaId)}`,
      );

      // Different bytes → cache miss → new invoke → new audit row.
      const altBytes = Buffer.from("CACHE-different-bytes");
      await storage.putDerived({
        tripId,
        mediaId,
        relPath: "thumbnail.jpg",
        data: altBytes,
        overwrite: true,
      });
      const third = await runAiBlurCheckForMedia(mediaId, deps);
      record(
        "cache: different bytes → success (not cache_hit)",
        third.outcome === "success" && third.auditId !== firstAuditId,
        `outcome=${third.outcome} new_audit=${third.auditId !== firstAuditId}`,
      );
      record(
        "cache: ai_invocations row count = 2 (1 cached + 1 fresh)",
        countAiInvocations(db, mediaId) === 2,
        `n=${countAiInvocations(db, mediaId)}`,
      );

      // 4th call on the new bytes → cache_hit on the 3rd row.
      const fourth = await runAiBlurCheckForMedia(mediaId, deps);
      record(
        "cache: 4th call (same as 3rd) = cache_hit on third's audit",
        fourth.outcome === "cache_hit" && fourth.auditId === third.auditId,
        `outcome=${fourth.outcome} match=${fourth.auditId === third.auditId}`,
      );
      record(
        "cache: media_analysis still has exactly one row for this media",
        (db.prepare(`SELECT COUNT(*) n FROM media_analysis WHERE media_id = ?`).get(mediaId) as { n: number }).n === 1,
        `count=${(db.prepare(`SELECT COUNT(*) n FROM media_analysis WHERE media_id = ?`).get(mediaId) as { n: number }).n}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 10: provider returns malformed JSON → failed_invalid_response
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "Malformed");
      const bytes = Buffer.from("MALFORMED-bytes");
      const mediaId = await seedMedia(db, storage, tripId, {
        originalBytes: bytes,
        versionBytes: { thumbnail: bytes },
      });
      const malformedProvider = {
        name: "malformed-mock",
        available: true,
        supports: new Set(["ai_blur_check"] as const),
        invoke: async () => ({
          status: "success" as const,
          provider: "malformed-mock",
          modelName: "malformed-v1",
          costEstimate: 0,
          durationMs: 1,
          outputBytes: Buffer.from("not json at all {{{"),
        }),
      };
      const deps = makeDeps(db, storage, malformedProvider);
      const res = await runAiBlurCheckForMedia(mediaId, deps);
      record(
        "malformed: outcome=failed_invalid_response",
        res.outcome === "failed_invalid_response",
        `outcome=${res.outcome}`,
      );
      record(
        "malformed: no media_analysis row written",
        getAiBlurFromAnalysis(db, mediaId) === null,
        `analysis=${JSON.stringify(getAiBlurFromAnalysis(db, mediaId))}`,
      );
      record(
        "malformed: ai_invocations row written with status=failed",
        countAiInvocationsByStatus(db, mediaId, "failed") === 1,
        `failed_count=${countAiInvocationsByStatus(db, mediaId, "failed")}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 11: provider invoke throws → failed_provider_error
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "Throw");
      const bytes = Buffer.from("THROW-bytes");
      const mediaId = await seedMedia(db, storage, tripId, {
        originalBytes: bytes,
        versionBytes: { thumbnail: bytes },
      });
      const throwingProvider = {
        name: "throwing-mock",
        available: true,
        supports: new Set(["ai_blur_check"] as const),
        invoke: async () => {
          throw new Error("simulated network failure");
        },
      };
      const deps = makeDeps(db, storage, throwingProvider);
      const res = await runAiBlurCheckForMedia(mediaId, deps);
      record(
        "throw: outcome=failed_provider_error + errorMessage propagated",
        res.outcome === "failed_provider_error" &&
          res.errorMessage !== null &&
          res.errorMessage.includes("simulated network failure"),
        `outcome=${res.outcome} err=${String(res.errorMessage)}`,
      );
      record(
        "throw: ai_invocations row with status=failed",
        countAiInvocationsByStatus(db, mediaId, "failed") === 1,
        `failed=${countAiInvocationsByStatus(db, mediaId, "failed")}`,
      );
      record(
        "throw: no media_analysis row",
        getAiBlurFromAnalysis(db, mediaId) === null,
        `analysis=${JSON.stringify(getAiBlurFromAnalysis(db, mediaId))}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 12: provider returns AIFailureResponse → failed_provider_error
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "ProviderFail");
      const bytes = Buffer.from("PROVIDER-FAIL-bytes");
      const mediaId = await seedMedia(db, storage, tripId, {
        originalBytes: bytes,
        versionBytes: { thumbnail: bytes },
      });
      const failingProvider = {
        name: "failing-mock",
        available: true,
        supports: new Set(["ai_blur_check"] as const),
        invoke: async () => ({
          status: "failed" as const,
          provider: "failing-mock",
          modelName: "failing-v1",
          costEstimate: 0,
          durationMs: 5,
          errorMessage: "simulated rate limit",
        }),
      };
      const deps = makeDeps(db, storage, failingProvider);
      const res = await runAiBlurCheckForMedia(mediaId, deps);
      record(
        "provider-failed: outcome=failed_provider_error + message includes provider text",
        res.outcome === "failed_provider_error" &&
          (res.errorMessage ?? "").includes("simulated rate limit"),
        `outcome=${res.outcome} err=${String(res.errorMessage)}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 13: trip-level batch with mixed outcomes
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "Batch");
      const bytesA = Buffer.from("BATCH-A");
      const bytesB = Buffer.from("BATCH-B");
      const aId = await seedMedia(db, storage, tripId, {
        originalBytes: bytesA,
        versionBytes: { thumbnail: bytesA },
      });
      const bId = await seedMedia(db, storage, tripId, {
        originalBytes: bytesB,
        versionBytes: { thumbnail: bytesB },
      });
      // Missing-source: media row exists but no file.
      const cId = await seedMedia(db, storage, tripId);
      // Non-image (filtered out at the trip-loop level — should not
      // count toward results).
      await seedMedia(db, storage, tripId, { type: "video" });
      // Soft-deleted (filtered out by repo).
      await seedMedia(db, storage, tripId, {
        originalBytes: Buffer.from("ignored"),
        softDeleted: true,
      });
      // Failed status (filtered at trip-loop level).
      await seedMedia(db, storage, tripId, {
        originalBytes: Buffer.from("ignored"),
        status: "failed",
      });

      const deps = makeDeps(db, storage, mockProvider);
      const res = await runAiBlurCheckForTrip(tripId, deps);
      record(
        "batch: totalCandidates=3 (only eligible images)",
        res.totalCandidates === 3,
        `total=${res.totalCandidates}`,
      );
      record(
        "batch: 2 success + 1 skipped_no_source",
        res.successCount === 2 && res.skippedCount === 1 && res.failedCount === 0,
        `s=${res.successCount} sk=${res.skippedCount} f=${res.failedCount}`,
      );
      const aRes = res.results.find((r) => r.mediaId === aId);
      const bRes = res.results.find((r) => r.mediaId === bId);
      const cRes = res.results.find((r) => r.mediaId === cId);
      record(
        "batch: per-media result A=success, B=success, C=skipped_no_source",
        aRes?.outcome === "success" &&
          bRes?.outcome === "success" &&
          cRes?.outcome === "skipped_no_source",
        `A=${aRes?.outcome} B=${bRes?.outcome} C=${cRes?.outcome}`,
      );

      // 2nd batch run on the same trip → both A and B become cache_hit.
      const res2 = await runAiBlurCheckForTrip(tripId, deps);
      record(
        "batch: 2nd run = 2 cache_hit + 1 skipped (idempotent)",
        res2.successCount === 0 &&
          res2.cacheHitCount === 2 &&
          res2.skippedCount === 1,
        `s=${res2.successCount} c=${res2.cacheHitCount} sk=${res2.skippedCount}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 14: trip-level isolation — one throwing media + one happy
    //          media → batch processes both; one fails, one succeeds.
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "Isolation");
      const okBytes = Buffer.from("ISOLATION-OK");
      const okId = await seedMedia(db, storage, tripId, {
        originalBytes: okBytes,
        versionBytes: { thumbnail: okBytes },
      });
      const badBytes = Buffer.from("ISOLATION-BAD");
      const badId = await seedMedia(db, storage, tripId, {
        originalBytes: badBytes,
        versionBytes: { thumbnail: badBytes },
      });

      // Provider throws only for the BAD media id.
      const conditionalProvider = {
        name: "conditional-mock",
        available: true,
        supports: new Set(["ai_blur_check"] as const),
        invoke: async (req: { mediaId?: string; inputBytes?: Buffer }) => {
          if (req.mediaId === badId) {
            throw new Error("isolation: simulated bad-media failure");
          }
          // Forward to LocalMock; satisfy exactOptionalPropertyTypes
          // by conditionally spreading inputBytes only when defined.
          return mockProvider.invoke({
            requestType: "ai_blur_check",
            ...(req.inputBytes !== undefined ? { inputBytes: req.inputBytes } : {}),
          });
        },
      };
      const deps = makeDeps(db, storage, conditionalProvider);
      const res = await runAiBlurCheckForTrip(tripId, deps);
      record(
        "isolation: 1 success + 1 failed (batch did NOT abort)",
        res.successCount === 1 && res.failedCount === 1 && res.totalCandidates === 2,
        `s=${res.successCount} f=${res.failedCount} total=${res.totalCandidates}`,
      );
      const okRes = res.results.find((r) => r.mediaId === okId);
      const badRes = res.results.find((r) => r.mediaId === badId);
      record(
        "isolation: ok media wrote media_analysis; bad media did not",
        okRes?.outcome === "success" &&
          badRes?.outcome === "failed_provider_error" &&
          getAiBlurFromAnalysis(db, okId) !== null &&
          getAiBlurFromAnalysis(db, badId) === null,
        `ok=${okRes?.outcome} bad=${badRes?.outcome} okAnalysis=${getAiBlurFromAnalysis(db, okId) !== null} badAnalysis=${getAiBlurFromAnalysis(db, badId) === null}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 15: invariant — empty mediaId rejected synchronously
    // -----------------------------------------------------------------------
    {
      const deps = makeDeps(db, storage, mockProvider);
      let threw: unknown;
      try {
        await runAiBlurCheckForMedia("", deps);
      } catch (err) {
        threw = err;
      }
      record(
        "invariant: empty mediaId throws synchronously",
        threw !== undefined && describeError(threw).includes("mediaId must be non-empty"),
        `err=${describeError(threw)}`,
      );

      let threwTrip: unknown;
      try {
        await runAiBlurCheckForTrip("", deps);
      } catch (err) {
        threwTrip = err;
      }
      record(
        "invariant: empty tripId throws synchronously",
        threwTrip !== undefined && describeError(threwTrip).includes("tripId must be non-empty"),
        `err=${describeError(threwTrip)}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 16: public constants
    // -----------------------------------------------------------------------
    {
      record(
        "constant: AI_BLUR_CHECK_JOB_TYPE='ai_blur_check'",
        AI_BLUR_CHECK_JOB_TYPE === "ai_blur_check",
        `value=${AI_BLUR_CHECK_JOB_TYPE}`,
      );
      record(
        "constant: AI_BLUR_CHECK_REQUEST_TYPE='ai_blur_check'",
        AI_BLUR_CHECK_REQUEST_TYPE === "ai_blur_check",
        `value=${AI_BLUR_CHECK_REQUEST_TYPE}`,
      );
      record(
        "constant: AI_BLUR_CHECK_TARGET_TYPE='media'",
        AI_BLUR_CHECK_TARGET_TYPE === "media",
        `value=${AI_BLUR_CHECK_TARGET_TYPE}`,
      );
      record(
        "constant: AI_BLUR_CHECK_SOURCE_PREFERENCE starts with 'thumbnail'",
        AI_BLUR_CHECK_SOURCE_PREFERENCE[0] === "thumbnail",
        `first=${AI_BLUR_CHECK_SOURCE_PREFERENCE[0]}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 17: determinism — LocalMock returns same class for same bytes
    //          across two FRESH media (different mediaIds, same bytes).
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "Determinism");
      const bytes = Buffer.from("DETERMINISTIC-BYTES");
      const aId = await seedMedia(db, storage, tripId, {
        originalBytes: bytes,
        versionBytes: { thumbnail: bytes },
      });
      const bId = await seedMedia(db, storage, tripId, {
        originalBytes: bytes,
        versionBytes: { thumbnail: bytes },
      });
      const deps = makeDeps(db, storage, mockProvider);
      const resA = await runAiBlurCheckForMedia(aId, deps);
      const resB = await runAiBlurCheckForMedia(bId, deps);
      record(
        "determinism: same input bytes → same blur class across different media",
        resA.outcome === "success" &&
          resB.outcome === "success" &&
          resA.aiBlurClass === resB.aiBlurClass &&
          resA.inputHash === resB.inputHash,
        `A=${resA.aiBlurClass} B=${resB.aiBlurClass} hashMatch=${resA.inputHash === resB.inputHash}`,
      );
      // Different target_id so cost-cache does NOT collapse them
      // (cache key includes target_id = mediaId).
      record(
        "determinism: still two distinct audit rows (target_id differs)",
        countAiInvocations(db, aId) === 1 && countAiInvocations(db, bId) === 1,
        `A=${countAiInvocations(db, aId)} B=${countAiInvocations(db, bId)}`,
      );
    }
  } finally {
    closeDatabase(dbHandle);
    await rm(tmpRoot, { recursive: true, force: true });
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n[smoke] summary: ${passed}/${results.length} passed`);
  if (failed > 0) {
    console.log(`[smoke] failures: ${results.filter((r) => !r.ok).map((r) => r.name).join(", ")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[smoke] uncaught error: ${describeError(err)}`);
  process.exit(1);
});
