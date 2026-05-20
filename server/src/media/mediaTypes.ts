// Media domain types (P2.T4 + P2.T5 scope).
//
// Mirrors the columns of server/migrations/002_create_media_items.sql.
// `MediaInsertData` is the writer surface used by Upload_Manager
// (P2.T4). `MediaItem` is the reader surface returned by the read API
// (P2.T5). Reads always go through the active filter (deleted_at IS
// NULL) unless `includeDeleted` is set; that flag is reserved for
// internal callers (P7 restore) and is not exposed at the HTTP layer.
//
// `MediaStatus` and `MediaUserDecision` mirror the CHECK enums in 002.
// `MediaType` is re-exported from the classifier so the value flowing
// into media_items.type comes from a single source of truth.

import type { MediaType } from "../classify/index.js";

export type { MediaType };

export type MediaStatus =
  | "uploaded"
  | "processing"
  | "processed"
  | "failed"
  | "archived"
  | "deleted";

export type MediaUserDecision = "keep" | "remove" | "undecided";

/**
 * Closed enum for `media_items.active_version_type` (migration 010,
 * P8.T4). The default `'original'` covers freshly-uploaded media —
 * nothing has been picked yet, so the original file is the implicit
 * active view. The non-default values point at user-selectable
 * `media_versions` rows:
 *   * `'enhanced'`   — P8.T3 sharp output (`media_versions(version_type='enhanced')`).
 *   * `'ai_refined'` — reserved for P10 AI refine.
 * Operational version_types ('thumbnail', 'preview', 'metadata',
 * 'video_cover', 'video_proxy') are NOT valid here; they are
 * artefacts of internal workers, not user-facing version choices.
 */
export type MediaActiveVersionType = "original" | "enhanced" | "ai_refined";

/**
 * Required fields when Upload_Manager creates a new media_items row.
 *
 * - `originalPath`  null for `type === 'unknown'` (per design.md §6.2.3
 *                   we intentionally discard the bytes for rejected
 *                   types); a logical storage path string otherwise.
 * - `status` / `userDecision` default to the DB defaults
 *   (`uploaded` / `undecided`) when omitted.
 * - Hash / dimension / preview columns stay NULL — those are filled by
 *   later tasks in P3 / P5 / P9.
 */
