// Public surface for the media domain (P2.T4 write + P2.T5 read +
// P3.T4 derived versions).
//
// Importers should pull from "../media" rather than reaching into
// individual files. The write side (Upload_Manager), the read side
// (Gallery / detail), and the derived-versions side (thumbnail /
// preview / enhanced / ai_refined writes) all live here.

export { MediaRepository } from "./mediaRepository.js";
// P11.T3 — Audio Library data layer. Repository + Service +
// seed-default-directory runner. No HTTP surface (P11.T6 territory).
export {
  AudioLibraryRepository,
  type AudioLibraryInsertData,
  type AudioLibrarySourceType,
  type AudioLibraryUpsertData,
  type AudioLibraryUpsertOutcome,
  type AudioLibraryUpsertResult,
  type AudioLibraryView,
} from "./audioLibraryRepository.js";
export {
  AudioLibraryService,
  type AudioLibrarySeedItem,
  type AudioLibrarySeedOutcome,
  type AudioLibrarySeedSummary,
  type SeedDefaultDirectoryOptions,
} from "./audioLibraryService.js";
// P11.T4 — Video edit plan generator (rule engine) + service +
// schema. Generates an edit-plan JSON document the future P11.T5
// render worker will consume. NEVER renders / writes processing_jobs
// / writes media_versions / calls real AI in V1.
export {
  EDIT_PLAN_DEFAULT_ASPECT_RATIO,
  EDIT_PLAN_DEFAULT_RESOLUTION,
  EDIT_PLAN_DEFAULT_STYLE,
  EDIT_PLAN_DEFAULT_TRANSITION,
  EDIT_PLAN_STYLE_TARGETS,
  EDIT_PLAN_VERSION,
  MIN_CLIP_DURATION_SECONDS,
  aiRefinePlan,
  buildEditPlan,
  computePerClipCapSeconds,
  noopPlanRefiner,
  resolveAudioPolicy,
  type AiRefinePlanInput,
  type AiRefinePlanRefiner,
  type AudioPolicyResolutionInput,
  type AudioPolicyResolutionResult,
  type BuildEditPlanInput,
  type EditPlanAspectRatio,
  type EditPlanAudioMode,
  type EditPlanAudioPolicy,
  type EditPlanCandidate,
  type EditPlanClip,
  type EditPlanResolution,
  type EditPlanStyle,
  type EditPlanTransition,
  type EditPlanTransitionKind,
  type EditPlanWarning,
  type EditPlanWarningCode,
  type VideoEditPlan,
} from "./videoEditPlan.js";
export {
  VideoEditPlanService,
  type GeneratePlanOptions,
  type VideoEditPlanServiceDeps,
} from "./videoEditPlanService.js";
export {
  editPlanAspectRatioSchema,
  editPlanAudioModeSchema,
  editPlanResolutionSchema,
  editPlanStyleSchema,
  generateEditPlanBodySchema,
  type GenerateEditPlanInput,
} from "./videoEditPlanSchemas.js";
export {
  MediaService,
  type AiRefineDeps,
  type AiRefineMediaResult,
  type AiRefineOptions,
  type EnhanceMediaResult,
  type MediaSoftDeleteDeps,
  type OptimizeVideoMediaResult,
  type ReprocessJobResult,
  type ReprocessOutcome,
  type ReprocessResult,
  type RestoreMediaResult,
  type SoftDeleteMediaResult,
} from "./mediaService.js";
export { MediaVersionsRepository, type MediaVersionUpsertData } from "./mediaVersionsRepository.js";
export {
  PRESERVE_USER_DECISION_OVERLAP_RATIO,
  VideoSegmentsRepository,
  mapUserDecisionsByOverlap,
  videoSegmentMp4Path,
  type ReplaceAllForMediaOptions,
  type VideoSegmentQualityUpdate,
} from "./videoSegmentsRepository.js";
export {
  VideoService,
  type KeyframesSummary,
  type ListVideoSegmentsResult,
  type ProcessSlotOutcome,
  type ProcessSlotResult,
  type ProcessVideoSegmentsResult,
  type UpdateUserDecisionResult,
  type VideoSegmentDetailResult,
  type VideoSegmentView,
} from "./videoService.js";
export {
  processVideoSegmentsBodySchema,
  updateUserDecisionBodySchema,
  type ProcessVideoSegmentsInput,
  type UpdateUserDecisionInput,
} from "./videoSchemas.js";
export type {
  VideoSegment,
  VideoSegmentInsertData,
  VideoSegmentUserDecision,
  VideoSegmentWasteType,
} from "./videoSegmentTypes.js";
export {
  BLUR_DIMENSION_LABELS,
  COLOR_DIMENSION_LABELS,
  EXPOSURE_DIMENSION_LABELS,
  MediaAnalysisRepository,
  mergeDimensionLabels,
  type MediaAnalysisRow,
  type UpsertBlurAnalysisInput,
  type UpsertColorAnalysisInput,
  type UpsertExposureAnalysisInput,
  type UpsertFinalQualityInput,
} from "./mediaAnalysisRepository.js";

export {
  listMediaOptionsSchema,
  selectVersionBodySchema,
  type ListMediaInput,
  type SelectVersionInput,
} from "./mediaSchemas.js";

export type {
  ListMediaOptions,
  MediaActiveVersionType,
  MediaAnalysisProjection,
  MediaDetail,
  MediaInsertData,
  MediaItem,
  MediaStatus,
  MediaType,
  MediaUserDecision,
  MediaVersion,
  MediaVersionView,
  MediaVersionsView,
  SelectVersionResult,
} from "./mediaTypes.js";
