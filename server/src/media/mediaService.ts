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

import type { SqliteDatabase } from "../db/connection.js";
import type { DuplicateGroupsRepository } from "../dedup/index.js";
import { BadRequestError, NotFoundError } from "../errors/AppError.js";
import { IMAGE_ENHANCE_JOB_TYPE, type JobRepository } from "../jobs/index.js";
import type { Logger } from "../logger.js";
import { QUALITY_SELECTOR_JOB_TYPE, encodeQualitySelectorPayload } from "../quality/index.js";
import {
  autoSelectCoverForTrip,
  entityIdSchema,
  type TripRepository,
  type TripService,
} from "../trips/index.js";
import { parseOrThrow } from "../util/zodParse.js";

import { MediaRepository } from "./mediaRepository.js";
import { listMediaOptionsSchema, selectVersionBodySchema } from "./mediaSchemas.js";
import { MediaVersionsRepository } from "./mediaVersionsRepository.js";
import type {
  MediaActiveVersionType,
  MediaDetail,
  MediaItem,
  MediaVersion,
  MediaVersionView,
  MediaVersionsView,
  SelectVersionResult,
} from "./mediaTypes.js";

/**
 * Cross-domain dependencies needed by {@link MediaService.softDeleteMedia}.
 * Grouped into one optional object so existing test harnesses can
 * still build a minimal `MediaService` without wiring P7 — the
 * soft-delete entry point throws when the bundle is missing.
 */
export interface MediaSoftDeleteDeps {
  /** Shared SQLite handle — needed for the cross-table transaction. */
  readonly db: SqliteDatabase;
  /** Cleared cover_media_id + cover_set_by_user when a media goes away. */
  readonly tripRepo: TripRepository;
  /**
   * Cleared duplicate_groups.recommended_media_id when the
   * soft-deleted media was a group's auto-recommendation. Items
   * themselves stay put (design.md §4.3 allows "保留记录"; the UI
   * already renders soft-deleted members as missing).
   */
  readonly duplicateGroupsRepo: DuplicateGroupsRepository;
  /** Logged auto-cover refresh outcomes; warnings on swallowed errors. */
  readonly logger: Logger;
}

/**
 * Outcome of a {@link MediaService.softDeleteMedia} call. Carries
 * enough information for diagnostics and for the route layer to
 * shape the HTTP response (e.g. the list of trips whose cover was
 * cleared).
 */
export interface SoftDeleteMediaResult {
  readonly mediaId: string;
  /** `true` when the row was active at call time. */
  readonly deleted: boolean;
  /**
   * `true` when the row was already soft-deleted before the call —
   * the response is idempotent-success rather than 404, since the
   * end state ("this media is gone") was already there.
   */
  readonly alreadyDeleted: boolean;
  /** Duplicate groups whose `recommended_media_id` was cleared. */
  readonly clearedRecommendedGroups: readonly string[];
  /** Trips whose `cover_media_id` was cleared (typically 0 or 1). */
  readonly clearedCoverTrips: readonly string[];
}

/**
 * Outcome of a {@link MediaService.restoreMedia} call. Mirrors the
 * soft-delete shape: a `restored: true` flag, an `alreadyRestored`
 * idempotency marker, and a `qualitySelectorEnqueued` boolean so
 * the route response can hint at the asynchronous re-rank /
 * cover-refresh that follows.
 */
export interface RestoreMediaResult {
  readonly mediaId: string;
  readonly tripId: string;
  /** `true` when the row is active after the call. */
  readonly restored: boolean;
  /**
   * `true` when the row was already active before the call (no
   * write happened). Distinguishes idempotent-success from
   * actual-write.
   */
  readonly alreadyRestored: boolean;
  /**
   * `true` when the post-restore `quality_selector_run` job was
   * successfully enqueued. `false` when enqueue failed (we log
   * + swallow so the HTTP response still reports the restore
   * success) or when the row was already active and no re-rank
   * was needed.
   */
  readonly qualitySelectorEnqueued: boolean;
}

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
 * Outcome envelope for {@link MediaService.enhanceMedia} (P8.T1).
 *
 * `image_enhance` is a single-slot enqueue (unlike reprocess which
 * covers `image_thumbnail + image_metadata`), so the response is
 * flat — no `results[]` wrapper. Keeps the typical UI call site
 * (`const { outcome } = await enhanceMedia(id)`) trivial.
 *
 * Outcome semantics mirror reprocess one-for-one so the queue
 * state-machine stays consistent:
 *   * `created` — no prior `image_enhance` row for this media;
 *                 one was inserted as pending.
 *   * `reset`   — the most recent prior row was failed / success /
 *                 cancelled / retrying; we routed it through
 *                 `retrying` (P4.T2 R-40 fix) so the executor's next
 *                 tick picks it up. `retry_count` resets to 0.
 *   * `skipped` — the most recent prior row is pending / running;
 *                 leaving it alone avoids double-queuing or racing
 *                 the handler. `reason` carries the explanation.
 */
