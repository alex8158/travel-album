// DedupEngine (P5.T3 .exact).
//
// Service layer that turns hash-bearing `media_items` rows into
// `duplicate_groups` / `duplicate_group_items` writes. Exposed via a
// "run once for one trip" method so the caller (P5.T5 API,
// future "rebuild dedup" job, or a one-shot maintenance CLI) can
// invoke it on demand without a job_type plumbing.
//
// Scope as of P5.T3:
//   * `runExactForTrip(tripId)` — byte-level exact duplicates:
//     group images whose `media_items.file_hash` is strictly equal,
//     within the same trip. Per docs/design.md §6.3 / §7.3:
//       - `group_type = 'exact'`
//       - confidence = 1.0
//       - similarity_score = 1.0
//
// What this engine deliberately does NOT do:
//   * pHash / dHash similarity grouping (P5.T4 `runSimilarForTrip`).
//   * Quality scoring / recommendation selection (P6 `Quality_Selector`).
//   * Recompute on user-confirmed groups (CLAUDE.md §3.9 — user
//     decisions win and are never overwritten by the engine).
//   * Cross-trip aggregation (each trip is independent per design §7.3).
//   * Soft-deleted / video media (filtered at the MediaRepository read).
//
// Idempotency & user-confirmed protection in ONE rule
// ----------------------------------------------------
// Before creating a group, we build the set of media IDs that
// already appear in ANY existing `'exact'` group for the trip
// (confirmed or not). If a candidate cohort overlaps that set, the
// engine skips it. This handles three cases cleanly with no
// special-casing:
//
//   * Re-running the engine on identical state → the previous run's
//     group still owns those media → skip → no duplicate group.
//   * User-confirmed groups → their members are in the set → skip →
//     `user_confirmed=1` rows are never overwritten or duplicated.
//   * Partial-overlap (e.g. one cohort member already grouped) →
//     skip → engine never creates a competing group; the membership
//     drift is left for a future "rebuild" flow to resolve manually.
//
// Each write goes through `DuplicateGroupsRepository.createGroupWithItems`,
// which is a single SQLite transaction — group + N items land
// atomically or not at all. The outer loop creates one transaction
// per cohort; we deliberately avoid wrapping the whole trip in one
// giant transaction so a freak constraint failure on one cohort
// doesn't undo other successful groups.

import { randomUUID } from "node:crypto";

import type { Logger } from "../logger.js";
import type { MediaRepository } from "../media/index.js";

import type { DuplicateGroupsRepository } from "./duplicateGroupsRepository.js";
import type { DuplicateGroupItemSeedData } from "./duplicateTypes.js";

/** confidence / similarity_score baked in for byte-level exact match. */
const EXACT_CONFIDENCE = 1.0;
const EXACT_SIMILARITY = 1.0;
const EXACT_REASON = "exact byte-level match (file_hash)";

export interface DedupEngineDeps {
  readonly mediaRepo: MediaRepository;
  readonly duplicateGroupsRepo: DuplicateGroupsRepository;
  readonly logger: Logger;
}

/**
 * Counters returned by `runExactForTrip`. Useful for the future API
 * to surface "the engine ran and did N things" without re-querying,
 * and for the smoke to assert deterministically.
 */
export interface RunExactResult {
  readonly tripId: string;
  /** Total active image rows considered (those with file_hash set). */
  readonly mediaScanned: number;
  /** Distinct file_hash values seen across those rows. */
  readonly hashesScanned: number;
  /** Hashes with ≥ 2 members — i.e. cohort candidates before skipping. */
  readonly candidateCohorts: number;
  /** New `'exact'` groups actually written this run. */
  readonly groupsCreated: number;
  /**
   * Cohorts that overlapped with an existing exact group (covers
   * idempotency + user-confirmed protection + partial-overlap) and
   * were skipped. Each entry records the file_hash and the candidate
   * media so the caller can log / surface.
   */
  readonly cohortsSkipped: readonly {
    readonly fileHash: string;
    readonly mediaIds: readonly string[];
    readonly reason: "already-grouped";
  }[];
}

export class DedupEngine {
  constructor(private readonly deps: DedupEngineDeps) {}

