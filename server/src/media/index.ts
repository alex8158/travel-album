// Public surface for the media domain (P2.T4).
//
// Only the write-side is needed for this task; read APIs come in P2.T5.
// Importers should pull from "../media" rather than reaching into
// individual files.

export { MediaRepository } from "./mediaRepository.js";

export type { MediaInsertData, MediaStatus, MediaType, MediaUserDecision } from "./mediaTypes.js";
