// SlideshowRendersRepository — data-access layer for the
// `slideshow_renders` table introduced in migration 022 (P12.T2).
//
// Scope:
//   * P12.T2 lands the schema + repository + smoke. Writers are
//     P12.T12 (slideshow API + worker): the API INSERTs a row in
//     pending state and the worker drives it through
//     running → success / failed / cancelled.
//   * Repository exposes the minimum surface P12.T12 will need.
//     The merging / orchestration logic stays in the service layer.
//
// Public methods:
//   * insert(row)                       — create a new render
//                                          request (pending)
//   * findById(id)
//   * listByTrip(tripId)                — newest-first history
//                                          (default deleted_at IS NULL)
//   * countActiveByTrip(tripId)         — for the per-trip 1-at-a-time
//                                          concurrency gate (returns
//                                          rows in pending/running)
//   * markStatus(id, newStatus, opts)   — controlled status transition
//                                          (worker)
//   * setOutputMediaVersion(id, mvId)   — link to media_versions row
//                                          after success
//   * softDelete(id)                    — set deleted_at (CLAUDE.md
//                                          §2.4: no auto permanent
//                                          delete)

import type { SqliteDatabase } from "../db/connection.js";

export type SlideshowRenderStatus =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "cancelled";

export type SlideshowTransitionType = "xfade" | "none";

export type SlideshowAudioPolicy = "replace_with_library" | "mute";

