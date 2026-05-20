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
 * P8.T4 — closed set of user-selectable active versions. Mirrors the
 * server-side `MediaActiveVersionType` (migration 010's CHECK enum
 * on `media_items.active_version_type`). Operational version_types
 * (`thumbnail` / `preview` / `metadata` / `video_*`) are NOT valid
 * here — they're internal worker artefacts, not user choices.
 */
export type MediaActiveVersionType = "original" | "enhanced" | "ai_refined";

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
  /**
   * P8.T4 — the version the user has currently selected for display.
   * Optional on the wire because older cached responses may not
   * carry the field (the server always sets it post-migration 010;
   * the optional shape just protects deploys mid-rollout). Readers
   * treat `undefined` the same as `'original'` (the schema-level
   * default).
   */
  readonly activeVersionType?: MediaActiveVersionType;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  /**
   * P6.T6: per-media quality analysis projection joined from the
   * `media_analysis` table. `null` when no analysis row exists yet
   * (the per-dimension workers haven't run on this media). Optional
   * on the wire because older clients / cached responses may not
   * carry it; readers treat `undefined` the same as `null`.
   */
  readonly analysis?: MediaAnalysisProjection | null;
}

/**
 * Quality / blur / colour signals surfaced to the gallery + detail
 * UI. Mirrors `MediaAnalysisProjection` in
 * `server/src/media/mediaTypes.ts`. All fields are optional /
 * nullable because the workers populate them progressively:
 *   - blur worker fills `sharpnessScore` + `isBlurry` (P6.T2)
 *   - exposure worker fills `exposureScore` (P6.T3)
 *   - colour worker fills `colorScore` + may add tags to `labels`
 *     (P6.T4)
 *   - finalize worker fills `qualityScore` + the composite `reason`
 *     (P6.T5 first half)
 * `isRecommended` is in the schema but no worker writes to it yet —
 * the per-group recommendation lives on `duplicate_group_items`.
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

interface ListMediaResponse {
  media: MediaItem[];
}

/**
 * Pagination knobs accepted by the list endpoint. Both are optional;
 * the server defaults to `limit=50 / offset=0`. The route layer caps
 * limit at 100. The gallery uses these only minimally (no in-UI
 * pagination yet — P2.T7 is the basic grid).
 *
 * `onlyDeleted` (P7.T4) flips the read to recycle-bin mode: the
 * server returns ONLY soft-deleted media for this trip, ordered by
 * `deleted_at DESC` (most-recently-deleted first). Default is false
 * so the gallery still hides deleted rows.
 */
