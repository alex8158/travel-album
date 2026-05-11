// Public surface for the jobs domain (P2.T4).
//
// Only the write-side is needed for this task; the Worker pool, the
// state-machine guard, retry / cancel helpers, and the Job API come in
// P4. Importers should pull from "../jobs" rather than reaching into
// individual files.

export { JobRepository } from "./jobRepository.js";

export type { JobInsertData, JobStatus } from "./jobTypes.js";
