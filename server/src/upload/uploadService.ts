// Upload_Manager (P2.T4).
//
// Orchestrates the upload pipeline laid out in docs/design.md §6.1 / §6.2:
//
//   1. Parse multipart body → stream each file part to a temp dir,
//      capturing head bytes + size + truncation flag.
//   2. For each staged file:
//      a. Classify via P2.T3 (filename + declared MIME + head bytes).
//      b. unknown → record a media_items row with type='unknown' and
//         throw the bytes away (design §6.2.3). No processing job.
//      c. image / video → write the bytes to
//         `trips/{tripId}/originals/{mediaId}.{ext}` via the storage
//         provider, then atomically INSERT media_items + processing_jobs
//         in a single SQLite transaction. The initial job is
//         `image_thumbnail` for images and `video_metadata` for videos
//         (design §6.2 / §7.1 / §8.1).
//   3. Cleanup the temp dir unconditionally.
//
// Failure handling (per the user spec for this turn):
//
//   * Trip not found / soft-deleted → NotFoundError. Whole-request
//     failure: respond 404, no files touched.
//   * Empty multipart payload → BadRequestError. Whole-request failure.
//   * Per-file staging failure (truncated, IO error, zero bytes,
//     classifier accepted but extension is null) → "failed" entry in
//     the per-file results array; no media_items row, no original on
//     disk.
//   * Storage `putOriginal` failure → "failed" entry; no media_items
//     row, no original on disk (putOriginal cleans up its own
//     half-writes).
//   * DB transaction failure AFTER the original was written →
//     compensating `storage.remove()` so the originals tree never holds
//     a file whose row was rolled back. The compensating remove being
//     itself impossible would be a deeper inconsistency; we log it but
//     still surface the original DB error to the caller.
//
// The class itself is stateless beyond its dependencies; multiple
// concurrent uploads are safe to run against the same instance.

import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import type { Readable } from "node:stream";

import { classify, type ClassifyOptions } from "../classify/index.js";
import type { SqliteDatabase } from "../db/connection.js";
import { BadRequestError } from "../errors/AppError.js";
import type { JobRepository } from "../jobs/index.js";
import type { Logger } from "../logger.js";
import type { MediaRepository } from "../media/index.js";
import type { LocalStorageProvider } from "../storage/index.js";
import type { TripService } from "../trips/index.js";

import { parseUpload, type StagedFile } from "./uploadParser.js";
import type {
  UploadAcceptedItem,
  UploadFailedItem,
  UploadItem,
  UploadRejectedUnknownItem,
  UploadResult,
} from "./types.js";

/**
 * Initial pending job type per design.md §6.2 / §7.1 / §8.1. Other
 * jobs in the chain (metadata, hash, dedup, quality, video_cover, etc.)
 * are seeded by their predecessor workers, not by the upload path.
 */
const INITIAL_JOB_TYPE: Record<"image" | "video", string> = {
  image: "image_thumbnail",
  video: "video_metadata",
} as const;

export interface UploadServiceDeps {
  readonly db: SqliteDatabase;
  readonly storage: LocalStorageProvider;
  readonly tripService: TripService;
  readonly mediaRepo: MediaRepository;
  readonly jobRepo: JobRepository;
  /** Wired from config.upload.allowed{Image,Video}Ext (see index.ts). */
  readonly classifyOptions: ClassifyOptions;
  /** Wired from config.upload.maxFileSize. Per-file limit in bytes. */
  readonly maxFileSize: number;
  readonly logger: Logger;
}

export interface HandleUploadArgs {
  readonly tripId: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Readable;
}

export class UploadService {
  constructor(private readonly deps: UploadServiceDeps) {}

  /**
   * Drive a single multipart upload to completion. Resolves with the
   * per-file results array; throws AppError subclasses on whole-request
   * failures (trip missing, empty payload, multipart parse error).
   */
  async handleUpload(args: HandleUploadArgs): Promise<UploadResult> {
    // Whole-request guard: refuse uploads against a missing / soft-
    // deleted trip up front. TripService.getTripById throws
    // NotFoundError which the route handler converts to 404.
    this.deps.tripService.getTripById(args.tripId);

    const parse = await parseUpload({
      headers: args.headers,
      body: args.body,
      maxFileSize: this.deps.maxFileSize,
    });

    try {
      if (parse.files.length === 0) {
        throw new BadRequestError(
          "no file parts found in multipart payload (expected at least one file)",
        );
      }
      const results: UploadItem[] = [];
      // Serial processing keeps disk + DB activity sequential for the
      // first version; the Worker pool (P4) is where real parallelism
      // kicks in. Per-file isolation does not require parallel awaits.
      for (const file of parse.files) {
        const item = await this.processOne(args.tripId, file);
        results.push(item);
      }
      return { results };
    } finally {
      await parse.cleanup();
    }
  }

  // -------------------------------------------------------------------------
  // private
  // -------------------------------------------------------------------------

