// MediaService — business surface for the media read API (P2.T5).
//
// Mirrors TripService's shape:
//   * Every public method takes `unknown` so route handlers (and
//     future CLI / smoke callers) cannot bypass the zod pass.
//   * Successful returns are always the public `MediaItem` shape.
//   * Misses raise AppError subclasses (NotFoundError) so the global
//     error middleware renders the unified envelope without per-route
//     try/catch.
//
// `listMediaForTrip` deliberately verifies the trip exists / is not
// soft-deleted before touching media_items. The alternative (silent
// empty array) would hide bad trip ids; with the trip check we get a
// 404 that mirrors `GET /api/trips/:id` and matches how Upload_Manager
// guards uploads (P2.T4). Note that this depends on `TripService` for
// the existence check — the dependency direction is media → trips,
// never the other way.

import { randomUUID } from "node:crypto";

import { BadRequestError, NotFoundError } from "../errors/AppError.js";
import type { JobRepository } from "../jobs/index.js";
import { entityIdSchema, type TripService } from "../trips/index.js";
import { parseOrThrow } from "../util/zodParse.js";

import { MediaRepository } from "./mediaRepository.js";
import { listMediaOptionsSchema } from "./mediaSchemas.js";
import { MediaVersionsRepository } from "./mediaVersionsRepository.js";
import type { MediaDetail, MediaItem } from "./mediaTypes.js";

/** Outcome of one job-type slot during reprocess (P3.T7). */
export type ReprocessOutcome = "created" | "reset" | "skipped";

export interface ReprocessJobResult {
  readonly jobType: string;
  readonly outcome: ReprocessOutcome;
  /** Job row id (newly created or pre-existing). */
  readonly jobId: string;
  /** When outcome === "skipped", why (e.g. "already pending"). */
  readonly reason?: string;
}

export interface ReprocessResult {
  readonly mediaId: string;
  readonly results: readonly ReprocessJobResult[];
}

/**
 * Job types reprocess covers for an image media. Closed list — adding
 * more (e.g. P5 image_hash, P6 image_quality) is a per-task scope
 * decision, not an implementation accident.
 */
const REPROCESS_IMAGE_JOB_TYPES: readonly string[] = ["image_thumbnail", "image_metadata"];

export class MediaService {
  constructor(
    private readonly repo: MediaRepository,
    private readonly tripService: TripService,
    /**
     * Optional so older call sites (smokes, unit tests that don't
     * exercise the detail bundle) can construct a service without
     * the versions repo. `getMediaDetailById` throws if it's missing.
     */
    private readonly versionsRepo?: MediaVersionsRepository,
    /**
     * Optional so the same staged-init pattern applies. `reprocess`
     * throws if it's missing.
     */
    private readonly jobRepo?: JobRepository,
  ) {}

  /**
   * Fetch a single media row by id. Active rows only — soft-deleted
   * rows surface as NotFoundError (HTTP 404) just like soft-deleted
   * trips.
   */
  getMediaById(id: unknown): MediaItem {
    const safeId = parseOrThrow(entityIdSchema, id, "id");
    const media = this.repo.findById(safeId);
    if (!media) {
      throw new NotFoundError(`Media not found: ${safeId}`, { id: safeId });
    }
    return media;
  }

  /**
   * Bundle the media row with every `media_versions` row attached
   * to it. Backing `GET /api/media/:id` for the detail page (P3.T6).
   * Versions are empty `[]` when none exist yet (e.g. media just
   * uploaded, workers not yet run).
   *
   * Throws NotFoundError when the media row itself is missing or
   * soft-deleted (same semantics as `getMediaById`).
   */
  getMediaDetailById(id: unknown): MediaDetail {
    if (this.versionsRepo === undefined) {
      // Programmer error — the route can't be wired without this.
      throw new Error("MediaService: versionsRepo not configured; cannot serve detail bundle");
    }
    const media = this.getMediaById(id);
    const versions = this.versionsRepo.listByMediaId(media.id);
    return { media, versions };
  }