export interface EnhanceMediaResult {
  readonly mediaId: string;
  readonly jobType: string;
  readonly outcome: ReprocessOutcome;
  /** Job row id (newly created or pre-existing). */
  readonly jobId: string;
  /** When outcome === "skipped", why (e.g. "already pending"). */
  readonly reason?: string;
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
    /**
     * Optional cross-domain bundle for {@link softDeleteMedia} (P7.T1).
     * When omitted, the soft-delete entry point throws — existing
     * smokes that don't exercise soft-delete continue to work
     * unchanged.
     */
    private readonly softDeleteDeps?: MediaSoftDeleteDeps,
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

  /**
   * P8.T1 — enqueue an `image_enhance` job for one media row.
   *
   * Single-slot wrapper around the same enqueue primitive that
   * `reprocess` uses (`reprocessOneJobType`). The handler that
   * consumes these rows lands in P8.T2 (sharp pipeline) and writes
   * `media_versions(version_type='enhanced')` in P8.T3 — this method
   * intentionally does NEITHER of those things; it just manipulates
   * the queue so the user's "Enhance" click stays snappy and the
   * heavy work happens off-request.
   *
   * Failure modes:
   *   * `NotFoundError` — media row missing OR soft-deleted. The
   *     recycle-bin contract from P7 forbids further writes to
   *     soft-deleted rows; the read goes through the default-active
   *     filter so a soft-deleted media surfaces as 404 here.
   *   * `BadRequestError` — `media.type !== 'image'`. Per
   *     requirements §7.9 enhancement is image-only; video enhance /
   *     AI refine (§7.10) live in later phases. `unknown`-typed
   *     media also rejects because the original bytes were discarded
   *     by Upload_Manager (design.md §6.2.3) — there is nothing to
   *     enhance.
   *
   * Idempotency: re-calling on a media whose latest `image_enhance`
   * row is pending / running yields `outcome='skipped'`. Calling
   * after a terminal row (success / failed / cancelled / retrying)
   * yields `outcome='reset'` (re-routes through the canonical
   * `retrying` re-entry state). First call on a fresh media yields
   * `outcome='created'`.
   *
   * Does NOT block on the actual enhance. The image-channel
   * executor (P3.T2) polls pending rows independently.
   */
  enhanceMedia(mediaIdInput: unknown): EnhanceMediaResult {
    if (this.jobRepo === undefined) {
      throw new Error("MediaService: jobRepo not configured; cannot enhance");
    }
    const safeId = parseOrThrow(entityIdSchema, mediaIdInput, "id");
    const media = this.repo.findById(safeId);
    if (media === null) {
      // Active-only read above — `findById` defaults
      // `includeDeleted=false`, so soft-deleted media surface here as
      // a clean 404 (matches the recycle-bin invariant from P7).
      throw new NotFoundError(`Media not found: ${safeId}`, { id: safeId });
    }
    if (media.type !== "image") {
      throw new BadRequestError(
        `enhance is only supported for image media; this row is '${media.type}'`,
        { mediaId: safeId, type: media.type },
      );
    }

    const now = new Date().toISOString();
    const slot = this.reprocessOneJobType(safeId, IMAGE_ENHANCE_JOB_TYPE, now);
    // `slot.reason` is exactOptionalPropertyTypes-friendly — we only
    // spread it back when it exists so the caller doesn't see an
    // explicit `reason: undefined` field.
    return slot.reason !== undefined
      ? {
          mediaId: safeId,
          jobType: slot.jobType,
          outcome: slot.outcome,
          jobId: slot.jobId,
          reason: slot.reason,
        }
      : {
          mediaId: safeId,
          jobType: slot.jobType,
          outcome: slot.outcome,
          jobId: slot.jobId,
        };
  }