  private async processOne(tripId: string, file: StagedFile): Promise<UploadItem> {
    // Upstream IO failure (rare: disk full, etc.). Surface as failed.
    if (file.error) {
      return failedItem(file, file.error);
    }

    // Size enforcement: busboy marked the part truncated when it hit
    // the configured maxFileSize. The bytes on disk are an incomplete
    // prefix and must not be persisted.
    if (file.truncated) {
      return failedItem(file, {
        code: "UPLOAD_FILE_TOO_LARGE",
        message: `file exceeds the configured maximum size (${this.deps.maxFileSize} bytes)`,
      });
    }

    // Zero-byte body. classify() would reject this too (head is empty
    // → no magic match → unknown), but failing early gives the user a
    // clearer reason than "magic bytes do not match".
    if (file.size === 0) {
      return failedItem(file, {
        code: "UPLOAD_EMPTY_FILE",
        message: "uploaded file is empty (0 bytes)",
      });
    }

    const classified = classify(
      {
        filename: file.originalFilename,
        declaredMimeType: file.declaredMimeType.length > 0 ? file.declaredMimeType : undefined,
        headBytes: file.headBytes,
      },
      this.deps.classifyOptions,
    );

    const mediaId = randomUUID();
    const now = new Date().toISOString();

    if (classified.type === "unknown") {
      return this.persistUnknown(file, tripId, mediaId, now, classified.reason, classified);
    }

    // Defensive: classifier guarantees an extension for known types
    // *when the filename had one*, but a magic-matched file with no
    // extension at all still passes today (extension=null). We can't
    // persist that to originals/{mediaId}.{ext} — fail this file.
    if (classified.extension === null) {
      return failedItem(file, {
        code: "UPLOAD_MISSING_EXTENSION",
        message:
          "filename has no extension; cannot persist original (please supply a filename with a valid extension)",
      });
    }

    return this.persistKnown(
      file,
      tripId,
      mediaId,
      now,
      classified.type,
      classified.extension,
      classified.mimeType,
      classified.reason,
    );
  }

  /**
   * Persist a media_items row for a classifier-rejected file. No
   * original is written to storage (design §6.2.3) and no processing
   * job is created (the file will never be processed).
   */
  private persistUnknown(
    file: StagedFile,
    tripId: string,
    mediaId: string,
    now: string,
    reason: string,
    classified: { readonly extension: string | null; readonly mimeType: string | null },
  ): UploadItem {
    try {
      this.deps.mediaRepo.insert({
        id: mediaId,
        tripId,
        type: "unknown",
        originalPath: null,
        fileSize: file.size,
        mimeType: classified.mimeType,
        extension: classified.extension,
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      return failedItem(file, {
        code: "MEDIA_INSERT_FAILED",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    const item: UploadRejectedUnknownItem = {
      status: "rejected_unknown",
      fieldName: file.fieldName,
      originalFilename: file.originalFilename,
      mediaId,
      type: "unknown",
      extension: classified.extension,
      mimeType: classified.mimeType,
      fileSize: file.size,
      reason,
    };
    return item;
  }

  /**
   * Persist an image/video upload:
   *   1. Stream the staged bytes into `originals/{mediaId}.{ext}` via
   *      the storage provider.
   *   2. In a single SQLite transaction, INSERT the media_items row
   *      and the initial pending job. Either both land or neither does.
   *   3. If the transaction throws, compensate by removing the
   *      original from storage so no orphan file lingers.
   */
  private async persistKnown(
    file: StagedFile,
    tripId: string,
    mediaId: string,
    now: string,
    type: "image" | "video",
    extension: string,
    mimeType: string | null,
    classifyReason: string,
  ): Promise<UploadItem> {
    let originalPath: string;
    try {
      const stored = await this.deps.storage.putOriginal({
        tripId,
        mediaId,
        extension,
        data: createReadStream(file.stagingPath),
      });
      originalPath = stored.logicalPath;
    } catch (err) {
      return failedItem(file, {
        code: "STORAGE_PUT_FAILED",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    const jobId = randomUUID();
    const jobType = INITIAL_JOB_TYPE[type];

    try {
      const tx = this.deps.db.transaction(() => {
        this.deps.mediaRepo.insert({
          id: mediaId,
          tripId,
          type,
          originalPath,
          fileSize: file.size,
          mimeType,
          extension,
          createdAt: now,
          updatedAt: now,
        });
        this.deps.jobRepo.insert({
          id: jobId,
          mediaId,
          jobType,
          createdAt: now,
          updatedAt: now,
        });
      });
      tx();
    } catch (err) {
      // Compensating remove: the file is on disk but the DB rolled
      // back. Best-effort; we still surface the DB failure to the
      // caller because that's the real cause.
      try {
        await this.deps.storage.remove(originalPath);
      } catch (rmErr) {
        this.deps.logger.error(
          {
            err: serializeError(rmErr),
            mediaId,
            tripId,
            originalPath,
          },
          "upload: failed to remove orphan original after DB rollback",
        );
      }
      return failedItem(file, {
        code: "DB_INSERT_FAILED",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    const item: UploadAcceptedItem = {
      status: "accepted",
      fieldName: file.fieldName,
      originalFilename: file.originalFilename,
      mediaId,
      type,
      extension,
      mimeType,
      fileSize: file.size,
      originalPath,
      jobId,
      jobType,
      reason: classifyReason,
    };
    return item;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function failedItem(
  file: StagedFile,
  error: { readonly code: string; readonly message: string },
): UploadFailedItem {
  return {
    status: "failed",
    fieldName: file.fieldName,
    originalFilename: file.originalFilename,
    reason: error.message,
    error,
  };
}

function serializeError(err: unknown): unknown {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return err;
}