  /**
   * Scan one trip's active images and create `'exact'` duplicate
   * groups for every hash cohort of size ≥ 2 whose members are not
   * already in an exact group.
   *
   * Returns counters describing what the run did. Does NOT throw on
   * domain-level conditions (empty trip, all-singletons, all-skipped) —
   * those simply yield a result with `groupsCreated = 0`. Only SQL /
   * IO errors (FK violation, db closed, etc.) bubble up.
   *
   * `now` is exposed so smokes can pin timestamps; production
   * callers omit and let the engine stamp `new Date().toISOString()`.
   */
  runExactForTrip(tripId: string, now: string = new Date().toISOString()): RunExactResult {
    const rows = this.deps.mediaRepo.findActiveImageHashesByTripId(tripId);

    // ---- Group by file_hash --------------------------------------------
    // Preserve creation-order within each cohort (the repo's ORDER BY
    // already gives us this; Map insertion order is preserved in JS).
    const byHash = new Map<string, string[]>();
    for (const r of rows) {
      const existing = byHash.get(r.fileHash);
      if (existing) existing.push(r.id);
      else byHash.set(r.fileHash, [r.id]);
    }

    // ---- Filter to cohorts of size ≥ 2 --------------------------------
    const candidateCohorts: { fileHash: string; mediaIds: string[] }[] = [];
    for (const [fileHash, mediaIds] of byHash) {
      if (mediaIds.length >= 2) {
        candidateCohorts.push({ fileHash, mediaIds });
      }
    }

    // ---- Build "already in some exact group for this trip" set --------
    // listByTripIdWithItems hydrates each group's items; we filter
    // to group_type='exact' (and ignore similar / candidate) and
    // collect all member media ids into a Set for O(1) lookup.
    const alreadyGrouped = new Set<string>();
    let existingExactGroups = 0;
    for (const g of this.deps.duplicateGroupsRepo.listByTripIdWithItems(tripId)) {
      if (g.groupType !== "exact") continue;
      existingExactGroups += 1;
      for (const it of g.items) alreadyGrouped.add(it.mediaId);
    }

    // ---- Per-cohort decision -------------------------------------------
    const cohortsSkipped: {
      fileHash: string;
      mediaIds: readonly string[];
      reason: "already-grouped";
    }[] = [];
    let groupsCreated = 0;

    for (const cohort of candidateCohorts) {
      const overlaps = cohort.mediaIds.some((m) => alreadyGrouped.has(m));
      if (overlaps) {
        cohortsSkipped.push({
          fileHash: cohort.fileHash,
          mediaIds: cohort.mediaIds,
          reason: "already-grouped",
        });
        this.deps.logger.info(
          {
            tripId,
            fileHash: cohort.fileHash,
            mediaIds: cohort.mediaIds,
          },
          "dedup.exact: skipping cohort — overlaps an existing exact group (idempotency / user-confirmed protection)",
        );
        continue;
      }

      // Create one group + N items in a single transaction. The repo's
      // createGroupWithItems wraps everything in db.transaction so a
      // CHECK / FK failure on any item rolls back the group too.
      const groupId = randomUUID();
      const items: DuplicateGroupItemSeedData[] = cohort.mediaIds.map((mediaId) => ({
        id: randomUUID(),
        mediaId,
        similarityScore: EXACT_SIMILARITY,
        // qualityScore is left NULL — P6.T5 Quality_Selector fills it.
        recommendation: "undecided",
        reason: EXACT_REASON,
        userDecision: "undecided",
        createdAt: now,
        updatedAt: now,
      }));
      this.deps.duplicateGroupsRepo.createGroupWithItems(
        {
          id: groupId,
          tripId,
          groupType: "exact",
          // recommended_media_id stays null — P6.T5 Quality_Selector
          // chooses the keeper. Confidence + similarity baked in.
          recommendedMediaId: null,
          confidence: EXACT_CONFIDENCE,
          similarityScore: EXACT_SIMILARITY,
          userConfirmed: false,
          createdAt: now,
          updatedAt: now,
        },
        items,
      );
      // After creation, treat the newly-grouped media as "already
      // grouped" so a duplicate cohort (e.g. somehow two cohorts
      // sharing a member — impossible by hash equality, but
      // defensive) doesn't fight itself.
      for (const m of cohort.mediaIds) alreadyGrouped.add(m);
      groupsCreated += 1;

      this.deps.logger.info(
        {
          tripId,
          groupId,
          fileHash: cohort.fileHash,
          memberCount: cohort.mediaIds.length,
        },
        "dedup.exact: created exact group",
      );
    }

    const result: RunExactResult = {
      tripId,
      mediaScanned: rows.length,
      hashesScanned: byHash.size,
      candidateCohorts: candidateCohorts.length,
      groupsCreated,
      cohortsSkipped,
    };

    this.deps.logger.info(
      {
        tripId,
        mediaScanned: result.mediaScanned,
        hashesScanned: result.hashesScanned,
        candidateCohorts: result.candidateCohorts,
        existingExactGroups,
        groupsCreated: result.groupsCreated,
        cohortsSkipped: result.cohortsSkipped.length,
      },
      "dedup.exact: run complete",
    );

    return result;
  }
}
