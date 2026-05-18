// DuplicateGroupsRepository — data-access layer for the two tables
// added by `migrations/007_create_duplicate_groups.sql`:
//
//   * duplicate_groups       — one row per cluster of exact / similar
//                              / candidate duplicate images.
//   * duplicate_group_items  — one row per (group, media) membership.
//
// Scope of this Repository (P5.T1 follow-up):
//   * Single-row writes for groups and items.
//   * Atomic "create a group with N members" via `db.transaction`
//     (per the user-spec: avoid the half-written state where a group
//     exists with no items).
//   * Read paths for the queries the upcoming Service / API layers
//     will need: by trip, by media, by group id, items by group.
//   * Hard delete of a group (FK CASCADE handles items).
//
// What this Repository deliberately does NOT cover (later phases):
//   * Recommendation / quality / similarity *recompute* logic
//     (P5.T2 … P5.T4 / P6.T5).
//   * `user_confirmed` toggle / `user_decision` flip
//     (P5.T7).
//   * Soft-delete cascade reset of `recommended_media_id` and item
//     `user_decision='remove'` (P7.T1).
//   * Any HTTP-shaped validation (Service / Route layer).
//
// Constraint violations (CHECK / FK / UNIQUE) propagate untouched —
// `.run()` on better-sqlite3 throws on constraint failure and the
// caller decides how to translate.
//
// All prepared statements are created once at construction time so
// the hot read paths stay fast. The repository never throws AppError;
// missing rows surface as `null` / empty arrays.

import type { SqliteDatabase } from "../db/connection.js";

import type {
  DuplicateDecision,
  DuplicateGroup,
  DuplicateGroupInsertData,
  DuplicateGroupItem,
  DuplicateGroupItemInsertData,
  DuplicateGroupItemSeedData,
  DuplicateGroupType,
  DuplicateGroupWithItems,
} from "./duplicateTypes.js";

const DEFAULT_DECISION: DuplicateDecision = "undecided";

/** Raw row shape returned by `SELECT ... FROM duplicate_groups`. */
interface GroupRow {
  id: string;
  trip_id: string;
  group_type: DuplicateGroupType;
  recommended_media_id: string | null;
  confidence: number | null;
  similarity_score: number | null;
  user_confirmed: number;
  created_at: string;
  updated_at: string;
}

/** Raw row shape returned by `SELECT ... FROM duplicate_group_items`. */
interface ItemRow {
  id: string;
  group_id: string;
  media_id: string;
  similarity_score: number | null;
  quality_score: number | null;
  recommendation: DuplicateDecision;
  reason: string | null;
  user_decision: DuplicateDecision;
  created_at: string;
  updated_at: string;
}

const GROUP_COLUMNS = `
  id,
  trip_id,
  group_type,
  recommended_media_id,
  confidence,
  similarity_score,
  user_confirmed,
  created_at,
  updated_at
`;

const ITEM_COLUMNS = `
  id,
  group_id,
  media_id,
  similarity_score,
  quality_score,
  recommendation,
  reason,
  user_decision,
  created_at,
  updated_at
`;

export class DuplicateGroupsRepository {
  private readonly insertGroupStmt;
  private readonly insertItemStmt;
  private readonly findGroupByIdStmt;
  private readonly listGroupsByTripIdStmt;
  private readonly listItemsByGroupIdStmt;
  private readonly listGroupsByMediaIdStmt;
  private readonly deleteGroupStmt;

