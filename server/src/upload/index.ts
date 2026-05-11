// Public surface for Upload_Manager (P2.T4).
//
// External callers (the routes layer, smoke scripts) should pull from
// "../upload" rather than reaching into individual files. The busboy
// wrapper is an implementation detail of the service and is not
// exported.

export { UploadService } from "./uploadService.js";
export type { UploadServiceDeps, HandleUploadArgs } from "./uploadService.js";

export type {
  UploadAcceptedItem,
  UploadFailedItem,
  UploadFailureError,
  UploadItem,
  UploadItemStatus,
  UploadRejectedUnknownItem,
  UploadResult,
} from "./types.js";
