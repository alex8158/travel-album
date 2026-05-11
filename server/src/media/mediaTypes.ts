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
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

/**
 * Internal options for `MediaRepository.list` / `MediaService.list*`.
 *
 * - `limit` / `offset` are conventional pagination; the route layer
 *   tightens them to 1..100, the service caps at 200 (mirrors trips).
 * - `includeDeleted` is for restore / admin paths and is NOT exposed
 *   on the public API.
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
}
