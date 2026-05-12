// Media API client (P2.T6 upload + P2.T7 list read + P3.T6 detail).
//
// Mirrors the server's per-file upload result (server/src/upload/types.ts)
// and the read projection from MediaService (server/src/media/
// mediaTypes.ts → MediaItem / MediaVersion / MediaDetail).
// Kept in sync by hand; an auto-generated client (e.g. via
// openapi-typescript) is a later concern (R-14 in P1 risks).
//
// Endpoints used:
//   * POST /api/trips/:tripId/media/upload     (P2.T4 / P2.T6)
//   * GET  /api/trips/:tripId/media            (P2.T5 / P2.T7)
//   * GET  /api/media/:id                      (P2.T5 + P3.T6 — now
//                                               returns {media, versions})

/**
 * Three discrete per-file outcomes from the upload endpoint:
 *
 *   * "accepted"          — image / video classified, original saved,
 *                           media_items + processing_jobs created.
 *   * "rejected_unknown"  — classifier returned `unknown`. A
 *                           media_items row with type='unknown' was
 *                           still created so the file is visible in
 *                           the trip, but no original was kept and no
 *                           job was scheduled.
 *   * "failed"            — upload-time failure (too large, empty,
 *                           extension missing, storage / DB error).
 *                           Nothing was persisted.
 */
export type UploadItemStatus = "accepted" | "rejected_unknown" | "failed";

export interface UploadAcceptedItem {
  readonly status: "accepted";
  readonly fieldName: string;
  readonly originalFilename: string;
  readonly mediaId: string;
  readonly type: "image" | "video";
  readonly extension: string;
  readonly mimeType: string | null;
  readonly fileSize: number;
  readonly originalPath: string;
  readonly jobId: string;
  readonly jobType: string;
  readonly reason: string;
}

export interface UploadRejectedUnknownItem {
  readonly status: "rejected_unknown";
  readonly fieldName: string;
  readonly originalFilename: string;
  readonly mediaId: string;
  readonly type: "unknown";
  readonly extension: string | null;
  readonly mimeType: string | null;
  readonly fileSize: number;
  readonly reason: string;
}

export interface UploadFailedItem {
  readonly status: "failed";
  readonly fieldName: string;
  readonly originalFilename: string;
  readonly reason: string;
  readonly error: { readonly code: string; readonly message: string };
}

export type UploadItem = UploadAcceptedItem | UploadRejectedUnknownItem | UploadFailedItem;

export interface UploadResponse {
  readonly results: readonly UploadItem[];
}

interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId?: string;
    details?: unknown;
  };
}

/**
 * Upload one or more files to a trip.
 *
 * Sends a single multipart/form-data POST with every file in the
 * `files` field. The backend (busboy + UploadService, P2.T4) processes
 * each part serially and returns a `results[]` array with the same
 * length as the inputs — per-file errors do not affect siblings.
 *
 * Throws on whole-request failures:
 *   * 400 — empty payload, invalid tripId
 *   * 404 — trip not found / soft-deleted
 *
 * The thrown `Error.message` is lifted from the unified error
 * envelope's `error.message` when present.
 */
export async function uploadMedia(
  tripId: string,
  files: readonly File[],
  signal?: AbortSignal,
): Promise<UploadResponse> {
  const form = new FormData();
  for (const file of files) {
    // Field name "files" matches the smoke fixtures. The backend
    // accepts any name (uploadParser.ts), so this is informational.
    form.append("files", file, file.name);
  }
  const init: RequestInit = {
    method: "POST",
    body: form,
    // Do NOT set Content-Type manually — the browser appends the
    // multipart boundary parameter to the header for us. Setting it
    // by hand strips the boundary and busboy will refuse the request.
    headers: { Accept: "application/json" },
  };
  if (signal) init.signal = signal;

  const res = await fetch(`/api/trips/${encodeURIComponent(tripId)}/media/upload`, init);
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  return (await res.json()) as UploadResponse;
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const envelope = (await res.json()) as ApiErrorEnvelope | null;
    if (envelope?.error?.message) return envelope.error.message;
  } catch {
    // Non-JSON error body; fall through.
  }
  return `HTTP ${res.status}`;
}

// ---------------------------------------------------------------------------
// Read side (P2.T7)
// ---------------------------------------------------------------------------

/**
 * Closed set of values returned in `MediaItem.type`. Same vocabulary as
 * the server's `media_items_type_enum` CHECK.
 */
export type MediaType = "image" | "video" | "unknown";

/**
 * Lifecycle states from media_items_status_enum (CLAUDE.md §4.1).
 */
export type MediaStatus =
  | "uploaded"
  | "processing"
  | "processed"
  | "failed"
  | "archived"
  | "deleted";

export type MediaUserDecision = "keep" | "remove" | "undecided";

/**
 * Read projection returned by GET /api/trips/:tripId/media (and the
 * single-row GET /api/media/:id, when that's wired later). Mirrors
 * `MediaItem` in server/src/media/mediaTypes.ts. Hash columns are
 * intentionally absent on the server side and therefore here too.
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

interface ListMediaResponse {
  media: MediaItem[];
}

/**
 * Pagination knobs accepted by the list endpoint. Both are optional;
 * the server defaults to `limit=50 / offset=0`. The route layer caps
 * limit at 100. The gallery uses these only minimally (no in-UI
 * pagination yet — P2.T7 is the basic grid).
 */
export interface FetchTripMediaOptions {
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * Fetch the active media list for a trip.
 *
 * Throws on whole-request failures:
 *   * 400 — invalid tripId / pagination
 *   * 404 — trip missing or soft-deleted
 *
 * The thrown `Error.message` is lifted from the unified error
 * envelope's `error.message` when present.
 */
export async function fetchTripMedia(
  tripId: string,
  options: FetchTripMediaOptions = {},
  signal?: AbortSignal,
): Promise<MediaItem[]> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.offset !== undefined) params.set("offset", String(options.offset));
  const query = params.toString();
  const url = `/api/trips/${encodeURIComponent(tripId)}/media${query ? `?${query}` : ""}`;

  const init: RequestInit = { headers: { Accept: "application/json" } };
  if (signal) init.signal = signal;

  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  const body = (await res.json()) as ListMediaResponse;
  return body.media;
}

/**
 * One row of `media_versions`. Mirrors the server-side `MediaVersion`
 * read projection. `params` is the raw JSON string the worker wrote;
 * consumers parse it on demand (the detail page parses the metadata
 * version's params to render an EXIF table).
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
 * Full detail bundle returned by `GET /api/media/:id`. Top-level
 * shape is `{ media, versions }` — list endpoints stay slim,
 * detail endpoint carries the related versions for one-shot render.
 */
export interface MediaDetail {
  readonly media: MediaItem;
  readonly versions: readonly MediaVersion[];
}

/**
 * Fetch the full detail bundle for one media id.
 *
 * Throws on whole-request failures:
 *   * 400 — invalid id format
 *   * 404 — media missing or soft-deleted
 */
export async function fetchMediaDetail(id: string, signal?: AbortSignal): Promise<MediaDetail> {
  const init: RequestInit = { headers: { Accept: "application/json" } };
  if (signal) init.signal = signal;

  const res = await fetch(`/api/media/${encodeURIComponent(id)}`, init);
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  return (await res.json()) as MediaDetail;
}
