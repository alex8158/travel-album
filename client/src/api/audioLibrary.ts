// Audio library API client (P11.T7 — consumes the P11.T6 server
// surface).
//
// Server endpoints (P11.T6):
//
//   GET    /api/audio-library                   list (filterable)
//   POST   /api/audio-library/upload            multipart/form-data
//   POST   /api/audio-library/import-url        JSON { url, name?, tags? }
//   DELETE /api/audio-library/:id               hard delete (system row → 403)
//
// Error envelope: every non-2xx is rendered by the server's global
// error middleware as { error: { code, message, details? } }. We
// lift `error.message` into the thrown `Error.message` so call
// sites can render it without unpacking the envelope.

/** Closed enum mirroring server `audio_library.source_type`. */
export type AudioLibrarySourceType = "system" | "user" | "url_import";

/** Read projection returned by `GET /api/audio-library` (one row).
 * Mirrors server `AudioLibraryView` (audioLibraryRepository.ts). */
export interface AudioLibraryItem {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly sourceType: AudioLibrarySourceType;
  readonly filePath: string;
  readonly relativePath: string | null;
  readonly mimeType: string | null;
  readonly durationSeconds: number | null;
  readonly sizeBytes: number;
  readonly checksum: string;
  readonly isActive: boolean;
  readonly tags: string | null;
  readonly metadataJson: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Result of an upload / import-url write op. Subset of the row
 * projection because the server returns only the fields the UI
 * needs to confirm the row was created. */
export interface AudioLibraryWriteResult {
  readonly id: string;
  readonly sourceType: AudioLibrarySourceType;
  readonly displayName: string;
  readonly filePath: string;
  readonly relativePath: string | null;
  readonly mimeType: string | null;
  readonly durationSeconds: number | null;
  readonly sizeBytes: number;
  readonly checksum: string;
}

/** Result of a DELETE. */
export interface AudioLibraryDeleteResult {
  readonly id: string;
  readonly deleted: boolean;
  readonly removedFilePath: string | null;
}

export interface ListAudioLibraryOptions {
  readonly sourceType?: AudioLibrarySourceType;
  /** Default false. When true the response includes inactive rows
   * (admin / debug surface). */
  readonly includeInactive?: boolean;
}

interface ListAudioLibraryResponse {
  items: AudioLibraryItem[];
}

interface ApiErrorEnvelope {
  error?: { code?: string; message?: string };
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const envelope = (await res.json()) as ApiErrorEnvelope | null;
    if (envelope?.error?.message) return envelope.error.message;
  } catch {
    /* fall through */
  }
  return `HTTP ${res.status}`;
}

export async function listAudioLibrary(
  options: ListAudioLibraryOptions = {},
  signal?: AbortSignal,
): Promise<AudioLibraryItem[]> {
  const params = new URLSearchParams();
  if (options.sourceType !== undefined) params.set("sourceType", options.sourceType);
  if (options.includeInactive !== undefined) {
    params.set("includeInactive", String(options.includeInactive));
  }
  const query = params.toString();
  const url = `/api/audio-library${query ? `?${query}` : ""}`;

  const init: RequestInit = { headers: { Accept: "application/json" } };
  if (signal) init.signal = signal;

  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  const body = (await res.json()) as ListAudioLibraryResponse;
  return body.items;
}

/** Upload a single audio file. The `file` browser File object is
 * sent as the multipart body; optional `name` / `tags` go in the
 * query string (the server reads them from `req.query`, not from
 * additional multipart fields, per the P11.T6 route comment). */
export interface UploadAudioOptions {
  readonly file: File;
  readonly name?: string;
  readonly tags?: string;
}

export async function uploadAudio(options: UploadAudioOptions): Promise<AudioLibraryWriteResult> {
  const params = new URLSearchParams();
  if (options.name !== undefined && options.name.length > 0) params.set("name", options.name);
  if (options.tags !== undefined && options.tags.length > 0) params.set("tags", options.tags);
  const query = params.toString();
  const url = `/api/audio-library/upload${query ? `?${query}` : ""}`;

  const form = new FormData();
  form.append("file", options.file, options.file.name);

  const res = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json" },
    body: form,
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  return (await res.json()) as AudioLibraryWriteResult;
}

export interface ImportAudioUrlOptions {
  readonly url: string;
  readonly name?: string;
  readonly tags?: string;
}

export async function importAudioFromUrl(
  options: ImportAudioUrlOptions,
): Promise<AudioLibraryWriteResult> {
  const body: Record<string, string> = { url: options.url };
  if (options.name !== undefined && options.name.length > 0) body.name = options.name;
  if (options.tags !== undefined && options.tags.length > 0) body.tags = options.tags;

  const res = await fetch("/api/audio-library/import-url", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  return (await res.json()) as AudioLibraryWriteResult;
}

export async function deleteAudioLibraryItem(
  id: string,
): Promise<AudioLibraryDeleteResult> {
  const res = await fetch(`/api/audio-library/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  return (await res.json()) as AudioLibraryDeleteResult;
}
