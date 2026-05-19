// Public surface for the quality domain (P6.T5 second half).
//
// Quality_Selector lives outside `jobs/` because it is a service-
// level orchestrator (no per-media bytes, no sharp pipeline), not a
// JobQueue handler. It consumes `media_analysis` + `media_items` +
// the dedup tables and writes back to the dedup tables.

export {
  QUALITY_SCORE_TIE_EPSILON,
  QualitySelectorService,
  buildPerItemReasons,
  rankMembers,
  type MemberRanking,
  type QualitySelectorServiceDeps,
  type SelectGroupOutcome,
} from "./qualitySelectorService.js";
