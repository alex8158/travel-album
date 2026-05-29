// SceneGroupsRepository — data-access layer for the `scene_groups`
// table introduced in migration 019 (P12.T2).
//
// Scope:
//   * P12.T2 lands the schema + repository + smoke. No worker /
//     service layer — those are P12.T4 (scene_grouping worker) and
//     P12.T9 (curation orchestrator).
//   * The repository exposes a typed surface for the basic
//     create / query / update operations the future worker layer
//     will need:
//       - insert(row)          — single-group insert
//       - findById(id)         — primary-key lookup
//       - listByTripRound      — "all groups for trip T round N"
//       - listByTrip           — "all groups for trip T (any round)"
//       - countByTripRound     — quick count for orchestrator
//       - updateMemberCount    — set member_count after items written
//       - updateRepresentative — set representative_media_id later
//
// Group MEMBERS are stored in `scene_group_items` and accessed via
// `SceneGroupItemsRepository` (sibling file in this directory).
//
// Conventions:
//   * Every prepared statement is constructed once in the
//     constructor and cached.
//   * Row → domain mapping happens in one place (`rowToView`) so
//     consumers always see camelCase typed shapes.
//   * No service-layer logic here (no quality_score sorting, no
//     algorithm dispatch) — purely data access.

import type { SqliteDatabase } from "../db/connection.js";

/** Domain view of a single `scene_groups` row. Field names are
 * camelCase mirrors of the schema columns; the SQL → domain
 * mapping happens in `rowToView`. */
export interface SceneGroupView {
  readonly id: string;
  readonly tripId: string;
  readonly selectionRound: number;
  readonly groupIndex: number;
  readonly capturedAtStart: string | null;
  readonly capturedAtEnd: string | null;
  readonly gpsCenterLat: number | null;
  readonly gpsCenterLon: number | null;
  readonly representativeMediaId: string | null;
  readonly memberCount: number;
  readonly algorithmVersion: string;
  readonly createdAt: string;
}

/** Insert shape — every column except defaults (member_count: 0,
 * created_at: now). `representativeMediaId` is nullable on insert
 * because the worker may decide on it AFTER inserting members. */
export interface SceneGroupInsertData {
  readonly id: string;
  readonly tripId: string;
  readonly selectionRound: number;
  readonly groupIndex: number;
  readonly capturedAtStart: string | null;
  readonly capturedAtEnd: string | null;
  readonly gpsCenterLat: number | null;
  readonly gpsCenterLon: number | null;
  readonly representativeMediaId: string | null;
  readonly memberCount?: number;
  readonly algorithmVersion: string;
}

interface SceneGroupRow {
  id: string;
  trip_id: string;
  selection_round: number;
  group_index: number;
  captured_at_start: string | null;
  captured_at_end: string | null;
  gps_center_lat: number | null;
  gps_center_lon: number | null;
  representative_media_id: string | null;
  member_count: number;
  algorithm_version: string;
  created_at: string;
}

const SELECT_COLUMNS = `
  id,
  trip_id,
  selection_round,
  group_index,
  captured_at_start,
  captured_at_end,
  gps_center_lat,
  gps_center_lon,
  representative_media_id,
  member_count,
  algorithm_version,
  created_at
`;

function rowToView(row: SceneGroupRow): SceneGroupView {
  return {
    id: row.id,
    tripId: row.trip_id,
    selectionRound: row.selection_round,
    groupIndex: row.group_index,
    capturedAtStart: row.captured_at_start,
    capturedAtEnd: row.captured_at_end,
    gpsCenterLat: row.gps_center_lat,
    gpsCenterLon: row.gps_center_lon,
    representativeMediaId: row.representative_media_id,
    memberCount: row.member_count,
    algorithmVersion: row.algorithm_version,
    createdAt: row.created_at,
  };
}

export class SceneGroupsRepository {
  private readonly insertStmt;
  private readonly findByIdStmt;
  private readonly listByTripRoundStmt;
  private readonly listByTripStmt;
  private readonly countByTripRoundStmt;
  private readonly updateMemberCountStmt;
  private readonly updateRepresentativeStmt;

