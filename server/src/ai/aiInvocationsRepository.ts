// AiInvocationsRepository — data-access layer for `ai_invocations`
// (migration 012, P10.T1 schema; producer P10.T4 enqueue path + future
// P10.T5 worker).
//
// Scope at P10.T4 (this commit):
//   * `insert` — write a `status='pending'` audit row at the moment
//     a fresh `image_ai_refine` job is enqueued (or a terminal-ish
//     one is reset). One ai_invocations row per attempt; the row
//     stays even after the parent media is hard-deleted (FK SET NULL
//     — see migration 012 header).
//   * `countSinceTimestamp(sinceIso)` — global daily quota counter.
//     Counts every row whose `created_at >= sinceIso`, regardless of
//     status. Includes failed attempts because the call WAS attempted
//     (cost may have been incurred — billing-safety > UX-niceness).
//   * `countByTripId(tripId)` — per-trip lifetime quota counter.
//     INNER JOINs media_items so orphaned rows (parent media
//     hard-deleted) naturally drop out — those calls cannot be
//     re-charged to a trip the operator no longer knows about.
//
// P10.T5 will add `markSuccess` / `markFailed` UPDATEs that flip the
// pending row's status + fill cost / duration / model_name / error.
// Those are NOT in scope here.
//
// All counts include every `request_type` value so the same quota
// envelope covers `ai_caption` / `ai_classify` / `aesthetic_score`
// when they land (no per-type quota in V1; if that becomes
// necessary, add request_type to the WHERE clause + a new config
// knob).

import type { SqliteDatabase } from "../db/connection.js";

import type { AIInvocationStatus, AIRequestType } from "./AIProvider.js";

/**
 * Minimum writer surface for {@link AiInvocationsRepository.insert}.
 * The P10.T4 enqueue path writes a `pending` audit row with provider
 * (known from the route's gate) + a placeholder `model_name` (P10.T5
 * worker UPDATEs the real one once it picks the model). `cost_estimate`
 * / `duration_ms` / `error_message` / `response_summary` are NULL at
 * insert time.
 */
export interface AiInvocationInsertData {
  readonly id: string;
  readonly mediaId: string | null;
  readonly jobId: string | null;
  readonly provider: string;
  readonly modelName: string;
  readonly requestType: AIRequestType;
  readonly status: AIInvocationStatus;
  readonly requestParams?: string | null;
  /** ISO-8601 timestamp; written into both `created_at` + `updated_at`. */
  readonly now: string;
}

/**
 * Read projection of one `ai_invocations` row. Mirrors every column
 * in migration 012. Only used by the future P10.T5 worker (to
 * UPDATE the row by id) and by tests / smokes (to assert that the
 * P10.T4 insert path wrote the expected shape).
 */
