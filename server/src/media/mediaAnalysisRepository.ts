// MediaAnalysisRepository — data-access layer for `media_analysis`
// (migration 008, P6.T1).
//
// Scope (P6.T2 — first consumer):
//   * `upsertBlurAnalysis` — write the blur-related columns for one
//     media. Wraps INSERT … ON CONFLICT(media_id) DO UPDATE so that
//     re-running the `image_quality_blur` worker on the same media is
//     idempotent (the deterministic Laplacian variance over the same
//     bytes yields the same numbers).
//   * `findByMediaId` — convenience reader for the smoke / future
//     callers (P6.T6 frontend badges).
//
// Schema reminder (migrations/008_create_media_analysis.sql):
//   * 1:1 with `media_items` enforced via UNIQUE(media_id).
//   * `raw_result` is a TEXT JSON blob shared across analysis
//     dimensions. P6.T2 owns the `$.blur` sub-key; P6.T3 / T4 will
//     own `$.exposure` / `$.color` and MUST NOT clobber siblings.
//     We use SQLite's `json_set` at the DB layer so concurrent
//     workers cannot trample each other through a JS-side
//     read-modify-write race window.
//   * `is_blurry` accepts NULL / 0 / 1 (CHECK). The repo passes
//     `null` through unchanged so the worker can encode the
//     "maybe-blurry" borderline state.
//
// What this Repository deliberately does NOT cover yet:
//   * Exposure / colour / aesthetic upserts — those land with their
//     respective workers (P6.T3 / P6.T4 / P10).
//   * Quality_score composition — that's the Quality_Selector's job
//     (P6.T5). The composite write will be its own method.
//   * Hard delete — `ON DELETE CASCADE` from `media_items` handles it.
//
// All prepared statements are created once at construction time, in
// line with the other `*Repository` classes in this package.

import type { SqliteDatabase } from "../db/connection.js";

/**
 * One row of `media_analysis` projected with snake_case → camelCase.
 * `rawResult` is returned as the raw JSON text — callers parse on demand
 * to avoid eager work in readers that only need the typed columns.
 */
