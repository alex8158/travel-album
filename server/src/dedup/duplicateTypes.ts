// Duplicate-detection domain types.
//
// Mirrors the columns of `migrations/007_create_duplicate_groups.sql`:
//   * duplicate_groups       — one row per cluster of exact / similar
//                              / candidate duplicate images.
//   * duplicate_group_items  — one row per (group, media) membership.
//
// Scope of this file: the read projections that flow back to the
// rest of the codebase + the Insert shapes accepted by the
// Repository. State-machine helpers, recommendation logic, and the
// Service-layer aggregations live elsewhere (P5.T2+).

/** Closed enum from `duplicate_groups.group_type` (CHECK constraint). */
export type DuplicateGroupType = "exact" | "similar" | "candidate";

/**
 * Closed enum shared by `duplicate_group_items.recommendation` AND
 * `duplicate_group_items.user_decision` (both have the same CHECK).
 *   * `recommendation` is what the engine chose (P5.T4 / P6.T5).
 *   * `user_decision`  is the user's manual override (P5.T7), which
 *     wins on conflict per CLAUDE.md §3.9.
 */
export type DuplicateDecision = "keep" | "remove" | "undecided";

/**
 * Read projection of one row in `duplicate_groups`. Mirrors every
 * column. `user_confirmed` is exposed as a boolean for callers'
 * convenience (storage is INTEGER 0/1 in SQLite STRICT).
 */
export interface DuplicateGroup {
  readonly id: string;
  readonly tripId: string;
  readonly groupType: DuplicateGroupType;
  readonly recommendedMediaId: string | null;
  readonly confidence: number | null;
  readonly similarityScore: number | null;
  readonly userConfirmed: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Read projection of one row in `duplicate_group_items`.
 */
export interface DuplicateGroupItem {
  readonly id: string;
  readonly groupId: string;
  readonly mediaId: string;
  readonly similarityScore: number | null;
  readonly qualityScore: number | null;
  readonly recommendation: DuplicateDecision;
  readonly reason: string | null;
  readonly userDecision: DuplicateDecision;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Convenience bundle: a group + its hydrated item list. Used by
 * `listByTripIdWithItems` so a single repo call can fully populate
 * the public Duplicate Group response shape (P5.T5).
 */
export interface DuplicateGroupWithItems extends DuplicateGroup {
  readonly items: readonly DuplicateGroupItem[];
}

/**
 * Insert payload for `duplicate_groups`. The caller supplies the id
 * (UUID; pattern matches MediaInsertData / JobInsertData) and the
 * timestamps so multi-row writes (group + items) share an identical
 * `now`. Optional fields default to NULL / 0 in SQL so the Repository
 * does not silently fabricate values.
 */
export interface DuplicateGroupInsertData {
  readonly id: string;
  readonly tripId: string;
  readonly groupType: DuplicateGroupType;
  readonly recommendedMediaId?: string | null;
  readonly confidence?: number | null;
  readonly similarityScore?: number | null;
  /** Default false. Stored as INTEGER 0/1; we accept boolean here. */
  readonly userConfirmed?: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Insert payload for `duplicate_group_items`. `recommendation` and
 * `user_decision` default to `'undecided'` matching the SQL DEFAULT.
 */
export interface DuplicateGroupItemInsertData {
  readonly id: string;
  readonly groupId: string;
  readonly mediaId: string;
  readonly similarityScore?: number | null;
  readonly qualityScore?: number | null;
  readonly recommendation?: DuplicateDecision;
  readonly reason?: string | null;
  readonly userDecision?: DuplicateDecision;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Payload variant used by `createGroupWithItems`. The caller does NOT
 * supply `groupId` for the items — the repo wires the freshly-created
 * group's id into every item inside the same transaction. Everything
 * else mirrors `DuplicateGroupItemInsertData` (minus `groupId`).
 */
export type DuplicateGroupItemSeedData = Omit<DuplicateGroupItemInsertData, "groupId">;
