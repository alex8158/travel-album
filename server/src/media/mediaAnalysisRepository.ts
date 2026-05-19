// MediaAnalysisRepository — data-access layer for `media_analysis`
// (migration 008, P6.T1).
//
// Scope (P6.T2 + P6.T3 + P6.T4 + P6.T5 consumers so far):
//   * `upsertBlurAnalysis` — write blur-related columns for one media.
//   * `upsertExposureAnalysis` — write exposure-related columns for one
//     media (P6.T3). Mirrors the blur shape: idempotent UPSERT keyed on
//     UNIQUE(media_id) with the per-dimension JSON merged into
//     `raw_result.$.exposure` so blur's `$.blur` is preserved.
//   * `upsertColorAnalysis` — write color-related columns (P6.T4).
//     Same shape; merges into `raw_result.$.color` so blur / exposure
//     siblings survive.
//   * `upsertFinalQuality` — write the composite `quality_score` +
//     composite `reason` (P6.T5). DOES touch the top-level `reason`
//     column because it is intentionally the "final word"; per-
//     dimension reasons are still kept inside their own
//     `raw_result.$.<dim>` sub-trees. DOES NOT touch the `labels`
//     column — those are already merged across dimensions by the
//     per-dimension upserts.
//   * `findByMediaId` — convenience reader for the smoke / future
//     callers (P6.T6 frontend badges).
//
// Schema reminder (migrations/008_create_media_analysis.sql):
//   * 1:1 with `media_items` enforced via UNIQUE(media_id).
//   * `raw_result` is a TEXT JSON blob shared across analysis
//     dimensions. P6.T2 owns the `$.blur` sub-key; P6.T3 owns
//     `$.exposure`; P6.T4 will own `$.color`. We use SQLite's
//     `json_set` at the DB layer so concurrent workers cannot trample
//     each other through a JS-side read-modify-write race window.
//   * `is_blurry` accepts NULL / 0 / 1 (CHECK). The repo passes
//     `null` through unchanged so the worker can encode the
//     "maybe-blurry" borderline state.
//
// Labels merge (P6.T3 refactor — shared by blur + exposure):
//   * Schema has ONE `labels` TEXT column (a JSON array of issue tags
//     per requirements §8.3). Multiple analysis dimensions need to
//     contribute their own tag without trampling siblings.
//   * Each worker dimension owns a closed vocabulary
//     (BLUR_DIMENSION_LABELS / EXPOSURE_DIMENSION_LABELS). The repo
//     reads the existing labels, strips any of THIS dimension's
//     vocabulary (so a re-run replaces the old label cleanly), and
//     appends the new label(s).
//   * The read-merge-write is wrapped in `db.transaction` so it is
//     atomic against any other writer on the same row. SQLite is a
//     single-writer DB, so this guarantees no torn merges.
//   * Why not pure SQL? SQLite JSON1 has no "filter array elements
//     by membership" primitive. A recursive CTE would work but is
//     significantly less readable than the JS merge. The merge runs
//     once per worker invocation — performance is irrelevant.
//
// What this Repository deliberately does NOT cover yet:
//   * Colour / aesthetic upserts — those land with their respective
//     workers (P6.T4 / P10).
//   * Quality_score composition — that's the Quality_Selector's job
//     (P6.T5). The composite write will be its own method.
//   * Hard delete — `ON DELETE CASCADE` from `media_items` handles it.
//
// All prepared statements are created once at construction time, in
// line with the other `*Repository` classes in this package.

import type { SqliteDatabase } from "../db/connection.js";

/**
 * Vocabulary owned by the `image_quality_blur` worker (P6.T2). Any
 * label string in this set is considered "blur's territory" — the
 * blur upsert removes them from the existing label array before
 * appending its own.
 */
export const BLUR_DIMENSION_LABELS = ["sharp", "maybe-blurry", "blurry"] as const;

/**
 * Vocabulary owned by the `image_quality_exposure` worker (P6.T3).
 * Distinct from blur's vocabulary so re-running one dimension never
 * disturbs the other.
 */
export const EXPOSURE_DIMENSION_LABELS = [
  "well-exposed",
  "underexposed",
  "overexposed",
  "mixed-exposure",
] as const;

/**
 * Vocabulary owned by the `image_quality_color` worker (P6.T4).
 *
 * The colour worker reports up to three orthogonal sub-classifications
 * (saturation level, channel-balance cast direction, contrast level)
 * so a single run may emit multiple labels — e.g. `["color-warm-cast",
 * "color-low-saturation"]`. The "balanced" label is emitted ONLY when
 * none of the issue labels apply, so its presence acts as the
 * "explicitly checked + nothing wrong" marker.
 *
 * All entries are namespaced with the `color-` prefix to keep this
 * dimension's tags visually distinguishable from blur (`sharp` /
 * `blurry`) and exposure (`well-exposed` / `underexposed`) labels.
 */