export interface MediaAnalysisRow {
  readonly id: string;
  readonly mediaId: string;
  readonly blurScore: number | null;
  readonly sharpnessScore: number | null;
  readonly exposureScore: number | null;
  readonly brightnessScore: number | null;
  readonly colorScore: number | null;
  readonly aestheticScore: number | null;
  readonly qualityScore: number | null;
  readonly isBlurry: 0 | 1 | null;
  readonly isDuplicate: 0 | 1 | null;
  readonly isRecommended: 0 | 1 | null;
  readonly labels: string | null;
  readonly reason: string | null;
  readonly rawResult: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Argument bag for `upsertBlurAnalysis`. All numeric scores are passed
 * as the worker computed them — no clamping happens here; the worker
 * is responsible for keeping `sharpness_score` in [0, 1] and
 * `is_blurry` in {0, 1, null}. The DB layer enforces the CHECK so
 * misuse fails loudly at the boundary.
 */
export interface UpsertBlurAnalysisInput {
  /** Required to generate the row id on the INSERT branch. */
  readonly id: string;
  readonly mediaId: string;
  /** Raw Laplacian variance (unbounded REAL, no CHECK). */
  readonly blurScore: number;
  /** Normalised confidence in [0, 1] (no CHECK at the SQL layer). */
  readonly sharpnessScore: number;
  /** Worker's classification — 1=blurry, 0=clear, NULL=borderline. */
  readonly isBlurry: 0 | 1 | null;
  /** JSON-stringified array of issue tags, e.g. `["maybe-blurry"]`. */
  readonly labels: string;
  /** Human-readable explanation surfaced by the UI (CLAUDE.md §3.8). */
  readonly reason: string;
  /**
   * JSON-stringified blur-specific raw output. Becomes the `$.blur`
   * sub-key of `raw_result`; siblings (`$.exposure`, `$.color`, …) are
   * preserved on update via `json_set`.
   */
  readonly rawBlurJson: string;
  readonly updatedAt: string;
}

const SELECT_COLUMNS = `
  id,
  media_id,
  blur_score,
  sharpness_score,
  exposure_score,
  brightness_score,
  color_score,
  aesthetic_score,
  quality_score,
  is_blurry,
  is_duplicate,
  is_recommended,
  labels,
  reason,
  raw_result,
  created_at,
  updated_at
`;

interface RawRow {
  id: string;
  media_id: string;
  blur_score: number | null;
  sharpness_score: number | null;
  exposure_score: number | null;
  brightness_score: number | null;
  color_score: number | null;
  aesthetic_score: number | null;
  quality_score: number | null;
  is_blurry: number | null;
  is_duplicate: number | null;
  is_recommended: number | null;
  labels: string | null;
  reason: string | null;
  raw_result: string | null;
  created_at: string;
  updated_at: string;
}

function rowToProjection(row: RawRow): MediaAnalysisRow {
  return {
    id: row.id,
    mediaId: row.media_id,
    blurScore: row.blur_score,
    sharpnessScore: row.sharpness_score,
    exposureScore: row.exposure_score,
    brightnessScore: row.brightness_score,
    colorScore: row.color_score,
    aestheticScore: row.aesthetic_score,
    qualityScore: row.quality_score,
    isBlurry: normaliseBoolColumn(row.is_blurry),
    isDuplicate: normaliseBoolColumn(row.is_duplicate),
    isRecommended: normaliseBoolColumn(row.is_recommended),
    labels: row.labels,
    reason: row.reason,
    rawResult: row.raw_result,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normaliseBoolColumn(value: number | null): 0 | 1 | null {
  if (value === null) return null;
  return value === 1 ? 1 : 0;
}

export class MediaAnalysisRepository {
  private readonly upsertBlurStmt;
  private readonly findByMediaIdStmt;

  constructor(db: SqliteDatabase) {
    // `json_set(COALESCE(raw_result, '{}'), '$.blur', json(@rawBlurJson))`
    // is the magic that lets two analysis workers share one TEXT JSON
    // column without trampling each other. On INSERT the column is
    // built fresh from `json_object('blur', json(@rawBlurJson))`; on
    // UPDATE we splice the new fragment into the existing blob, so
    // sibling keys like `$.exposure` (P6.T3) and `$.color` (P6.T4) are
    // untouched.
    //
    // Named bindings are reused — better-sqlite3 allows referring to
    // the same @parameter in multiple positions of the same statement.
    this.upsertBlurStmt = db.prepare(`
      INSERT INTO media_analysis (
        id, media_id,
        blur_score, sharpness_score, is_blurry,
        labels, reason, raw_result,
        created_at, updated_at
      ) VALUES (
        @id, @mediaId,
        @blurScore, @sharpnessScore, @isBlurry,
        @labels, @reason, json_object('blur', json(@rawBlurJson)),
        @updatedAt, @updatedAt
      )
      ON CONFLICT(media_id) DO UPDATE SET
        blur_score      = excluded.blur_score,
        sharpness_score = excluded.sharpness_score,
        is_blurry       = excluded.is_blurry,
        labels          = excluded.labels,
        reason          = excluded.reason,
        raw_result      = json_set(COALESCE(raw_result, '{}'), '$.blur', json(@rawBlurJson)),
        updated_at      = excluded.updated_at
    `);

    this.findByMediaIdStmt = db.prepare(`
      SELECT ${SELECT_COLUMNS}
      FROM media_analysis
      WHERE media_id = ?
    `);
  }

  /**
   * Write the blur-analysis fields for one media row. Idempotent —
   * re-running with identical inputs yields the same row. Other
   * analysis dimensions (`exposure_*`, `color_*`, `aesthetic_*`,
   * `quality_score`, etc.) and the matching `$.*` keys of
   * `raw_result` are preserved across the UPDATE.
   *
   * Returns the number of rows affected. Always 1 on success (INSERT
   * counts as 1 changed row; ON CONFLICT … DO UPDATE also reports 1).
   *
   * Throws on schema-level violations (UNIQUE / FK / CHECK) — the
   * caller decides how to translate.
   */
  upsertBlurAnalysis(input: UpsertBlurAnalysisInput): number {
    const info = this.upsertBlurStmt.run({
      id: input.id,
      mediaId: input.mediaId,
      blurScore: input.blurScore,
      sharpnessScore: input.sharpnessScore,
      isBlurry: input.isBlurry,
      labels: input.labels,
      reason: input.reason,
      rawBlurJson: input.rawBlurJson,
      updatedAt: input.updatedAt,
    });
    return info.changes;
  }

  /** Null when no analysis row exists for the given media. */
  findByMediaId(mediaId: string): MediaAnalysisRow | null {
    const row = this.findByMediaIdStmt.get(mediaId) as RawRow | undefined;
    return row ? rowToProjection(row) : null;
  }
}
