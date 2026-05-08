// TripRepository: data-access layer for the trips table (P1.T2).
//
// The repository:
//   - prepares all read statements once at construction time;
//   - hides the snake_case <-> camelCase mapping from callers;
//   - enforces "WHERE deleted_at IS NULL" on every default read path;
//   - never throws AppError. Missing rows surface as `null` / `false`
//     so the caller (TripService) decides how to translate to an HTTP-
//     facing error.
//
// `update` builds its SQL dynamically because we need to discriminate
// "key absent → keep current value" from "key present → write the
// passed value". With better-sqlite3's prepare() being cheap, the
// per-call prepare cost is acceptable for the first version.

import type { SqliteDatabase } from "../db/connection.js";
import type { ListTripsOptions, Trip, TripCreateData, TripUpdateData } from "./tripTypes.js";

/** Internal raw row shape — column names match the trips table schema. */
interface TripRow {
  id: string;
  title: string;
  description: string | null;
  destination: string | null;
  start_date: string | null;
  end_date: string | null;
  cover_media_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const DEFAULT_LIMIT = 50;

const SELECT_COLUMNS = `
  id,
  title,
  description,
  destination,
  start_date,
  end_date,
  cover_media_id,
  created_at,
  updated_at,
  deleted_at
`;

export class TripRepository {
  private readonly insertStmt;
  private readonly findByIdActiveStmt;
  private readonly findByIdAnyStmt;
  private readonly listActiveStmt;
  private readonly listAllStmt;
  private readonly softDeleteStmt;

  constructor(private readonly db: SqliteDatabase) {
    this.insertStmt = db.prepare(`
      INSERT INTO trips (
        id, title, description, destination,
        start_date, end_date, cover_media_id,
        created_at, updated_at
      ) VALUES (
        @id, @title, @description, @destination,
        @startDate, @endDate, @coverMediaId,
        @createdAt, @updatedAt
      )
    `);

    this.findByIdActiveStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM trips
      WHERE id = ? AND deleted_at IS NULL
    `);

    this.findByIdAnyStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM trips
      WHERE id = ?
    `);

    this.listActiveStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM trips
      WHERE deleted_at IS NULL
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `);

    this.listAllStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM trips
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `);

    this.softDeleteStmt = db.prepare(`
      UPDATE trips
      SET deleted_at = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL
    `);
  }

  /**
   * Persist a brand-new trip. The caller (TripService) is responsible
   * for picking the id, the timestamps, and ensuring nullability of
   * the optional columns. Throws on PRIMARY KEY collision (already
   * exists) or CHECK violation (e.g. title becomes blank somehow).
   */
  create(data: TripCreateData): Trip {
    this.insertStmt.run({
      id: data.id,
      title: data.title,
      description: data.description,
      destination: data.destination,
      startDate: data.startDate,
      endDate: data.endDate,
      coverMediaId: data.coverMediaId,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    });
    const trip = this.findByIdAny(data.id);
    if (!trip) {
      // Inserted rows must always be findable; getting null here would
      // imply a concurrent delete + replace. Fail loudly so the caller
      // does not return a half-truth.
      throw new Error(`trips: row vanished immediately after insert (id=${data.id})`);
    }
    return trip;
  }

  /** Active rows only (deleted_at IS NULL). */
  findById(id: string): Trip | null {
    const row = this.findByIdActiveStmt.get(id) as TripRow | undefined;
    return row ? rowToTrip(row) : null;
  }

  /** Includes soft-deleted rows. Reserved for restore / admin paths. */
  findByIdAny(id: string): Trip | null {
    const row = this.findByIdAnyStmt.get(id) as TripRow | undefined;
    return row ? rowToTrip(row) : null;
  }

  list(options: ListTripsOptions = {}): Trip[] {
    const limit = options.limit ?? DEFAULT_LIMIT;
    const offset = options.offset ?? 0;
    const stmt = options.includeDeleted ? this.listAllStmt : this.listActiveStmt;
    const rows = stmt.all(limit, offset) as TripRow[];
    return rows.map(rowToTrip);
  }

  /**
   * Apply a partial update. Returns the refreshed Trip on success, or
   * null if no active trip with the given id exists.
   *
   * `updated_at` is always refreshed, even if `patch` is empty — calling
   * update with no fields is treated as "touch this row" and is fine.
   */
  update(id: string, patch: TripUpdateData, updatedAt: string): Trip | null {
    const setClauses: string[] = [];
    const params: Record<string, unknown> = { id, updatedAt };

    if (patch.title !== undefined) {
      setClauses.push("title = @title");
      params.title = patch.title;
    }
    if (patch.description !== undefined) {
      setClauses.push("description = @description");
      params.description = patch.description;
    }
    if (patch.destination !== undefined) {
      setClauses.push("destination = @destination");
      params.destination = patch.destination;
    }
    if (patch.startDate !== undefined) {
      setClauses.push("start_date = @startDate");
      params.startDate = patch.startDate;
    }
    if (patch.endDate !== undefined) {
      setClauses.push("end_date = @endDate");
      params.endDate = patch.endDate;
    }
    if (patch.coverMediaId !== undefined) {
      setClauses.push("cover_media_id = @coverMediaId");
      params.coverMediaId = patch.coverMediaId;
    }

    setClauses.push("updated_at = @updatedAt");

    const sql = `
      UPDATE trips
      SET ${setClauses.join(", ")}
      WHERE id = @id AND deleted_at IS NULL
    `;

    const info = this.db.prepare(sql).run(params);
    if (info.changes === 0) {
      return null;
    }
    return this.findById(id);
  }

  /**
   * Mark the row as soft-deleted by setting deleted_at. Returns true
   * iff exactly one active row was flipped. False covers both "id
   * does not exist" and "already soft-deleted" — both look identical
   * to default queries, and TripService treats them the same.
   */
  softDelete(id: string, deletedAt: string): boolean {
    const info = this.softDeleteStmt.run(deletedAt, deletedAt, id);
    return info.changes > 0;
  }
}

function rowToTrip(row: TripRow): Trip {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    destination: row.destination,
    startDate: row.start_date,
    endDate: row.end_date,
    coverMediaId: row.cover_media_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}
