// CuratedSelectionsRepository — data-access layer for the
// `curated_selections` table introduced in migration 021 (P12.T2).
//
// Scope:
//   * P12.T2 lands the schema + repository + smoke. Writers are
//     P12.T6 (scene_best_pick — draft rows is_current=0), P12.T9
//     (curation_finalize — flips is_current=1; appends fallback
//     rows), and the override API (round=0 user pin / exclude).
//   * Repository exposes the minimum surface P12.T6 / P12.T9 /
//     P12.T11 (frontend) will need; advanced merge-formula logic
//     (aiCurrent ∪ userPins − userUnpins) is layered later as a
//     service method. The repository itself stays untyped about
//     "current curated set" — it's just rows in / rows out.
//
// Public methods:
//   * insert(row)                    — single-row write (AI draft or
//                                       user override)
//   * findById(id)
//   * findByTripRoundMedia(trip,r,m) — UNIQUE-key lookup
//   * listByTripRound(trip, round)   — single-round listing
//   * listByTripCurrent(trip)        — `is_current=1 AND included=1`
//                                       (AI layer only — does NOT
//                                       merge round=0; that's a
//                                       service-layer concern)
//   * listByTripOverrides(trip)      — round=0 rows
//   * countByTripRound
//   * markRoundCurrent(trip, round)  — flip is_current 1→0 on older
//                                       AI rounds + 0→1 on this round
//                                       (used by P12.T9 finalize)
//   * updateRefinementParams(id, j)  — set refinement_params JSON
//   * upsertOverride(trip,m,decision) — UPSERT round=0 row
//   * deleteOverrideByTripMedia       — single-row clear (Clear pin)
//   * deleteOverridesByTrip           — batch clear (Reset overrides)

import type { SqliteDatabase } from "../db/connection.js";

/** Closed enum mirroring `user_decision` CHECK. NULL is also valid
 * (for round>=1 AI rows). */
export type CuratedUserDecision = "kept" | "excluded";

