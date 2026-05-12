// ImageWorker.metadata (P3.T5).
//
// Job handler registered as `image_metadata` on the image-channel
// executor (P3.T2). For one media row:
//   1. Resolve the original via `media_items.original_path`.
//   2. Read the bytes through the existing LocalStorageProvider.
//   3. Run exifr to extract EXIF / TIFF / IPTC fields. Returns `null`
//      when the file has no recognisable EXIF data — that's a valid
//      outcome (e.g. a screenshot or a stripped JPEG); the job still
//      succeeds and persists `{}` as the metadata payload.
//   4. Use sharp briefly to read the rotated display dimensions so
//      the media_versions row's `width` / `height` columns match the
//      values P3.T4 wrote to `media_items` from the same image.
//   5. UPSERT one row into `media_versions` with version_type =
//      `'metadata'`. The EXIF JSON is persisted in the `params`
//      column (per requirements §8.6 naming).
//
// Scope per docs/tasks.md P3.T5 — strictly EXIF read + persist.
// Explicitly NOT in scope:
//   * Triggering this job from the upload path (P2.T4 only creates
//     image_thumbnail today; chaining metadata as a follow-up step
//     is later P4 / process-chain work).
//   * Promoting EXIF fields onto media_items columns (forbidden by
//     P3.T5 prompt; reserved for the future when consumers actually
//     query specific fields).
//   * Reading GPS. CLAUDE.md §5.3 says GPS is sensitive; we pass
//     `gps: false` to exifr so we never load it into memory. A
//     future task can opt in once we have a deliberate policy.
//
// Idempotency: re-running the same `image_metadata` job for the same
// media UPSERTs the existing row (UNIQUE constraint on
// (media_id, version_type) guarantees one row per media); a fresh
// EXIF read either yields the same JSON or a corrected JSON (e.g. if
// the original was replaced — which is itself forbidden by CLAUDE.md
// §2.1, so practically the JSON is stable across runs).
//
// Failure modes mirror P3.T4:
//   * Media row missing / soft-deleted → throw → executor marks job
//     `failed`.
//   * Media type ≠ image → throw.
//   * Original path missing or file missing → throw.
//   * `exifr` library error → throw. NB: an image with no EXIF is
//     NOT an error; exifr returns null and we persist `{}`.

import type { Readable } from "node:stream";

import exifr from "exifr";
import sharp from "sharp";

import type { Logger } from "../logger.js";
import type { MediaRepository, MediaVersionsRepository } from "../media/index.js";
import type { LocalStorageProvider } from "../storage/index.js";

import type { JobHandler } from "./handlerRegistry.js";

/** application/json — semantically describes the `params` payload, not a separate JSON file. */
const METADATA_MIME = "application/json";

/**
 * exifr parse options. Defaults pulled in IPTC + XMP + thumbnail-IFD
 * data which we do not need today; turning them off keeps the
 * payload small and the parse fast. `gps: false` is deliberate (see
 * file-header note on CLAUDE.md §5.3).
 */
const EXIFR_OPTIONS = {
  tiff: true,
  exif: true,
  gps: false,
  iptc: false,
  xmp: false,
  jfif: true,
  ifd1: false,
  // Default: parse silently when no EXIF is present — return null
  // rather than throwing. exifr already behaves this way; declaring
  // explicitly so the intent is visible in this file.
  silentErrors: true,
} as const;

export interface ImageMetadataHandlerDeps {
  readonly storage: LocalStorageProvider;
  readonly mediaRepo: MediaRepository;
  readonly mediaVersionsRepo: MediaVersionsRepository;
  readonly logger: Logger;
}

/**
 * Build the `image_metadata` handler. Register the returned value
 * on the executor's `JobHandlerRegistry` at boot.
 */
