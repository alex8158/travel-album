// Public surface for the dedup domain (P5).
//
// Importers should pull from `../dedup` rather than reaching into
// individual files.
//
// P5.T1 — duplicate_groups + duplicate_group_items migration.
// P5.T1.5 — DuplicateGroupsRepository data-access layer.
// P5.T3 — DedupEngine.exact (`runExactForTrip`).

export { DuplicateGroupsRepository } from "./duplicateGroupsRepository.js";
export { DedupEngine, type DedupEngineDeps, type RunExactResult } from "./dedupEngine.js";

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
