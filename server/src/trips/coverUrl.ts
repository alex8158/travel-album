// Derived trip cover URL (P3.T8).
//
// Pure response-layer enrichment — the result is NOT persisted on
// the `trips.cover_media_id` column. design.md §7.7 prescribes a
// staged cover strategy:
//
//   * stage 1 (Trip CRUD only)         → static placeholder
//   * stage 3 (after thumbnails)       → derive from the trip's
//                                         oldest thumbnailed image
//                                         when `cover_media_id` is NULL
//   * stage 6 (after quality scoring)  → P6.T7 will populate
//                                         `cover_media_id` and the
//                                         response layer falls
//                                         through to it
//
// This module owns the stage-3 fallback only. P6.T7 will write
// `cover_media_id` in the DB; this helper continues to honour an
// explicit cover (priority 1 below) so the persisted choice wins.
//
// Three priorities, evaluated top-down:
//
//   1. Explicit pin: `trip.coverMediaId` is set AND that media row
//      is an active image AND its thumbnail has been generated.
//      Use its thumbnail.
//   2. Derived first-image: trip has at least one active image with
//      a thumbnail_path. Use the oldest one (created_at ASC).
//   3. Placeholder: nothing else fits. Return the static SVG bundled
//      in client/public/. Same URL works in Vite dev (served by
//      Vite from client/public/) and in production (served alongside
//      the built client assets).
//
// The "no thumbnail yet" sub-case in priority 1 deliberately falls
// through to priority 2 — the user-pinned media is the canonical
// cover, but if its thumbnail worker has not run, we still show
// SOMETHING (the first thumbnailed image) rather than the bare
// placeholder. That preserves user intent (the pin is sticky in the
// DB, will surface as soon as its thumbnail lands) without making
// the UI look broken in the meantime.

import type { MediaRepository } from "../media/index.js";
import type { Trip } from "./tripTypes.js";

/** Static asset served by Vite dev / production from client/public/. */
export const PLACEHOLDER_COVER_URL = "/placeholder-cover.svg";

/** Storage path prefix shared with P3.T1's `/storage/*` route. */
const STORAGE_URL_PREFIX = "/storage/";

export function deriveCoverUrl(trip: Trip, mediaRepo: MediaRepository): string {
  // Priority 1: explicit cover_media_id, if the pinned media has a
  // thumbnail. Soft-deleted / unknown / video media or one without
  // a thumbnail yet → fall through.
  if (trip.coverMediaId !== null) {
    const pinned = mediaRepo.findById(trip.coverMediaId);
    if (
      pinned !== null &&
      pinned.type === "image" &&
      pinned.thumbnailPath !== null &&
      pinned.thumbnailPath.length > 0
    ) {
      return toStorageUrl(pinned.thumbnailPath);
    }
  }
  // Priority 2: derived — first thumbnailed image in this trip.
  const path = mediaRepo.findFirstThumbnailPath(trip.id);
  if (path !== null && path.length > 0) {
    return toStorageUrl(path);
  }
  // Priority 3: placeholder.
  return PLACEHOLDER_COVER_URL;
}

function toStorageUrl(logicalPath: string): string {
  return `${STORAGE_URL_PREFIX}${logicalPath}`;
}