export interface AiInvocationRow {
  readonly id: string;
  readonly mediaId: string | null;
  readonly jobId: string | null;
  readonly provider: string;
  readonly modelName: string;
  readonly requestType: AIRequestType;
  readonly requestParams: string | null;
  readonly status: AIInvocationStatus;
  readonly responseSummary: string | null;
  readonly costEstimate: number | null;
  readonly durationMs: number | null;
  readonly errorMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface AiInvocationDbRow {
  id: string;
  media_id: string | null;
  job_id: string | null;
  provider: string;
  model_name: string;
  request_type: AIRequestType;
  request_params: string | null;
  status: AIInvocationStatus;
  response_summary: string | null;
  cost_estimate: number | null;
  duration_ms: number | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_COLUMNS = `
  id,
  media_id,
  job_id,
  provider,
  model_name,
  request_type,
  request_params,
  status,
  response_summary,
  cost_estimate,
  duration_ms,
  error_message,
  created_at,
  updated_at
`;

export class AiInvocationsRepository {
  private readonly insertStmt;
  private readonly countSinceStmt;
  private readonly countByTripIdStmt;
  private readonly findByIdStmt;

  constructor(private readonly db: SqliteDatabase) {
    // INSERT: media_id + job_id NULLABLE so audit rows can outlive
    // their parents (FK SET NULL); model_name is required (CHECK
    // non-blank), but the enqueue path writes a 'pending' placeholder
    // until the P10.T5 worker fills the real model.
    this.insertStmt = db.prepare(`
      INSERT INTO ai_invocations (
        id, media_id, job_id, provider, model_name, request_type,
        request_params, status, created_at, updated_at
      ) VALUES (
        @id, @mediaId, @jobId, @provider, @modelName, @requestType,
        @requestParams, @status, @now, @now
      )
    `);

    // Daily quota: total audit rows (across all media in the DB)
    // whose created_at is at-or-after the given timestamp. The route
    // layer hands us a since-iso = start-of-today (or any window
    // boundary it wants). ISO-8601 string ordering matches
    // chronological ordering (same as elsewhere in the codebase).
    this.countSinceStmt = db.prepare(`
      SELECT COUNT(*) AS n
      FROM ai_invocations
      WHERE created_at >= ?
    `);

    // Per-trip quota: INNER JOIN media_items so orphaned rows
    // (media_id NULL after media hard-delete) drop out. The trip's
    // lifetime quota is the total non-orphaned audit rows that
    // belong to media still in this trip.
    this.countByTripIdStmt = db.prepare(`
      SELECT COUNT(*) AS n
      FROM ai_invocations ai
      INNER JOIN media_items m ON ai.media_id = m.id
      WHERE m.trip_id = ?
    `);

    // Read-by-id powers tests / smokes / the future P10.T5 worker.
    this.findByIdStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM ai_invocations
      WHERE id = ?
    `);
  }

  /**
   * Write one `pending` audit row. Throws on PK collision, FK
   * violation (media_id / job_id references gone), CHECK failure
   * (unknown request_type / status, blank provider/model_name,
   * negative duration_ms — though P10.T4 only writes pending +
   * NULL duration so the duration check should never trip).
   */
  insert(data: AiInvocationInsertData): void {
    this.insertStmt.run({
      id: data.id,
      mediaId: data.mediaId,
      jobId: data.jobId,
      provider: data.provider,
      modelName: data.modelName,
      requestType: data.requestType,
      requestParams: data.requestParams ?? null,
      status: data.status,
      now: data.now,
    });
  }

  /**
   * Count audit rows created at-or-after the given ISO timestamp.
   * Used by the P10.T4 daily quota gate; the caller computes the
   * boundary (e.g. start-of-today in UTC) and passes it in.
   */
  countSinceTimestamp(sinceIso: string): number {
    const row = this.countSinceStmt.get(sinceIso) as { n: number };
    return row.n;
  }

  /**
   * Count audit rows belonging to media in the given trip.
   * Orphans (media hard-deleted, FK flipped to NULL) drop out.
   */
  countByTripId(tripId: string): number {
    const row = this.countByTripIdStmt.get(tripId) as { n: number };
    return row.n;
  }

  /**
   * Lookup one audit row by primary key. Returns `null` when
   * missing. Powers the future P10.T5 worker's "find my row by
   * the id I just got back from the service" pattern.
   */
  findById(id: string): AiInvocationRow | null {
    const row = this.findByIdStmt.get(id) as AiInvocationDbRow | undefined;
    if (row === undefined) return null;
    return rowToView(row);
  }
}

function rowToView(row: AiInvocationDbRow): AiInvocationRow {
  return {
    id: row.id,
    mediaId: row.media_id,
    jobId: row.job_id,
    provider: row.provider,
    modelName: row.model_name,
    requestType: row.request_type,
    requestParams: row.request_params,
    status: row.status,
    responseSummary: row.response_summary,
    costEstimate: row.cost_estimate,
    durationMs: row.duration_ms,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