  /**
   * P8.T4 — list user-selectable versions for one media + flag the
   * currently-active one.
   *
   * Response shape (`MediaVersionsView`):
   *   * Always includes a synthesized `'original'` entry derived
   *     from `media_items` columns (originalPath, mimeType, width,
   *     height, fileSize, timestamps). `id` is `null` for this
   *     entry because the original is not represented as a
   *     `media_versions` row — it's the implicit base.
   *   * Includes `'enhanced'` / `'ai_refined'` entries when a
   *     matching `media_versions` row exists.
   *   * Excludes operational version_types (`thumbnail`, `preview`,
   *     `metadata`, `video_cover`, `video_proxy`) — those are
   *     artefacts of internal workers, not user-facing versions.
   *
   * Failure modes:
   *   * `NotFoundError` — media row missing OR soft-deleted (default
   *     active-only read; matches the P7 recycle-bin contract — a
   *     soft-deleted media has no user-facing version list).
   *
   * Note: original_path may be `null` for `unknown`-typed media
   * (Upload_Manager discards the bytes per design §6.2.3). In that
   * case we still emit a synthesized entry for completeness (with
   * `filePath: ''`), but the version cannot be selected by the
   * version-switch endpoint — `selectVersion` enforces the
   * non-empty original_path predicate.
   */
  listVersions(idInput: unknown): MediaVersionsView {
    if (this.versionsRepo === undefined) {
      throw new Error("MediaService: versionsRepo not configured; cannot list versions");
    }
    const media = this.getMediaById(idInput);
    const allVersions = this.versionsRepo.listByMediaId(media.id);
    return buildVersionsView(media, allVersions);
  }

