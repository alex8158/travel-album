// Public surface for the dedup domain (P5).
//
// Importers should pull from `../dedup` rather than reaching into
// individual files. Today only the Repository is exposed; Services /
// engines / API will be added by P5.T2 ... P5.T8 and re-exported
// from here.

export { DuplicateGroupsRepository } from "./duplicateGroupsRepository.js";

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
