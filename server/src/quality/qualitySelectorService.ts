// Quality_Selector (P6.T5, second half).
//
// Picks the recommended media inside one `duplicate_group` from the
// composite `quality_score` produced by P6.T5 first-half (the
// `image_quality_finalize` worker writes that). For every group it
// processes:
//   1. Fetch members + each member's `media_analysis` + per-row
//      `media_items` metadata.
//   2. Rank members by quality_score DESC with deterministic
//      tie-breaks (see {@link rankMembers}).
//   3. Build a per-item reason explaining the keep / remove choice.
//   4. Atomically write back via
//      `DuplicateGroupsRepository.applyRecommendation` —
//      `recommended_media_id` on the group header + `recommendation`
//      / `reason` on every item.
//
// What this service deliberately does NOT do:
//   * Touch `user_decision` — that column is the manual override
//     written by `POST /api/duplicate-groups/:id/confirm` (P5.T7) and
//     CLAUDE.md §3.9 says it dominates the auto-recommendation.
//   * Flip `user_confirmed` — the user is the only writer of that
//     bit. Groups with `user_confirmed = 1` are SKIPPED outright.
//   * Recompute / rewrite the `quality_score` itself — that's the
//     `image_quality_finalize` worker's job.
//   * Run video. The service operates on whatever members the group
//     contains; today P5 only emits image groups. Once P9 introduces
//     video groups, the ranking inputs need to be revisited (no
//     scoring exists for video yet).
//
// Trigger point: not wired into the job queue or HTTP layer in this
// task — callers are responsible. The next PR (upload chain
// integration or a manual API endpoint) can pick this up.

import type {
  DuplicateDecision,
  DuplicateGroupItem,
  DuplicateGroupsRepository,
  DuplicateGroupWithItems,
} from "../dedup/index.js";
import type { Logger } from "../logger.js";
import type {
  MediaAnalysisRepository,
  MediaAnalysisRow,
  MediaItem,
  MediaRepository,
} from "../media/index.js";

/**
 * Epsilon used when comparing `quality_score`. Two scores within
 * `0.01` of each other are treated as ties and fall through to the
 * blur / exposure / color / resolution / file-size / created_at
 * tie-breaks. Keeps the ranking stable against tiny floating-point
 * jitter and lets a meaningful resolution edge break a "0.875 vs
 * 0.879" near-tie.
 */
export const QUALITY_SCORE_TIE_EPSILON = 0.01;

/** Per-member view materialised for ranking. Exported for the smoke. */
export interface MemberRanking {
  readonly mediaId: string;
  readonly item: DuplicateGroupItem;
  readonly analysis: MediaAnalysisRow | null;
  readonly media: MediaItem | null;
  /** `media_analysis.quality_score`, null when no finalize run yet. */
  readonly qualityScore: number | null;
  /** Tie-break component pulled out for the smoke. */
  readonly sharpness: number | null;
  readonly exposure: number | null;
  readonly color: number | null;
  /** Resolution = width × height, null when either is missing. */
  readonly resolution: number | null;
  readonly fileSize: number | null;
  readonly createdAt: string | null;
}

/** Outcome of `selectForGroup` — exported so callers can branch on it. */
export type SelectGroupOutcome =
  | {
      readonly groupId: string;
      readonly status: "applied";
      readonly winnerMediaId: string;
      /** Member media IDs in ranking order, winner first. */
      readonly ranking: readonly string[];
    }
  | {
      readonly groupId: string;
      readonly status: "skipped-confirmed";
      /** `recommended_media_id` left untouched. */
      readonly currentRecommended: string | null;
    }
  | { readonly groupId: string; readonly status: "skipped-empty" }
  | { readonly groupId: string; readonly status: "missing-group" };

export interface QualitySelectorServiceDeps {
  readonly duplicateGroupsRepo: DuplicateGroupsRepository;
  readonly mediaAnalysisRepo: MediaAnalysisRepository;
  readonly mediaRepo: MediaRepository;
  readonly logger: Logger;
}

export class QualitySelectorService {
  constructor(private readonly deps: QualitySelectorServiceDeps) {}

