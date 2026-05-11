// Public surface for the jobs domain (P2.T4 + P3.T2).
//
// P2.T4 introduced the writer side (`JobRepository.insert`).
// P3.T2 adds:
//   * Repository read / state-transition methods (`claimNextPendingImageJob`,
//     `markSuccess`, `markFailed`, `findById`) — minimum needed for the
//     image-channel stub.
//   * `JobHandlerRegistry` + `JobHandler` type — registration surface
//     shared with the eventual P4.T1 worker pool.
//   * `ImageChannelExecutor` — minimal single-concurrency stub that
//     drives the registry. P4.T1 will replace its scheduling loop with
//     channel-aware pooling; the handler contract above stays stable.
//   * Stub handlers for the two job types upload currently produces
//     (image_thumbnail / image_metadata). P3.T4 / P3.T5 swap in real
//     implementations.

export { JobRepository } from "./jobRepository.js";
export { JobHandlerRegistry, type JobHandler } from "./handlerRegistry.js";
export {
  ImageChannelExecutor,
  type ImageChannelExecutorDeps,
  type TickResult,
  type TickOutcome,
} from "./imageChannelExecutor.js";
export { makeStubImageThumbnailHandler, makeStubImageMetadataHandler } from "./imageJobHandlers.js";

export type { JobInsertData, JobStatus, ProcessingJob } from "./jobTypes.js";
