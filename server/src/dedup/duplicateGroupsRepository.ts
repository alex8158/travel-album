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
//   * Soft-delete cascade reset of `recommended_media_id` and item
//     `user_decision='remove'` (P7.T1).
//   * Any HTTP-shaped validation (Service / Route layer).
//
// P5.T7 added the user-confirmation surface:
//   * `groupContainsMedia` — membership check used to reject
//     recommend / confirm requests that point at a media not in
//     the group.
//   * `setRecommendedMedia` — single UPDATE of `recommended_media_id`
//     (used by `POST /api/duplicate-groups/:id/recommend`).
//   * `confirmGroupRecommendation` — `db.transaction`-wrapped write:
//     `recommended_media_id` + `user_confirmed=1` on the group, plus
//     items.user_decision = 'keep' for the selected media and
//     'remove' for every other member of the same group. Atomic so
//     a partial failure can never leave the group half-confirmed.
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
  // P5.T7 — user confirmation
  private readonly groupContainsMediaStmt;
  private readonly setRecommendedMediaStmt;
  private readonly confirmGroupHeaderStmt;
  private readonly markItemKeepStmt;
  private readonly markOtherItemsRemoveStmt;
  // P6.T5 (second half) — Quality_Selector recommendation writeback
  private readonly setGroupRecommendedOnlyStmt;
  private readonly setItemRecommendationStmt;

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

    // P5.T7 user confirmation primitives. Each statement is tiny
    // and guarded so the Service layer can compose them safely
    // without re-deriving the schema invariants.
    //
    // Membership check: returns the count of items matching
    // (group_id, media_id). Used to reject `recommend` / `confirm`
    // requests whose mediaId is not actually a member of the
    // target group (cross-group leak protection).
    this.groupContainsMediaStmt = db.prepare(`
      SELECT COUNT(*) AS n
      FROM duplicate_group_items
      WHERE group_id = ? AND media_id = ?
    `);
    // Set the recommended media on a group (recommend endpoint).
    // The WHERE clause guards on group id only — Service validates
    // the (group, media) membership before calling.
    this.setRecommendedMediaStmt = db.prepare(`
      UPDATE duplicate_groups
      SET recommended_media_id = ?, updated_at = ?
      WHERE id = ?
    `);
    // Confirm: flip the group's user_confirmed flag and the
    // recommended media in one statement.
    this.confirmGroupHeaderStmt = db.prepare(`
      UPDATE duplicate_groups
      SET recommended_media_id = ?, user_confirmed = 1, updated_at = ?
      WHERE id = ?
    `);
    // Per-item decision UPDATEs used by confirmGroupRecommendation
    // inside a db.transaction so the (group, items) state lands
    // atomically. The "keep" stmt also tightens
    // `recommendation = 'keep'` so the engine-derived signal
    // stays consistent with the user choice; same for 'remove'.
    this.markItemKeepStmt = db.prepare(`
      UPDATE duplicate_group_items
      SET user_decision = 'keep', recommendation = 'keep', updated_at = ?
      WHERE group_id = ? AND media_id = ?
    `);
    this.markOtherItemsRemoveStmt = db.prepare(`
      UPDATE duplicate_group_items
      SET user_decision = 'remove', recommendation = 'remove', updated_at = ?
      WHERE group_id = ? AND media_id != ?
    `);

    // P6.T5 (second half) Quality_Selector primitives. Distinct from
    // the P5.T7 confirm path because they DO NOT touch `user_decision`
    // (that remains the user's territory) and DO NOT flip
    // `user_confirmed` (caller filters out already-confirmed groups
    // before invoking). Per-item statement is bound row-by-row inside
    // the transaction so the reason text can differ per member.
    this.setGroupRecommendedOnlyStmt = db.prepare(`
      UPDATE duplicate_groups
      SET recommended_media_id = ?, updated_at = ?
      WHERE id = ?
    `);
    this.setItemRecommendationStmt = db.prepare(`
      UPDATE duplicate_group_items
      SET recommendation = ?, reason = ?, updated_at = ?
      WHERE group_id = ? AND media_id = ?
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
   * P5.T6: look up one duplicate group + hydrate its items. Null
   * when the group does not exist. Mirrors `listByTripIdWithItems`
   * but for a single id — used by `GET /api/duplicate-groups/:id`.
   */
  findGroupByIdWithItems(id: string): DuplicateGroupWithItems | null {
    const group = this.findGroupById(id);
    if (group === null) return null;
    return { ...group, items: this.listItemsByGroupId(group.id) };
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

  /**
   * P5.T7 membership check: does `mediaId` currently belong to
   * `groupId` as a `duplicate_group_items` row? Used by the
   * recommend / confirm service paths to reject cross-group writes
   * (a client cannot smuggle a mediaId from another group via the
   * body).
   *
   * Returns `false` for missing group, missing media, or a
   * (group, media) pair that simply isn't there. The Service maps
   * `false` to a 400 INVALID_STATE_TRANSITION.
   */
  groupContainsMedia(groupId: string, mediaId: string): boolean {
    const row = this.groupContainsMediaStmt.get(groupId, mediaId) as { n: number };
    return row.n > 0;
  }

  /**
   * P5.T7 `POST /api/duplicate-groups/:id/recommend`: set the
   * recommended media on a group. Does NOT flip user_confirmed or
   * touch items.user_decision — that's reserved for the confirm
   * endpoint per CLAUDE.md §3.9 ("recommendation is suggestive,
   * confirmation is binding").
   *
   * Service is expected to call `groupContainsMedia` first; this
   * method assumes the membership invariant holds. Returns the
   * UPDATE rowcount (0 means the group disappeared between the
   * Service's check and this write — caller surfaces 404).
   */
  setRecommendedMedia(
    groupId: string,
    mediaId: string,
    now: string = new Date().toISOString(),
  ): number {
    const info = this.setRecommendedMediaStmt.run(mediaId, now, groupId);
    return info.changes;
  }

  /**
   * P5.T7 `POST /api/duplicate-groups/:id/confirm`: atomically
   * confirm the user's pick for a duplicate group.
   *
   * Inside a single `db.transaction` we write three UPDATEs:
   *   1. duplicate_groups SET recommended_media_id=?, user_confirmed=1
   *   2. duplicate_group_items SET user_decision='keep', recommendation='keep'
   *      WHERE group_id=? AND media_id = recommendedMediaId
   *   3. duplicate_group_items SET user_decision='remove', recommendation='remove'
   *      WHERE group_id=? AND media_id != recommendedMediaId
   *
   * Any thrown error (constraint failure, foreign-key clash) rolls
   * the entire write back so a partial confirm can never leave the
   * group in a "header confirmed but items still undecided" state.
   *
   * Idempotency: a second call with the same recommendedMediaId
   * yields the same final state (keep stays keep, remove stays
   * remove); a call with a DIFFERENT mediaId on an already-confirmed
   * group flips the items accordingly — the user is allowed to
   * change their mind.
   *
   * Returns the number of rows affected on the group header (0 or 1).
   * 0 means the group was deleted mid-call; Service maps to 404.
   */
  confirmGroupRecommendation(
    groupId: string,
    recommendedMediaId: string,
    now: string = new Date().toISOString(),
  ): number {
    const tx = this.db.transaction((gid: string, mid: string, ts: string): number => {
      const header = this.confirmGroupHeaderStmt.run(mid, ts, gid);
      if (header.changes === 0) return 0;
      this.markItemKeepStmt.run(ts, gid, mid);
      this.markOtherItemsRemoveStmt.run(ts, gid, mid);
      return header.changes;
    });
    return tx(groupId, recommendedMediaId, now);
  }

  /**
   * P6.T5 (second half) Quality_Selector writeback: atomically apply
   * a system-derived recommendation to one duplicate group + each of
   * its items.
   *
   * Inside one `db.transaction`:
   *   1. duplicate_groups SET recommended_media_id, updated_at WHERE id
   *   2. for each (mediaId, {recommendation, reason}):
   *        duplicate_group_items SET recommendation, reason, updated_at
   *          WHERE group_id = ? AND media_id = ?
   *
   * Crucially differs from `confirmGroupRecommendation` in two ways:
   *   * Does NOT flip `user_confirmed` to 1. The caller is the
   *     Quality_Selector, not the user.
   *   * Does NOT touch `user_decision`. That column is the user's
   *     manual override (CLAUDE.md §3.9) and survives a re-rank.
   *
   * The caller MUST already have filtered out `user_confirmed=1`
   * groups (this method does not double-check) and MUST guarantee
   * every key in `perItemReasons` is an actual member of the group
   * (statement is a no-op for non-members; bad input becomes a
   * silently-ignored UPDATE).
   *
   * Returns the number of rows updated on the group header (0 if the
   * group vanished mid-transaction; otherwise 1).
   */
  applyRecommendation(args: {
    readonly groupId: string;
    readonly winnerMediaId: string;
    readonly perItemReasons: ReadonlyMap<
      string,
      { readonly recommendation: DuplicateDecision; readonly reason: string }
    >;
    readonly updatedAt: string;
  }): number {
    const tx = this.db.transaction(
      (
        gid: string,
        mid: string,
        perItem: ReadonlyMap<string, { recommendation: DuplicateDecision; reason: string }>,
        ts: string,
      ): number => {
        const header = this.setGroupRecommendedOnlyStmt.run(mid, ts, gid);
        if (header.changes === 0) return 0;
        for (const [mediaId, decision] of perItem.entries()) {
          this.setItemRecommendationStmt.run(
            decision.recommendation,
            decision.reason,
            ts,
            gid,
            mediaId,
          );
        }
        return header.changes;
      },
    );
    return tx(args.groupId, args.winnerMediaId, args.perItemReasons, args.updatedAt);
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
