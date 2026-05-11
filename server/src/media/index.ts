// Public surface for the media domain (P2.T4 write + P2.T5 read).
//
// Importers should pull from "../media" rather than reaching into
// individual files. The write side (Upload_Manager) and the read
// side (Gallery / detail) share the same Repository for now; future
// state-machine / soft-delete helpers will go through the same
// barrel as they land in P4 / P7.

export { MediaRepository } from "./mediaRepository.js";
export { MediaService } from "./mediaService.js";

export { listMediaOptionsSchema, type ListMediaInput } from "./mediaSchemas.js";

export type {
  ListMediaOptions,
  MediaInsertData,
  MediaItem,
  MediaStatus,
  MediaType,
  MediaUserDecision,
} from "./mediaTypes.js";