export interface MediaInsertData {
  readonly id: string;
  readonly tripId: string;
  readonly type: MediaType;
  readonly originalPath: string | null;
  readonly fileSize: number | null;
  readonly mimeType: string | null;
  readonly extension: string | null;
  readonly status?: MediaStatus;
  readonly userDecision?: MediaUserDecision;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Reader-facing shape returned by the media GET endpoints (P2.T5).
 *
 * Field set is the projection of media_items columns that the front-
 * end Gallery (P2.T7) needs:
 *   - identity (id, tripId)
 *   - kind / payload metadata (type, originalPath, previewPath,
 *     thumbnailPath, mimeType, extension, fileSize)
 *   - intrinsic media metrics (width, height, duration) — filled by
 *     later workers; NULL on uploaded rows
 *   - lifecycle (status, userDecision)
 *   - timestamps (createdAt, updatedAt, deletedAt)
 *
 * Hash columns (file_hash / perceptual_hash) are intentionally NOT
 * projected: they are dedup internals (P5) and not useful to the
 * frontend. The DB row still carries them; this type just hides them.
 *
 * `deletedAt` is included so internal callers (P7 restore) can branch
 * on it; the default HTTP read path only ever surfaces rows where it
 * is null.
 */
export interface MediaItem {
  readonly id: string;
  readonly tripId: string;
  readonly type: MediaType;
  readonly originalPath: string | null;
  readonly previewPath: string | null;
  readonly thumbnailPath: string | null;
  readonly fileSize: number | null;
  readonly mimeType: string | null;
  readonly extension: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly duration: number | null;
  readonly status: MediaStatus;
  readonly userDecision: MediaUserDecision;
  /**
   * P8.T4 — the version the user has currently selected for display.
   * `'original'` is the default for every freshly-uploaded row (set
   * by migration 010); the column is updated by
   * `MediaService.selectVersion` when the user picks 'enhanced' /
   * 'ai_refined'. The thumbnail / preview / metadata version_types
   * are intentionally absent from this enum — they are operational
   * artefacts of the image-channel workers, not user choices.
   */
  readonly activeVersionType: MediaActiveVersionType;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  /**
   * P6.T6: per-media analysis projection joined from `media_analysis`.
   * `null` when no analysis row exists yet (i.e. the per-dimension
   * workers haven't run on this media). The projection intentionally
   * exposes only the fields the gallery + detail UI need — not the
   * raw_result blob nor the per-axis means (those stay in the audit
   * trail inside the DB).
   */
  readonly analysis: MediaAnalysisProjection | null;
}

/**
 * Subset of `media_analysis` surfaced to the read endpoints. Mirrors
 * the columns P6.T2–P6.T5 actually populate. Optional / nullable
 * everywhere because workers fill them progressively:
 *   - blur worker writes sharpness + isBlurry (P6.T2)
 *   - exposure worker writes exposureScore (P6.T3)
 *   - colour worker writes colorScore + labels + isBlurry-orthogonal
 *     entries in `labels` (P6.T4)
 *   - finalize worker writes qualityScore + the composite reason
 *     (P6.T5 first half)
 * `isRecommended` is in the schema but no worker writes it yet —
 * the per-group recommendation lives on `duplicate_group_items`
 * (Quality_Selector, P6.T5 second half).
 *
 * `labels` is the parsed JSON-array form of the DB column; readers
 * never have to JSON.parse themselves.
 */
export interface MediaAnalysisProjection {
  readonly qualityScore: number | null;
  readonly sharpnessScore: number | null;
  readonly exposureScore: number | null;
  readonly colorScore: number | null;
  readonly isBlurry: 0 | 1 | null;
  readonly isRecommended: 0 | 1 | null;
  readonly labels: readonly string[] | null;
  readonly reason: string | null;
}

/**
 * Internal options for `MediaRepository.list` / `MediaService.list*`.
 *
 * - `limit` / `offset` are conventional pagination; the route layer
 *   tightens them to 1..100, the service caps at 200 (mirrors trips).
 * - `includeDeleted` is for restore / admin paths and is NOT exposed
 *   on the public API.
 * - `onlyDeleted` (P7.T4) is the "recycle bin" filter — when true the
 *   repository inverts the active-only predicate and returns ONLY
 *   soft-deleted rows, ordered by `deleted_at DESC` so the UI shows
 *   the most-recently-deleted items first. Wins over `includeDeleted`
 *   when both are set; route layer exposes only this knob so the
 *   frontend recycle-bin page can query without extra ceremony.
 *
 * The `| undefined` on each property is required by
 * `exactOptionalPropertyTypes: true`: it lets callers pass
 * `{ limit: x }` without `offset`, and also lets the zod-derived
 * `ListMediaInput` (where coerce + default yields
 * `number | undefined`) flow into this shape without an extra rebuild.
 * Mirrors the equivalent pattern in trips/tripTypes.ts.
 */
export interface ListMediaOptions {
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
  readonly includeDeleted?: boolean | undefined;
  readonly onlyDeleted?: boolean | undefined;
}

/**
 * Read projection of a `media_versions` row, returned by the detail
 * endpoint (P3.T6). Mirrors every column the table holds; consumers
 * pick whatever they need. `params` is the raw JSON string from
 * media_versions.params — the frontend parses it on demand (e.g.
 * for the EXIF table on the metadata version).
 */
export interface MediaVersion {
  readonly id: string;
  readonly mediaId: string;
  readonly versionType: string;
  readonly filePath: string;
  readonly mimeType: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly fileSize: number | null;
  readonly modelName: string | null;
  readonly params: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * `GET /api/media/:id` response payload (P3.T6).
 *
 * Top-level `{ media, versions }` keeps `MediaItem` type-clean and
 * the list endpoint (`GET /api/trips/:tripId/media`) untouched —
 * list intentionally does NOT carry per-row versions to keep the
 * Gallery payload small.
 */
export interface MediaDetail {
  readonly media: MediaItem;
  readonly versions: readonly MediaVersion[];
}

/**
 * One row in the user-facing versions response (P8.T4
 * `GET /api/media/:id/versions`). Differs from {@link MediaVersion}
 * in three ways:
 *
 *   1. It includes a synthesized 'original' entry that has no
 *      `media_versions` row — derived from `media_items` columns
 *      (originalPath, mimeType, width, height, fileSize, timestamps).
 *      So `id` is `null` for the original entry.
 *   2. `isActive` is precomputed against `media_items.active_version_type`
 *      so the frontend doesn't have to cross-reference.
 *   3. The shape only carries user-relevant fields — `model_name` /
 *      `params` / `status` are dropped (they're audit-trail noise for
 *      the user-facing UI; the detail endpoint still exposes them).
 *
 * Versions in the list are filtered to user-selectable types only
 * (`original` + `enhanced` + `ai_refined`). Thumbnail / preview /
 * metadata / video_* entries are operational and never appear here.
 */
export interface MediaVersionView {
  /** `null` for the synthesized 'original' entry; uuid for real rows. */
  readonly id: string | null;
  readonly versionType: MediaActiveVersionType;
  readonly isActive: boolean;
  /** Logical path inside the storage root. Never an absolute fs path. */
  readonly filePath: string;
  readonly mimeType: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly fileSize: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Response envelope for `GET /api/media/:id/versions` (P8.T4).
 *
 * `activeVersionType` mirrors `media.activeVersionType` and is
 * surfaced at top-level for convenience — the frontend can decide
 * which version to render without scanning `versions[]`.
 */
export interface MediaVersionsView {
  readonly mediaId: string;
  readonly activeVersionType: MediaActiveVersionType;
  readonly versions: readonly MediaVersionView[];
}

/**
 * Response envelope for `POST /api/media/:id/select-version` (P8.T4).
 *
 * `alreadyActive` is `true` when the user selects the version that
 * was already active — no DB write happened, but the response still
 * looks like success (idempotent UX). `previousVersionType` is the
 * value before the call so the UI can show "switched from X to Y".
 */
export interface SelectVersionResult {
  readonly mediaId: string;
  readonly activeVersionType: MediaActiveVersionType;
  readonly previousVersionType: MediaActiveVersionType;
  readonly alreadyActive: boolean;
}
