// Stub handlers for image-channel job types that don't have a real
// worker yet.
//
// History:
//   * P3.T2 introduced two stubs (thumbnail + metadata) so the
//     executor's state-machine could be exercised end-to-end before
//     real workers landed.
//   * P3.T4 replaced the `image_thumbnail` stub with the real
//     `makeImageThumbnailHandler` in `imageThumbnailWorker.ts`.
//   * `image_metadata` is still a stub here pending P3.T5.
//
// The metadata stub is intentionally a clearly-labelled no-op so a
// stub running in production is obvious in logs (per CLAUDE.md §3.5
// — no fake processing results). It does NOT touch media_items /
// media_versions / storage.

import type { Logger } from "../logger.js";

import type { JobHandler } from "./handlerRegistry.js";

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
