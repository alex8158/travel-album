// JobRepository — data-access layer for `processing_jobs`.
//
// Scope:
//   * P2.T4 added `insert` for Upload_Manager.
//   * P3.T2 added the minimum read / state-transition surface the
//     image-channel executor (R-36 stub) needs: claim one pending
//     `image_*` job, mark it `success` or `failed`.
//   * P3.T7 added `resetToPending` (since replaced by
//     `resetToRetrying` in P4.T2) and findLatestByMediaIdAndType.
//   * P4.T1 added `claimNextPendingByJobTypes` for the multi-channel
//     JobQueue scheduler.
//   * P4.T2 adds the failure-retry surface:
//       - `markRetrying`: running → retrying with retry_count bump
//         + next_run_at backoff target,
//       - `resetToRetrying`: terminal → retrying (R-40 fix — the
//         §4.3-canonical reprocess entry point),
//       - claim SELECTs now also pick up retrying rows whose
//         `next_run_at` has elapsed.
//   * P4.T3 adds zombie scanning:
//       - `findZombieRunningJobs`: returns `running` rows whose
//         `started_at` is older than the caller-supplied cutoff
//         (used by JobQueue.recoverZombies at start() time).
//   * P4.T4 adds the read / cancel surface backing the public
//     Job API (`GET /api/jobs[/:id]`, `POST /api/jobs/:id/cancel`):
//       - `findJobView`: `findById` + LEFT JOIN media_items.trip_id,
//       - `listJobs`: filtered + paginated list with the same JOIN,
//       - `cancelJob`: pending / retrying / running → cancelled.
//   * P4.T5 syncs `media_items.status` from the aggregate of job
//     statuses at every transition (claim / success / fail / retry
//     / cancel / reset). The sync is a side-effect of the repo's
//     mutating methods so every code path (JobQueue, JobService,
//     MediaService.reprocess, ImageChannelExecutor) gets it for
//     free. See `syncMediaStatusByMediaId` for the derivation rules.
//
// Transitions are guarded by `WHERE status='<expected>'` predicates so
// a bug that called `markSuccess` on a non-running row simply returns
// `changes=0` rather than violating the CLAUDE.md §4.3 transition
// graph. The executor logs and continues on `changes=0`.

import type { SqliteDatabase } from "../db/connection.js";
import type { JobInsertData, JobStatus, JobView, ProcessingJob } from "./jobTypes.js";

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