  /**
   * P8.T4 — flip the user-selected active version.
   *
   * Body shape `{ versionType: 'original' | 'enhanced' | 'ai_refined' }`.
   *
   * Failure modes:
   *   * `NotFoundError` — media row missing OR soft-deleted (matches
   *     `listVersions` and the P7 contract).
   *   * `BadRequestError` — body fails zod (`selectVersionBodySchema`)
   *     OR the requested version doesn't exist for this media:
   *       - `'original'`: media has no `original_path` (e.g.
   *         `type='unknown'` rows where Upload_Manager discarded the
   *         bytes — there is no original to select).
   *       - `'enhanced'` / `'ai_refined'`: no `media_versions` row
   *         with that `(media_id, version_type)` exists yet (the
   *         worker hasn't run or failed).
   *
   * Idempotency: selecting the already-active version is a no-op
   * at the DB level — we short-circuit before the UPDATE and return
   * `alreadyActive: true` so the response still looks like success.
   * `updated_at` stays at its previous value, which keeps audit
   * trails clean when the user re-clicks the same button.
   */
  selectVersion(idInput: unknown, bodyInput: unknown): SelectVersionResult {
    if (this.versionsRepo === undefined) {
      throw new Error("MediaService: versionsRepo not configured; cannot select version");
    }
    const media = this.getMediaById(idInput);
    const body = parseOrThrow(selectVersionBodySchema, bodyInput, "select-version body");
    const target: MediaActiveVersionType = body.versionType;

    // Validate the target version actually exists for this media.
    if (target === "original") {
      if (media.originalPath === null || media.originalPath.length === 0) {
        throw new BadRequestError(
          "cannot select 'original' on a media with no original_path (e.g. type='unknown')",
          { mediaId: media.id, mediaType: media.type },
        );
      }
    } else {
      // 'enhanced' / 'ai_refined' — verify a media_versions row exists.
      const versions = this.versionsRepo.listByMediaId(media.id);
      const row = versions.find((v) => v.versionType === target);
      if (row === undefined) {
        throw new BadRequestError(
          `cannot select '${target}': no media_versions row of that type for this media`,
          { mediaId: media.id, requestedVersionType: target },
        );
      }
    }

    const previous = media.activeVersionType;
    if (previous === target) {
      // No-op — short-circuit to keep updated_at stable.
      return {
        mediaId: media.id,
        activeVersionType: target,
        previousVersionType: previous,
        alreadyActive: true,
      };
    }

    const now = new Date().toISOString();
    const changed = this.repo.setActiveVersionType(media.id, target, now);
    if (changed === 0) {
      // Race: media was soft-deleted between the read and the write.
      // Both possible outcomes look identical from the user's POV
      // (a 404 follows on the next read), so report it as NotFound.
      throw new NotFoundError(`Media not found: ${media.id}`, { id: media.id });
    }
    return {
      mediaId: media.id,
      activeVersionType: target,
      previousVersionType: previous,
      alreadyActive: false,
    };
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
    //
    // P4.T2 R-40 fix: route through `retrying`, the §4.3-canonical
    // re-entry point, instead of the old direct → `pending` flip.
    // The JobQueue SELECT (P4.T2) accepts both `pending` and
    // `retrying` rows, so the executor still picks it up next tick;
    // the state-machine no longer skips the documented step.
    // retry_count is reset to 0 — reprocess is "start over", not
    // "continue the existing retry budget".
    const changes = jobRepo.resetToRetrying(latest.id, now);
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

  /**
   * P7.T1 — soft-delete one media row + clean up the references that
   * would otherwise dangle:
   *
   *   1. Inside a single `db.transaction`:
   *      a. `media_items.deleted_at = now()`, `status = 'deleted'`
   *      b. `duplicate_groups.recommended_media_id = NULL` for any
   *         group recommending this media (the FK's SET NULL is for
   *         hard delete only; soft delete needs the explicit reset).
   *      c. `trips.cover_media_id = NULL`, `cover_set_by_user = 0`
   *         for any trip pinning this media as cover.
   *   2. After the transaction commits, best-effort
   *      `autoSelectCoverForTrip(tripId)` for each cleared cover —
   *      lets the system immediately replace a cover the user just
   *      removed, instead of leaving the trip with a placeholder
   *      until the next finalize → selector pass.
   *
   * Idempotent: a re-DELETE on an already-soft-deleted media returns
   * `{ deleted: true, alreadyDeleted: true }` with no further DB
   * writes. A DELETE on a missing media throws NotFoundError.
   *
   * Side effects deliberately NOT in scope (per task):
   *   * No file removal — originals / thumbnails / previews stay on
   *     disk (design.md §4.3 + CLAUDE.md §2.4).
   *   * No `duplicate_group_items.user_decision` flip — the row
   *     stays put; the UI projects `media: null` for soft-deleted
   *     members, preserving the user's original decision for
   *     P7.T2 restore.
   *   * No automatic Quality_Selector re-run on the affected
   *     duplicate groups — groups simply lose their recommendation
   *     until the next regular Quality_Selector cycle (which may
   *     run as part of P6.T7's finalize-triggered chain).
   */
  softDeleteMedia(idInput: unknown): SoftDeleteMediaResult {
    const mediaId = parseOrThrow(entityIdSchema, idInput, "id");
    if (this.softDeleteDeps === undefined) {
      throw new BadRequestError(
        "MediaService.softDeleteMedia called without softDeleteDeps; service not fully wired",
      );
    }
    const deps = this.softDeleteDeps;

    // Existence + idempotency check — read with `includeDeleted` so
    // we can tell "missing" (404) apart from "already soft-deleted"
    // (200 no-op).
    const existing = this.repo.findById(mediaId, { includeDeleted: true });
    if (existing === null) {
      throw new NotFoundError(`Media not found: ${mediaId}`, { id: mediaId });
    }
    if (existing.deletedAt !== null) {
      return {
        mediaId,
        deleted: true,
        alreadyDeleted: true,
        clearedRecommendedGroups: [],
        clearedCoverTrips: [],
      };
    }

    const now = new Date().toISOString();
    let clearedRecommendedGroups: readonly string[] = [];
    let clearedCoverTrips: readonly string[] = [];

    const tx = deps.db.transaction((): void => {
      // 1. Flip the media row to soft-deleted.
      const changed = this.repo.softDelete(mediaId, now);
      if (changed === 0) {
        // Race: another writer soft-deleted between our existence
        // check and the UPDATE. Tx rollback ensures atomicity but
        // is harmless either way (end state = soft-deleted).
        return;
      }
      // 2. Release any duplicate-group recommendation that pinned
      //    this media.
      clearedRecommendedGroups = deps.duplicateGroupsRepo.clearRecommendedMediaForMedia(
        mediaId,
        now,
      );
      // 3. Clear cover references + release user pins.
      clearedCoverTrips = deps.tripRepo.clearCoverForMedia(mediaId, now);
    });
    tx();

    // Best-effort auto-cover refresh post-commit. The cover selector
    // itself is idempotent and never throws on operational paths
    // (missing trip / no candidate); DB errors during the UPDATE
    // bubble up and we log + swallow so the HTTP response still
    // reports the successful soft-delete.
    for (const tripId of clearedCoverTrips) {
      try {
        const outcome = autoSelectCoverForTrip(
          { tripRepo: deps.tripRepo, mediaRepo: this.repo, logger: deps.logger },
          tripId,
        );
        deps.logger.info(
          { mediaId, tripId, coverOutcome: outcome.status },
          "soft_delete_media: auto cover refreshed for trip",
        );
      } catch (err) {
        deps.logger.warn(
          {
            mediaId,
            tripId,
            err: err instanceof Error ? err.message : String(err),
          },
          "soft_delete_media: auto cover refresh failed (soft-delete itself still succeeded)",
        );
      }
    }

    deps.logger.info(
      {
        mediaId,
        tripId: existing.tripId,
        clearedRecommendedGroups,
        clearedCoverTrips,
      },
      "soft_delete_media: media soft-deleted + references cleaned up",
    );

    return {
      mediaId,
      deleted: true,
      alreadyDeleted: false,
      clearedRecommendedGroups,
      clearedCoverTrips,
    };
  }

  /**
   * P7.T2 — restore one soft-deleted media row. The reverse of
   * `softDeleteMedia`, with deliberately asymmetric responsibilities:
   *
   *   * The active part of restore is intentionally tiny — just
   *     clear `deleted_at` and reset `status` to 'processed'. That
   *     is what design.md §4.3 lists as the "restore" path and what
   *     re-exposes the row to every default reader (gallery, dedup
   *     engine, auto-cover candidate query).
   *   * The downstream re-rank + cover refresh is delegated to a
   *     freshly-enqueued `quality_selector_run` job (trip-scope
   *     payload). The handler — which has been in the queue since
   *     P6.T5 — calls `Quality_Selector.selectForTrip` (skipping
   *     `user_confirmed=1` groups per CLAUDE.md §3.9) and then the
   *     post-success `autoSelectCoverForTrip`. The two together
   *     give the restored media its full "re-participate in dedup
   *     + maybe become the cover again" treatment without us
   *     re-implementing any of it here.
   *
   * Idempotent: a restore on an already-active media returns
   * `{ restored: true, alreadyRestored: true }` with no DB writes
   * and no selector enqueue. A restore on a missing media throws
   * NotFoundError.
   *
   * Files on disk are NOT touched (the soft-delete left them alone
   * to begin with).
   */
  restoreMedia(idInput: unknown): RestoreMediaResult {
    const mediaId = parseOrThrow(entityIdSchema, idInput, "id");
    if (this.softDeleteDeps === undefined) {
      throw new BadRequestError(
        "MediaService.restoreMedia called without softDeleteDeps; service not fully wired",
      );
    }
    const deps = this.softDeleteDeps;

    const existing = this.repo.findById(mediaId, { includeDeleted: true });
    if (existing === null) {
      throw new NotFoundError(`Media not found: ${mediaId}`, { id: mediaId });
    }
    if (existing.deletedAt === null) {
      // Already active — idempotent success.
      return {
        mediaId,
        tripId: existing.tripId,
        restored: true,
        alreadyRestored: true,
        qualitySelectorEnqueued: false,
      };
    }

    const now = new Date().toISOString();

    const tx = deps.db.transaction((): void => {
      const changed = this.repo.restore(mediaId, now);
      if (changed === 0) {
        // Race: another writer restored between our existence check
        // and the UPDATE. Tx is harmless either way; end state =
        // active.
        return;
      }
    });
    tx();

    // Enqueue a trip-scope quality_selector_run job. The handler
    // (registered on the image channel by `server/src/index.ts`)
    // will re-rank every group in the trip — skipping user-confirmed
    // groups — and then refresh the cover, picking up the newly-
    // restored media as a candidate.
    //
    // Job-insert failures are non-fatal: the restore itself succeeded;
    // the user just won't get an immediate re-rank. The next finalize-
    // triggered selector chain will catch up naturally.
    let qualitySelectorEnqueued = false;
    if (this.jobRepo !== undefined) {
      try {
        this.jobRepo.insert({
          id: randomUUID(),
          mediaId,
          jobType: QUALITY_SELECTOR_JOB_TYPE,
          payload: encodeQualitySelectorPayload({ scope: "trip", tripId: existing.tripId }),
          createdAt: now,
          updatedAt: now,
        });
        qualitySelectorEnqueued = true;
        deps.logger.info(
          { mediaId, tripId: existing.tripId },
          "restore_media: quality_selector_run enqueued (trip-scope)",
        );
      } catch (err) {
        deps.logger.warn(
          {
            mediaId,
            tripId: existing.tripId,
            err: err instanceof Error ? err.message : String(err),
          },
          "restore_media: failed to enqueue quality_selector_run (restore itself still succeeded)",
        );
      }
    } else {
      deps.logger.warn(
        { mediaId, tripId: existing.tripId },
        "restore_media: jobRepo not wired; skipping quality_selector_run enqueue",
      );
    }

    deps.logger.info(
      { mediaId, tripId: existing.tripId, qualitySelectorEnqueued },
      "restore_media: media restored + quality selector queued",
    );

    return {
      mediaId,
      tripId: existing.tripId,
      restored: true,
      alreadyRestored: false,
      qualitySelectorEnqueued,
    };
  }
}

/**
 * Closed set of `version_type` values that the user-facing versions
 * endpoint surfaces. Operational types ('thumbnail', 'preview',
 * 'metadata', 'video_cover', 'video_proxy') are deliberately
 * excluded — they are artefacts of internal workers, not user
 * choices. Mirrors the CHECK enum on
 * `media_items.active_version_type` from migration 010.
 */
const USER_SELECTABLE_VERSION_TYPES: ReadonlySet<MediaActiveVersionType> = new Set([
  "original",
  "enhanced",
  "ai_refined",
]);

/**
 * Build the `MediaVersionsView` response from a media row + the
 * raw `media_versions` rows for that media.
 *
 * Steps:
 *   1. Filter the `media_versions` rows down to user-selectable
 *      types (drops thumbnail / preview / metadata / video_* ).
 *   2. Synthesize a virtual 'original' entry from `media_items`
 *      columns. There is no `media_versions` row for 'original'
 *      because the original file is the implicit base; we still
 *      render an entry so the frontend can switch back to it.
 *   3. Mark each entry's `isActive` flag against
 *      `media.activeVersionType`.
 *
 * Ordering: 'original' first, then the rest in their natural
 * `media_versions.created_at` order (the repo's `listByMediaId`
 * already orders by version_type ASC). Stable order makes the UI
 * easy to reason about.
 */
function buildVersionsView(
  media: MediaItem,
  allVersions: readonly MediaVersion[],
): MediaVersionsView {
  const selectable = allVersions.filter((v) =>
    USER_SELECTABLE_VERSION_TYPES.has(v.versionType as MediaActiveVersionType),
  );

  const out: MediaVersionView[] = [];

  // 1. Synthesized 'original' entry. We treat the original even
  //    when originalPath is null (unknown-typed rows) — the entry
  //    still exists in the list so the UI can show "no original
  //    available" rather than hiding the row entirely. selectVersion
  //    will reject 'original' for such rows on the write side.
  out.push({
    id: null,
    versionType: "original",
    isActive: media.activeVersionType === "original",
    filePath: media.originalPath ?? "",
    mimeType: media.mimeType,
    width: media.width,
    height: media.height,
    fileSize: media.fileSize,
    createdAt: media.createdAt,
    updatedAt: media.updatedAt,
  });

  // 2. Real media_versions rows, mapped into the view shape. The
  //    cast on versionType is safe because the filter above only
  //    keeps types from USER_SELECTABLE_VERSION_TYPES.
  for (const v of selectable) {
    out.push({
      id: v.id,
      versionType: v.versionType as MediaActiveVersionType,
      isActive: media.activeVersionType === v.versionType,
      filePath: v.filePath,
      mimeType: v.mimeType,
      width: v.width,
      height: v.height,
      fileSize: v.fileSize,
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
    });
  }

  return {
    mediaId: media.id,
    activeVersionType: media.activeVersionType,
    versions: out,
  };
}
