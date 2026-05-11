// ImageWorker.thumbnail (P3.T4).
//
// Job handler registered as `image_thumbnail` on the image-channel
// executor (P3.T2). For one media row:
//   1. Resolve the original via `media_items.original_path`.
//   2. Read the bytes through the existing LocalStorageProvider.
//   3. Run sharp twice to produce `thumb.webp` (small, list grid) and
//      `preview.webp` (medium, detail page). EXIF orientation is
//      honoured (`.rotate()` with no args).
//   4. Write both derived files via `storage.putDerived` with
//      `overwrite: true` so the job is naturally idempotent.
//   5. UPSERT a row per version into `media_versions` (one for
//      thumbnail, one for preview).
//   6. Cache the original's display dimensions + the two derived
//      paths on `media_items` so the Gallery can render without
//      joining media_versions.
//
// Scope per docs/tasks.md P3.T4 — strictly thumbnail / preview.
// Explicitly NOT in scope:
//   * EXIF / camera metadata extraction (P3.T5).
//   * Hash / pHash (P5.T2).
//   * Quality scoring / blur detection (P6.T2 onwards).
//   * Image enhancement (P8) or AI refine (P10).
//
// Failure modes:
//   * Media row missing / soft-deleted → throw → executor marks job
//     `failed` with the thrown message.
//   * Media type ≠ image → throw (this handler shouldn't see other
//     types; the upload path only queues `image_thumbnail` for image
//     uploads).
//   * Original path missing → throw (unknown-type rows have NULL
//     `original_path` and should never have an image_thumbnail job).
//   * Storage read / sharp / storage write fails → throw → executor
//     marks failed. Original file is NEVER overwritten.

import type { Readable } from "node:stream";

import sharp from "sharp";

import type { Logger } from "../logger.js";
import type { MediaRepository, MediaVersionsRepository } from "../media/index.js";
import type { LocalStorageProvider } from "../storage/index.js";

import type { JobHandler } from "./handlerRegistry.js";

/** Maximum edge of the small thumbnail (list grid). */
const THUMB_MAX_EDGE = 320;
/** Maximum edge of the medium preview (detail page hero image). */
const PREVIEW_MAX_EDGE = 1600;
/** WebP quality (0..100). Conservative: small files, no visible loss at these sizes. */
const THUMB_QUALITY = 80;
const PREVIEW_QUALITY = 82;

/** Logical file names under `derived/{mediaId}/...`. Stable so the Gallery URL can be cached. */
const THUMB_FILENAME = "thumb.webp";
const PREVIEW_FILENAME = "preview.webp";

const WEBP_MIME = "image/webp";

export interface ImageThumbnailHandlerDeps {
  readonly storage: LocalStorageProvider;
  readonly mediaRepo: MediaRepository;
  readonly mediaVersionsRepo: MediaVersionsRepository;
  readonly logger: Logger;
}

/**
 * Build the `image_thumbnail` handler. Register the returned value
 * on the executor's `JobHandlerRegistry` at boot.
 */
