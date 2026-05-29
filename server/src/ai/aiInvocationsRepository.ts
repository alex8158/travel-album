// AiInvocationsRepository — data-access layer for `ai_invocations`
// (migration 012, P10.T1 schema; producer P10.T4 enqueue path +
// worker P10.T5 state transitions).
//
// Public surface:
//   * `insert` — write a `status='pending'` audit row at the moment
//     a fresh `image_ai_refine` job is enqueued (or a terminal-ish
//     one is reset). One ai_invocations row per attempt; the row
//     stays even after the parent media is hard-deleted (FK SET NULL
//     — see migration 012 header).
//   * `countSinceTimestamp(sinceIso)` — global daily quota counter.
//   * `countByTripId(tripId)` — per-trip lifetime quota counter.
//     INNER JOINs media_items so orphaned rows drop out — those
//     calls cannot be re-charged to a trip the operator no longer
//     knows about.
//   * `findById(id)` — lookup by primary key.
//   * `findPendingByJobId(jobId)` — the P10.T5 worker's "what
//     audit row should I be processing?" lookup. Returns the most
//     recent pending row keyed to the job id (P10.T4 idempotency
//     guarantees at most one row in `pending` state per job_id at
//     any moment, so the "most recent" is informational not
//     ambiguous).
//   * `markSuccess(args)` — flip `pending → success` + fill
//     `model_name` / `cost_estimate` / `duration_ms` /
//     `response_summary` from the provider's response. The
//     `WHERE status='pending'` predicate is the audit-row claim:
//     in a parallel-worker scenario, only the first writer wins
//     and subsequent ones see `changes=0`. This eliminates the
//     need for a separate `running` intermediate state (which the
//     migration 012 CHECK enum doesn't allow anyway — the schema
//     constrains status to {'pending','success','failed'}). For
//     channel-concurrency=1 production setups this is moot, but
//     the predicate is defence-in-depth for future
//     multi-worker rollouts.
//   * `markFailed(args)` — flip `pending → failed` + fill
//     `error_message` / `duration_ms`. Same atomic-claim
//     semantics as markSuccess.
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
 * Argument shape for {@link AiInvocationsRepository.markSuccess}.
 * Fields mirror the columns the P10.T5 worker fills after a
 * successful provider call. `responseSummary` is optional because
 * not all providers return a short summary.
 */
export interface AiInvocationMarkSuccessArgs {
  readonly id: string;
  readonly modelName: string;
  readonly costEstimate: number | null;
  readonly durationMs: number;
  readonly responseSummary?: string | null;
  readonly now: string;
}

/**
 * Argument shape for {@link AiInvocationsRepository.markFailed}.
 * `durationMs` is nullable — a "could not start" failure (e.g.
 * provider unavailable before the network round-trip) has no
 * meaningful duration.
 */
export interface AiInvocationMarkFailedArgs {
  readonly id: string;
  readonly errorMessage: string;
  readonly durationMs?: number | null;
  readonly now: string;
}

/**
 * P12.T5 — writer for ai_invocations rows that participate in the P12
 * curated-album pipeline. Mirrors {@link AiInvocationInsertData} but
 * also writes the four columns added in migration 024 (P12.T3):
 *   * `trip_id`     — denormalised trip ownership (FK SET NULL)
 *   * `target_type` — closed enum {media,trip,audio,composition,
 *                     slideshow,scene_group}
 *   * `target_id`   — table-PK of the target (e.g. media_id when
 *                     target_type='media', scene_group_id when
 *                     target_type='scene_group')
 *   * `input_hash`  — SHA256 of the AI input bytes + key params;
 *                     drives the partial-UNIQUE cost-cache index
 *                     `(trip_id, request_type, target_type, target_id,
 *                       input_hash) WHERE status='success'`
 *
 * The legacy {@link AiInvocationsRepository.insert} stays untouched so
 * P10 workers (which were written before P12.T3 added these columns)
 * keep compiling. New P12 workers use this method.
 *
 * All four new columns are nullable except `target_type` (NOT NULL,
 * DEFAULT 'media'). Callers SHOULD pass an `inputHash` to participate
 * in the cost cache; passing NULL means "this row is not cacheable".
 *
 * `model_name` may be a placeholder at write time (the same pattern as
 * the legacy `insert` for `pending` rows); successful calls overwrite
 * it via {@link AiInvocationsRepository.markSuccess}.
 */
