// DedupEngine (P5.T3 .exact + P5.T4 .similar).
//
// Service layer that turns hash-bearing `media_items` rows into
// `duplicate_groups` / `duplicate_group_items` writes. Exposed via
// "run once for one trip" methods so the caller (P5.T5 API,
// future "rebuild dedup" job, or a one-shot maintenance CLI) can
// invoke them on demand without a job_type plumbing.
//
// Scope as of P5.T4:
//   * `runExactForTrip(tripId)` — byte-level exact duplicates:
//     group images whose `media_items.file_hash` is strictly equal,
//     within the same trip. Per docs/design.md §6.3 / §7.3:
//       - `group_type = 'exact'`
//       - confidence = 1.0
//       - similarity_score = 1.0
//   * `runSimilarForTrip(tripId, opts)` — pHash Hamming-distance
//     similarity grouping:
//       - Reads `media_items.perceptual_hash`; takes the first 16
//         hex chars (pHash half — P5.T2 layout `pHashHex + dHashHex`).
//       - Pairwise compares within a trip; pairs with distance
//         ≤ `hammingThreshold` (default 8 = `PHASH_DISTANCE_MAX`) are
//         connected. Components ≥ 2 form cohorts.
//       - `group_type = 'similar'`, confidence + similarity_score
//         derived from worst pair distance (`1 - d_max / 64`).
//       - Per-item similarity_score = distance to cohort
//         representative (first member by sorted id).
//
// What this engine deliberately does NOT do:
//   * Quality scoring / recommendation selection (P6 `Quality_Selector`).
//   * Recompute on user-confirmed groups (CLAUDE.md §3.9 — user
//     decisions win and are never overwritten by the engine).
//   * Cross-trip aggregation (each trip is independent per design §7.3).
//   * Soft-deleted / video media (filtered at the MediaRepository read).
//   * AI-based perceptual similarity (CLIP / DINOv2 etc; out of P5 V1).
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
import { HEX16_MAX_BITS, hexHammingDistance } from "./hamming.js";

/** confidence / similarity_score baked in for byte-level exact match. */
const EXACT_CONFIDENCE = 1.0;
const EXACT_SIMILARITY = 1.0;
const EXACT_REASON = "exact byte-level match (file_hash)";

/**
 * Default pHash Hamming-distance threshold for similar dedup. Mirrors
 * `PHASH_DISTANCE_MAX` (env, default 8). Callers can override via
 * `runSimilarForTrip({ hammingThreshold })`. Production wiring passes
 * the value from `config.quality.pHashDistanceMax`; smokes pin an
 * explicit value for deterministic assertions.
 */
export const DEFAULT_SIMILAR_HAMMING_THRESHOLD = 8;

/**
 * Number of hex chars used for the pHash slice of `perceptual_hash`.
 * Layout per P5.T2 worker: `pHashHex(16) + dHashHex(16) = 32 hex`.
 * The engine only considers pHash for similarity matching today.
 */
const PHASH_HEX_LEN = 16;

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

/**
 * Options for `runSimilarForTrip`. Both fields are optional;
 * `hammingThreshold` defaults to `DEFAULT_SIMILAR_HAMMING_THRESHOLD`
 * (8 bits) and `now` defaults to wall-clock at call time.
 */
export interface RunSimilarOptions {
  readonly hammingThreshold?: number;
  readonly now?: string;
}

/**
 * Counters returned by `runSimilarForTrip`. Same shape as
 * `RunExactResult` except the per-row dimension is pHash instead of
 * file_hash, and "candidate cohorts" come from connected components
 * over the pairwise similarity graph (DSU / union-find).
 */
