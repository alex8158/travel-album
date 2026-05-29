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
// P10.T5: image_ai_refine worker — consumes pending ai_invocations
// audit rows + invokes AIProvider + writes
// `media_versions(version_type='ai_refined')`. Registered on the
// image channel alongside enhance / thumbnail / metadata.
export {
  DEFAULT_IMAGE_AI_REFINE_SETTINGS,
  IMAGE_AI_REFINE_JOB_TYPE,
  makeImageAiRefineHandler,
  type ImageAiRefineHandlerDeps,
  type ImageAiRefineSettings,
} from "./imageAiRefineWorker.js";
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
// P9.T5 — `video_keyframes` worker (ffmpeg fixed-interval frame
// extraction). Video channel; shares the same budget.
export {
  DEFAULT_VIDEO_KEYFRAMES_SETTINGS,
  VIDEO_KEYFRAMES_JOB_TYPE,
  computeEffectiveInterval,
  makeVideoKeyframesHandler,
  type KeyframeManifest,
  type KeyframeManifestEntry,
  type VideoKeyframesHandlerDeps,
  type VideoKeyframesSettings,
} from "./videoKeyframesWorker.js";
// P9.T6 — `video_segments` worker (ffmpeg fixed-duration slicing).
// Same video channel; shares the VIDEO_WORKER_CONCURRENCY=1 budget
// with metadata / cover / proxy / keyframes.
export {
  DEFAULT_VIDEO_SEGMENTS_SETTINGS,
  VIDEO_SEGMENTS_JOB_TYPE,
  makeVideoSegmentsHandler,
  type VideoSegmentsHandlerDeps,
  type VideoSegmentsSettings,
} from "./videoSegmentsWorker.js";
// P9.T7 — `video_segment_quality` worker (per-keyframe Laplacian
// sharpness + ffmpeg blackdetect → per-segment scoring / waste_type
// / is_recommended). Same video channel; shares the budget.
export {
  DEFAULT_VIDEO_SEGMENT_QUALITY_SETTINGS,
  VIDEO_SEGMENT_QUALITY_JOB_TYPE,
  makeVideoSegmentQualityHandler,
  parseBlackdetectStderr,
  runBlackdetect,
  scoreOneSegment,
  type SegmentScore,
  type VideoSegmentQualityHandlerDeps,
  type VideoSegmentQualitySettings,
} from "./videoSegmentQualityWorker.js";
// P11.T1 — `video_optimize` worker (H.264 / AAC browser-friendly
// re-encode, capped at 1080p by default). Same video channel; shares
// the VIDEO_WORKER_CONCURRENCY=1 budget with the rest. Distinct from
// `video_proxy` (P9.T4): proxy is the INTERNAL low-res analysis
// source, optimize is the USER-FACING re-encode.
export {
  DEFAULT_VIDEO_OPTIMIZE_SETTINGS,
  VIDEO_OPTIMIZE_JOB_TYPE,
  makeVideoOptimizeHandler,
  type VideoOptimizeHandlerDeps,
  type VideoOptimizeSettings,
} from "./videoOptimizeWorker.js";
// P11.T5 — `video_render` worker. Consumes a persisted edit plan,
// trims + concats clips, applies audioPolicy, writes
// `media_versions(version_type='edited')`. Registered on the video
// channel alongside the other video workers; shares the
// VIDEO_WORKER_CONCURRENCY=1 budget so renders serialise with
// metadata / cover / proxy / keyframes / segments / optimize.
// NB: the `VIDEO_RENDER_JOB_TYPE` constant is exported from
// `media/videoRenderService.ts` (the Service-layer canonical
// source); the worker inlines the same literal string to avoid
// the cross-module circular import that `videoService.ts`
// already documents (P9.T8 header).
export {
  DEFAULT_VIDEO_RENDER_SETTINGS,
  makeVideoRenderHandler,
  type VideoRenderHandlerDeps,
  type VideoRenderSettings,
} from "./videoRenderWorker.js";
// P11.T2 — audio processing toolkit (FFmpeg building blocks). NOT
// a JobHandler — utilities consumed by future render / compose
// workers (P11.T5 / P11.T8). Pure filter builders + bounded async
// runners; refuses `targetDurationSec <= 0` to block runaway
// `-stream_loop -1` encodes.
export {
  DEFAULT_AUDIO_LOUDNORM_I,
  DEFAULT_AUDIO_LOUDNORM_LRA,
  DEFAULT_AUDIO_LOUDNORM_TP,
  DEFAULT_AUDIO_PROCESSOR_SETTINGS,
  buildAfadeFilter,
  buildAtrimFilter,
  buildLoudnormFilter,
  findDefaultAudioCandidates,
  joinAfChain,
  prepareBackgroundMusic,
  replaceVideoAudio,
  stripAudio,
  trimAudio,
  type AudioProcessorSettings,
  type DefaultAudioCandidate,
  type PrepareBackgroundMusicOptions,
  type ReplaceVideoAudioOptions,
  type StripAudioOptions,
  type TrimAudioOptions,
} from "./audioProcessor.js";

// P12.T4 — scene_grouping baseline service. Pure function, no handler
// registration (the orchestrator + scene_grouping job_type wiring land
// in P12.T9). AI scene-embedding enrichment is a seam (typed
// `SceneEmbeddingProvider`) that the baseline never invokes.
export {
  DEFAULT_SCENE_GROUPING_SETTINGS,
  DEFAULT_SCENE_GROUPING_TIME_GAP_SECONDS,
  SCENE_GROUPING_ALGORITHM_VERSION_CODE_TIME,
  SCENE_GROUPING_JOB_TYPE,
  SCENE_GROUPING_MAX_CANDIDATES,
  runSceneGroupingForTrip,
  type SceneEmbeddingProvider,
  type SceneGroupingDeps,
  type SceneGroupingPlanGroup,
  type SceneGroupingPlanMember,
  type SceneGroupingRequest,
  type SceneGroupingResult,
  type SceneGroupingSettings,
} from "./sceneGroupingService.js";

export type { JobInsertData, JobStatus, JobView, ProcessingJob } from "./jobTypes.js";