export interface AiInvocationInsertWithTargetsData {
  readonly id: string;
  readonly mediaId: string | null;
  readonly tripId: string | null;
  readonly jobId: string | null;
  readonly provider: string;
  readonly modelName: string;
  readonly requestType: AIRequestType;
  /** Closed enum mirrored from the migration 024 CHECK. */
  readonly targetType:
    | "media"
    | "trip"
    | "audio"
    | "composition"
    | "slideshow"
    | "scene_group";
  readonly targetId: string | null;
  readonly inputHash: string | null;
  readonly status: AIInvocationStatus;
  readonly requestParams?: string | null;
  readonly responseSummary?: string | null;
  readonly costEstimate?: number | null;
  readonly durationMs?: number | null;
  readonly errorMessage?: string | null;
  /** ISO-8601 timestamp written into both `created_at` + `updated_at`. */
  readonly now: string;
}

/**
 * Lookup key for the P12 cost-cache. Mirrors the partial UNIQUE
 * `(trip_id, request_type, target_type, target_id, input_hash)
 *  WHERE status='success'` declared in migration 024.
 *
 * Callers pass the same tuple they would write on a fresh row; when a
 * match exists the worker reuses it and skips the AI call (saving the
 * quota + cost).
 */
export interface AiInvocationCacheLookup {
  readonly tripId: string | null;
  readonly requestType: AIRequestType;
  readonly targetType:
    | "media"
    | "trip"
    | "audio"
    | "composition"
    | "slideshow"
    | "scene_group";
  readonly targetId: string | null;
  readonly inputHash: string;
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
  private readonly findPendingByJobIdStmt;
  private readonly markSuccessStmt;
  private readonly markFailedStmt;
  // P12.T5 — writers/readers for the curated-album pipeline. Built
  // alongside the legacy P10 statements; the legacy `insert` stays
  // bit-identical so P10 workers compile unchanged.
  private readonly insertWithTargetsStmt;
  private readonly findCachedSuccessStmt;

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

