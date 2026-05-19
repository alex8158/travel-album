// Quality_Selector job handler (P6.T5 follow-up).
//
// JobQueue handler that wraps `QualitySelectorService` so the
// recommendation-writeback runs through the same scheduler as the
// per-dimension workers.
//
// Trigger chain:
//   blur / exposure / color workers → media_analysis sub-trees populated
//   ↓
//   image_quality_finalize worker → media_analysis.quality_score
//     ↑ (on success) enqueues:
//   quality_selector_run job → this handler → service.selectForTrip
//     (re-ranks every duplicate group containing the finalized media)
//
// Payload shape (JSON text):
//   * `{ "scope": "trip", "tripId": "<uuid>" }`   → selectForTrip(tripId)
//   * `{ "scope": "group", "groupId": "<uuid>" }` → selectForGroup(groupId)
//
// Defaults / fallbacks:
//   * If payload is NULL / unparseable / unrecognised, the handler
//     resolves `job.mediaId → media.tripId` and runs
//     `selectForTrip` on that trip. This makes the auto-trigger path
//     from finalize robust even if the enqueuer ever forgets to set
//     payload (the job's `media_id` is the source of truth for trip
//     scope).
//
// Failure modes (mirror the other quality workers):
//   * Media row missing / soft-deleted → throw (the trip-scope
//     fallback needs `media.tripId`).
//   * Service errors propagate (e.g. `applyRecommendation` rejecting
//     a non-member winner with the new defense check). JobQueue marks
//     the row `failed` with the thrown message.
//   * `skipped-confirmed` / `skipped-empty` / `missing-group` are
//     NORMAL outcomes — the handler logs them and resolves the job
//     as `success` (the selector did the right thing by not
//     overwriting).

import type { Logger } from "../logger.js";
import type { MediaRepository } from "../media/index.js";

import type { JobHandler } from "../jobs/handlerRegistry.js";
import type { QualitySelectorService, SelectGroupOutcome } from "./qualitySelectorService.js";

/** Closed job_type token. Registered by `server/src/index.ts` boot. */
export const QUALITY_SELECTOR_JOB_TYPE = "quality_selector_run";

export interface QualitySelectorHandlerDeps {
  readonly service: QualitySelectorService;
  readonly mediaRepo: MediaRepository;
  readonly logger: Logger;
}

/**
 * Discriminated payload shape. Exported for callers that build the
 * payload before enqueueing (the finalize worker). When neither
 * branch matches the handler falls back to trip scope using
 * `media.tripId` — see the worker header for the rationale.
 */
export type QualitySelectorPayload =
  | { readonly scope: "trip"; readonly tripId: string }
  | { readonly scope: "group"; readonly groupId: string };

/** Encode a payload for `processing_jobs.payload`. */
export function encodeQualitySelectorPayload(payload: QualitySelectorPayload): string {
  return JSON.stringify(payload);
}

/**
 * Parse a `processing_jobs.payload` value. Returns `null` for NULL,
 * unparseable JSON, or shapes that don't match the discriminator —
 * the handler then falls back to the trip-from-media path.
 */
export function decodeQualitySelectorPayload(raw: string | null): QualitySelectorPayload | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (obj.scope === "trip" && typeof obj.tripId === "string" && obj.tripId.length > 0) {
      return { scope: "trip", tripId: obj.tripId };
    }
    if (obj.scope === "group" && typeof obj.groupId === "string" && obj.groupId.length > 0) {
      return { scope: "group", groupId: obj.groupId };
    }
  } catch {
    /* malformed JSON */
  }
  return null;
}

export function makeQualitySelectorHandler(deps: QualitySelectorHandlerDeps): JobHandler {
  return async (job) => {
    const correlation = { jobId: job.id, mediaId: job.mediaId };
    const parsed = decodeQualitySelectorPayload(job.payload);

    let outcomes: SelectGroupOutcome[];
    let scopeForLog: string;
    if (parsed?.scope === "group") {
      outcomes = [deps.service.selectForGroup(parsed.groupId)];
      scopeForLog = `group:${parsed.groupId}`;
    } else if (parsed?.scope === "trip") {
      outcomes = deps.service.selectForTrip(parsed.tripId);
      scopeForLog = `trip:${parsed.tripId}`;
    } else {
      // Fallback: resolve the trip from the media row attached to
      // this job. Throws on missing / soft-deleted media so the
      // JobQueue marks the row failed (rather than silently writing
      // nothing).
      const media = deps.mediaRepo.findById(job.mediaId);
      if (media === null) {
        throw new Error(
          `quality_selector_run: payload missing and media not found / soft-deleted: ${job.mediaId}`,
        );
      }
      outcomes = deps.service.selectForTrip(media.tripId);
      scopeForLog = `trip-from-media:${media.tripId}`;
    }

    const summary = summariseOutcomes(outcomes);
    deps.logger.info(
      { ...correlation, scope: scopeForLog, ...summary },
      "quality_selector_run: completed",
    );
  };
}

function summariseOutcomes(outcomes: readonly SelectGroupOutcome[]): {
  totalGroups: number;
  applied: number;
  skippedConfirmed: number;
  skippedEmpty: number;
  missingGroup: number;
} {
  let applied = 0;
  let skippedConfirmed = 0;
  let skippedEmpty = 0;
  let missingGroup = 0;
  for (const o of outcomes) {
    switch (o.status) {
      case "applied":
        applied += 1;
        break;
      case "skipped-confirmed":
        skippedConfirmed += 1;
        break;
      case "skipped-empty":
        skippedEmpty += 1;
        break;
      case "missing-group":
        missingGroup += 1;
        break;
      default:
        break;
    }
  }
  return {
    totalGroups: outcomes.length,
    applied,
    skippedConfirmed,
    skippedEmpty,
    missingGroup,
  };
}
