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
export {
  IMAGE_QUALITY_BLUR_JOB_TYPE,
  classifyBlur,
  computeLaplacianStats,
  makeImageQualityBlurHandler,
  normaliseSharpness,
  type BlurAnalysisSettings,
  type BlurClassification,
  type ImageQualityBlurHandlerDeps,
  type LaplacianStats,
} from "./imageQualityBlurWorker.js";
export {
  BRIGHT_PIXEL_CUTOFF,
  DARK_PIXEL_CUTOFF,
  IMAGE_QUALITY_EXPOSURE_JOB_TYPE,
  MIXED_RATIO_FLOOR,
  classifyExposure,
  computeBrightnessStats,
  makeImageQualityExposureHandler,
  scoreExposure,
  type BrightnessStats,
  type ExposureAnalysisSettings,
  type ExposureClassification,
  type ExposureLabel,
  type ImageQualityExposureHandlerDeps,
} from "./imageQualityExposureWorker.js";
export {
  HIGH_CONTRAST_CUTOFF,
  HIGH_SATURATION_PIXEL_CUTOFF,
  IMAGE_QUALITY_COLOR_JOB_TYPE,
  LOW_SATURATION_PIXEL_CUTOFF,
  classifyColor,
  computeColorStats,
  makeImageQualityColorHandler,
  scoreColor,
  type ColorAnalysisSettings,
  type ColorCast,
  type ColorClassification,
  type ColorStats,
  type ContrastClass,
  type ImageQualityColorHandlerDeps,
  type SaturationClass,
} from "./imageQualityColorWorker.js";
export {
  IMAGE_QUALITY_FINALIZE_JOB_TYPE,
  aggregateQuality,
  makeImageQualityFinalizeHandler,
  temperColor,
  type FinalizeAggregateResult,
  type FinalizeDimensionName,
  type FinalizeQualitySettings,
  type FinalizeUsedDimension,
  type ImageQualityFinalizeHandlerDeps,
} from "./imageQualityFinalizeWorker.js";
// P8.T1: constant for the enqueue endpoint. P8.T2 added the
// `makeImageEnhanceHandler` + `ImageEnhanceHandlerDeps` types
// alongside, completing the sharp pipeline + media_versions writer.
export {
  IMAGE_ENHANCE_JOB_TYPE,
  makeImageEnhanceHandler,
  type EnhanceSettings,
  type ImageEnhanceHandlerDeps,
} from "./imageEnhanceWorker.js";
// P9.T2 — `video_metadata` worker (ffprobe). Registered on the
// video channel (not image), per design.md §6.10
// (VIDEO_WORKER_CONCURRENCY=1).
export {
  DEFAULT_VIDEO_METADATA_SETTINGS,
  VIDEO_METADATA_JOB_TYPE,
  makeVideoMetadataHandler,
  projectFfprobe,
  type VideoMetadataHandlerDeps,
  type VideoMetadataProjection,
  type VideoMetadataSettings,
} from "./videoMetadataWorker.js";
// P9.T3 — `video_cover` worker (ffmpeg cover-frame extraction).
// Also registered on the video channel; shares the
// VIDEO_WORKER_CONCURRENCY=1 budget with video_metadata.
export {
  DEFAULT_VIDEO_COVER_SETTINGS,
  VIDEO_COVER_JOB_TYPE,
  chooseCoverSeekSeconds,
  makeVideoCoverHandler,
  type VideoCoverHandlerDeps,
  type VideoCoverSettings,
} from "./videoCoverWorker.js";
// P9.T4 — `video_proxy` worker (ffmpeg 720p H.264/AAC transcode).
// Same video channel, shares the same VIDEO_WORKER_CONCURRENCY=1
// budget as metadata + cover.
export {
  DEFAULT_VIDEO_PROXY_SETTINGS,
  VIDEO_PROXY_JOB_TYPE,
  makeVideoProxyHandler,
  type VideoProxyHandlerDeps,
  type VideoProxySettings,
} from "./videoProxyWorker.js";

export type { JobInsertData, JobStatus, JobView, ProcessingJob } from "./jobTypes.js";
