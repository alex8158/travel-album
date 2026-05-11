// Media domain types (P2.T4 scope).
//
// Mirrors the columns of server/migrations/002_create_media_items.sql.
// Only the writer-facing subset is needed today — Upload_Manager INSERTS,
// no GETs yet. Reader-facing helpers (list, findById, etc.) land in
// P2.T5 along with the read API.
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
