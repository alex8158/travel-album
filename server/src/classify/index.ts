// Public surface for the file classifier (P2.T3). Importers should
// pull from "../classify" rather than reaching into individual files
// — magic-number internals are an implementation detail.

export { classify } from "./classifier.js";

export type { ClassifyInput, ClassifyOptions, ClassifyResult, MediaType } from "./types.js";