export function makeImageThumbnailHandler(deps: ImageThumbnailHandlerDeps): JobHandler {
  return async (job) => {
    const correlation = { jobId: job.id, mediaId: job.mediaId };

    // ---- 1. Resolve media row ------------------------------------------
    const media = deps.mediaRepo.findById(job.mediaId);
    if (media === null) {
      // Either missing or soft-deleted. Either way the job has nothing
      // to operate on.
      throw new Error(`media not found or soft-deleted: ${job.mediaId}`);
    }
    if (media.type !== "image") {
      throw new Error(`media is not an image (type='${media.type}'); refusing to thumbnail`);
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

    // ---- 3. sharp: rotated metadata + two resized outputs --------------
    // Use `.rotate()` (no args) so EXIF Orientation is applied — phone
    // photos commonly land with rotation tags. The dimensions we cache
    // on media_items are the display dimensions (post-rotation), which
    // is what the Gallery / detail page actually shows.
    const meta = await sharp(sourceBuf).rotate().metadata();
    const fullWidth = meta.width;
    const fullHeight = meta.height;
    if (typeof fullWidth !== "number" || typeof fullHeight !== "number") {
      throw new Error(
        `sharp could not determine image dimensions (format=${meta.format ?? "unknown"})`,
      );
    }

    const thumb = await sharp(sourceBuf)
      .rotate()
      .resize({
        width: THUMB_MAX_EDGE,
        height: THUMB_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: THUMB_QUALITY })
      .toBuffer({ resolveWithObject: true });

    const preview = await sharp(sourceBuf)
      .rotate()
      .resize({
        width: PREVIEW_MAX_EDGE,
        height: PREVIEW_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: PREVIEW_QUALITY })
      .toBuffer({ resolveWithObject: true });

    // ---- 4. Persist derived files --------------------------------------
    // overwrite:true makes the job idempotent — a retry / replay
    // regenerates both files cleanly. Originals are NEVER written or
    // overwritten by this handler (CLAUDE.md §2.1).
    const thumbStored = await deps.storage.putDerived({
      tripId: media.tripId,
      mediaId: media.id,
      relPath: THUMB_FILENAME,
      data: thumb.data,
      overwrite: true,
    });
    const previewStored = await deps.storage.putDerived({
      tripId: media.tripId,
      mediaId: media.id,
      relPath: PREVIEW_FILENAME,
      data: preview.data,
      overwrite: true,
    });

    // ---- 5. UPSERT media_versions (one row per version) ----------------
    const now = new Date().toISOString();
    const sharpParamsJson = JSON.stringify({
      sharpVersion: sharp.versions?.vips ?? null,
      // Record the knobs the handler used so a future "regenerate"
      // task can detect parameter drift.
      thumb: { maxEdge: THUMB_MAX_EDGE, quality: THUMB_QUALITY, format: "webp" },
      preview: { maxEdge: PREVIEW_MAX_EDGE, quality: PREVIEW_QUALITY, format: "webp" },
    });
    deps.mediaVersionsRepo.upsert({
      mediaId: media.id,
      versionType: "thumbnail",
      filePath: thumbStored.logicalPath,
      mimeType: WEBP_MIME,
      width: thumb.info.width,
      height: thumb.info.height,
      fileSize: thumb.info.size,
      params: sharpParamsJson,
      now,
    });
    deps.mediaVersionsRepo.upsert({
      mediaId: media.id,
      versionType: "preview",
      filePath: previewStored.logicalPath,
      mimeType: WEBP_MIME,
      width: preview.info.width,
      height: preview.info.height,
      fileSize: preview.info.size,
      params: sharpParamsJson,
      now,
    });

    // ---- 6. Cache dimensions + derived paths on media_items -----------
    const changed = deps.mediaRepo.updateImageDerivedPaths({
      mediaId: media.id,
      width: fullWidth,
      height: fullHeight,
      previewPath: previewStored.logicalPath,
      thumbnailPath: thumbStored.logicalPath,
      updatedAt: now,
    });
    if (changed === 0) {
      // The row was soft-deleted between the read and the write —
      // worker-level race that we let through (derived files + version
      // rows still land in case the user restores the media later).
      deps.logger.warn(
        {
          ...correlation,
          mediaId: media.id,
        },
        "image_thumbnail: media row not updated (likely soft-deleted mid-job); derived files + version rows still written",
      );
    }

    deps.logger.info(
      {
        ...correlation,
        thumbPath: thumbStored.logicalPath,
        previewPath: previewStored.logicalPath,
        fullWidth,
        fullHeight,
        thumbBytes: thumb.info.size,
        previewBytes: preview.info.size,
      },
      "image_thumbnail: derived versions written",
    );
  };
}

/**
 * Drain a node Readable into a single Buffer. Used to feed sharp,
 * which prefers a Buffer over a stream when the same source has to
 * be read multiple times (metadata + two resizes here).
 */
async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}
