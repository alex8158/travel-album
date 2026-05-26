// EditPlansRepository — data-access layer for the `edit_plans`
// table introduced in migration 015 (P11.T5).
//
// Scope:
//   * P11.T5 lands the schema + repository. The
//     `VideoEditPlanService` writes to it from the plan-generation
//     path; the render service / worker reads from it.
//   * No HTTP surface, no admin API — P11.T6+ may add CRUD around
//     plans if needed. V1 only exposes "create + read".
//
// Conventions:
//   * Prepared statements cached in the constructor.
//   * The JSON column is stored as-is (no normalisation) and
//     re-parsed on read. The repo is type-agnostic about the plan
//     shape; the Service layer owns the `VideoEditPlan` interface.

import type { SqliteDatabase } from "../db/connection.js";

/** Domain-shape view of an `edit_plans` row. */
export interface EditPlanRow {
  readonly id: string;
  readonly tripId: string;
  /** Raw JSON string of the persisted `VideoEditPlan`. The caller
   * `JSON.parse`s it; we don't return a typed plan here because
   * the repo is intentionally decoupled from the plan schema. */
  readonly planJson: string;
  readonly targetDurationSec: number;
  readonly style: string;
  readonly createdAt: string;
}

/** INSERT payload. The Service serialises the plan + extracts the
 * denormalised columns before calling. */
export interface EditPlanInsertData {
  readonly id: string;
  readonly tripId: string;
  readonly planJson: string;
  readonly targetDurationSec: number;
  readonly style: string;
  readonly now: string;
}

interface EditPlanDbRow {
  id: string;
  trip_id: string;
  plan_json: string;
  target_duration_sec: number;
  style: string;
  created_at: string;
}

const SELECT_COLUMNS = `
  id, trip_id, plan_json, target_duration_sec, style, created_at
`;

export class EditPlansRepository {
  private readonly insertStmt;
  private readonly findByIdStmt;
  private readonly findLatestByTripIdStmt;
  private readonly countByTripIdStmt;

  constructor(private readonly db: SqliteDatabase) {
    this.insertStmt = db.prepare(`
      INSERT INTO edit_plans (
        id, trip_id, plan_json, target_duration_sec, style, created_at
      ) VALUES (
        @id, @tripId, @planJson, @targetDurationSec, @style, @now
      )
    `);

    this.findByIdStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM edit_plans
      WHERE id = ?
    `);

    // "Latest plan for this trip" — drives the render endpoint's
    // fallback path. ORDER BY created_at DESC, id DESC keeps ties
    // deterministic.
    this.findLatestByTripIdStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM edit_plans
      WHERE trip_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `);

    this.countByTripIdStmt = db.prepare(`
      SELECT COUNT(*) AS n
      FROM edit_plans
      WHERE trip_id = ?
    `);
  }

  insert(data: EditPlanInsertData): void {
    this.insertStmt.run({
      id: data.id,
      tripId: data.tripId,
      planJson: data.planJson,
      targetDurationSec: data.targetDurationSec,
      style: data.style,
      now: data.now,
    });
  }

  findById(id: string): EditPlanRow | null {
    const row = this.findByIdStmt.get(id) as EditPlanDbRow | undefined;
    return row === undefined ? null : rowToView(row);
  }

  /** Returns the most-recently-created plan for the trip, or null
   * when the trip has no plans yet. The render endpoint's "no
   * planId" fallback. */
  findLatestByTripId(tripId: string): EditPlanRow | null {
    const row = this.findLatestByTripIdStmt.get(tripId) as EditPlanDbRow | undefined;
    return row === undefined ? null : rowToView(row);
  }

  countByTripId(tripId: string): number {
    return (this.countByTripIdStmt.get(tripId) as { n: number }).n;
  }
}

function rowToView(row: EditPlanDbRow): EditPlanRow {
  return {
    id: row.id,
    tripId: row.trip_id,
    planJson: row.plan_json,
    targetDurationSec: row.target_duration_sec,
    style: row.style,
    createdAt: row.created_at,
  };
}