  constructor(private readonly db: SqliteDatabase) {
    // Insert one duplicate_groups row. `user_confirmed` is the only
    // boolean-shaped field; SQLite STRICT stores it as INTEGER 0/1 so
    // we coerce the boolean to a number at the call site. Defaults
    // mirror the SQL DEFAULTs: NULL for the score/recommended fields,
    // 0 for user_confirmed.
    this.insertGroupStmt = db.prepare(`
      INSERT INTO duplicate_groups (
        id, trip_id, group_type, recommended_media_id,
        confidence, similarity_score, user_confirmed,
        created_at, updated_at
      ) VALUES (
        @id, @tripId, @groupType, @recommendedMediaId,
        @confidence, @similarityScore, @userConfirmed,
        @createdAt, @updatedAt
      )
    `);

    // Insert one duplicate_group_items row. The two enum-shaped
    // fields default to 'undecided' (matches the SQL DEFAULT and
    // the CHECK constraint), so callers that don't have a value
    // yet can omit them.
    this.insertItemStmt = db.prepare(`
      INSERT INTO duplicate_group_items (
        id, group_id, media_id,
        similarity_score, quality_score,
        recommendation, reason, user_decision,
        created_at, updated_at
      ) VALUES (
        @id, @groupId, @mediaId,
        @similarityScore, @qualityScore,
        @recommendation, @reason, @userDecision,
        @createdAt, @updatedAt
      )
    `);

    this.findGroupByIdStmt = db.prepare(`
      SELECT ${GROUP_COLUMNS}
      FROM duplicate_groups
      WHERE id = ?
    `);

    // Per-trip listing, newest first with a stable id tiebreak so the
    // order is deterministic even when two groups share a timestamp.
    this.listGroupsByTripIdStmt = db.prepare(`
      SELECT ${GROUP_COLUMNS}
      FROM duplicate_groups
      WHERE trip_id = ?
      ORDER BY created_at DESC, id DESC
    `);

    // Per-group item listing. Sort by similarity DESC (NULLs last)
    // so the most-similar candidate surfaces first when the engine
    // populates it; fall back to a stable `id ASC` tiebreak so the
    // ordering is deterministic when scores are equal / NULL.
    this.listItemsByGroupIdStmt = db.prepare(`
      SELECT ${ITEM_COLUMNS}
      FROM duplicate_group_items
      WHERE group_id = ?
      ORDER BY
        similarity_score IS NULL,
        similarity_score DESC,
        id ASC
    `);

    // Reverse lookup: which groups currently include this media?
    // P7.T1 soft-delete uses this to find groups whose membership /
    // recommendation needs updating when a media is removed.
    // DISTINCT in case a future schema change ever permits the same
    // group to appear multiple times (UNIQUE today forbids it; the
    // DISTINCT is defensive and free given the small result set).
    this.listGroupsByMediaIdStmt = db.prepare(`
      SELECT DISTINCT
        g.id              AS id,
        g.trip_id         AS trip_id,
        g.group_type      AS group_type,
        g.recommended_media_id AS recommended_media_id,
        g.confidence      AS confidence,
        g.similarity_score AS similarity_score,
        g.user_confirmed  AS user_confirmed,
        g.created_at      AS created_at,
        g.updated_at      AS updated_at
      FROM duplicate_groups g
      JOIN duplicate_group_items i ON i.group_id = g.id
      WHERE i.media_id = ?
      ORDER BY g.created_at DESC, g.id DESC
    `);

    // Hard delete. Items go away via ON DELETE CASCADE on
    // duplicate_group_items.group_id — no explicit DELETE needed.
    this.deleteGroupStmt = db.prepare(`
      DELETE FROM duplicate_groups
      WHERE id = ?
    `);
  }

  /**
   * Insert one duplicate_groups row. Throws on:
   *   * PK collision (`id` already exists)
   *   * FK violation (`trip_id` missing; `recommended_media_id` missing
   *     when supplied non-null)
   *   * CHECK failure (`group_type` not in enum, scores outside [0,1],
   *     `user_confirmed` not 0/1)
   */
  insertGroup(data: DuplicateGroupInsertData): void {
    this.insertGroupStmt.run({
      id: data.id,
      tripId: data.tripId,
      groupType: data.groupType,
      recommendedMediaId: data.recommendedMediaId ?? null,
      confidence: data.confidence ?? null,
      similarityScore: data.similarityScore ?? null,
      userConfirmed: data.userConfirmed === true ? 1 : 0,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    });
  }

  /**
   * Insert one duplicate_group_items row. Throws on:
   *   * PK collision
   *   * FK violation (`group_id` missing; `media_id` missing)
   *   * UNIQUE (group_id, media_id) violation — the same media cannot
   *     be added twice to the same group
   *   * CHECK failure (recommendation / user_decision not in enum,
   *     scores outside [0,1])
   */
  insertItem(data: DuplicateGroupItemInsertData): void {
    this.insertItemStmt.run({
      id: data.id,
      groupId: data.groupId,
      mediaId: data.mediaId,
      similarityScore: data.similarityScore ?? null,
      qualityScore: data.qualityScore ?? null,
      recommendation: data.recommendation ?? DEFAULT_DECISION,
      reason: data.reason ?? null,
      userDecision: data.userDecision ?? DEFAULT_DECISION,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    });
  }