// P4.T4: same columns prefixed with `j.` so they coexist with a
// JOIN'd `media_items` (aliased `m`) without column-name collisions
// on `id` / `media_id` / `created_at` / etc.
const SELECT_COLUMNS_PREFIXED = `
  j.id,
  j.media_id,
  j.job_type,
  j.status,
  j.progress,
  j.error_message,
  j.retry_count,
  j.payload,
  j.next_run_at,
  j.started_at,
  j.finished_at,
  j.created_at,
  j.updated_at
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

/**
 * P4.T4: filter shape for `JobRepository.listJobs`. All keys are
 * optional. The Service layer is responsible for HTTP-level
 * validation (caps, enum membership) before passing this in. The
 * repository simply translates each present key into a single
 * `AND col = ?` predicate.
 */
export interface JobListFilter {
  readonly status?: JobStatus;
  readonly jobType?: string;
  readonly mediaId?: string;
  readonly tripId?: string;
  readonly limit: number;
  readonly offset: number;
}

/**
 * Raw row shape of a `processing_jobs` row JOIN'd with
 * `media_items.trip_id`. `trip_id` is `null` only when the media row
 * is missing (LEFT JOIN — defensive; ON DELETE CASCADE means a
 * surviving job row should always have a corresponding media).
 */
interface JobViewRow extends JobRow {
  trip_id: string | null;
}

export class JobRepository {
  private readonly insertStmt;
  private readonly findByIdStmt;
  private readonly findLatestByMediaAndTypeStmt;
  private readonly findActiveByTypeStmt;
  private readonly selectNextPendingImageStmt;
  private readonly claimStmt;
  private readonly markSuccessStmt;
  private readonly markFailedStmt;
  private readonly markRetryingStmt;
  private readonly resetToRetryingStmt;
  private readonly findZombieRunningJobsStmt;
  private readonly findJobViewByIdStmt;
  private readonly cancelJobStmt;
  // P4.T5 — media status sync helpers
  private readonly statusCountsByMediaStmt;
  private readonly applyMediaStatusStmt;
  private readonly lookupMediaIdForJobStmt;

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

    // P11.T6 — "any active row of this type" for the audio-library
    // delete in-use check. "Active" here is the closed set
    // {pending, running, retrying} — terminal rows (success /
    // failed / cancelled) don't block the delete because the
    // render they describe is already done (success: file already
    // produced) or won't run (failed / cancelled). LIMIT 256 is a
    // paranoid upper bound; under normal queue conditions there
    // are typically <10 active rows of any one job_type.
    this.findActiveByTypeStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM processing_jobs
      WHERE job_type = ? AND status IN ('pending', 'running', 'retrying')
      ORDER BY created_at ASC, id ASC
      LIMIT 256
    `);

    // Pick the oldest claimable image-channel job. P4.T2 expanded
    // the SELECT to include retrying rows whose `next_run_at` is due:
    //   * status = 'pending'  (untried or freshly enqueued / reset)
    //   * OR status = 'retrying' AND next_run_at IS NULL OR <= now
    //                         (back-off elapsed; ready for re-claim)
    // Time comparison uses ISO-8601 strings, which sort
    // lexicographically the same as chronologically.
    this.selectNextPendingImageStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM processing_jobs
      WHERE job_type LIKE 'image\\_%' ESCAPE '\\'
        AND (
          status = 'pending'
          OR (status = 'retrying' AND (next_run_at IS NULL OR next_run_at <= ?))
        )
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `);

    // Flip pending OR retrying → running. The `status IN (...)`
    // predicate keeps the transition race-safe: if a parallel
    // claimer already grabbed the row, our UPDATE sees `changes=0`
    // and the caller treats that as "nothing claimed". `next_run_at`
    // is cleared on claim so a stale value doesn't linger past a
    // successful retry.
    this.claimStmt = db.prepare(`
      UPDATE processing_jobs
      SET status = 'running',
          started_at = ?,
          updated_at = ?,
          next_run_at = NULL
      WHERE id = ? AND status IN ('pending', 'retrying')
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

    // P4.T2: running → retrying. The catch path in JobQueue calls
    // this when the handler threw and the retry budget is not
    // exhausted. We:
    //   * record the human-readable error_message,
    //   * bump retry_count to the caller-supplied "new count",
    //   * stash the backoff target in next_run_at (the SELECT branch
    //     above gates re-claim on it),
    //   * clear started_at / finished_at so the next attempt looks
    //     pristine in the Job API.
    // Guard `status = 'running'` keeps the transition race-safe:
    // a stray markRetrying on a non-running row sees `changes=0`
    // and the caller logs / continues.
    this.markRetryingStmt = db.prepare(`
      UPDATE processing_jobs
      SET status = 'retrying',
          error_message = ?,
          retry_count = ?,
          next_run_at = ?,
          started_at = NULL,
          finished_at = NULL,
          updated_at = ?
      WHERE id = ? AND status = 'running'
    `);

    // P4.T2 R-40 fix: reprocess now routes terminal rows through
    // `retrying` (the §4.3-canonical re-entry point) rather than
    // direct → `pending`. retry_count is reset to 0 (user-driven
    // reprocess is "start over", not "continue the existing retry
    // budget"); next_run_at is the caller-supplied wall-clock time
    // (typically now-ish — the executor will pick it up next tick).
    //
    // WHERE clause matches the same closed set as the old
    // resetToPendingStmt: failed / success / retrying / cancelled.
    // pending / running rows are deliberately not matched — the
    // Service layer already branches them to "skipped" or "active".
    this.resetToRetryingStmt = db.prepare(`
      UPDATE processing_jobs
      SET status = 'retrying',
          error_message = NULL,
          retry_count = 0,
          next_run_at = ?,
          started_at = NULL,
          finished_at = NULL,
          updated_at = ?
      WHERE id = ?
        AND status IN ('failed', 'success', 'retrying', 'cancelled')
    `);

    // P4.T3 zombie scan: list every row stuck in `running` whose
    // `started_at` is at or before the caller-supplied cutoff. A
    // NULL `started_at` is treated as "ancient" so it gets recovered
    // too — that combination shouldn't occur (claim always sets
    // started_at), but if a manual UPDATE or a future code path
    // skipped it, we'd rather recover than leak the row.
    //
    // ORDER BY started_at ASC NULLS-FIRST (SQLite's default NULL
    // ordering in ASC) so the oldest zombies surface first — gives
    // logs deterministic ordering when multiple are queued.
    this.findZombieRunningJobsStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM processing_jobs
      WHERE status = 'running'
        AND (started_at IS NULL OR started_at <= ?)
      ORDER BY started_at ASC, id ASC
    `);

    // P4.T4 single job + trip_id projection for the public Job API.
    // LEFT JOIN so a job whose media row was hard-deleted (would
    // require disabling FK / direct SQL) still returns; trip_id ends
    // up NULL in that pathological case.
    this.findJobViewByIdStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS_PREFIXED},
             m.trip_id AS trip_id
      FROM processing_jobs j
      LEFT JOIN media_items m ON m.id = j.media_id
      WHERE j.id = ?
    `);

    // P4.T4 cancel: pending / retrying / running → cancelled. The
    // `running` branch deliberately does NOT kill the in-flight
    // handler — when the handler later tries markSuccess /
    // markFailed / markRetrying, those guards (`WHERE status =
    // 'running'`) fail and the cancellation persists. `finished_at`
    // is set so the lifecycle has a definitive endpoint.
    this.cancelJobStmt = db.prepare(`
      UPDATE processing_jobs
      SET status = 'cancelled',
          finished_at = ?,
          updated_at = ?
      WHERE id = ?
        AND status IN ('pending', 'retrying', 'running')
    `);

    // P4.T5 media-status sync. Three statements, each tiny:
    //   * statusCountsByMediaStmt: aggregate counts of jobs per
    //     status for a single media. Fed into `syncMediaStatusByMediaId`
    //     to derive the target media status.
    //   * applyMediaStatusStmt: write the derived status onto the
    //     media row. The WHERE clause protects soft-deleted +
    //     archived rows and is a no-op when the target == current
    //     (saves a write).
    //   * lookupMediaIdForJobStmt: cheap "give me the media_id for
    //     this job" lookup so methods that take only a jobId can
    //     still drive the sync.
    this.statusCountsByMediaStmt = db.prepare(`
      SELECT status, COUNT(*) AS n
      FROM processing_jobs
      WHERE media_id = ?
      GROUP BY status
    `);
    this.applyMediaStatusStmt = db.prepare(`
      UPDATE media_items
      SET status = ?, updated_at = ?
      WHERE id = ?
        AND deleted_at IS NULL
        AND status NOT IN ('archived', 'deleted')
        AND status != ?
    `);
    this.lookupMediaIdForJobStmt = db.prepare(`
      SELECT media_id AS media_id FROM processing_jobs WHERE id = ?
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
   *
   * Retained for backward compatibility with the P3.T2
   * `ImageChannelExecutor` stub (and its smokes). The new
   * `claimNextPendingByJobTypes` (P4.T1) generalises this to any
   * channel's handler set.
   */
  claimNextPendingImageJob(now: string = nowIso()): ProcessingJob | null {
    // P4.T2: SELECT now also matches `retrying` rows whose
    // `next_run_at` has elapsed. `now` is bound twice — once for
    // the next_run_at <= ? comparison in the SELECT, once for
    // started_at / updated_at in the UPDATE.
    const candidate = this.selectNextPendingImageStmt.get(now) as JobRow | undefined;
    if (!candidate) return null;
    const info = this.claimStmt.run(now, now, candidate.id);
    if (info.changes === 0) {
      return null;
    }
    const updated = this.findByIdStmt.get(candidate.id) as JobRow | undefined;
    if (!updated) return null;
    // P4.T5: claim flipped the row pending/retrying → running, so
    // the owning media transitions uploaded/processing → processing.
    this.syncMediaStatusByMediaId(updated.media_id, now);
    return rowToJob(updated);
  }

  /**
   * Generalised claim used by the P4.T1 JobQueue. Each channel
   * passes the closed list of job_type strings it has handlers
   * registered for; we SELECT the oldest pending row whose job_type
   * is in that set and flip it to `running` race-safely.
   *
   * Empty `jobTypes` returns null immediately — a channel with no
   * handlers should never claim, full stop. Otherwise the semantics
   * mirror `claimNextPendingImageJob`:
   *   * `null` when nothing eligible exists OR we lost a race.
   *   * Returns the row in its new `running` state on success.
   *
   * Implementation detail: SQLite has no `ANY (?)` placeholder for
   * dynamic-length IN-lists, so the SELECT is prepared per call
   * with the right number of placeholders. The cost (~6 prepares/s
   * across 3 channels at 1.5 s poll interval) is negligible vs. the
   * IO of a real handler. The UPDATE re-uses `claimStmt`.
   */
  claimNextPendingByJobTypes(
    jobTypes: readonly string[],
    now: string = nowIso(),
  ): ProcessingJob | null {
    if (jobTypes.length === 0) return null;
    const placeholders = jobTypes.map(() => "?").join(", ");
    // P4.T2: the channel-aware SELECT mirrors selectNextPendingImageStmt:
    //   * pending rows are always claimable,
    //   * retrying rows are claimable iff next_run_at has elapsed
    //     (or is NULL, which means "no backoff was scheduled").
    // ISO-8601 lexicographic compare = chronological compare.
    const selectStmt = this.db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM processing_jobs
      WHERE job_type IN (${placeholders})
        AND (
          status = 'pending'
          OR (status = 'retrying' AND (next_run_at IS NULL OR next_run_at <= ?))
        )
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `);
    const candidate = selectStmt.get(...jobTypes, now) as JobRow | undefined;
    if (!candidate) return null;
    const info = this.claimStmt.run(now, now, candidate.id);
    if (info.changes === 0) return null;
    const updated = this.findByIdStmt.get(candidate.id) as JobRow | undefined;
    if (!updated) return null;
    // P4.T5: see claimNextPendingImageJob for rationale.
    this.syncMediaStatusByMediaId(updated.media_id, now);
    return rowToJob(updated);
  }

  /**
   * Transition `running → success`. Returns the number of rows
   * touched (0 means the row was not in `running` and nothing was
   * changed — the executor logs that as an unexpected condition but
   * does not throw).
   */
  markSuccess(jobId: string, finishedAt: string = nowIso()): number {
    const info = this.markSuccessStmt.run(finishedAt, finishedAt, jobId);
    if (info.changes > 0) this.syncMediaStatusForJob(jobId, finishedAt);
    return info.changes;
  }

  /**
   * Transition `running → failed`, recording the human-readable error
   * message. Same `changes=0` semantics as `markSuccess`.
   */
  markFailed(jobId: string, errorMessage: string, finishedAt: string = nowIso()): number {
    const info = this.markFailedStmt.run(errorMessage, finishedAt, finishedAt, jobId);
    if (info.changes > 0) this.syncMediaStatusForJob(jobId, finishedAt);
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
   * P11.T6 — return every "active" (pending / running / retrying)
   * job of a given type. Used by the audio-library DELETE path
   * (`AudioLibraryService.deleteAudio`) to detect whether the
   * row about to be removed is referenced by an in-progress
   * render — refusing the delete in that case prevents a
   * mid-render file-disappearance failure.
   *
   * Bounded by the JobQueue's concurrency + retry policy in
   * normal operation (typically <10 active rows of any one type
   * at any moment); a `LIMIT 256` is added defensively so a
   * pathological state can't make this scan unbounded.
   */
  findActiveByType(jobType: string): ProcessingJob[] {
    const rows = this.findActiveByTypeStmt.all(jobType) as JobRow[];
    return rows.map(rowToJob);
  }

  /**
   * P4.T2: `running → retrying`. Called by JobQueue's catch path
   * when the handler threw and the retry budget still has slack.
   *
   * Parameters:
   *   * `errorMessage` — human-readable error from the throw site,
   *     persisted to `error_message` (overwrites any previous value).
   *   * `nextRunAt` — ISO-8601 wall-clock time before which the
   *     row is NOT eligible for re-claim. The caller computes this
   *     from the exponential-backoff formula.
   *   * `newRetryCount` — the post-increment value (caller passes
   *     `job.retryCount + 1`). The repository doesn't compute it
   *     to keep this layer dumb / transparent.
   *
   * Returns the number of rows touched. 0 means the row was not in
   * `running` at the moment of UPDATE (rare — implies someone
   * already transitioned it). Caller logs and continues.
   */
  markRetrying(
    jobId: string,
    errorMessage: string,
    nextRunAt: string,
    newRetryCount: number,
    now: string = nowIso(),
  ): number {
    const info = this.markRetryingStmt.run(errorMessage, newRetryCount, nextRunAt, now, jobId);
    if (info.changes > 0) this.syncMediaStatusForJob(jobId, now);
    return info.changes;
  }

  /**
   * P3.T7 reprocess support, P4.T2 R-40 fix: flip a terminal row
   * (failed / success / retrying / cancelled) back into the
   * runnable queue via the §4.3-canonical `retrying` state.
   *
   * Differences vs. the (now-removed) `resetToPending`:
   *   * Target status is `retrying`, not `pending`. The claim
   *     SELECT (P4.T2) accepts both, so the executor still picks
   *     it up next tick.
   *   * retry_count is reset to 0 — user-driven reprocess is
   *     "start over", not "continue the existing retry budget".
   *   * next_run_at is set to the caller-supplied `now` so the
   *     "due-iff `next_run_at <= now`" predicate fires immediately.
   *
   * WHERE clause still restricts source statuses to the closed
   * non-active set; pending / running rows are filtered upstream
   * by the Service layer ("skipped" / "already active" branches).
   */
  resetToRetrying(jobId: string, now: string = nowIso()): number {
    const info = this.resetToRetryingStmt.run(now, now, jobId);
    if (info.changes > 0) this.syncMediaStatusForJob(jobId, now);
    return info.changes;
  }

  /**
   * P4.T4: fetch a job by id with its owning `trip_id` resolved via
   * LEFT JOIN. Returns null when the job row does not exist. Used
   * by `GET /api/jobs/:id` and by retry / cancel responses so the
   * client always sees the post-mutation row.
   */
  findJobView(id: string): JobView | null {
    const row = this.findJobViewByIdStmt.get(id) as JobViewRow | undefined;
    return row ? rowToJobView(row) : null;
  }

  /**
   * P4.T4: filtered + paginated list backing `GET /api/jobs`. SQL is
   * built per call because the predicate set depends on which
   * filter keys the caller supplied (SQLite has no opt-in WHERE
   * placeholder). All filters are AND-combined; nothing supports
   * IN-lists for the V1 surface.
   *
   * Ordering is `created_at DESC, id DESC` — newest first, stable
   * tiebreak by id. The route layer caps `limit` at 100; we do not
   * re-cap here so internal callers can request more if they ever
   * need to (e.g. a hypothetical maintenance CLI).
   */
  listJobs(filter: JobListFilter): JobView[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status !== undefined) {
      where.push("j.status = ?");
      params.push(filter.status);
    }
    if (filter.jobType !== undefined) {
      where.push("j.job_type = ?");
      params.push(filter.jobType);
    }
    if (filter.mediaId !== undefined) {
      where.push("j.media_id = ?");
      params.push(filter.mediaId);
    }
    if (filter.tripId !== undefined) {
      where.push("m.trip_id = ?");
      params.push(filter.tripId);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const sql = `
      SELECT ${SELECT_COLUMNS_PREFIXED},
             m.trip_id AS trip_id
      FROM processing_jobs j
      LEFT JOIN media_items m ON m.id = j.media_id
      ${whereClause}
      ORDER BY j.created_at DESC, j.id DESC
      LIMIT ? OFFSET ?
    `;
    params.push(filter.limit, filter.offset);
    const rows = this.db.prepare(sql).all(...params) as JobViewRow[];
    return rows.map(rowToJobView);
  }

  /**
   * P4.T4 cancel: flip pending / retrying / running → cancelled.
   * Service layer guards on the current status to surface a
   * domain-shaped 400 ("cannot cancel job in status X") before
   * touching SQL; this method's WHERE clause is the final race-safe
   * guard. Returns the rowcount (0 means the row's status moved
   * mid-request — caller retries-by-refresh or returns 409).
   */
  cancelJob(jobId: string, now: string = nowIso()): number {
    const info = this.cancelJobStmt.run(now, now, jobId);
    if (info.changes > 0) this.syncMediaStatusForJob(jobId, now);
    return info.changes;
  }

  /**
   * P4.T3 zombie recovery: return every `running` job whose
   * `started_at` is at or before `startedBefore`. Rows are returned
   * oldest-first (NULL started_at treated as ancient → first).
   *
   * The caller (JobQueue.recoverZombies) then decides per row
   * whether to push it back to `retrying` (retry budget left) or
   * `failed` (budget exhausted), using the existing `markRetrying`
   * / `markFailed` methods — both already guard on
   * `WHERE status='running'`, so a row that transitioned out of
   * `running` between this SELECT and the UPDATE is a safe no-op.
   *
   * Returns an empty array when nothing is eligible. Throws only
   * on a real SQL error (caller logs + bails).
   */
  findZombieRunningJobs(startedBefore: string): ProcessingJob[] {
    const rows = this.findZombieRunningJobsStmt.all(startedBefore) as JobRow[];
    return rows.map(rowToJob);
  }

  // ---------------------------------------------------------------------------
  // P4.T5 — media status sync (private)
  // ---------------------------------------------------------------------------

  /**
   * Look up `media_id` for a job and forward to
   * `syncMediaStatusByMediaId`. Used by methods that take only a
   * jobId (markSuccess / markFailed / markRetrying / cancelJob /
   * resetToRetrying) so the caller doesn't have to re-fetch.
   *
   * Quietly returns when the job row is missing (e.g. caller deleted
   * it between UPDATE and the sync — impossible under FK CASCADE,
   * but defensive).
   */
  private syncMediaStatusForJob(jobId: string, now: string): void {
    const row = this.lookupMediaIdForJobStmt.get(jobId) as { media_id: string } | undefined;
    if (!row) return;
    this.syncMediaStatusByMediaId(row.media_id, now);
  }

  /**
   * Recompute and persist `media_items.status` for one media row
   * from the aggregate of its job rows.
   *
   * Derivation rules (priority order):
   *   1. Any job in {pending, retrying, running} → 'processing'.
   *   2. Else any job in 'failed' → 'failed'.
   *   3. Else any job in 'success' → 'processed' (cancelled rows
   *      that coexist with successes count as user-intentional
   *      skips and don't downgrade the media).
   *   4. Else only 'cancelled' jobs → 'failed' (cancel is terminal
   *      but not successful — "should not stay processing").
   *   5. No jobs at all for this media → leave the row alone.
   *
   * `media_items` has no error-message column, so per-job error
   * details stay in `processing_jobs.error_message` and are
   * exposed via `GET /api/jobs?mediaId=…` (P4.T4). Schema is
   * unchanged.
   *
   * The UPDATE guards against:
   *   * soft-deleted rows (`deleted_at IS NOT NULL`),
   *   * `archived` rows (user opt-in; future feature),
   *   * `deleted` rows (status flag for soft delete),
   *   * no-op writes (target == current).
   */
  private syncMediaStatusByMediaId(mediaId: string, now: string): void {
    const counts = this.statusCountsByMediaStmt.all(mediaId) as {
      status: string;
      n: number;
    }[];
    let active = 0;
    let success = 0;
    let failed = 0;
    let cancelled = 0;
    for (const c of counts) {
      if (c.status === "pending" || c.status === "retrying" || c.status === "running") {
        active += c.n;
      } else if (c.status === "success") success += c.n;
      else if (c.status === "failed") failed += c.n;
      else if (c.status === "cancelled") cancelled += c.n;
    }
    const total = active + success + failed + cancelled;
    if (total === 0) return; // No jobs — don't touch the media row.

    let target: "processing" | "failed" | "processed";
    if (active > 0) target = "processing";
    else if (failed > 0) target = "failed";
    else if (success > 0) target = "processed";
    else target = "failed"; // cancelled-only

    this.applyMediaStatusStmt.run(target, now, mediaId, target);
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

function rowToJobView(row: JobViewRow): JobView {
  return {
    ...rowToJob(row),
    tripId: row.trip_id,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}