export interface RunSimilarResult {
  readonly tripId: string;
  /** Threshold used for this run — surfaced for log / API observability. */
  readonly hammingThreshold: number;
  /** Active image rows with a non-NULL `perceptual_hash` considered. */
  readonly mediaScanned: number;
  /** Rows dropped because their stored hash wasn't 32 valid hex chars. */
  readonly mediaSkippedInvalid: number;
  /** Connected components of size ≥ 2 — cohort candidates before skipping. */
  readonly candidateCohorts: number;
  /** New `'similar'` groups actually written this run. */
  readonly groupsCreated: number;
  /**
   * Cohorts that overlapped an existing group of ANY type (covers
   * idempotency, user-confirmed protection, and the "don't break
   * exact groups" invariant in one rule).
   */
  readonly cohortsSkipped: readonly {
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

  /**
   * Scan one trip's active images and create `'similar'` duplicate
   * groups by clustering connected components over pairwise pHash
   * Hamming distance ≤ `hammingThreshold`.
   *
   * Cohort assembly:
   *   * Build the pHash slice (first 16 hex) of every active image
   *     with `perceptual_hash` set; drop malformed.
   *   * Pairwise compare; pairs with distance ≤ threshold are
   *     `union`'d in a small DSU. Transitive similarity is handled
   *     for free: if A~B and B~C but A's distance to C is just over
   *     the threshold, all three still belong to one component.
   *
   * Skip rule (idempotency + user-confirmed + exact-group protection):
   *   * Build the set of media IDs that already sit in ANY existing
   *     group for the trip — regardless of `group_type` or
   *     `user_confirmed`. If a candidate cohort contains any member
   *     of that set, skip the entire cohort. This single rule
   *     guarantees:
   *       - Re-running yields zero new groups when state is stable.
   *       - User-confirmed groups stay intact and never get duplicate
   *         coverage.
   *       - Existing `'exact'` groups are not broken or overlapped
   *         (the prompt's "exact 优先" invariant — design.md §7.3 #4).
   *
   * Scoring (per docs/design.md §7.3 "置信度按距离归一化"):
   *   * Group-level `confidence` = group-level `similarity_score` =
   *     `1 - maxPairDistance / 64`. The worst (largest) intra-cohort
   *     pair distance is the tightest bound — a tighter cluster has
   *     higher confidence.
   *   * Item-level `similarity_score` = `1 - distance(item, representative) / 64`
   *     where the representative is the first member by sorted id.
   *     The representative's own row gets `1.0`.
   *   * Item `reason` records the per-item distance for explainability
   *     (CLAUDE.md §3.8).
   *
   * Atomicity: each group is written via
   * `createGroupWithItems`, which wraps group + items in a single
   * `db.transaction`. Cohort-level failure does not undo other
   * successful groups.
   */
  runSimilarForTrip(tripId: string, options: RunSimilarOptions = {}): RunSimilarResult {
    const hammingThreshold = options.hammingThreshold ?? DEFAULT_SIMILAR_HAMMING_THRESHOLD;
    const now = options.now ?? new Date().toISOString();

    const rows = this.deps.mediaRepo.findActiveImagePerceptualHashesByTripId(tripId);

    // ---- Parse + filter pHash slices ----------------------------------
    const items: { id: string; pHash: string }[] = [];
    let mediaSkippedInvalid = 0;
    for (const r of rows) {
      const slice = r.perceptualHash.slice(0, PHASH_HEX_LEN);
      // The hamming helper returns null for malformed input; we
      // still pre-check length so the loop accurately accounts for
      // invalid rows in the result counters.
      if (slice.length < PHASH_HEX_LEN) {
        mediaSkippedInvalid += 1;
        continue;
      }
      items.push({ id: r.id, pHash: slice });
    }

    // ---- DSU over pairwise comparisons --------------------------------
    // Small map-backed union-find. find() walks parent chain with
    // path compression on the way back; we don't bother with union-
    // by-rank because trip-scale N (< 10k images V1) makes the
    // worst-case chain trivially short.
    const parent = new Map<string, string>();
    for (const it of items) parent.set(it.id, it.id);
    const find = (x: string): string => {
      let p = parent.get(x);
      // Should never be undefined because we initialise above, but
      // guard for paranoia.
      if (p === undefined) {
        parent.set(x, x);
        return x;
      }
      while (p !== parent.get(p)) {
        const grand = parent.get(parent.get(p) as string) as string;
        parent.set(p, grand);
        p = grand;
      }
      return p;
    };
    const union = (a: string, b: string): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };

    // O(N^2) pair compares. For V1 trip sizes (≤ a few thousand
    // images) this is fine — the helper is tight (constant work per
    // pair) and the alternative (BK-tree / locality-sensitive
    // hashing) is a P5 follow-up at best.
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        const a = items[i] as { id: string; pHash: string };
        const b = items[j] as { id: string; pHash: string };
        const d = hexHammingDistance(a.pHash, b.pHash, PHASH_HEX_LEN);
        if (d === null) continue;
        if (d <= hammingThreshold) union(a.id, b.id);
      }
    }

    // ---- Collect connected components --------------------------------
    const byRoot = new Map<string, string[]>();
    for (const it of items) {
      const root = find(it.id);
      const list = byRoot.get(root);
      if (list) list.push(it.id);
      else byRoot.set(root, [it.id]);
    }
    const candidateCohorts: string[][] = [];
    for (const cohort of byRoot.values()) {
      if (cohort.length >= 2) {
        // Stable sort by id so the cohort representative ("first"
        // member) is deterministic and item ordering in logs is
        // reproducible across runs.
        cohort.sort();
        candidateCohorts.push(cohort);
      }
    }

    // ---- Build "already in some group" set (ALL group_types) ---------
    const alreadyGrouped = new Set<string>();
    let existingGroupCount = 0;
    for (const g of this.deps.duplicateGroupsRepo.listByTripIdWithItems(tripId)) {
      existingGroupCount += 1;
      for (const it of g.items) alreadyGrouped.add(it.mediaId);
    }

    // ---- Decide + write -----------------------------------------------
    const pHashById = new Map(items.map((it) => [it.id, it.pHash]));
    const cohortsSkipped: { mediaIds: string[]; reason: "already-grouped" }[] = [];
    let groupsCreated = 0;

    for (const cohort of candidateCohorts) {
      if (cohort.some((m) => alreadyGrouped.has(m))) {
        cohortsSkipped.push({ mediaIds: cohort, reason: "already-grouped" });
        this.deps.logger.info(
          { tripId, mediaIds: cohort, hammingThreshold },
          "dedup.similar: skipping cohort — overlaps an existing group (idempotency / user-confirmed / exact protection)",
        );
        continue;
      }

      // Compute max pair distance for group-level confidence.
      let maxPairDistance = 0;
      for (let i = 0; i < cohort.length; i += 1) {
        for (let j = i + 1; j < cohort.length; j += 1) {
          const a = pHashById.get(cohort[i] as string) as string;
          const b = pHashById.get(cohort[j] as string) as string;
          const d = hexHammingDistance(a, b, PHASH_HEX_LEN);
          if (d !== null && d > maxPairDistance) maxPairDistance = d;
        }
      }
      const groupConfidence = clamp01(1 - maxPairDistance / HEX16_MAX_BITS);
      const groupSimilarity = groupConfidence;

      const representativeId = cohort[0] as string;
      const representativePHash = pHashById.get(representativeId) as string;
      const itemRows: DuplicateGroupItemSeedData[] = cohort.map((mediaId) => {
        const p = pHashById.get(mediaId) as string;
        const d = hexHammingDistance(representativePHash, p, PHASH_HEX_LEN) ?? 0;
        return {
          id: randomUUID(),
          mediaId,
          similarityScore: clamp01(1 - d / HEX16_MAX_BITS),
          recommendation: "undecided",
          reason: `pHash hamming distance ${d} to cohort representative (${representativeId.slice(0, 8)})`,
          userDecision: "undecided",
          createdAt: now,
          updatedAt: now,
        };
      });

      const groupId = randomUUID();
      this.deps.duplicateGroupsRepo.createGroupWithItems(
        {
          id: groupId,
          tripId,
          groupType: "similar",
          // recommended_media_id stays NULL — P6.T5 Quality_Selector
          // chooses based on quality_score (not yet computed here).
          recommendedMediaId: null,
          confidence: groupConfidence,
          similarityScore: groupSimilarity,
          userConfirmed: false,
          createdAt: now,
          updatedAt: now,
        },
        itemRows,
      );

      // Defensive: mark members so any (impossible-by-DSU) later
      // cohort sharing a member would still skip cleanly.
      for (const m of cohort) alreadyGrouped.add(m);
      groupsCreated += 1;

      this.deps.logger.info(
        {
          tripId,
          groupId,
          memberCount: cohort.length,
          maxPairDistance,
          confidence: groupConfidence,
          hammingThreshold,
        },
        "dedup.similar: created similar group",
      );
    }

    const result: RunSimilarResult = {
      tripId,
      hammingThreshold,
      mediaScanned: items.length,
      mediaSkippedInvalid,
      candidateCohorts: candidateCohorts.length,
      groupsCreated,
      cohortsSkipped,
    };

    this.deps.logger.info(
      {
        tripId,
        hammingThreshold,
        mediaScanned: result.mediaScanned,
        mediaSkippedInvalid: result.mediaSkippedInvalid,
        candidateCohorts: result.candidateCohorts,
        existingGroupCount,
        groupsCreated: result.groupsCreated,
        cohortsSkipped: result.cohortsSkipped.length,
      },
      "dedup.similar: run complete",
    );

    return result;
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
