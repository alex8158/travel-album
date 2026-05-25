// image_ai_refine worker (P10.T5).
//
// Job handler for the image-channel `image_ai_refine` row that P10.T3
// enqueues. The handler's job is the worker half of the AI refine
// pipeline: claim the audit row that P10.T4 wrote at enqueue time,
// invoke `AIProvider.invoke`, persist the refined bytes as a fresh
// `media_versions(version_type='ai_refined')` row, and close the
// audit trail.
//
// Pipeline (one media row):
//
//   1. Find the pending `ai_invocations` row keyed to this job id
//      (P10.T4 wrote it at enqueue time / on reset). Missing →
//      hard fail; P10.T5 prompt: "只消费 status='pending' 的 audit
//      row" + "找不到 pending audit row 应安全失败". The handler
//      does NOT fabricate a fresh audit row on retry — that's a
//      deliberate scope choice; future polish may introduce
//      "retries auto-write a fresh audit row" semantics.
//   2. Resolve the media row. Active-only (P7 contract); refuse
//      non-image + missing-original-path with a clear audit
//      message. From this point onward any thrown error must
//      first flip the audit row to `failed` (so the audit trail
//      is consistent with the job's terminal state).
//   3. Stream the original bytes through `LocalStorageProvider`.
//   4. Re-check `aiProvider.available`. Belt-and-suspenders: the
//      P10.T3 route gate already blocked enqueue when AI was off,
//      but a job that was enqueued when AI was available could
//      still be claimed AFTER a config rollback to disabled (e.g.
//      operator unset AI_ENABLED mid-flight). Refusing here keeps
//      the audit row's failure cleanly attributable to "AI
//      disabled at handler time".
//   5. Call `aiProvider.invoke({ requestType: 'image_ai_refine',
//      mediaId, jobId, inputBytes })`. Three response shapes:
//        a. AISuccessResponse — proceed to step 6.
//        b. AIFailureResponse — mark audit `failed` with the
//           provider's error_message + duration; throw so the
//           JobQueue marks the processing_jobs row terminal
//           per its retry policy.
//        c. Thrown AIProviderNotConfiguredError /
//           AIProviderUnsupportedRequestError / generic Error —
//           mark audit `failed` with the error message + the
//           wall-clock duration we measured locally; rethrow.
//   6. Validate `outputBytes` is non-empty + parseable as an
//      image via `sharp.metadata()`. Empty / unparseable →
//      mark audit `failed` (the worker promised an image; the
//      provider broke the contract) + throw.
//   7. `storage.putDerived({ relPath: 'ai_refined.jpg',
//      overwrite: true })` — overwrite on retry / reset; the
//      derived file is keyed by media id so a fresh attempt
//      cleanly replaces the prior file.
//   8. `mediaVersionsRepo.upsert({ versionType: 'ai_refined', ...
//      provider/model/cost params })`. UPSERT on
//      `(media_id, version_type='ai_refined')` per migration 005
//      so a retry / re-run swaps the row in place — no duplicate
//      "ai_refined #2" row clutters the version list.
//   9. `aiInvocationsRepo.markSuccess({ ... })`. The audit row
//      transitions `pending → success` atomically (the
//      `WHERE status='pending'` predicate is the claim — only
//      the first writer wins) and fills `model_name`,
//      `cost_estimate`, `duration_ms`, `response_summary`.
//  10. Handler returns cleanly. JobQueue marks the processing_jobs
//      row `success` per its standard contract.
//
// Audit row state machine (V1 — migration 012 CHECK enum):
//
//   pending → success     (markSuccess on happy path)
//   pending → failed      (markFailed on any error path)
//
// There is intentionally no `running` intermediate state in V1;
// the migration 012 enum allows only {pending,success,failed},
// and the atomic-claim guarantees the same race protection an
// explicit `running` state would (only the first markSuccess /
// markFailed writer wins; subsequent attempts see changes=0).
//
// Cross-task red lines (CLAUDE.md §2.1 / §2.4 / §3.9):
//   * Never touches `media_items.original_path` or its bytes.
//   * Never touches `media_items.user_decision` /
//     `active_version_type` — the user controls those; ai_refine
//     just lands the file + version row, and the user has to
//     explicitly switch via P8.T4 select-version + P10.T6
//     frontend.
//   * Never deletes any existing media_versions row — the UPSERT
//     replaces only the `ai_refined` slot.
//
// What this worker does NOT do (out of scope for P10.T5):
//   * Real network call to OpenAI / Gemini / Bedrock / a local
//     model — V1 only ships NoopProvider (always unavailable);
//     real providers land in a later PR and slot into the same
//     `AIProvider.invoke()` shape verbatim.
//   * Quota enforcement at execution time — that's already done
//     at enqueue time by P10.T4; by the time the worker runs the
//     row was charged.
//   * Per-attempt audit row creation on retry — see note 1
//     above; future polish.