  /**
   * Compute and write the recommendation for one duplicate group.
   * Returns a structured outcome; never throws on "group missing /
   * already confirmed / empty" — those are normal operational paths
   * that route through the typed result instead of an exception.
   *
   * Throws only on:
   *   * DB-level failures (constraint / FK / SQL errors from the
   *     transactional UPDATE).
   */
  selectForGroup(groupId: string, now: string = new Date().toISOString()): SelectGroupOutcome {
    const group = this.deps.duplicateGroupsRepo.findGroupByIdWithItems(groupId);
    if (group === null) {
      this.deps.logger.warn({ groupId }, "quality_selector: group not found");
      return { groupId, status: "missing-group" };
    }
    if (group.userConfirmed) {
      // CLAUDE.md §3.9: user choice dominates; do not overwrite.
      this.deps.logger.info(
        { groupId, recommendedMediaId: group.recommendedMediaId },
        "quality_selector: skipping user_confirmed group",
      );
      return {
        groupId,
        status: "skipped-confirmed",
        currentRecommended: group.recommendedMediaId,
      };
    }
    if (group.items.length === 0) {
      this.deps.logger.info({ groupId }, "quality_selector: group has no members; skipping");
      return { groupId, status: "skipped-empty" };
    }

    const ranking = this.hydrateAndRank(group);
    const winner = ranking[0];
    if (winner === undefined) {
      return { groupId, status: "skipped-empty" };
    }

    const perItemReasons = buildPerItemReasons(ranking, winner);
    this.deps.duplicateGroupsRepo.applyRecommendation({
      groupId,
      winnerMediaId: winner.mediaId,
      perItemReasons,
      updatedAt: now,
    });

    this.deps.logger.info(
      {
        groupId,
        winnerMediaId: winner.mediaId,
        memberCount: ranking.length,
        winnerQualityScore: winner.qualityScore,
      },
      "quality_selector: recommendation written",
    );

    return {
      groupId,
      status: "applied",
      winnerMediaId: winner.mediaId,
      ranking: ranking.map((m) => m.mediaId),
    };
  }

  /**
   * Convenience: run `selectForGroup` for every duplicate group in a
   * trip. Returns the per-group outcome array in the same order the
   * repository surfaced them (newest-first per design.md).
   */
  selectForTrip(tripId: string, now: string = new Date().toISOString()): SelectGroupOutcome[] {
    const groups = this.deps.duplicateGroupsRepo.listByTripIdWithItems(tripId);
    return groups.map((g) => this.selectForGroup(g.id, now));
  }

  private hydrateAndRank(group: DuplicateGroupWithItems): MemberRanking[] {
    const members: MemberRanking[] = group.items.map((item) => {
      const analysis = this.deps.mediaAnalysisRepo.findByMediaId(item.mediaId);
      const media = this.deps.mediaRepo.findById(item.mediaId);
      const resolution =
        media !== null && media.width !== null && media.height !== null
          ? media.width * media.height
          : null;
      return {
        mediaId: item.mediaId,
        item,
        analysis,
        media,
        qualityScore: analysis?.qualityScore ?? null,
        sharpness: analysis?.sharpnessScore ?? null,
        exposure: analysis?.exposureScore ?? null,
        color: analysis?.colorScore ?? null,
        resolution,
        fileSize: media?.fileSize ?? null,
        createdAt: media?.createdAt ?? null,
      };
    });
    return rankMembers(members);
  }
}

// ---------------------------------------------------------------------------
// pure helpers (exported for the smoke)
// ---------------------------------------------------------------------------

/**
 * Sort `members` by quality first, then by sharper / better-exposed /
 * better-coloured / higher-resolution / larger-file / earlier-created /
 * stable-id tie-breaks. Returns a NEW array; the caller's array is
 * not mutated.
 *
 * Comparison rules (in order):
 *   1. `quality_score` DESC — null sorts last. Two non-null scores
 *      within {@link QUALITY_SCORE_TIE_EPSILON} are treated as tied
 *      and fall through to step 2.
 *   2. `sharpness_score` DESC — null treated as -1 so a media with
 *      no analysis loses to a media with even the lowest sharpness.
 *   3. `exposure_score` DESC — same null handling.
 *   4. `color_score` DESC — same null handling.
 *   5. resolution (width × height) DESC — null treated as 0.
 *   6. `file_size` DESC — null treated as 0.
 *   7. `created_at` ASC — earlier upload wins; null sorts to the end.
 *   8. `mediaId` ASC — final stable tie-break (UUID lexicographic).
 */
export function rankMembers(members: readonly MemberRanking[]): MemberRanking[] {
  const copy = [...members];
  copy.sort((a, b) => compareMembers(a, b));
  return copy;
}

function compareMembers(a: MemberRanking, b: MemberRanking): number {
  // Quality first — null sorts last (worse).
  const qDiff = compareNullableDesc(a.qualityScore, b.qualityScore, QUALITY_SCORE_TIE_EPSILON);
  if (qDiff !== 0) return qDiff;
  // Tie-breaks: blur / exposure / color (higher is better, null = -1).
  const sDiff = compareNullableDesc(a.sharpness, b.sharpness, QUALITY_SCORE_TIE_EPSILON);
  if (sDiff !== 0) return sDiff;
  const eDiff = compareNullableDesc(a.exposure, b.exposure, QUALITY_SCORE_TIE_EPSILON);
  if (eDiff !== 0) return eDiff;
  const cDiff = compareNullableDesc(a.color, b.color, QUALITY_SCORE_TIE_EPSILON);
  if (cDiff !== 0) return cDiff;
  // Resolution / file_size — exact comparison (no epsilon).
  const rDiff = (b.resolution ?? 0) - (a.resolution ?? 0);
  if (rDiff !== 0) return rDiff;
  const fDiff = (b.fileSize ?? 0) - (a.fileSize ?? 0);
  if (fDiff !== 0) return fDiff;
  // Earlier created_at wins. Null sorts last.
  const tDiff = compareCreatedAt(a.createdAt, b.createdAt);
  if (tDiff !== 0) return tDiff;
  // Final stable tie-break.
  if (a.mediaId < b.mediaId) return -1;
  if (a.mediaId > b.mediaId) return 1;
  return 0;
}