  constructor(private readonly db: SqliteDatabase) {
    this.insertStmt = db.prepare(`
      INSERT INTO scene_groups (
        id, trip_id, selection_round, group_index,
        captured_at_start, captured_at_end,
        gps_center_lat, gps_center_lon,
        representative_media_id, member_count, algorithm_version
      ) VALUES (
        @id, @tripId, @selectionRound, @groupIndex,
        @capturedAtStart, @capturedAtEnd,
        @gpsCenterLat, @gpsCenterLon,
        @representativeMediaId, @memberCount, @algorithmVersion
      )
    `);

    this.findByIdStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM scene_groups
      WHERE id = ?
    `);

    // Ordered by group_index ASC for deterministic UI / smoke output.
    this.listByTripRoundStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM scene_groups
      WHERE trip_id = ? AND selection_round = ?
      ORDER BY group_index ASC, id ASC
    `);

    // All rounds for this trip — newest round first, then groups in
    // index order. Useful for "show me history" admin views.
    this.listByTripStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM scene_groups
      WHERE trip_id = ?
      ORDER BY selection_round DESC, group_index ASC, id ASC
    `);

    this.countByTripRoundStmt = db.prepare(`
      SELECT COUNT(*) AS n
      FROM scene_groups
      WHERE trip_id = ? AND selection_round = ?
    `);

    this.updateMemberCountStmt = db.prepare(`
      UPDATE scene_groups
         SET member_count = @memberCount
       WHERE id = @id
    `);

    this.updateRepresentativeStmt = db.prepare(`
      UPDATE scene_groups
         SET representative_media_id = @representativeMediaId
       WHERE id = @id
    `);
  }

  /** Insert a new scene_groups row. Returns the inserted view. */
  insert(data: SceneGroupInsertData): SceneGroupView {
    this.insertStmt.run({
      id: data.id,
      tripId: data.tripId,
      selectionRound: data.selectionRound,
      groupIndex: data.groupIndex,
      capturedAtStart: data.capturedAtStart,
      capturedAtEnd: data.capturedAtEnd,
      gpsCenterLat: data.gpsCenterLat,
      gpsCenterLon: data.gpsCenterLon,
      representativeMediaId: data.representativeMediaId,
      memberCount: data.memberCount ?? 0,
      algorithmVersion: data.algorithmVersion,
    });
    const row = this.findByIdStmt.get(data.id) as SceneGroupRow | undefined;
    if (row === undefined) {
      throw new Error(`SceneGroupsRepository.insert: row vanished post-insert (id=${data.id})`);
    }
    return rowToView(row);
  }

  findById(id: string): SceneGroupView | null {
    const row = this.findByIdStmt.get(id) as SceneGroupRow | undefined;
    return row ? rowToView(row) : null;
  }

  listByTripRound(tripId: string, selectionRound: number): SceneGroupView[] {
    const rows = this.listByTripRoundStmt.all(tripId, selectionRound) as SceneGroupRow[];
    return rows.map(rowToView);
  }

  listByTrip(tripId: string): SceneGroupView[] {
    const rows = this.listByTripStmt.all(tripId) as SceneGroupRow[];
    return rows.map(rowToView);
  }

  countByTripRound(tripId: string, selectionRound: number): number {
    const row = this.countByTripRoundStmt.get(tripId, selectionRound) as { n: number };
    return row.n;
  }

  /** Update member_count after the items table has been populated.
   * Returns the number of rows affected (1 if the group existed,
   * 0 otherwise). */
  updateMemberCount(id: string, memberCount: number): number {
    if (memberCount < 0) {
      throw new Error(
        `SceneGroupsRepository.updateMemberCount: memberCount must be >= 0 (got ${memberCount})`,
      );
    }
    const info = this.updateMemberCountStmt.run({ id, memberCount });
    return info.changes;
  }

  /** Update the representative_media_id after the worker has picked
   * a cover photo. NULL is allowed (e.g. on rep soft-delete). */
  updateRepresentative(id: string, representativeMediaId: string | null): number {
    const info = this.updateRepresentativeStmt.run({ id, representativeMediaId });
    return info.changes;
  }
}
