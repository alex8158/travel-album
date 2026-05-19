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
  MediaAnalysisRepository,
  type MediaAnalysisRow,
  type UpsertBlurAnalysisInput,
} from "./mediaAnalysisRepository.js";

export { listMediaOptionsSchema, type ListMediaInput } from "./mediaSchemas.js";

export type {
  ListMediaOptions,
  MediaDetail,
  MediaInsertData,
  MediaItem,
  MediaStatus,
  MediaType,
  MediaUserDecision,
  MediaVersion,
} from "./mediaTypes.js";
