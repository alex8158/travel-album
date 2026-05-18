// Public surface for the jobs domain (P2.T4 + P3.T2 + P3.T4 + P3.T5 + P4.T1+).
//
// P2.T4 introduced the writer side (`JobRepository.insert`).
// P3.T2 added the executor + registry + initial stub handlers.
// P3.T4 replaced the `image_thumbnail` stub with the real
//       `makeImageThumbnailHandler`.
// P3.T5 replaced the `image_metadata` stub with the real
//       `makeImageMetadataHandler`.
// P4.T1 introduced `JobQueue` — multi-channel scheduler that
//       supersedes `ImageChannelExecutor` in production. The latter
//       is retained as a deterministic single-concurrency harness
//       for the P3 smokes (see jobQueue.ts header note).
// P4.T4 adds the public Job API surface: `JobService` (read / retry /
//       cancel) backing `routes/jobs.ts`.
// P5.T2 adds `makeImageHashHandler` — the `image_hash` worker that
//       writes `media_items.file_hash` (SHA256) + `media_items.perceptual_hash`
//       (pHash + dHash concatenation) for the dedup engine to consume.

export { JobRepository, type JobListFilter } from "./jobRepository.js";
export { JobService } from "./jobService.js";
export { jobStatusSchema, listJobsQuerySchema, type ListJobsQuery } from "./jobSchemas.js";
export { JobHandlerRegistry, type JobHandler } from "./handlerRegistry.js";
export {
  ImageChannelExecutor,
  type ImageChannelExecutorDeps,
  type TickResult,
  type TickOutcome,
} from "./imageChannelExecutor.js";
export {
  JobQueue,
  type JobQueueChannelConfig,
  type JobQueueChannelName,
  type JobQueueDeps,
  type JobQueueRetryConfig,
  type JobQueueState,
  type TickChannelResult,
  type ZombieRecoveryResult,
} from "./jobQueue.js";
export {
  makeImageThumbnailHandler,
  type ImageThumbnailHandlerDeps,
} from "./imageThumbnailWorker.js";
export { makeImageMetadataHandler, type ImageMetadataHandlerDeps } from "./imageMetadataWorker.js";
export {
  IMAGE_HASH_JOB_TYPE,
  computeDHash,
  computePHash,
  makeImageHashHandler,
  type ImageHashHandlerDeps,
} from "./imageHashWorker.js";

export type { JobInsertData, JobStatus, JobView, ProcessingJob } from "./jobTypes.js";
