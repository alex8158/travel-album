// SceneGroupItemsRepository — data-access layer for the
// `scene_group_items` table introduced in migration 020 (P12.T2).
//
// Scope:
//   * P12.T2 lands the schema + repository + smoke. Writers will be
//     the P12.T4 scene_grouping worker; readers will be the
//     orchestrator (P12.T9) and the Curated tab front-end (P12.T11
//     via the `GET /api/trips/:tripId/scene-groups` endpoint).
//   * Repository exposes basic CRUD:
//       - insert(row)               — single-member insert
//       - insertMany(rows)          — bulk write within a transaction
//       - findById(id)
//       - listByGroup(groupId)      — ordered by rank_in_group
//       - listByMedia(mediaId)      — reverse lookup
//       - deleteByGroup(groupId)    — bulk delete (e.g. failed run
//                                     cleanup; in practice CASCADE
//                                     from scene_groups handles this)
//
// Note on transactions:
//   `insertMany` is wrapped in `db.transaction(...)`; design.md
//   §7.8.3 requires L2 to write scene_groups + scene_group_items
//   atomically. The caller is expected to nest both repositories'
//   writes inside the SAME outer transaction so a partial failure
//   rolls back BOTH tables.

import type { SqliteDatabase } from "../db/connection.js";

export interface SceneGroupItemView {
  readonly id: string;
  readonly sceneGroupId: string;
  readonly mediaId: string;
  readonly selectionRound: number;
  readonly groupScore: number | null;
  readonly similarityScore: number | null;
  readonly rankInGroup: number;
  readonly reason: string | null;
  readonly createdAt: string;
}

export interface SceneGroupItemInsertData {
  readonly id: string;
  readonly sceneGroupId: string;
  readonly mediaId: string;
  readonly selectionRound: number;
  readonly groupScore: number | null;
  readonly similarityScore: number | null;
  readonly rankInGroup: number;
  readonly reason: string | null;
}

interface SceneGroupItemRow {
  id: string;
  scene_group_id: string;
  media_id: string;
  selection_round: number;
  group_score: number | null;
  similarity_score: number | null;
  rank_in_group: number;
  reason: string | null;
  created_at: string;
}

const SELECT_COLUMNS = `
  id,
  scene_group_id,
  media_id,
  selection_round,
  group_score,
  similarity_score,
  rank_in_group,
  reason,
  created_at
`;

function rowToView(row: SceneGroupItemRow): SceneGroupItemView {
  return {
    id: row.id,
    sceneGroupId: row.scene_group_id,
    mediaId: row.media_id,
    selectionRound: row.selection_round,
    groupScore: row.group_score,
    similarityScore: row.similarity_score,
    rankInGroup: row.rank_in_group,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

export class SceneGroupItemsRepository {
  private readonly insertStmt;
  private readonly findByIdStmt;
  private readonly listByGroupStmt;
  private readonly listByMediaStmt;
  private readonly deleteByGroupStmt;
  private readonly insertManyTxn;

  constructor(private readonly db: SqliteDatabase) {
    this.insertStmt = db.prepare(`
      INSERT INTO scene_group_items (
        id, scene_group_id, media_id, selection_round,
        group_score, similarity_score, rank_in_group, reason
      ) VALUES (
        @id, @sceneGroupId, @mediaId, @selectionRound,
        @groupScore, @similarityScore, @rankInGroup, @reason
      )
    `);

    this.findByIdStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM scene_group_items
      WHERE id = ?
    `);

    // Ordered by rank_in_group ASC (0 = most-representative member
    // first). Matches the UI's typical "show me this group in order"
    // pattern.
    this.listByGroupStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM scene_group_items
      WHERE scene_group_id = ?
      ORDER BY rank_in_group ASC, id ASC
    `);

    // Reverse lookup: "every group containing this media". Used by
    // smoke + admin views; not a hot path.
    this.listByMediaStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM scene_group_items
      WHERE media_id = ?
      ORDER BY scene_group_id ASC, rank_in_group ASC
    `);

    this.deleteByGroupStmt = db.prepare(`
      DELETE FROM scene_group_items
      WHERE scene_group_id = ?
    `);

    // Bulk insert wrapped in a transaction. Caller passes a fully
    // prepared array; failure on any row rolls back ALL inserts in
    // this batch (matching design.md §7.8.3 "single transaction").
    this.insertManyTxn = db.transaction((items: SceneGroupItemInsertData[]) => {
      for (const it of items) {
        this.insertStmt.run({
          id: it.id,
          sceneGroupId: it.sceneGroupId,
          mediaId: it.mediaId,
          selectionRound: it.selectionRound,
          groupScore: it.groupScore,
          similarityScore: it.similarityScore,
          rankInGroup: it.rankInGroup,
          reason: it.reason,
        });
      }
    });
  }

  insert(data: SceneGroupItemInsertData): SceneGroupItemView {
    this.insertStmt.run({
      id: data.id,
      sceneGroupId: data.sceneGroupId,
      mediaId: data.mediaId,
      selectionRound: data.selectionRound,
      groupScore: data.groupScore,
      similarityScore: data.similarityScore,
      rankInGroup: data.rankInGroup,
      reason: data.reason,
    });
    const row = this.findByIdStmt.get(data.id) as SceneGroupItemRow | undefined;
    if (row === undefined) {
      throw new Error(
        `SceneGroupItemsRepository.insert: row vanished post-insert (id=${data.id})`,
      );
    }
    return rowToView(row);
  }

  /** Bulk insert in a single transaction. Pass a fully-prepared
   * array (the worker computed `id`, `rank_in_group` etc. up-front).
   * Returns the rows in input order. */
  insertMany(items: ReadonlyArray<SceneGroupItemInsertData>): SceneGroupItemView[] {
    if (items.length === 0) return [];
    this.insertManyTxn(items as SceneGroupItemInsertData[]);
    // Re-fetch in input order to return concrete views.
    return items.map((it) => {
      const row = this.findByIdStmt.get(it.id) as SceneGroupItemRow | undefined;
      if (row === undefined) {
        throw new Error(
          `SceneGroupItemsRepository.insertMany: row vanished post-insert (id=${it.id})`,
        );
      }
      return rowToView(row);
    });
  }

  findById(id: string): SceneGroupItemView | null {
    const row = this.findByIdStmt.get(id) as SceneGroupItemRow | undefined;
    return row ? rowToView(row) : null;
  }

  listByGroup(sceneGroupId: string): SceneGroupItemView[] {
    const rows = this.listByGroupStmt.all(sceneGroupId) as SceneGroupItemRow[];
    return rows.map(rowToView);
  }

  listByMedia(mediaId: string): SceneGroupItemView[] {
    const rows = this.listByMediaStmt.all(mediaId) as SceneGroupItemRow[];
    return rows.map(rowToView);
  }

  /** Returns the number of rows deleted. */
  deleteByGroup(sceneGroupId: string): number {
    const info = this.deleteByGroupStmt.run(sceneGroupId);
    return info.changes;
  }
}