export interface FetchTripMediaOptions {
  readonly limit?: number;
  readonly offset?: number;
  readonly onlyDeleted?: boolean;
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
  if (options.onlyDeleted) params.set("onlyDeleted", "true");
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

/**
 * Outcome of one job-type slot from `POST /api/media/:id/reprocess`.
 * Mirrors `ReprocessOutcome` on the server side.
 */
export type ReprocessOutcome = "created" | "reset" | "skipped";

export interface ReprocessJobResult {
  readonly jobType: string;
  readonly outcome: ReprocessOutcome;
  readonly jobId: string;
  readonly reason?: string;
}

export interface ReprocessResult {
  readonly mediaId: string;
  readonly results: readonly ReprocessJobResult[];
}

/**
 * Re-queue the image-channel jobs for one media (P3.T7). Each of
 * `image_thumbnail` / `image_metadata` independently resolves to
 * `created` / `reset` / `skipped`.
 *
 * Throws on whole-request failures:
 *   * 400 — invalid id format / media not an image
 *   * 404 — media missing or soft-deleted
 */
export async function reprocessMedia(id: string): Promise<ReprocessResult> {
  const res = await fetch(`/api/media/${encodeURIComponent(id)}/reprocess`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  return (await res.json()) as ReprocessResult;
}

/**
 * P7.T1 — soft-delete one media. Server flips `deleted_at` +
 * `status = 'deleted'`, clears any `duplicate_groups.recommended_media_id`
 * pointing at this media, and clears any `trips.cover_media_id`
 * pointing at it (releasing the user-pin so auto-cover can pick a
 * substitute). Original / preview / thumbnail files on disk are
 * NOT removed.
 *
 * Idempotent: re-deleting an already-soft-deleted media returns
 * `alreadyDeleted: true` with no further side effects. 404 only
 * when the media row is genuinely missing.
 */
export interface SoftDeleteMediaResult {
  readonly mediaId: string;
  readonly deleted: boolean;
  readonly alreadyDeleted: boolean;
  readonly clearedRecommendedGroups: readonly string[];
  readonly clearedCoverTrips: readonly string[];
}

export async function softDeleteMedia(id: string): Promise<SoftDeleteMediaResult> {
  const res = await fetch(`/api/media/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  return (await res.json()) as SoftDeleteMediaResult;
}

/**
 * P7.T2 — restore a soft-deleted media. Server clears `deleted_at`,
 * resets `status` to `'processed'`, and enqueues a trip-scope
 * `quality_selector_run` job so the restored media re-participates
 * in dedup ranking + auto-cover selection (skipping user-confirmed
 * groups per CLAUDE.md §3.9).
 *
 * Idempotent: re-restoring an already-active media returns
 * `alreadyRestored: true` with `qualitySelectorEnqueued: false`.
 * 404 only when the row is genuinely missing.
 *
 * Note: this client doesn't currently expose a UI for restore — the
 * recycle-bin view lands in P7.T4. Callers in V1 invoke this from
 * scripts / admin tools / future UI surfaces.
 */
export interface RestoreMediaResult {
  readonly mediaId: string;
  readonly tripId: string;
  readonly restored: boolean;
  readonly alreadyRestored: boolean;
  readonly qualitySelectorEnqueued: boolean;
}

export async function restoreMedia(id: string): Promise<RestoreMediaResult> {
  const res = await fetch(`/api/media/${encodeURIComponent(id)}/restore`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  return (await res.json()) as RestoreMediaResult;
}

// ---------------------------------------------------------------------------
// P8 — Enhance + version switching (T1 / T4)
// ---------------------------------------------------------------------------

/**
 * P8.T1 — enqueue a fresh `image_enhance` job for one media. Mirrors
 * the server's `EnhanceMediaResult` envelope.
 *
 * The job is asynchronous from the client's perspective: the response
 * confirms the enqueue (`outcome: 'created' | 'reset' | 'skipped'`)
 * but the sharp pipeline runs on the image channel after the
 * executor's next tick. The UI typically shows "Submitted — refresh
 * in a moment" and lets the user re-check Versions later.
 *
 * Throws on whole-request failures:
 *   * 400 — invalid id / non-image media
 *   * 404 — media missing or soft-deleted
 */
export type EnhanceOutcome = "created" | "reset" | "skipped";

export interface EnhanceMediaResult {
  readonly mediaId: string;
  readonly jobType: string;
  readonly outcome: EnhanceOutcome;
  readonly jobId: string;
  readonly reason?: string;
}

export async function enhanceMedia(id: string): Promise<EnhanceMediaResult> {
  const res = await fetch(`/api/media/${encodeURIComponent(id)}/enhance`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  return (await res.json()) as EnhanceMediaResult;
}

/**
 * P8.T4 — one user-selectable version entry. Mirrors the server-side
 * `MediaVersionView` projection. `id` is `null` for the synthesized
 * 'original' entry (no `media_versions` row exists for it — it's
 * the implicit base). `filePath` is a logical path inside the
 * storage root (never an absolute filesystem path).
 */
export interface MediaVersionView {
  readonly id: string | null;
  readonly versionType: MediaActiveVersionType;
  readonly isActive: boolean;
  readonly filePath: string;
  readonly mimeType: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly fileSize: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * P8.T4 — response envelope of `GET /api/media/:id/versions`.
 * `activeVersionType` is surfaced at top level so callers don't have
 * to scan `versions[]` to find the active one.
 */
export interface MediaVersionsView {
  readonly mediaId: string;
  readonly activeVersionType: MediaActiveVersionType;
  readonly versions: readonly MediaVersionView[];
}

/**
 * Fetch the user-selectable versions for one media (P8.T4). Returns
 * the synthesized 'original' entry plus any 'enhanced' / 'ai_refined'
 * rows; operational types (thumbnail / preview / metadata / video_*)
 * are filtered out at the server.
 *
 * Throws on whole-request failures:
 *   * 400 — invalid id format
 *   * 404 — media missing or soft-deleted (P7 recycle-bin contract)
 */
export async function fetchMediaVersions(
  id: string,
  signal?: AbortSignal,
): Promise<MediaVersionsView> {
  const init: RequestInit = { headers: { Accept: "application/json" } };
  if (signal) init.signal = signal;
  const res = await fetch(`/api/media/${encodeURIComponent(id)}/versions`, init);
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  return (await res.json()) as MediaVersionsView;
}

/**
 * P8.T4 — outcome of `POST /api/media/:id/select-version`. Server
 * writes `media_items.active_version_type` and reports the previous
 * value + an `alreadyActive` flag (true means the user re-selected
 * the already-current version; no DB write happened but the response
 * still looks like success for idempotent UX).
 */
export interface SelectVersionResult {
  readonly mediaId: string;
  readonly activeVersionType: MediaActiveVersionType;
  readonly previousVersionType: MediaActiveVersionType;
  readonly alreadyActive: boolean;
}

/**
 * Switch the user-selected active version for one media (P8.T4).
 *
 * Throws on whole-request failures:
 *   * 400 — invalid versionType / version doesn't exist for this media
 *   * 404 — media missing or soft-deleted
 */
export async function selectMediaVersion(
  id: string,
  versionType: MediaActiveVersionType,
): Promise<SelectVersionResult> {
  const res = await fetch(`/api/media/${encodeURIComponent(id)}/select-version`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ versionType }),
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  return (await res.json()) as SelectVersionResult;
}
