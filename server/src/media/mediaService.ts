// MediaService — business surface for the media read API (P2.T5).
//
// Mirrors TripService's shape:
//   * Every public method takes `unknown` so route handlers (and
//     future CLI / smoke callers) cannot bypass the zod pass.
//   * Successful returns are always the public `MediaItem` shape.
//   * Misses raise AppError subclasses (NotFoundError) so the global
//     error middleware renders the unified envelope without per-route
//     try/catch.
//
// `listMediaForTrip` deliberately verifies the trip exists / is not
// soft-deleted before touching media_items. The alternative (silent
// empty array) would hide bad trip ids; with the trip check we get a
// 404 that mirrors `GET /api/trips/:id` and matches how Upload_Manager
// guards uploads (P2.T4). Note that this depends on `TripService` for
// the existence check — the dependency direction is media → trips,
// never the other way.

import { NotFoundError } from "../errors/AppError.js";
import { entityIdSchema, type TripService } from "../trips/index.js";
import { parseOrThrow } from "../util/zodParse.js";

import { MediaRepository } from "./mediaRepository.js";
import { listMediaOptionsSchema } from "./mediaSchemas.js";
import type { MediaItem } from "./mediaTypes.js";

export class MediaService {
  constructor(
    private readonly repo: MediaRepository,
    private readonly tripService: TripService,
  ) {}

  /**
   * Fetch a single media row by id. Active rows only — soft-deleted
   * rows surface as NotFoundError (HTTP 404) just like soft-deleted
   * trips.
   */
  getMediaById(id: unknown): MediaItem {
    const safeId = parseOrThrow(entityIdSchema, id, "id");
    const media = this.repo.findById(safeId);
    if (!media) {
      throw new NotFoundError(`Media not found: ${safeId}`, { id: safeId });
    }
    return media;
  }

  /**
   * Page through the media items of a single trip.
   *
   * Throws NotFoundError when the trip itself does not exist or has
   * been soft-deleted, by delegating the check to `TripService`.
   * Returns an empty array when the trip exists but has no media yet.
   */
  listMediaForTrip(tripId: unknown, options: unknown = {}): MediaItem[] {
    const safeTripId = parseOrThrow(entityIdSchema, tripId, "tripId");
    // 404 on missing / soft-deleted trip. Reuses TripService.getTripById
    // so the message and error code match `GET /api/trips/:id`.
    this.tripService.getTripById(safeTripId);
    const opts = parseOrThrow(listMediaOptionsSchema, options, "list options");
    return this.repo.list(safeTripId, opts);
  }
}