/** Domain view of a single `curated_selections` row. */
export interface CuratedSelectionView {
  readonly id: string;
  readonly tripId: string;
  readonly mediaId: string;
  readonly sceneGroupId: string | null;
  readonly selectionRound: number;
  readonly included: 0 | 1;
  readonly isCurrent: 0 | 1;
  readonly reason: string | null;
  readonly aiConfidence: number | null;
  /** JSON-encoded; the repository does not parse to keep schema
   * boundaries clean. Callers decode/encode as needed. */
  readonly refinementParams: string | null;
  readonly userDecision: CuratedUserDecision | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** AI-draft / AI-final / Code-fallback row insert (round >= 1).
 * Must NOT set `userDecision`. */
export interface CuratedSelectionAiInsert {
  readonly id: string;
  readonly tripId: string;
  readonly mediaId: string;
  readonly sceneGroupId: string | null;
  readonly selectionRound: number;
  readonly included: 0 | 1;
  readonly isCurrent?: 0 | 1;
  readonly reason: string | null;
  readonly aiConfidence: number | null;
  readonly refinementParams: string | null;
}

interface CuratedSelectionRow {
  id: string;
  trip_id: string;
  media_id: string;
  scene_group_id: string | null;
  selection_round: number;
  included: 0 | 1;
  is_current: 0 | 1;
  reason: string | null;
  ai_confidence: number | null;
  refinement_params: string | null;
  user_decision: CuratedUserDecision | null;
  created_at: string;
  updated_at: string;
}

const SELECT_COLUMNS = `
  id,
  trip_id,
  media_id,
  scene_group_id,
  selection_round,
  included,
  is_current,
  reason,
  ai_confidence,
  refinement_params,
  user_decision,
  created_at,
  updated_at
`;

function rowToView(row: CuratedSelectionRow): CuratedSelectionView {
  return {
    id: row.id,
    tripId: row.trip_id,
    mediaId: row.media_id,
    sceneGroupId: row.scene_group_id,
    selectionRound: row.selection_round,
    included: row.included,
    isCurrent: row.is_current,
    reason: row.reason,
    aiConfidence: row.ai_confidence,
    refinementParams: row.refinement_params,
    userDecision: row.user_decision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CuratedSelectionsRepository {
  private readonly insertAiStmt;
  private readonly findByIdStmt;
  private readonly findByTripRoundMediaStmt;
  private readonly listByTripRoundStmt;
  private readonly listByTripCurrentStmt;
  private readonly listByTripOverridesStmt;
  private readonly countByTripRoundStmt;
  private readonly markRoundCurrentSetCurrentStmt;
  private readonly markRoundCurrentClearOlderStmt;
  private readonly updateRefinementParamsStmt;
  private readonly upsertOverrideStmt;
  private readonly deleteOverrideByTripMediaStmt;
  private readonly deleteOverridesByTripStmt;
  /** P12.T6 — scene_best_pick worker's idempotency primitive. */
  private readonly deleteDraftsForGroupStmt;
  private readonly markRoundCurrentTxn;

  constructor(private readonly db: SqliteDatabase) {
    // AI draft / AI final / Code fallback insert (round >= 1, no
    // user_decision). round=0 rows go through `upsertOverride`.
    this.insertAiStmt = db.prepare(`
      INSERT INTO curated_selections (
        id, trip_id, media_id, scene_group_id,
        selection_round, included, is_current,
        reason, ai_confidence, refinement_params,
        user_decision
      ) VALUES (
        @id, @tripId, @mediaId, @sceneGroupId,
        @selectionRound, @included, @isCurrent,
        @reason, @aiConfidence, @refinementParams,
        NULL
      )
    `);

    this.findByIdStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM curated_selections
      WHERE id = ?
    `);

    this.findByTripRoundMediaStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM curated_selections
      WHERE trip_id = ? AND selection_round = ? AND media_id = ?
    `);

    // Ordered by media_id for deterministic UI / smoke output;
    // a smarter order (by scene_group + rank) is the service
    // layer's job.
    this.listByTripRoundStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM curated_selections
      WHERE trip_id = ? AND selection_round = ?
      ORDER BY media_id ASC, id ASC
    `);

    // AI current-set retrieval (does NOT merge round=0 — that's
    // the service-layer's `getCurrentCuratedMediaIds` job per
    // §7.8.4). Backed by the (trip_id, is_current, included)
    // index.
    this.listByTripCurrentStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM curated_selections
      WHERE trip_id = ? AND is_current = 1 AND included = 1
      ORDER BY media_id ASC, id ASC
    `);

    // Round=0 user-override layer only.
    this.listByTripOverridesStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM curated_selections
      WHERE trip_id = ? AND selection_round = 0
      ORDER BY media_id ASC, id ASC
    `);

    this.countByTripRoundStmt = db.prepare(`
      SELECT COUNT(*) AS n
      FROM curated_selections
      WHERE trip_id = ? AND selection_round = ?
    `);

    // P12.T9 finalize: flip is_current=1→0 on every round of this
    // trip that is NOT the new round, then flip 0→1 on the new
    // round. Two separate statements wrapped in a transaction so
    // either both apply or neither does.
    this.markRoundCurrentClearOlderStmt = db.prepare(`
      UPDATE curated_selections
         SET is_current = 0,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE trip_id = ?
         AND selection_round <> ?
         AND selection_round > 0
         AND is_current = 1
    `);

    this.markRoundCurrentSetCurrentStmt = db.prepare(`
      UPDATE curated_selections
         SET is_current = 1,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE trip_id = ?
         AND selection_round = ?
         AND selection_round > 0
    `);

    this.markRoundCurrentTxn = db.transaction(
      (tripId: string, round: number): { cleared: number; set: number } => {
        const cleared = this.markRoundCurrentClearOlderStmt.run(tripId, round).changes;
        const set = this.markRoundCurrentSetCurrentStmt.run(tripId, round).changes;
        return { cleared, set };
      },
    );

    this.updateRefinementParamsStmt = db.prepare(`
      UPDATE curated_selections
         SET refinement_params = @refinementParams,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = @id
    `);

    // Round=0 override UPSERT. The SQL CHECK
    // `curated_selections_round0_requires_decision` enforces
    // user_decision NOT NULL when selection_round=0; we satisfy
    // that here. Also forces is_current=0 (the round=0 layer
    // never carries the AI's is_current flag — design.md §7.8.4).
    //
    // ON CONFLICT(trip_id, selection_round, media_id) DO UPDATE
    // matches the UNIQUE index. We refresh user_decision +
    // updated_at; reason is set to a stable "user override"
    // marker (overwritten on every pin/unpin so the latest action
    // is always reflected).
    this.upsertOverrideStmt = db.prepare(`
      INSERT INTO curated_selections (
        id, trip_id, media_id, scene_group_id,
        selection_round, included, is_current,
        reason, ai_confidence, refinement_params,
        user_decision
      ) VALUES (
        @id, @tripId, @mediaId, NULL,
        0,
        CASE WHEN @userDecision = 'kept' THEN 1 ELSE 0 END,
        0,
        'user override: ' || @userDecision,
        NULL, NULL, @userDecision
      )
      ON CONFLICT(trip_id, selection_round, media_id) DO UPDATE
        SET user_decision = excluded.user_decision,
            included = CASE WHEN excluded.user_decision = 'kept' THEN 1 ELSE 0 END,
            reason = excluded.reason,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `);

    this.deleteOverrideByTripMediaStmt = db.prepare(`
      DELETE FROM curated_selections
       WHERE trip_id = ? AND selection_round = 0 AND media_id = ?
    `);

    this.deleteOverridesByTripStmt = db.prepare(`
      DELETE FROM curated_selections
       WHERE trip_id = ? AND selection_round = 0
    `);

    // P12.T6 — scene_best_pick draft cleanup. Used by the worker for
    // idempotent re-run: before INSERTing the new draft rows for a
    // (trip, round, scene_group) tuple, the worker DELETEs any prior
    // draft rows so the second run does not collide with the
    // `(trip_id, selection_round, media_id)` UNIQUE index.
    //
    // Three predicates are deliberately layered:
    //   * `selection_round = ?` AND `selection_round > 0` — never
    //     touch the round=0 user-override layer (CLAUDE.md §3.9
    //     red line; design.md §7.8.4).
    //   * `scene_group_id = ?` — never touch other groups in the
    //     same round.
    //   * `user_decision IS NULL` — defence-in-depth: only AI / Code
    //     rows are draftable. A row that somehow carries a
    //     user_decision (would violate the layer-discipline CHECK,
    //     but we still guard at the writer) is preserved.
    this.deleteDraftsForGroupStmt = db.prepare(`
      DELETE FROM curated_selections
       WHERE trip_id = ?
         AND selection_round = ?
         AND selection_round > 0
         AND scene_group_id = ?
         AND user_decision IS NULL
    `);
  }

  /** Insert an AI-layer row (round >= 1). user_decision is forced
   * to NULL by the SQL. */
  insertAi(data: CuratedSelectionAiInsert): CuratedSelectionView {
    if (data.selectionRound <= 0) {
      throw new Error(
        `CuratedSelectionsRepository.insertAi: selectionRound must be >= 1 (got ${data.selectionRound})`,
      );
    }
    this.insertAiStmt.run({
      id: data.id,
      tripId: data.tripId,
      mediaId: data.mediaId,
      sceneGroupId: data.sceneGroupId,
      selectionRound: data.selectionRound,
      included: data.included,
      isCurrent: data.isCurrent ?? 0,
      reason: data.reason,
      aiConfidence: data.aiConfidence,
      refinementParams: data.refinementParams,
    });
    const row = this.findByIdStmt.get(data.id) as CuratedSelectionRow | undefined;
    if (row === undefined) {
      throw new Error(
        `CuratedSelectionsRepository.insertAi: row vanished post-insert (id=${data.id})`,
      );
    }
    return rowToView(row);
  }

  findById(id: string): CuratedSelectionView | null {
    const row = this.findByIdStmt.get(id) as CuratedSelectionRow | undefined;
    return row ? rowToView(row) : null;
  }

  findByTripRoundMedia(
    tripId: string,
    selectionRound: number,
    mediaId: string,
  ): CuratedSelectionView | null {
    const row = this.findByTripRoundMediaStmt.get(tripId, selectionRound, mediaId) as
      | CuratedSelectionRow
      | undefined;
    return row ? rowToView(row) : null;
  }

  listByTripRound(tripId: string, selectionRound: number): CuratedSelectionView[] {
    const rows = this.listByTripRoundStmt.all(tripId, selectionRound) as CuratedSelectionRow[];
    return rows.map(rowToView);
  }

  /** AI current set only (is_current=1 AND included=1). Round=0
   * user overrides are returned via `listByTripOverrides` separately;
   * the service layer composes them via §7.8.4 formula. */
  listByTripCurrent(tripId: string): CuratedSelectionView[] {
    const rows = this.listByTripCurrentStmt.all(tripId) as CuratedSelectionRow[];
    return rows.map(rowToView);
  }

  listByTripOverrides(tripId: string): CuratedSelectionView[] {
    const rows = this.listByTripOverridesStmt.all(tripId) as CuratedSelectionRow[];
    return rows.map(rowToView);
  }

  countByTripRound(tripId: string, selectionRound: number): number {
    const row = this.countByTripRoundStmt.get(tripId, selectionRound) as { n: number };
    return row.n;
  }

  /** Atomically flip is_current: older AI rounds → 0, new round → 1.
   * Returns the row counts. Throws if newRound <= 0. */
  markRoundCurrent(tripId: string, newRound: number): { cleared: number; set: number } {
    if (newRound <= 0) {
      throw new Error(
        `CuratedSelectionsRepository.markRoundCurrent: newRound must be >= 1 (got ${newRound})`,
      );
    }
    return this.markRoundCurrentTxn(tripId, newRound);
  }

  updateRefinementParams(id: string, refinementParams: string | null): number {
    const info = this.updateRefinementParamsStmt.run({ id, refinementParams });
    return info.changes;
  }

  /** Insert / update the round=0 user-override row for this (trip,
   * media). Returns the resulting view. */
  upsertOverride(
    id: string,
    tripId: string,
    mediaId: string,
    userDecision: CuratedUserDecision,
  ): CuratedSelectionView {
    this.upsertOverrideStmt.run({
      id,
      tripId,
      mediaId,
      userDecision,
    });
    const row = this.findByTripRoundMediaStmt.get(tripId, 0, mediaId) as
      | CuratedSelectionRow
      | undefined;
    if (row === undefined) {
      throw new Error(
        `CuratedSelectionsRepository.upsertOverride: row vanished post-upsert (trip=${tripId} media=${mediaId})`,
      );
    }
    return rowToView(row);
  }

  /** Single-row override clear. Returns 1 if the row existed, 0
   * otherwise. */
  deleteOverrideByTripMedia(tripId: string, mediaId: string): number {
    const info = this.deleteOverrideByTripMediaStmt.run(tripId, mediaId);
    return info.changes;
  }

  /** Batch override clear (Reset overrides). Returns the row count. */
  deleteOverridesByTrip(tripId: string): number {
    const info = this.deleteOverridesByTripStmt.run(tripId);
    return info.changes;
  }

  /**
   * P12.T6 — delete every AI-draft row for one (trip, round, scene
   * group) tuple. The DELETE is scoped so the round=0 user-override
   * layer and the rows of other scene groups in the same round are
   * never touched. Returns the number of rows deleted.
   *
   * `selectionRound` must be >= 1 (round=0 is the user-override layer
   * and is not reachable here by SQL anyway — the WHERE clause
   * enforces `selection_round > 0`).
   */
  deleteDraftsForGroup(
    tripId: string,
    selectionRound: number,
    sceneGroupId: string,
  ): number {
    if (selectionRound <= 0) {
      throw new Error(
        `CuratedSelectionsRepository.deleteDraftsForGroup: selectionRound must be >= 1 (got ${selectionRound})`,
      );
    }
    const info = this.deleteDraftsForGroupStmt.run(tripId, selectionRound, sceneGroupId);
    return info.changes;
  }
}
