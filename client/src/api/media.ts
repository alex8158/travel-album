// Media API client (P2.T6 scope: upload only).
//
// Mirrors the server's per-file result shape from
// server/src/upload/types.ts. Currently kept in sync by hand; an
// auto-generated client (e.g. via openapi-typescript) is a later
// concern (R-14 in P1 risks).
//
// The endpoint is POST /api/trips/:tripId/media/upload — the route
// landed in P2.T4. Frontend reads (Gallery / detail) come in P2.T7+
// and will add the corresponding fetch helpers; this file deliberately
// holds only the upload helper for P2.T6.

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
