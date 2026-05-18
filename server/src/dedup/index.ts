// Public surface for the dedup domain (P5).
//
// Importers should pull from `../dedup` rather than reaching into
// individual files.
//
// P5.T1 — duplicate_groups + duplicate_group_items migration.
// P5.T1.5 — DuplicateGroupsRepository data-access layer.
// P5.T3 — DedupEngine.exact (`runExactForTrip`).
// P5.T4 — DedupEngine.similar (`runSimilarForTrip`) + pHash Hamming.
// P5.T5 — DedupService (exact / similar / run) backing /api/trips/:tripId/dedup/*.

export { DuplicateGroupsRepository } from "./duplicateGroupsRepository.js";
export {
  DEFAULT_SIMILAR_HAMMING_THRESHOLD,
  DedupEngine,
  type DedupEngineDeps,
  type RunExactResult,
  type RunSimilarOptions,
  type RunSimilarResult,
} from "./dedupEngine.js";
export { HEX16_MAX_BITS, hexHammingDistance } from "./hamming.js";
export {
  DedupService,
  type DedupExactApiResult,
  type DedupRunApiResult,
  type DedupSimilarApiResult,
} from "./dedupService.js";
export {
  dedupRunBodySchema,
  dedupSimilarBodySchema,
  type DedupRunBody,
  type DedupSimilarBody,
} from "./dedupSchemas.js";

export type {
  DuplicateDecision,
  DuplicateGroup,
  DuplicateGroupInsertData,
  DuplicateGroupItem,
  DuplicateGroupItemInsertData,
  DuplicateGroupItemSeedData,
  DuplicateGroupType,
  DuplicateGroupWithItems,
} from "./duplicateTypes.js";
