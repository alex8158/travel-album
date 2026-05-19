// Public surface for the media domain (P2.T4 write + P2.T5 read +
// P3.T4 derived versions).
//
// Importers should pull from "../media" rather than reaching into
// individual files. The write side (Upload_Manager), the read side
// (Gallery / detail), and the derived-versions side (thumbnail /
// preview / enhanced / ai_refined writes) all live here.

export { MediaRepository } from "./mediaRepository.js";
export {
  MediaService,
  type ReprocessJobResult,
  type ReprocessOutcome,
  type ReprocessResult,
} from "./mediaService.js";
export { MediaVersionsRepository, type MediaVersionUpsertData } from "./mediaVersionsRepository.js";
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

export { listMediaOptionsSchema, type ListMediaInput } from "./mediaSchemas.js";

export type {
  ListMediaOptions,
  MediaAnalysisProjection,
  MediaDetail,
  MediaInsertData,
  MediaItem,
  MediaStatus,
  MediaType,
  MediaUserDecision,
  MediaVersion,
} from "./mediaTypes.js";