function compareNullableDesc(aVal: number | null, bVal: number | null, epsilon: number): number {
  // Both null → tied.
  if (aVal === null && bVal === null) return 0;
  // Null sorts to the end.
  if (aVal === null) return 1;
  if (bVal === null) return -1;
  const diff = bVal - aVal;
  if (Math.abs(diff) <= epsilon) return 0;
  return diff;
}

function compareCreatedAt(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Build the per-item `recommendation` + `reason` map from the ranked
 * members. The winner gets `keep` + a short "best in group" reason;
 * everyone else gets `remove` + a reason that explains the gap
 * (quality_score, missing analysis, or tie-break axis). Exported for
 * the smoke to assert.
 */
export function buildPerItemReasons(
  ranking: readonly MemberRanking[],
  winner: MemberRanking,
): Map<string, { recommendation: DuplicateDecision; reason: string }> {
  const out = new Map<string, { recommendation: DuplicateDecision; reason: string }>();
  const memberCount = ranking.length;
  for (const m of ranking) {
    if (m.mediaId === winner.mediaId) {
      out.set(m.mediaId, {
        recommendation: "keep",
        reason: describeWinner(winner, memberCount),
      });
    } else {
      out.set(m.mediaId, {
        recommendation: "remove",
        reason: describeLoser(m, winner),
      });
    }
  }
  return out;
}

function describeWinner(winner: MemberRanking, memberCount: number): string {
  const losers = Math.max(0, memberCount - 1);
  if (winner.qualityScore !== null) {
    return `recommended — quality_score=${roundTo(winner.qualityScore, 3)} (best of ${memberCount} member(s))`;
  }
  // No analysis yet — picked purely on tie-breakers / fallback.
  return `recommended — no quality_score yet; chosen by tie-breakers across ${losers} other member(s)`;
}

function describeLoser(loser: MemberRanking, winner: MemberRanking): string {
  if (loser.qualityScore === null && winner.qualityScore !== null) {
    return `no quality_score yet; winner has ${roundTo(winner.qualityScore, 3)}`;
  }
  if (loser.qualityScore === null && winner.qualityScore === null) {
    return `tied on missing quality_score; lost on tie-breakers (sharpness/exposure/color/resolution/file_size/created_at)`;
  }
  if (
    loser.qualityScore !== null &&
    winner.qualityScore !== null &&
    Math.abs(loser.qualityScore - winner.qualityScore) > QUALITY_SCORE_TIE_EPSILON
  ) {
    return `quality_score ${roundTo(loser.qualityScore, 3)} < winner ${roundTo(winner.qualityScore, 3)}`;
  }
  // Tied on quality_score → must have lost on a tie-break axis.
  const axis = identifyLosingAxis(loser, winner);
  const lScore = loser.qualityScore;
  const wScore = winner.qualityScore;
  const head =
    lScore !== null && wScore !== null
      ? `tied on quality_score ${roundTo(lScore, 3)}`
      : `tied on quality_score`;
  return `${head}; lost on ${axis}`;
}

function identifyLosingAxis(loser: MemberRanking, winner: MemberRanking): string {
  if (compareNullableDesc(loser.sharpness, winner.sharpness, QUALITY_SCORE_TIE_EPSILON) > 0) {
    return formatAxis("sharpness", loser.sharpness, winner.sharpness);
  }
  if (compareNullableDesc(loser.exposure, winner.exposure, QUALITY_SCORE_TIE_EPSILON) > 0) {
    return formatAxis("exposure", loser.exposure, winner.exposure);
  }
  if (compareNullableDesc(loser.color, winner.color, QUALITY_SCORE_TIE_EPSILON) > 0) {
    return formatAxis("color", loser.color, winner.color);
  }
  if ((winner.resolution ?? 0) > (loser.resolution ?? 0)) {
    return `resolution ${loser.resolution ?? 0} < winner ${winner.resolution ?? 0}`;
  }
  if ((winner.fileSize ?? 0) > (loser.fileSize ?? 0)) {
    return `file_size ${loser.fileSize ?? 0} < winner ${winner.fileSize ?? 0}`;
  }
  return "created_at / id ordering";
}

function formatAxis(name: string, loser: number | null, winner: number | null): string {
  const l = loser === null ? "n/a" : roundTo(loser, 3).toString();
  const w = winner === null ? "n/a" : roundTo(winner, 3).toString();
  return `${name} ${l} < winner ${w}`;
}

function roundTo(value: number, digits: number): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