export interface SlideshowRenderView {
  readonly id: string;
  readonly tripId: string;
  readonly status: SlideshowRenderStatus;
  /** JSON-encoded ordered array of media_ids. The repository does
   * NOT parse — callers decode/encode as needed. */
  readonly inputMediaIdsJson: string;
  readonly perImageDurationSec: number;
  readonly transitionType: SlideshowTransitionType;
  readonly transitionDurationSec: number;
  readonly outputResolution: string;
  readonly outputFps: number;
  readonly audioPolicy: SlideshowAudioPolicy;
  readonly backgroundAudioId: string | null;
  readonly outputMediaVersionId: string | null;
  readonly errorMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

export interface SlideshowRenderInsertData {
  readonly id: string;
  readonly tripId: string;
  /** Caller MUST pre-JSON-encode the ordered media_id array. */
  readonly inputMediaIdsJson: string;
  readonly perImageDurationSec: number;
  readonly transitionType: SlideshowTransitionType;
  readonly transitionDurationSec: number;
  readonly outputResolution: string;
  readonly outputFps: number;
  readonly audioPolicy: SlideshowAudioPolicy;
  readonly backgroundAudioId: string | null;
}

interface SlideshowRenderRow {
  id: string;
  trip_id: string;
  status: SlideshowRenderStatus;
  input_media_ids: string;
  per_image_duration_sec: number;
  transition_type: SlideshowTransitionType;
  transition_duration_sec: number;
  output_resolution: string;
  output_fps: number;
  audio_policy: SlideshowAudioPolicy;
  background_audio_id: string | null;
  output_media_version_id: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const SELECT_COLUMNS = `
  id,
  trip_id,
  status,
  input_media_ids,
  per_image_duration_sec,
  transition_type,
  transition_duration_sec,
  output_resolution,
  output_fps,
  audio_policy,
  background_audio_id,
  output_media_version_id,
  error_message,
  created_at,
  updated_at,
  deleted_at
`;

function rowToView(row: SlideshowRenderRow): SlideshowRenderView {
  return {
    id: row.id,
    tripId: row.trip_id,
    status: row.status,
    inputMediaIdsJson: row.input_media_ids,
    perImageDurationSec: row.per_image_duration_sec,
    transitionType: row.transition_type,
    transitionDurationSec: row.transition_duration_sec,
    outputResolution: row.output_resolution,
    outputFps: row.output_fps,
    audioPolicy: row.audio_policy,
    backgroundAudioId: row.background_audio_id,
    outputMediaVersionId: row.output_media_version_id,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export interface SlideshowMarkStatusOptions {
  readonly errorMessage?: string | null;
}

export class SlideshowRendersRepository {
  private readonly insertStmt;
  private readonly findByIdStmt;
  private readonly listByTripActiveStmt;
  private readonly listByTripAllStmt;
  private readonly countActiveByTripStmt;
  private readonly markStatusStmt;
  private readonly setOutputMediaVersionStmt;
  private readonly softDeleteStmt;

  constructor(private readonly db: SqliteDatabase) {
    // Status defaults to 'pending'; the schema's DEFAULT clause is
    // what backs that, so we don't write it explicitly here.
    this.insertStmt = db.prepare(`
      INSERT INTO slideshow_renders (
        id, trip_id,
        input_media_ids,
        per_image_duration_sec,
        transition_type, transition_duration_sec,
        output_resolution, output_fps,
        audio_policy, background_audio_id
      ) VALUES (
        @id, @tripId,
        @inputMediaIdsJson,
        @perImageDurationSec,
        @transitionType, @transitionDurationSec,
        @outputResolution, @outputFps,
        @audioPolicy, @backgroundAudioId
      )
    `);

    this.findByIdStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM slideshow_renders
      WHERE id = ?
    `);

    // Active rows for a trip, newest first — backs
    // GET /api/trips/:id/slideshows by default (deleted_at filter
    // honoured per §4.4 soft-delete query convention).
    this.listByTripActiveStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM slideshow_renders
      WHERE trip_id = ? AND deleted_at IS NULL
      ORDER BY created_at DESC, id DESC
    `);

    // Admin / smoke variant — includes soft-deleted rows.
    this.listByTripAllStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM slideshow_renders
      WHERE trip_id = ?
      ORDER BY created_at DESC, id DESC
    `);

    // For the per-trip concurrency gate: how many renders are
    // in-flight right now? Soft-deleted rows are excluded — they
    // can't transition.
    this.countActiveByTripStmt = db.prepare(`
      SELECT COUNT(*) AS n
      FROM slideshow_renders
      WHERE trip_id = ?
        AND deleted_at IS NULL
        AND status IN ('pending', 'running')
    `);

    // Status transition. error_message is set when transitioning to
    // 'failed' (worker), otherwise NULL.
    this.markStatusStmt = db.prepare(`
      UPDATE slideshow_renders
         SET status = @status,
             error_message = @errorMessage,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = @id
    `);

    this.setOutputMediaVersionStmt = db.prepare(`
      UPDATE slideshow_renders
         SET output_media_version_id = @outputMediaVersionId,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = @id
    `);

    this.softDeleteStmt = db.prepare(`
      UPDATE slideshow_renders
         SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND deleted_at IS NULL
    `);
  }

  insert(data: SlideshowRenderInsertData): SlideshowRenderView {
    this.insertStmt.run({
      id: data.id,
      tripId: data.tripId,
      inputMediaIdsJson: data.inputMediaIdsJson,
      perImageDurationSec: data.perImageDurationSec,
      transitionType: data.transitionType,
      transitionDurationSec: data.transitionDurationSec,
      outputResolution: data.outputResolution,
      outputFps: data.outputFps,
      audioPolicy: data.audioPolicy,
      backgroundAudioId: data.backgroundAudioId,
    });
    const row = this.findByIdStmt.get(data.id) as SlideshowRenderRow | undefined;
    if (row === undefined) {
      throw new Error(
        `SlideshowRendersRepository.insert: row vanished post-insert (id=${data.id})`,
      );
    }
    return rowToView(row);
  }

  findById(id: string): SlideshowRenderView | null {
    const row = this.findByIdStmt.get(id) as SlideshowRenderRow | undefined;
    return row ? rowToView(row) : null;
  }

  /** Non-deleted rows only (default UI / API behaviour). */
  listByTrip(tripId: string): SlideshowRenderView[] {
    const rows = this.listByTripActiveStmt.all(tripId) as SlideshowRenderRow[];
    return rows.map(rowToView);
  }

  /** Includes soft-deleted rows. Admin / smoke use. */
  listByTripAll(tripId: string): SlideshowRenderView[] {
    const rows = this.listByTripAllStmt.all(tripId) as SlideshowRenderRow[];
    return rows.map(rowToView);
  }

  countActiveByTrip(tripId: string): number {
    const row = this.countActiveByTripStmt.get(tripId) as { n: number };
    return row.n;
  }

  /** Drive a status transition. The worker / API enforce which
   * transitions are valid; the repository just writes.
   * `errorMessage` defaults to NULL — pass a string only when
   * transitioning to 'failed'. */
  markStatus(
    id: string,
    status: SlideshowRenderStatus,
    options: SlideshowMarkStatusOptions = {},
  ): number {
    const info = this.markStatusStmt.run({
      id,
      status,
      errorMessage: options.errorMessage ?? null,
    });
    return info.changes;
  }

  setOutputMediaVersion(id: string, outputMediaVersionId: string | null): number {
    const info = this.setOutputMediaVersionStmt.run({ id, outputMediaVersionId });
    return info.changes;
  }

  /** Returns 1 if a non-deleted row was soft-deleted, 0 otherwise. */
  softDelete(id: string): number {
    const info = this.softDeleteStmt.run(id);
    return info.changes;
  }
}
