// Public surface for the jobs domain (P2.T4 + P3.T2 + P3.T4).
//
// P2.T4 introduced the writer side (`JobRepository.insert`).
// P3.T2 added the executor + registry + initial stub handlers.
// P3.T4 replaced the `image_thumbnail` stub with the real
// `makeImageThumbnailHandler`. The `image_metadata` stub remains until
// P3.T5 lands the real exifr-based handler.

export { JobRepository } from "./jobRepository.js";
export { JobHandlerRegistry, type JobHandler } from "./handlerRegistry.js";
export {
  ImageChannelExecutor,
  type ImageChannelExecutorDeps,
  type TickResult,
  type TickOutcome,
} from "./imageChannelExecutor.js";
export { makeStubImageMetadataHandler } from "./imageJobHandlers.js";
export {
  makeImageThumbnailHandler,
  type ImageThumbnailHandlerDeps,
} from "./imageThumbnailWorker.js";

export type { JobInsertData, JobStatus, ProcessingJob } from "./jobTypes.js";