export function makeImageMetadataHandler(deps: ImageMetadataHandlerDeps): JobHandler {
  return async (job) => {
    const correlation = { jobId: job.id, mediaId: job.mediaId };

    // ---- 1. Resolve media row ------------------------------------------
    const media = deps.mediaRepo.findById(job.mediaId);
    if (media === null) {
      throw new Error(`media not found or soft-deleted: ${job.mediaId}`);
    }
    if (media.type !== "image") {
      throw new Error(`media is not an image (type='${media.type}'); refusing to read metadata`);
    }
    if (media.originalPath === null) {
      throw new Error("media has no original_path; cannot read source bytes");
    }

    // ---- 2. Read original bytes ----------------------------------------
    const sourceStream = await deps.storage.read(media.originalPath);
    const sourceBuf = await streamToBuffer(sourceStream);
    if (sourceBuf.length === 0) {
      throw new Error("original file is empty");
    }

    // ---- 3. exifr: EXIF / TIFF / IPTC fields ---------------------------
    // Returns `null` when no EXIF data is present (e.g. screenshots,
    // freshly re-encoded JPEGs with no metadata block). We treat that
    // as a successful job with an empty payload rather than a
    // failure — the worker's job is "read whatever's there", not
    // "demand that EXIF be present".
    let rawExif: unknown;
    try {
      rawExif = await exifr.parse(sourceBuf, EXIFR_OPTIONS);
    } catch (err) {
      // exifr really does throw for truly broken inputs even with
      // silentErrors: true (e.g. when sourceBuf is not an image at
      // all). Surface to the executor as a job failure with a clear
      // message rather than letting the raw library error escape.
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`exifr failed to parse source: ${message}`);
    }
    const metadata = isPlainObject(rawExif) ? rawExif : {};
    const metadataJson = JSON.stringify(metadata, exifReplacer);

    // ---- 4. sharp: rotated display dimensions --------------------------
    // We could try to read these from EXIF too (e.g. ExifImageWidth)
    // but EXIF dimensions are pre-rotation and not always present.
    // sharp().rotate().metadata() always gives the displayed dims
    // and matches what P3.T4 writes to media_items.
    const meta = await sharp(sourceBuf).rotate().metadata();
    const width = typeof meta.width === "number" ? meta.width : null;
    const height = typeof meta.height === "number" ? meta.height : null;

    // ---- 5. UPSERT media_versions --------------------------------------
    // file_path points at the original — the metadata "version" is a
    // record ABOUT that file, not a separate derived artefact. Using
    // a fictional path like `derived/{mediaId}/metadata.json` would
    // imply a file the /storage route could serve, which we don't
    // write here. Pointing at the original is honest.
    // mime_type='application/json' describes the format of `params`,
    // following the user-spec convention.
    // file_size stays NULL because there is no separate metadata file
    // on disk; size_bytes "of what" would be undefined.
    const now = new Date().toISOString();
    deps.mediaVersionsRepo.upsert({
      mediaId: media.id,
      versionType: "metadata",
      filePath: media.originalPath,
      mimeType: METADATA_MIME,
      width,
      height,
      fileSize: null,
      params: metadataJson,
      now,
    });

    const exifFieldCount = Object.keys(metadata).length;
    deps.logger.info(
      {
        ...correlation,
        originalPath: media.originalPath,
        exifFieldCount,
        // Never log the full payload — CLAUDE.md §5.3 says no full
        // EXIF GPS / sensitive fields in logs. Field count + flag is
        // enough for diagnostics.
        hadExif: exifFieldCount > 0,
        width,
        height,
      },
      "image_metadata: metadata row upserted",
    );
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Drain a node Readable into a single Buffer. Same helper used by
 * imageThumbnailWorker — duplicated here to avoid forcing a shared
 * utils module just for two callers.
 */
async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * JSON replacer used for `JSON.stringify(metadata, exifReplacer)`.
 * Handles values that the default replacer would either choke on or
 * write as `null`:
 *   * Dates → ISO 8601 strings (exifr returns DateTimeOriginal as Date).
 *   * Buffers / typed arrays → omitted (binary, not useful in JSON).
 *   * BigInts → strings (JSON has no BigInt).
 *   * `undefined` values → omitted (default behaviour, made explicit).
 * Anything else passes through untouched.
 */
function exifReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return undefined; // skip raw binary blobs
  if (typeof value === "undefined") return undefined;
  return value;
}