  /**
   * P3.T7: re-queue the image-channel jobs that own this media row.
   *
   * For each of `image_thumbnail` / `image_metadata`, the per-slot
   * decision is:
   *   * No existing job → INSERT a fresh pending row → "created"
   *   * Existing pending / running → leave it alone → "skipped"
   *   * Existing failed / success / retrying / cancelled → reset
   *     to pending → "reset"
   *
   * `running` is skipped because the executor is mid-handler — a
   * reset would race with markSuccess / markFailed. `pending` is
   * skipped because the executor will pick it up on its next tick.
   *
   * Does NOT block on actual reprocessing. The executor (P3.T2)
   * polls the pending queue independently and runs the real workers
   * (P3.T4 thumbnail, P3.T5 metadata).
   *
   * Throws:
   *   * NotFoundError when the media row is missing / soft-deleted.
   *   * BadRequestError when media.type !== 'image' (video and
   *     unknown reprocess flows belong to later phases).
   */
  reprocess(mediaIdInput: unknown): ReprocessResult {
    if (this.jobRepo === undefined) {
      throw new Error("MediaService: jobRepo not configured; cannot reprocess");
    }
    const safeId = parseOrThrow(entityIdSchema, mediaIdInput, "id");
    const media = this.repo.findById(safeId);
    if (media === null) {
      throw new NotFoundError(`Media not found: ${safeId}`, { id: safeId });
    }
    if (media.type !== "image") {
      throw new BadRequestError(
        `reprocess is only supported for image media; this row is '${media.type}'`,
        { mediaId: safeId, type: media.type },
      );
    }

    const now = new Date().toISOString();
    const results = REPROCESS_IMAGE_JOB_TYPES.map((jobType) =>
      this.reprocessOneJobType(safeId, jobType, now),
    );
    return { mediaId: safeId, results };
  }

  // -------------------------------------------------------------------------
  // private
  // -------------------------------------------------------------------------

  private reprocessOneJobType(mediaId: string, jobType: string, now: string): ReprocessJobResult {
    const jobRepo = this.jobRepo;
    if (jobRepo === undefined) {
      // Defensive — public `reprocess` already guards this branch.
      throw new Error("MediaService: jobRepo not configured");
    }

    const latest = jobRepo.findLatestByMediaIdAndType(mediaId, jobType);

    if (latest === null) {
      // No prior job for this media+type at all — seed a fresh pending.
      const jobId = randomUUID();
      jobRepo.insert({ id: jobId, mediaId, jobType, createdAt: now, updatedAt: now });
      return { jobType, outcome: "created", jobId };
    }

    if (latest.status === "pending" || latest.status === "running") {
      // Active — don't double-queue. The executor's next tick (or
      // current handler) will take this through to a terminal state.
      return {
        jobType,
        outcome: "skipped",
        jobId: latest.id,
        reason: `already ${latest.status}`,
      };
    }

    // Terminal-ish (failed / success / retrying / cancelled) → reset.
    const changes = jobRepo.resetToPending(latest.id, now);
    if (changes === 0) {
      // SQL guard refused — only possible if a parallel writer
      // flipped this row to pending/running between our SELECT and
      // UPDATE. Treat as "already active again".
      return {
        jobType,
        outcome: "skipped",
        jobId: latest.id,
        reason: "row no longer eligible for reset (raced with executor)",
      };
    }
    return { jobType, outcome: "reset", jobId: latest.id };
  }

  /**
   * Page through the media items of a single trip.
   *
   * Throws NotFoundError when the trip itself does not exist or has
   * been soft-deleted, by delegating the check to `TripService`.
   * Returns an empty array when the trip exists but has no media yet.
   */
  listMediaForTrip(tripId: unknown, options: unknown = {}): MediaItem[] {
    const safeTripId = parseOrThrow(entityIdSchema, tripId, "tripId");
    // 404 on missing / soft-deleted trip. Reuses TripService.getTripById
    // so the message and error code match `GET /api/trips/:id`.
    this.tripService.getTripById(safeTripId);
    const opts = parseOrThrow(listMediaOptionsSchema, options, "list options");
    return this.repo.list(safeTripId, opts);
  }
}