    // Read-by-id powers tests / smokes / the P10.T5 worker's
    // "find my row by the id I just got back from the service".
    this.findByIdStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM ai_invocations
      WHERE id = ?
    `);

    // P10.T5: when the worker claims a `image_ai_refine` job from
    // the queue, it needs the matching audit row to write progress
    // into. P10.T4 idempotency guarantees ≤ 1 pending row per
    // job_id at any moment; `ORDER BY created_at DESC LIMIT 1`
    // is defensive (would still pick the latest one if the
    // invariant ever broke).
    this.findPendingByJobIdStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM ai_invocations
      WHERE job_id = ? AND status = 'pending'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `);

    // `pending → success` + fill the provider-supplied audit
    // columns. The `WHERE status='pending'` predicate is the
    // atomic claim — only the first writer flips the row to a
    // terminal state, subsequent attempts see changes=0 and the
    // caller treats that as a race. (The migration 012 CHECK
    // enum constrains status to {pending,success,failed}; no
    // `running` intermediate exists in V1.)
    this.markSuccessStmt = db.prepare(`
      UPDATE ai_invocations
      SET status = 'success',
          model_name = @modelName,
          cost_estimate = @costEstimate,
          duration_ms = @durationMs,
          response_summary = @responseSummary,
          error_message = NULL,
          updated_at = @now
      WHERE id = @id AND status = 'pending'
    `);

    // `pending → failed` + record the error.
    this.markFailedStmt = db.prepare(`
      UPDATE ai_invocations
      SET status = 'failed',
          error_message = @errorMessage,
          duration_ms = @durationMs,
          updated_at = @now
      WHERE id = @id AND status = 'pending'
    `);

    // P12.T5 — write a row covering the four new columns added by
    // migration 024 (trip_id / target_type / target_id / input_hash)
    // plus the optional terminal-state columns (response_summary /
    // cost_estimate / duration_ms / error_message) so the caller can
    // write success / failed rows in one statement. This is the new
    // canonical writer for the curated-album pipeline; the legacy
    // {@link insertStmt} is kept for P10 callers.
    this.insertWithTargetsStmt = db.prepare(`
      INSERT INTO ai_invocations (
        id, media_id, trip_id, job_id,
        provider, model_name, request_type,
        target_type, target_id, input_hash,
        request_params, response_summary,
        cost_estimate, duration_ms, error_message,
        status, created_at, updated_at
      ) VALUES (
        @id, @mediaId, @tripId, @jobId,
        @provider, @modelName, @requestType,
        @targetType, @targetId, @inputHash,
        @requestParams, @responseSummary,
        @costEstimate, @durationMs, @errorMessage,
        @status, @now, @now
      )
    `);

    // P12.T5 — cost-cache lookup. Mirrors the partial UNIQUE declared
    // in migration 024:
    //   `(trip_id, request_type, target_type, target_id, input_hash)
    //    WHERE status='success'`
    //
    // Returns the most-recent matching row, or NULL when no success
    // row matches. The partial UNIQUE guarantees AT MOST one row
    // matches; ORDER BY + LIMIT 1 is defensive. We treat NULL inputs
    // as their SQL-NULL counterparts via `IS @bound` matching, but
    // input_hash is NOT NULL by interface contract (cache lookup is
    // only meaningful when the worker computed an input hash).
    this.findCachedSuccessStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM ai_invocations
      WHERE status = 'success'
        AND request_type = @requestType
        AND target_type = @targetType
        AND input_hash = @inputHash
        AND (
          (trip_id IS NULL AND @tripId IS NULL)
          OR trip_id = @tripId
        )
        AND (
          (target_id IS NULL AND @targetId IS NULL)
          OR target_id = @targetId
        )
      ORDER BY created_at DESC, id DESC
      LIMIT 1
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

  /**
   * P10.T5 — find the pending audit row keyed to a given job id.
   * Returns `null` when there is no pending row (e.g. the prior
   * attempt already failed and no fresh enqueue happened — the
   * worker treats this as "no audit row to consume" and fails
   * the job rather than fabricating one, per P10.T5 prompt
   * "只消费 status='pending' 的 audit row").
   */
  findPendingByJobId(jobId: string): AiInvocationRow | null {
    const row = this.findPendingByJobIdStmt.get(jobId) as AiInvocationDbRow | undefined;
    if (row === undefined) return null;
    return rowToView(row);
  }

  /**
   * Atomic-claim flip `pending → success` + fill audit columns.
   * Returns the number of rows changed (1 = ok, 0 = wrong state
   * — e.g. row was already marked terminal by a parallel writer,
   * or never existed in 'pending' to begin with).
   */
  markSuccess(args: AiInvocationMarkSuccessArgs): number {
    const info = this.markSuccessStmt.run({
      id: args.id,
      modelName: args.modelName,
      costEstimate: args.costEstimate,
      durationMs: args.durationMs,
      responseSummary: args.responseSummary ?? null,
      now: args.now,
    });
    return info.changes;
  }

  /**
   * Atomic-claim flip `pending → failed` + fill error_message.
   * Returns the number of rows changed. Idempotent-friendly:
   * calling on an already-failed row is a no-op (returns 0).
   */
  markFailed(args: AiInvocationMarkFailedArgs): number {
    const info = this.markFailedStmt.run({
      id: args.id,
      errorMessage: args.errorMessage,
      durationMs: args.durationMs ?? null,
      now: args.now,
    });
    return info.changes;
  }

  /**
   * P12.T5 — write one audit row using the full P12 column set added
   * by migration 024 (trip_id / target_type / target_id / input_hash)
   * plus the optional terminal-state columns. The caller decides
   * whether to write `pending` (then `markSuccess` / `markFailed`
   * later) or a fully-formed terminal row in one shot.
   *
   * Throws on:
   *   * UNIQUE violation of the partial cost-cache index when status
   *     is 'success' and a matching tuple already exists (this is
   *     why the caller should run {@link findSuccessfulCached} first).
   *   * CHECK failure (unknown target_type, blank model_name, etc.).
   *   * FK failure (trip_id no longer exists; media_id no longer
   *     exists; job_id no longer exists).
   */
  insertWithTargets(data: AiInvocationInsertWithTargetsData): void {
    this.insertWithTargetsStmt.run({
      id: data.id,
      mediaId: data.mediaId,
      tripId: data.tripId,
      jobId: data.jobId,
      provider: data.provider,
      modelName: data.modelName,
      requestType: data.requestType,
      targetType: data.targetType,
      targetId: data.targetId,
      inputHash: data.inputHash,
      requestParams: data.requestParams ?? null,
      responseSummary: data.responseSummary ?? null,
      costEstimate: data.costEstimate ?? null,
      durationMs: data.durationMs ?? null,
      errorMessage: data.errorMessage ?? null,
      status: data.status,
      now: data.now,
    });
  }

  /**
   * P12.T5 — find the previously-successful audit row matching the
   * cost-cache key tuple. Returns `null` when no match exists; the
   * partial UNIQUE on `(trip_id, request_type, target_type, target_id,
   * input_hash) WHERE status='success'` guarantees AT MOST one match.
   *
   * The caller uses this BEFORE calling `aiProvider.invoke` so a
   * deterministic re-run for the same input bytes skips the second
   * AI call and reuses the prior verdict (saving quota + cost). The
   * media_analysis write that wrote the verdict last time is already
   * persisted on disk so the worker simply returns "cache_hit" and
   * exits.
   */
  findSuccessfulCached(args: AiInvocationCacheLookup): AiInvocationRow | null {
    const row = this.findCachedSuccessStmt.get({
      tripId: args.tripId,
      requestType: args.requestType,
      targetType: args.targetType,
      targetId: args.targetId,
      inputHash: args.inputHash,
    }) as AiInvocationDbRow | undefined;
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