import type { Readable } from "node:stream";

import sharp from "sharp";

import type { AIProvider } from "../ai/index.js";
import {
  AIProviderNotConfiguredError,
  AIProviderUnsupportedRequestError,
  IMAGE_AI_REFINE_JOB_TYPE as AI_REFINE_JOB_TYPE_SOURCE,
  type AiInvocationsRepository,
} from "../ai/index.js";
import type { Logger } from "../logger.js";
import type { MediaRepository, MediaVersionsRepository } from "../media/index.js";
import type { LocalStorageProvider } from "../storage/index.js";

import type { JobHandler } from "./handlerRegistry.js";

/** Closed job_type token. Re-exported verbatim from the ai module's
 * single source of truth (`server/src/ai/index.ts`, added in P10.T3)
 * so the registry key, the AIRequestType union, and the migration
 * 012 CHECK enum stay byte-identical at build time. R-121 is
 * narrowed to a single TS import line by this re-export. */
export const IMAGE_AI_REFINE_JOB_TYPE = AI_REFINE_JOB_TYPE_SOURCE;

/** Logical relpath under `derived/{mediaId}/`. Pinned so the route /
 * P10.T6 UI can reference the canonical location. */
const AI_REFINED_FILENAME = "ai_refined.jpg";

/** Output MIME we record on `media_versions.mime_type`. Always JPEG
 * for V1 (design.md §6.2 enumerates the slot as `ai_refined_*.jpg`).
 * If a future provider returns webp/png/etc, the row can be widened
 * — for V1 we narrow to JPEG to match the enhance path. */
const AI_REFINED_MIME = "image/jpeg";

/**
 * Settings exposed to make the handler's behaviour configurable
 * without dragging the full `Config` object across the import line.
 * The defaults are baked into the handler itself so smokes can
 * construct it without a config layer.
 */
export interface ImageAiRefineSettings {
  /** Stamped into `media_versions.params` for traceability. */
  readonly workerVersion: string;
}

export const DEFAULT_IMAGE_AI_REFINE_SETTINGS: ImageAiRefineSettings = {
  workerVersion: "1.0",
};

export interface ImageAiRefineHandlerDeps {
  readonly storage: LocalStorageProvider;
  readonly mediaRepo: MediaRepository;
  readonly mediaVersionsRepo: MediaVersionsRepository;
  readonly aiInvocationsRepo: AiInvocationsRepository;
  readonly aiProvider: AIProvider;
  readonly settings?: ImageAiRefineSettings;
  readonly logger: Logger;
  /** Override clock for tests / smokes. Defaults to `new Date()`. */
  readonly now?: () => Date;
}

/**
 * Build the `image_ai_refine` handler. Register the returned value
 * on the image-channel `JobHandlerRegistry` at boot.
 */