  /**
   * Atomic "create group + add members" write.
   *
   * Wraps the group insert and every item insert in a single
   * `db.transaction(...)` callback. better-sqlite3's `transaction`
   * helper runs the body inside a SAVEPOINT and rolls back the
   * entire write on any thrown error — so a UNIQUE / FK / CHECK
   * failure on any item undoes the group too, preventing the
   * half-completed "group exists but has no members" state called
   * out in the user-spec.
   *
   * The caller passes items WITHOUT a `groupId`; the repo wires the
   * group's id into every item inside the transaction.
   *
   * Returns nothing. On failure the original constraint error
   * propagates to the caller.
   */
  createGroupWithItems(
    group: DuplicateGroupInsertData,
    items: readonly DuplicateGroupItemSeedData[],
  ): void {
    const tx = this.db.transaction(
      (g: DuplicateGroupInsertData, list: readonly DuplicateGroupItemSeedData[]) => {
        this.insertGroup(g);
        for (const it of list) {
          this.insertItem({ ...it, groupId: g.id });
        }
      },
    );
    tx(group, items);
  }

  /** Look up one duplicate_groups row by id. Null when missing. */
  findGroupById(id: string): DuplicateGroup | null {
    const row = this.findGroupByIdStmt.get(id) as GroupRow | undefined;
    return row ? rowToGroup(row) : null;
  }

  /**
   * List every duplicate_groups row that belongs to a trip, ordered
   * newest-first. Returns `[]` when none exist. Does NOT hydrate the
   * item list — call `listByTripIdWithItems` when you want both in
   * one shot (e.g. the public Duplicate Group API will).
   */
  listByTripId(tripId: string): DuplicateGroup[] {
    const rows = this.listGroupsByTripIdStmt.all(tripId) as GroupRow[];
    return rows.map(rowToGroup);
  }

  /**
   * List items belonging to one group, ordered similarity-DESC with
   * NULLs last and a stable id ASC tiebreak. Returns `[]` for an
   * empty / missing group.
   */
  listItemsByGroupId(groupId: string): DuplicateGroupItem[] {
    const rows = this.listItemsByGroupIdStmt.all(groupId) as ItemRow[];
    return rows.map(rowToItem);
  }

  /**
   * One-shot listing: every group for a trip, each with its hydrated
   * items array. Equivalent to `listByTripId` + an N-times
   * `listItemsByGroupId`, but a single method gives the Service /
   * API layer a clean entry point.
   *
   * No JOIN is used — two simpler queries keep the prepared
   * statements small and the row→object mapping straightforward.
   * Per-trip duplicate-group counts are tiny in V1 (usually < 50
   * groups, < 10 items each) so the N+1 cost is negligible.
   */
  listByTripIdWithItems(tripId: string): DuplicateGroupWithItems[] {
    const groups = this.listByTripId(tripId);
    return groups.map((group) => ({
      ...group,
      items: this.listItemsByGroupId(group.id),
    }));
  }

  /**
   * Reverse lookup: every group that currently contains the given
   * media as a member. Ordered newest-first.
   *
   * Used by P7 soft-delete to find groups whose `recommended_media_id`
   * needs to be reset / whose item rows need to be flipped to
   * `user_decision='remove'` when a media is removed.
   */
  listGroupsByMediaId(mediaId: string): DuplicateGroup[] {
    const rows = this.listGroupsByMediaIdStmt.all(mediaId) as GroupRow[];
    return rows.map(rowToGroup);
  }

  /**
   * Delete one duplicate_groups row. The schema's
   * `duplicate_group_items.group_id ON DELETE CASCADE` removes its
   * member rows in the same statement, so the caller does not need
   * a transaction to keep the two tables consistent.
   *
   * Returns the number of rows affected (0 or 1).
   */
  deleteGroup(groupId: string): number {
    const info = this.deleteGroupStmt.run(groupId);
    return info.changes;
  }
}

function rowToGroup(row: GroupRow): DuplicateGroup {
  return {
    id: row.id,
    tripId: row.trip_id,
    groupType: row.group_type,
    recommendedMediaId: row.recommended_media_id,
    confidence: row.confidence,
    similarityScore: row.similarity_score,
    userConfirmed: row.user_confirmed === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToItem(row: ItemRow): DuplicateGroupItem {
  return {
    id: row.id,
    groupId: row.group_id,
    mediaId: row.media_id,
    similarityScore: row.similarity_score,
    qualityScore: row.quality_score,
    recommendation: row.recommendation,
    reason: row.reason,
    userDecision: row.user_decision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
