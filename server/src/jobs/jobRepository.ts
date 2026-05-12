// JobRepository — data-access layer for `processing_jobs`.
//
// Scope:
//   * P2.T4 added `insert` for Upload_Manager.
//   * P3.T2 adds the minimum read / state-transition surface the
//     image-channel executor (R-36 stub) needs: claim one pending
//     `image_*` job, mark it `success` or `failed`.
//   * Everything else — retry, cancel, zombie recovery, channel
//     splitting, the Job API — stays for P4.T1+.
//
// Transitions are guarded by `WHERE status='<expected>'` predicates so
// a bug that called `markSuccess` on a non-running row simply returns
// `changes=0` rather than violating the CLAUDE.md §4.3 transition
// graph. The executor logs and continues on `changes=0`.

import type { SqliteDatabase } from "../db/connection.js";
import type { JobInsertData, JobStatus, ProcessingJob } from "./jobTypes.js";

const DEFAULT_STATUS = "pending";

/**
 * Raw row shape returned by `SELECT ... FROM processing_jobs`. Maps
 * to camelCase via `rowToJob` on the way out.
 */
interface JobRow {
  id: string;
  media_id: string;
  job_type: string;
  status: JobStatus;
  progress: number;
  error_message: string | null;
  retry_count: number;
  payload: string | null;
  next_run_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_COLUMNS = `
  id,
  media_id,
  job_type,
  status,
  progress,
  error_message,
  retry_count,
  payload,
  next_run_at,
  started_at,
  finished_at,
  created_at,
  updated_at
`;

/**
 * Outcome of `claimNextPendingImageJob`. The executor branches on this
 * to distinguish "nothing to do" from "claimed but lost the race"
 * (the latter is not expected in the P3 stub which has no parallel
 * claimers, but the API leaves room for P4.T1).
 */
export interface JobClaimResult {
  readonly job: ProcessingJob | null;
}

export class JobRepository {
  private readonly insertStmt;
  private readonly findByIdStmt;
  private readonly findLatestByMediaAndTypeStmt;
  private readonly selectNextPendingImageStmt;
  private readonly claimStmt;
  private readonly markSuccessStmt;
  private readonly markFailedStmt;
  private readonly resetToPendingStmt;

  constructor(private readonly db: SqliteDatabase) {
    this.insertStmt = db.prepare(`
      INSERT INTO processing_jobs (
        id, media_id, job_type, status, payload,
        created_at, updated_at
      ) VALUES (
        @id, @mediaId, @jobType, @status, @payload,
        @createdAt, @updatedAt
      )
    `);

    this.findByIdStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM processing_jobs
      WHERE id = ?
    `);

    // Pick the most-recently-created job row for a given media + type
    // pair (used by reprocess in P3.T7 to decide whether to skip /
    // reset / create). UNIQUE doesn't apply here (multiple historical
    // rows for the same media+type are legal); we want the freshest.
    this.findLatestByMediaAndTypeStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM processing_jobs
      WHERE media_id = ? AND job_type = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `);