export const COLOR_DIMENSION_LABELS = [
  "color-balanced",
  "color-low-saturation",
  "color-high-saturation",
  "color-warm-cast",
  "color-cool-cast",
  "color-green-cast",
  "color-magenta-cast",
  "color-low-contrast",
  "color-high-contrast",
] as const;

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
  /**
   * The blur dimension's own labels for this run, e.g. `["blurry"]`.
   * The repository merges these into the existing `labels` column —
   * existing entries that belong to {@link BLUR_DIMENSION_LABELS} are
   * stripped first so a re-run cleanly replaces the prior blur label.
   */
  readonly blurLabels: readonly string[];
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

/**
 * Argument bag for `upsertExposureAnalysis` (P6.T3). Mirror of the
 * blur shape: scalar typed columns plus a dimension-scoped label list
 * + JSON fragment. Labels are merged via the same dimension-vocab
 * stripping rule as blur, against {@link EXPOSURE_DIMENSION_LABELS}.
 */
export interface UpsertExposureAnalysisInput {
  /** Required to generate the row id on the INSERT branch. */
  readonly id: string;
  readonly mediaId: string;
  /**
   * Composite "how well-exposed" confidence in [0, 1] (no CHECK at
   * the SQL layer). Worker formula is documented in the worker
   * header.
   */
  readonly exposureScore: number;
  /** Raw normalised mean brightness in [0, 1] = mean(0..255) / 255. */
  readonly brightnessScore: number;
  /** Exposure dimension's labels for this run, e.g. `["overexposed"]`. */
  readonly exposureLabels: readonly string[];
  /** Human-readable explanation surfaced by the UI. */
  readonly reason: string;
  /**
   * JSON-stringified exposure-specific raw output. Becomes the
   * `$.exposure` sub-key of `raw_result`; siblings (`$.blur`,
   * `$.color`, …) are preserved on update via `json_set`.
   */
  readonly rawExposureJson: string;
  readonly updatedAt: string;
}

/**
 * Argument bag for `upsertFinalQuality` (P6.T5). Different from the
 * per-dimension upserts:
 *   * Writes the composite `quality_score` column (CHECK 0..1).
 *   * Writes the composite `reason` column — intentionally the final
 *     word; per-dimension reasons remain inside their own
 *     `raw_result.$.<dim>` sub-trees.
 *   * Does NOT touch `labels` — those are already merged across
 *     dimensions by the per-dimension upserts.
 */
export interface UpsertFinalQualityInput {
  readonly id: string;
  readonly mediaId: string;
  /** Composite quality in [0, 1]. Subject to the schema CHECK. */
  readonly qualityScore: number;
  /**
   * Composite reason. Includes per-dimension snippets and the final
   * weighted aggregation; the writer is the source of truth for what
   * ends up in this column.
   */
  readonly reason: string;
  /**
   * JSON-stringified payload for `raw_result.$.final_quality`. Holds
   * the algorithm name, version, per-dimension contributions,
   * skipped dimensions, configured weights, and the colour floor.
   * Sibling sub-trees (`$.blur`, `$.exposure`, `$.color`) survive
   * via `json_set` (same pattern as the per-dimension upserts).
   */
  readonly rawFinalJson: string;
  readonly updatedAt: string;
}

/**
 * Argument bag for `upsertColorAnalysis` (P6.T4). Same shape as the
 * blur / exposure inputs:
 *   * One scalar score column (`color_score`).
 *   * A dimension-scoped labels list (multi-element — colour reports
 *     orthogonal sub-classifications, see {@link COLOR_DIMENSION_LABELS}).
 *   * A JSON fragment for the `$.color` sub-key of `raw_result`.
 */
export interface UpsertColorAnalysisInput {
  readonly id: string;
  readonly mediaId: string;
  /**
   * Composite "how colour-healthy" confidence in [0, 1]. Worker
   * formula is documented in the worker header (`min` of saturation /
   * cast / contrast sub-scores).
   */
  readonly colorScore: number;
  /**
   * Colour dimension's labels for this run. May contain ZERO entries
   * (when the worker has nothing to flag — though in practice it
   * emits `color-balanced` instead), ONE entry, or several when
   * orthogonal sub-classifications fire (e.g. low saturation AND a
   * green cast).
   */
  readonly colorLabels: readonly string[];
  readonly reason: string;
  /**
   * JSON-stringified colour-specific raw output. Becomes the
   * `$.color` sub-key of `raw_result`; siblings (`$.blur`,
   * `$.exposure`, …) are preserved on update via `json_set`.
   */
  readonly rawColorJson: string;
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

/**
 * Parse a `labels` column value (TEXT JSON array or NULL) into a
 * defensive string array. Anything that doesn't decode to a
 * `string[]` becomes `[]` — the column is treated as untrusted on
 * read (a malformed write from a future bug should not crash later
 * upserts).
 */
function parseLabelArray(json: string | null): string[] {
  if (json === null) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
      return parsed.slice() as string[];
    }
  } catch {
    /* malformed — fall through */
  }
  return [];
}