export function makeImageAiRefineHandler(deps: ImageAiRefineHandlerDeps): JobHandler {
  const settings = deps.settings ?? DEFAULT_IMAGE_AI_REFINE_SETTINGS;
  const clock = deps.now ?? (() => new Date());

  return async (job) => {
    const correlation = { jobId: job.id, mediaId: job.mediaId };

    // ---- 1. Find the pending audit row keyed to this job id -----------
    const audit = deps.aiInvocationsRepo.findPendingByJobId(job.id);
    if (audit === null) {
      // No pending audit row for this job. Per the P10.T5 contract
      // ("只消费 status='pending' 的 audit row"), the worker does NOT
      // fabricate a fresh row — it fails the job so an operator can
      // investigate (or the user can re-trigger via /ai-refine, which
      // P10.T4 writes a fresh pending audit row for). The
      // processing_jobs row terminates with a clear message.
      throw new Error(
        `image_ai_refine: no pending ai_invocations row for job_id=${job.id}; refuse to fabricate one`,
      );
    }

    // Note: the audit row stays in `pending` through the entire
    // handler — there is no intermediate `running` state in V1
    // (migration 012's CHECK enum only allows
    // pending/success/failed). The atomic-claim WHERE-predicate
    // on markSuccess / markFailed provides the equivalent race
    // protection: only the first terminal-state writer wins.
    const claimStartedAt = clock();

    // From here on, every thrown error MUST first mark the audit
    // row failed (so the audit trail and the job's terminal state
    // agree). `markAuditFailed` is the single funnel for that.
    const markAuditFailed = (errorMessage: string, durationMs: number | null): void => {
      try {
        deps.aiInvocationsRepo.markFailed({
          id: audit.id,
          errorMessage,
          durationMs,
          now: clock().toISOString(),
        });
      } catch (markErr) {
        // If the audit UPDATE itself fails (DB write error), log
        // loudly but rethrow the ORIGINAL provider error — the
        // operator needs the actual failure cause more than the
        // bookkeeping error.
        deps.logger.error(
          {
            ...correlation,
            auditId: audit.id,
            originalError: errorMessage,
            markFailedError: markErr instanceof Error ? markErr.message : String(markErr),
          },
          "image_ai_refine: markFailed itself threw; audit row may be inconsistent",
        );
      }
    };

    // ---- 3. Resolve the media row ------------------------------------
    const media = deps.mediaRepo.findById(job.mediaId);
    if (media === null) {
      const msg = `media not found or soft-deleted: ${job.mediaId}`;
      markAuditFailed(msg, Date.now() - claimStartedAt.getTime());
      throw new Error(msg);
    }
    if (media.type !== "image") {
      const msg = `media is not an image (type='${media.type}'); refusing to ai-refine`;
      markAuditFailed(msg, Date.now() - claimStartedAt.getTime());
      throw new Error(msg);
    }
    if (media.originalPath === null) {
      const msg = "media has no original_path; cannot read source bytes";
      markAuditFailed(msg, Date.now() - claimStartedAt.getTime());
      throw new Error(msg);
    }

    // ---- 4. Read original bytes --------------------------------------
    let sourceBuf: Buffer;
    try {
      const sourceStream = await deps.storage.read(media.originalPath);
      sourceBuf = await streamToBuffer(sourceStream);
    } catch (readErr) {
      const msg = `failed to read original bytes: ${readErr instanceof Error ? readErr.message : String(readErr)}`;
      markAuditFailed(msg, Date.now() - claimStartedAt.getTime());
      throw new Error(msg);
    }
    if (sourceBuf.length === 0) {
      const msg = "original file is empty";
      markAuditFailed(msg, Date.now() - claimStartedAt.getTime());
      throw new Error(msg);
    }

    // ---- 5. Re-check provider availability ---------------------------
    if (!deps.aiProvider.available) {
      const msg = `AI provider '${deps.aiProvider.name}' is not available at handler time (config rollback?); refusing to invoke`;
      markAuditFailed(msg, null);
      throw new Error(msg);
    }

    // ---- 6. Invoke the provider --------------------------------------
    const invokeStartedAt = Date.now();
    let response;
    try {
      response = await deps.aiProvider.invoke({
        requestType: "image_ai_refine",
        mediaId: media.id,
        jobId: job.id,
        inputBytes: sourceBuf,
      });
    } catch (invokeErr) {
      const durationMs = Date.now() - invokeStartedAt;
      let msg: string;
      if (invokeErr instanceof AIProviderNotConfiguredError) {
        msg = `AI provider threw AI_NOT_CONFIGURED at invoke: ${invokeErr.message}`;
      } else if (invokeErr instanceof AIProviderUnsupportedRequestError) {
        msg = `AI provider does not support 'image_ai_refine': ${invokeErr.message}`;
      } else {
        msg =
          invokeErr instanceof Error
            ? `AI provider invoke threw: ${invokeErr.name}: ${invokeErr.message}`
            : `AI provider invoke threw: ${String(invokeErr)}`;
      }
      markAuditFailed(msg, durationMs);
      throw new Error(msg);
    }

    if (response.status === "failed") {
      // Provider returned a structured failure (rate limit, content
      // policy, …). Audit row records the wall-clock + provider's
      // own message; the throw lets the JobQueue mark the job
      // terminal.
      markAuditFailed(
        `AI provider returned failure: ${response.errorMessage}`,
        response.durationMs,
      );
      throw new Error(`AI provider returned failure: ${response.errorMessage}`);
    }

    // ---- 7. Validate outputBytes -------------------------------------
    const outputBytes = response.outputBytes;
    if (outputBytes === undefined || outputBytes.length === 0) {
      const msg = "AI provider returned no outputBytes for image_ai_refine";
      markAuditFailed(msg, response.durationMs);
      throw new Error(msg);
    }
    let outputMeta;
    try {
      outputMeta = await sharp(outputBytes).metadata();
    } catch (metaErr) {
      const msg = `AI provider outputBytes are not a parseable image: ${metaErr instanceof Error ? metaErr.message : String(metaErr)}`;
      markAuditFailed(msg, response.durationMs);
      throw new Error(msg);
    }
    if (outputMeta.width === undefined || outputMeta.height === undefined) {
      const msg = "AI provider outputBytes parsed but have no width/height — unexpected";
      markAuditFailed(msg, response.durationMs);
      throw new Error(msg);
    }

    // ---- 8. Persist derived file -------------------------------------
    let stored;
    try {
      stored = await deps.storage.putDerived({
        tripId: media.tripId,
        mediaId: media.id,
        relPath: AI_REFINED_FILENAME,
        data: outputBytes,
        overwrite: true,
      });
    } catch (writeErr) {
      const msg = `failed to persist ai_refined.jpg: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`;
      markAuditFailed(msg, response.durationMs);
      throw new Error(msg);
    }

    // ---- 9. UPSERT media_versions row --------------------------------
    const nowIso = clock().toISOString();
    const paramsJson = JSON.stringify({
      workerVersion: settings.workerVersion,
      provider: response.provider,
      model: response.modelName,
      costEstimate: response.costEstimate,
      durationMs: response.durationMs,
      responseSummary: response.responseSummary ?? null,
      raw: response.raw ?? null,
    });
    try {
      deps.mediaVersionsRepo.upsert({
        mediaId: media.id,
        versionType: "ai_refined",
        filePath: stored.logicalPath,
        mimeType: AI_REFINED_MIME,
        width: outputMeta.width,
        height: outputMeta.height,
        fileSize: outputBytes.length,
        modelName: response.modelName,
        params: paramsJson,
        now: nowIso,
      });
    } catch (upsertErr) {
      const msg = `failed to upsert media_versions(version_type='ai_refined'): ${upsertErr instanceof Error ? upsertErr.message : String(upsertErr)}`;
      markAuditFailed(msg, response.durationMs);
      throw new Error(msg);
    }

    // ---- 10. Mark audit row 'success' --------------------------------
    const successChanges = deps.aiInvocationsRepo.markSuccess({
      id: audit.id,
      modelName: response.modelName,
      costEstimate: response.costEstimate,
      durationMs: response.durationMs,
      responseSummary: response.responseSummary ?? null,
      now: nowIso,
    });
    if (successChanges === 0) {
      // Audit row was no longer in `pending` when we tried the
      // atomic flip — either an operator intervened or a parallel
      // worker (channel concurrency > 1) raced us. Log loudly
      // but DON'T fail the job: the artefact + media_versions row
      // are already written, so the user-facing outcome is
      // "success"; only the audit trail is inconsistent.
      deps.logger.warn(
        { ...correlation, auditId: audit.id },
        "image_ai_refine: markSuccess changed 0 rows; audit row is not 'pending' anymore",
      );
    }

    deps.logger.info(
      {
        ...correlation,
        auditId: audit.id,
        aiRefinedPath: stored.logicalPath,
        width: outputMeta.width,
        height: outputMeta.height,
        bytes: outputBytes.length,
        provider: response.provider,
        model: response.modelName,
        costEstimate: response.costEstimate,
        durationMs: response.durationMs,
        workerVersion: settings.workerVersion,
      },
      "image_ai_refine: ai_refined.jpg written + media_versions upserted + audit 'success'",
    );
  };
}

/**
 * Drain a node Readable into a single Buffer. Same helper as the
 * sister image workers; kept local to avoid a cross-module dep for
 * four lines of utility.
 */
async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}