    // Pick the oldest pending image-channel job. `LIKE 'image_%'`
    // intentionally matches both `image_thumbnail` (P3.T4) and
    // `image_metadata` (P3.T5), and any future image_* type, without
    // hard-coding the closed set. Video / AI / generic channels stay
    // unclaimed — those are P4 / future work.
    this.selectNextPendingImageStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM processing_jobs
      WHERE status = 'pending' AND job_type LIKE 'image\\_%' ESCAPE '\\'
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `);

    // pending → running. The `AND status = 'pending'` predicate makes
    // the transition idempotent under concurrent claimers: if someone
    // beat us to the row, our UPDATE finds 0 rows and the executor
    // moves on.
    this.claimStmt = db.prepare(`
      UPDATE processing_jobs
      SET status = 'running', started_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'
    `);

    // running → success. Guarded so a stray call from outside the
    // executor cannot drop a non-running row straight to success.
    this.markSuccessStmt = db.prepare(`
      UPDATE processing_jobs
      SET status = 'success', finished_at = ?, updated_at = ?, error_message = NULL
      WHERE id = ? AND status = 'running'
    `);

    // running → failed. Same guard.
    this.markFailedStmt = db.prepare(`
      UPDATE processing_jobs
      SET status = 'failed', error_message = ?, finished_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running'
    `);

    // P3.T7 reprocess support: reset a terminal-ish row back to
    // `pending` so the executor picks it up next tick.
    //
    // The WHERE clause is the entire "non-active" closed set
    // (failed / success / retrying / cancelled). pending / running
    // rows are intentionally NOT matched — reprocess at the Service
    // layer already branches them to "skipped" before getting here.
    //
    // NOTE on the state-machine: CLAUDE.md §4.3 reserves the proper
    // `failed → retrying → running` path. This `→ pending` direct
    // flip is a deliberate P3.T7 stub; P4.T2 will replace it with
    // the full retry / backoff state machine. The behaviour is
    // user-spec'd for the stub.
    this.resetToPendingStmt = db.prepare(`
      UPDATE processing_jobs
      SET status = 'pending',
          error_message = NULL,
          started_at = NULL,
          finished_at = NULL,
          updated_at = ?
      WHERE id = ?
        AND status IN ('failed', 'success', 'retrying', 'cancelled')
    `);
  }

  /**
   * Persist a brand-new processing_jobs row. Throws on PK collision,
   * FK violation (media_id missing), or CHECK failure
   * (status not in enum / job_type blank / etc.). UploadService treats
   * any throw as "this upload didn't make it past the DB" and triggers
   * the compensating remove of the original file.
   */
  insert(data: JobInsertData): void {
    this.insertStmt.run({
      id: data.id,
      mediaId: data.mediaId,
      jobType: data.jobType,
      status: data.status ?? DEFAULT_STATUS,
      payload: data.payload ?? null,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    });
  }

  /** Fetch a job by id, regardless of status. */
  findById(id: string): ProcessingJob | null {
    const row = this.findByIdStmt.get(id) as JobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  /**
   * Atomically claim the oldest pending image-channel job:
   *   1. SELECT one pending image_* row.
   *   2. UPDATE WHERE id=? AND status='pending'. The predicate makes
   *      the flip-to-running race-safe.
   *   3. Return the row as it now is (status='running', started_at set).
   *
   * `null` covers all three "nothing to do" cases:
   *   * no pending image_* jobs exist
   *   * the row was flipped by someone else between (1) and (2)
   *   * the post-claim re-read returns nothing (vanishingly rare)
   */
  claimNextPendingImageJob(now: string = nowIso()): ProcessingJob | null {
    const candidate = this.selectNextPendingImageStmt.get() as JobRow | undefined;
    if (!candidate) return null;
    const info = this.claimStmt.run(now, now, candidate.id);
    if (info.changes === 0) {
      return null;
    }
    const updated = this.findByIdStmt.get(candidate.id) as JobRow | undefined;
    return updated ? rowToJob(updated) : null;
  }

  /**
   * Transition `running → success`. Returns the number of rows
   * touched (0 means the row was not in `running` and nothing was
   * changed — the executor logs that as an unexpected condition but
   * does not throw).
   */
  markSuccess(jobId: string, finishedAt: string = nowIso()): number {
    const info = this.markSuccessStmt.run(finishedAt, finishedAt, jobId);
    return info.changes;
  }

  /**
   * Transition `running → failed`, recording the human-readable error
   * message. Same `changes=0` semantics as `markSuccess`.
   */
  markFailed(jobId: string, errorMessage: string, finishedAt: string = nowIso()): number {
    const info = this.markFailedStmt.run(errorMessage, finishedAt, finishedAt, jobId);
    return info.changes;
  }

  /**
   * Find the most-recently-created job row for a given
   * (media_id, job_type) pair. Returns `null` when no row exists.
   * Used by reprocess (P3.T7) to decide create / reset / skip.
   */
  findLatestByMediaIdAndType(mediaId: string, jobType: string): ProcessingJob | null {
    const row = this.findLatestByMediaAndTypeStmt.get(mediaId, jobType) as JobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  /**
   * P3.T7 reprocess: flip a terminal row back to `pending` so the
   * executor (P3.T2) re-picks it up. The SQL guard restricts the
   * source statuses to {failed, success, retrying, cancelled} —
   * pending / running rows are deliberately not matched (the Service
   * layer takes the "already active, skip" branch before reaching
   * this call). Returns the number of rows touched (0 when nothing
   * was eligible, e.g. lost race with the executor flipping to
   * running concurrently).
   */
  resetToPending(jobId: string, now: string = nowIso()): number {
    const info = this.resetToPendingStmt.run(now, jobId);
    return info.changes;
  }
}

function rowToJob(row: JobRow): ProcessingJob {
  return {
    id: row.id,
    mediaId: row.media_id,
    jobType: row.job_type,
    status: row.status,
    progress: row.progress,
    errorMessage: row.error_message,
    retryCount: row.retry_count,
    payload: row.payload,
    nextRunAt: row.next_run_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}