/**
 * Merge a dimension's new labels into the existing column value:
 *   1. Decode the existing JSON array (treating malformed as empty).
 *   2. Drop any entries in `ownedLabels` — those are this dimension's
 *      territory and a re-run replaces them cleanly.
 *   3. Append `newLabels` in order, deduping against entries already
 *      kept from step 2.
 *
 * Exported so tests can validate the merge semantics without going
 * through the full UPSERT path.
 */
export function mergeDimensionLabels(
  existingJson: string | null,
  ownedLabels: readonly string[],
  newLabels: readonly string[],
): string {
  const existing = parseLabelArray(existingJson);
  const ownedSet = new Set(ownedLabels);
  const kept = existing.filter((label) => !ownedSet.has(label));
  const seen = new Set(kept);
  for (const label of newLabels) {
    if (!seen.has(label)) {
      kept.push(label);
      seen.add(label);
    }
  }
  return JSON.stringify(kept);
}

export class MediaAnalysisRepository {
  private readonly upsertBlurStmt;
  private readonly upsertExposureStmt;
  private readonly upsertColorStmt;
  private readonly upsertFinalQualityStmt;
  private readonly selectLabelsStmt;
  private readonly findByMediaIdStmt;

  constructor(private readonly db: SqliteDatabase) {
    // `json_set(COALESCE(raw_result, '{}'), '$.<dim>', json(@rawJson))`
    // is the magic that lets two analysis workers share one TEXT JSON
    // column without trampling each other. On INSERT the column is
    // built fresh from `json_object('<dim>', json(@rawJson))`; on
    // UPDATE we splice the new fragment into the existing blob, so
    // sibling keys are untouched.
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

    this.upsertExposureStmt = db.prepare(`
      INSERT INTO media_analysis (
        id, media_id,
        exposure_score, brightness_score,
        labels, reason, raw_result,
        created_at, updated_at
      ) VALUES (
        @id, @mediaId,
        @exposureScore, @brightnessScore,
        @labels, @reason, json_object('exposure', json(@rawExposureJson)),
        @updatedAt, @updatedAt
      )
      ON CONFLICT(media_id) DO UPDATE SET
        exposure_score   = excluded.exposure_score,
        brightness_score = excluded.brightness_score,
        labels           = excluded.labels,
        reason           = excluded.reason,
        raw_result       = json_set(COALESCE(raw_result, '{}'), '$.exposure', json(@rawExposureJson)),
        updated_at       = excluded.updated_at
    `);

    this.upsertColorStmt = db.prepare(`
      INSERT INTO media_analysis (
        id, media_id,
        color_score,
        labels, reason, raw_result,
        created_at, updated_at
      ) VALUES (
        @id, @mediaId,
        @colorScore,
        @labels, @reason, json_object('color', json(@rawColorJson)),
        @updatedAt, @updatedAt
      )
      ON CONFLICT(media_id) DO UPDATE SET
        color_score = excluded.color_score,
        labels      = excluded.labels,
        reason      = excluded.reason,
        raw_result  = json_set(COALESCE(raw_result, '{}'), '$.color', json(@rawColorJson)),
        updated_at  = excluded.updated_at
    `);

    this.upsertFinalQualityStmt = db.prepare(`
      INSERT INTO media_analysis (
        id, media_id,
        quality_score,
        reason, raw_result,
        created_at, updated_at
      ) VALUES (
        @id, @mediaId,
        @qualityScore,
        @reason, json_object('final_quality', json(@rawFinalJson)),
        @updatedAt, @updatedAt
      )
      ON CONFLICT(media_id) DO UPDATE SET
        quality_score = excluded.quality_score,
        reason        = excluded.reason,
        raw_result    = json_set(COALESCE(raw_result, '{}'), '$.final_quality', json(@rawFinalJson)),
        updated_at    = excluded.updated_at
    `);

    // Tiny SELECT used inside the upsert transactions to fetch the
    // current `labels` value for the dimension-vocab merge. A separate
    // statement (instead of reusing findByMediaIdStmt) avoids hauling
    // every column over for what is a one-string read.
    this.selectLabelsStmt = db.prepare(`SELECT labels FROM media_analysis WHERE media_id = ?`);

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
   * Labels merge: existing labels owned by other dimensions (e.g.
   * `"underexposed"`) are preserved; only labels in
   * {@link BLUR_DIMENSION_LABELS} are replaced by `blurLabels`. Runs
   * inside a `db.transaction` so the read + write is atomic against
   * other writers.
   *
   * Returns the number of rows affected. Always 1 on success (INSERT
   * counts as 1 changed row; ON CONFLICT … DO UPDATE also reports 1).
   *
   * Throws on schema-level violations (UNIQUE / FK / CHECK) — the
   * caller decides how to translate.
   */
  upsertBlurAnalysis(input: UpsertBlurAnalysisInput): number {
    const tx = this.db.transaction((data: UpsertBlurAnalysisInput): number => {
      const existing = this.selectLabelsStmt.get(data.mediaId) as
        | { labels: string | null }
        | undefined;
      const labels = mergeDimensionLabels(
        existing?.labels ?? null,
        BLUR_DIMENSION_LABELS,
        data.blurLabels,
      );
      const info = this.upsertBlurStmt.run({
        id: data.id,
        mediaId: data.mediaId,
        blurScore: data.blurScore,
        sharpnessScore: data.sharpnessScore,
        isBlurry: data.isBlurry,
        labels,
        reason: data.reason,
        rawBlurJson: data.rawBlurJson,
        updatedAt: data.updatedAt,
      });
      return info.changes;
    });
    return tx(input);
  }

  /**
   * Write the colour-analysis fields for one media row (P6.T4).
   * Mirror of {@link upsertBlurAnalysis}: idempotent, atomic labels
   * merge against {@link COLOR_DIMENSION_LABELS}, JSON fragment
   * spliced into `raw_result.$.color` so blur / exposure siblings
   * survive untouched.
   */
  upsertColorAnalysis(input: UpsertColorAnalysisInput): number {
    const tx = this.db.transaction((data: UpsertColorAnalysisInput): number => {
      const existing = this.selectLabelsStmt.get(data.mediaId) as
        | { labels: string | null }
        | undefined;
      const labels = mergeDimensionLabels(
        existing?.labels ?? null,
        COLOR_DIMENSION_LABELS,
        data.colorLabels,
      );
      const info = this.upsertColorStmt.run({
        id: data.id,
        mediaId: data.mediaId,
        colorScore: data.colorScore,
        labels,
        reason: data.reason,
        rawColorJson: data.rawColorJson,
        updatedAt: data.updatedAt,
      });
      return info.changes;
    });
    return tx(input);
  }

  /**
   * Write the exposure-analysis fields for one media row (P6.T3).
   * Mirror of {@link upsertBlurAnalysis}: idempotent, atomic labels
   * merge against {@link EXPOSURE_DIMENSION_LABELS}, JSON fragment
   * spliced into `raw_result.$.exposure` so blur / colour siblings
   * survive untouched.
   */
  upsertExposureAnalysis(input: UpsertExposureAnalysisInput): number {
    const tx = this.db.transaction((data: UpsertExposureAnalysisInput): number => {
      const existing = this.selectLabelsStmt.get(data.mediaId) as
        | { labels: string | null }
        | undefined;
      const labels = mergeDimensionLabels(
        existing?.labels ?? null,
        EXPOSURE_DIMENSION_LABELS,
        data.exposureLabels,
      );
      const info = this.upsertExposureStmt.run({
        id: data.id,
        mediaId: data.mediaId,
        exposureScore: data.exposureScore,
        brightnessScore: data.brightnessScore,
        labels,
        reason: data.reason,
        rawExposureJson: data.rawExposureJson,
        updatedAt: data.updatedAt,
      });
      return info.changes;
    });
    return tx(input);
  }

  /**
   * Write the composite `quality_score` + final `reason` for one
   * media row (P6.T5). Unlike the per-dimension upserts this one
   * intentionally OVERWRITES the top-level `reason` column — finalize
   * is the source of truth for the human-readable "final word" on
   * quality. Per-dimension human-readable details remain inside their
   * own `raw_result.$.<dim>` sub-trees + a structured snapshot inside
   * `raw_result.$.final_quality`.
   *
   * Does NOT touch the `labels` column; per-dimension upserts have
   * already merged labels across all dimensions. Idempotent over the
   * same inputs.
   */
  upsertFinalQuality(input: UpsertFinalQualityInput): number {
    const info = this.upsertFinalQualityStmt.run({
      id: input.id,
      mediaId: input.mediaId,
      qualityScore: input.qualityScore,
      reason: input.reason,
      rawFinalJson: input.rawFinalJson,
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
