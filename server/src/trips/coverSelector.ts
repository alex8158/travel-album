// Auto cover selector (P6.T7).
//
// Pure orchestration on top of TripRepository + MediaRepository:
//   1. Look up the trip.
//   2. If `cover_set_by_user = 1` → leave it alone (user choice
//      dominates the system recommendation, per CLAUDE.md §3.9).
//   3. Find the highest-quality candidate via
//      `MediaRepository.findBestCoverCandidate`.
//   4. Skip when no eligible image exists (analysis hasn't run yet,
//      every image is blurry / failed, or the trip is empty).
//   5. Skip when the best candidate matches the current
//      `cover_media_id` (no-op writes are not informative).
//   6. Otherwise call `TripRepository.setAutoCover` — the repo
//      writes ONLY when `cover_set_by_user = 0`, so a concurrent
//      user pin between our read and write still wins.
//
// Trigger points:
//   * `quality_selector_run` handler calls this after
//     `service.selectForTrip(tripId)` completes (success or skipped).
//   * `POST /api/trips/:id/cover/reset` calls this immediately
//     after `clearCoverSetByUserFlag` so the user gets an
//     auto-selected cover synchronously.
//
// Returns a typed outcome — the function NEVER throws on
// operational paths (missing trip / no candidate / user-pinned),
// keeping the caller's error-handling tree small. DB errors during
// the UPDATE bubble up untouched.

import type { Logger } from "../logger.js";
import type { MediaRepository } from "../media/index.js";
import type { TripRepository } from "./tripRepository.js";

export interface CoverSelectorDeps {
  readonly tripRepo: TripRepository;
  readonly mediaRepo: MediaRepository;
  readonly logger: Logger;
}

export type AutoCoverOutcome =
  | {
      readonly status: "applied";
      readonly tripId: string;
      readonly coverMediaId: string;
      readonly previousCoverMediaId: string | null;
      readonly qualityScore: number;
    }
  | {
      readonly status: "unchanged";
      readonly tripId: string;
      readonly coverMediaId: string;
      readonly qualityScore: number;
    }
  | {
      readonly status: "skipped-user-pinned";
      readonly tripId: string;
      readonly coverMediaId: string | null;
    }
  | {
      readonly status: "skipped-no-candidate";
      readonly tripId: string;
      readonly coverMediaId: string | null;
    }
  | { readonly status: "missing-trip"; readonly tripId: string };

/**
 * Auto-pick the best image cover for one trip and persist it via
 * `TripRepository.setAutoCover`. See module header for the rules.
 */
export function autoSelectCoverForTrip(
  deps: CoverSelectorDeps,
  tripId: string,
  now: string = new Date().toISOString(),
): AutoCoverOutcome {
  const trip = deps.tripRepo.findById(tripId);
  if (trip === null) {
    deps.logger.warn({ tripId }, "auto_cover_selector: trip missing / soft-deleted");
    return { status: "missing-trip", tripId };
  }
  if (trip.coverSetByUser) {
    // CLAUDE.md §3.9 — user choice dominates; do not overwrite.
    deps.logger.info(
      { tripId, coverMediaId: trip.coverMediaId },
      "auto_cover_selector: skipping user-pinned cover",
    );
    return {
      status: "skipped-user-pinned",
      tripId,
      coverMediaId: trip.coverMediaId,
    };
  }

  const candidate = deps.mediaRepo.findBestCoverCandidate(tripId);
  if (candidate === null) {
    deps.logger.info(
      { tripId, currentCoverMediaId: trip.coverMediaId },
      "auto_cover_selector: no eligible candidate yet (analysis still pending or every image disqualified)",
    );
    return {
      status: "skipped-no-candidate",
      tripId,
      coverMediaId: trip.coverMediaId,
    };
  }

  if (candidate.mediaId === trip.coverMediaId) {
    deps.logger.info(
      { tripId, coverMediaId: trip.coverMediaId, qualityScore: candidate.qualityScore },
      "auto_cover_selector: best candidate already the current cover; no write",
    );
    return {
      status: "unchanged",
      tripId,
      coverMediaId: trip.coverMediaId,
      qualityScore: candidate.qualityScore,
    };
  }

  const changed = deps.tripRepo.setAutoCover(tripId, candidate.mediaId, now);
  if (changed === 0) {
    // `cover_set_by_user = 0` predicate failed → the user pinned a
    // cover between our findById and setAutoCover. Treat as a
    // soft "user wins" outcome.
    deps.logger.info(
      { tripId, attemptedCoverMediaId: candidate.mediaId },
      "auto_cover_selector: setAutoCover changed=0 (likely a concurrent user pin); leaving cover alone",
    );
    return {
      status: "skipped-user-pinned",
      tripId,
      coverMediaId: trip.coverMediaId,
    };
  }

  deps.logger.info(
    {
      tripId,
      previousCoverMediaId: trip.coverMediaId,
      newCoverMediaId: candidate.mediaId,
      qualityScore: candidate.qualityScore,
    },
    "auto_cover_selector: cover updated",
  );
  return {
    status: "applied",
    tripId,
    coverMediaId: candidate.mediaId,
    previousCoverMediaId: trip.coverMediaId,
    qualityScore: candidate.qualityScore,
  };
}
