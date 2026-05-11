// Public types for Upload_Manager (P2.T4).
//
// The upload response is a per-file array (per requirements §7.2 verif
// 3 + design.md §3.3): the whole HTTP request returns 200 even if some
// files were rejected, so the front-end can show one banner per file.
//
// Three discrete outcomes, modelled as a discriminated union on
// `status` so consumers branch exhaustively:
//
//   * "accepted"          — image / video classified, original written
//                           to storage, media_items + processing_jobs
//                           inserted atomically. The Worker pool (P4)
//                           will pick the job up later.
//   * "rejected_unknown"  — File_Classifier returned `unknown`. A
//                           media_items row with type='unknown' was
//                           still created so the user can see the file
//                           was received but not processed (design
//                           §6.2.3). No job, no original on disk.
//   * "failed"            — Upload-time failure: file truncated past
//                           the size limit, zero-byte body, classifier
//                           accepted but extension was unusable
//                           (UPLOAD_MISSING_EXTENSION), storage write
//                           failed, or the DB transaction rolled back.
//                           In every case the file does NOT live in
//                           storage afterwards.

import type { MediaType } from "../classify/index.js";

/** Possible discriminator values; explicit type for downstream switches. */
export type UploadItemStatus = "accepted" | "rejected_unknown" | "failed";

export interface UploadAcceptedItem {
  readonly status: "accepted";
  readonly fieldName: string;
  readonly originalFilename: string;
  readonly mediaId: string;
  readonly type: Exclude<MediaType, "unknown">;
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

export interface UploadFailureError {
  readonly code: string;
  readonly message: string;
}

export interface UploadFailedItem {
  readonly status: "failed";
  readonly fieldName: string;
  readonly originalFilename: string;
  readonly reason: string;
  readonly error: UploadFailureError;
}

export type UploadItem = UploadAcceptedItem | UploadRejectedUnknownItem | UploadFailedItem;

export interface UploadResult {
  readonly results: readonly UploadItem[];
}
