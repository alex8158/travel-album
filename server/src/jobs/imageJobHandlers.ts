// Stub handlers for the image-channel job types that P2.T4
// Upload_Manager currently produces (P3.T2).
//
// These exist ONLY so the executor's state-machine can be exercised
// end-to-end before the real workers land:
//   * P3.T4 (`image_thumbnail`) — sharp → thumb.webp + preview.webp.
//   * P3.T5 (`image_metadata`)  — exifr → EXIF columns + image_metadata
//                                  job_type.
// When P3.T4 / P3.T5 land they replace these stubs at the boot-time
// `registry.register(...)` call — the executor and registry stay
// untouched.
//
// CLAUDE.md §3.5 forbids putting real heavy work in the upload-time
// hot path, which is why these are jobs rather than synchronous
// post-upload steps. But they ARE forbidden today: the executor would
// mark a job 'success' without doing anything useful, which would be
// dishonest if the rest of the system relied on the side effects
// (e.g. media_items.thumbnail_path being populated).
//
// To keep the stubs honest:
//   * They log a clearly-labelled "STUB" line every time they run so
//     a stub running in production is obvious in logs.
//   * They do NOT touch media_items, media_versions, or storage —
//     anything that would create the illusion of completed work.
//
// The Gallery (P2.T7) currently shows status='uploaded' regardless
// of job state, so a stub run does not lie to the UI either.

import type { JobHandler } from "./handlerRegistry.js";
import type { Logger } from "../logger.js";

/**
 * Build the stub `image_thumbnail` handler. The real implementation
 * lands in P3.T4 and will replace this registration in
 * server/src/index.ts.
 */
export function makeStubImageThumbnailHandler(logger: Logger): JobHandler {
  return async (job) => {
    logger.info(
      {
        jobId: job.id,
        jobType: job.jobType,
        mediaId: job.mediaId,
        stub: true,
        replacedBy: "P3.T4",
      },
      "[STUB] image_thumbnail handler (no-op). Replace with sharp pipeline in P3.T4.",
    );
    // No-op: returns successfully. The real handler will produce
    // thumb.webp + preview.webp under derived/{mediaId}/ and update
    // media_items.{width,height,preview_path,thumbnail_path}.
  };
}

/**
 * Build the stub `image_metadata` handler. The real implementation
 * lands in P3.T5 and will replace this registration in
 * server/src/index.ts.
 */
export function makeStubImageMetadataHandler(logger: Logger): JobHandler {
  return async (job) => {
    logger.info(
      {
        jobId: job.id,
        jobType: job.jobType,
        mediaId: job.mediaId,
        stub: true,
        replacedBy: "P3.T5",
      },
      "[STUB] image_metadata handler (no-op). Replace with exifr pipeline in P3.T5.",
    );
    // No-op: returns successfully. The real handler will read EXIF
    // via exifr and persist camera / lens / capture-time columns.
  };
}
