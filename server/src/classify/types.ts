// File classifier types (P2.T3).
//
// The closed set `image | video | unknown` is the same vocabulary
// enforced by the `media_items_type_enum` CHECK in
// server/migrations/002_create_media_items.sql, so a classifier
// result can flow directly into media_items.type without translation.

export type MediaType = "image" | "video" | "unknown";

/**
 * Inputs to the classifier.
 *
 * - `filename`         The original upload filename, including any
 *                      directory path. Only the basename is used for
 *                      extension extraction; path separators are
 *                      stripped.
 * - `declaredMimeType` The Content-Type the upload declared (HTTP
 *                      header / browser hint). Pass undefined / empty
 *                      / "application/octet-stream" when there is no
 *                      reliable declaration — those neutral values
 *                      do not contribute a constraint.
 * - `headBytes`        The first few bytes of the file (recommended
 *                      ≥ 16 to cover every supported magic pattern).
 *                      The classifier never reads beyond what it
 *                      needs; passing more is harmless.
 */
export interface ClassifyInput {
  readonly filename: string;
  readonly declaredMimeType?: string | undefined;
  readonly headBytes: Uint8Array;
}

/**
 * Per-call options. The caller wires these from
 * `config.upload.allowed{Image,Video}Ext` (server/src/config) so the
 * classifier itself stays a pure function with no global state.
 *
 * Lists may use any case; the classifier lowercases internally before
 * matching.
 */
export interface ClassifyOptions {
  readonly imageExtensions: readonly string[];
  readonly videoExtensions: readonly string[];
}

/**
 * Output of a classification call.
 *
 * - `type`      The decided media type, or `"unknown"` when any layer
 *               fails (filename empty, magic unrecognised, or
 *               cross-layer conflict).
 * - `extension` The lowercase extension (no leading dot) extracted
 *               from the filename, or null when no extension is
 *               present.
 * - `mimeType`  The normalised MIME type (lowercased, parameters
 *               stripped), or null when none was declared / declared
 *               value was empty.
 * - `reason`    Always non-empty. For accepted files it summarises
 *               the matched magic + extension + MIME; for rejected
 *               files it explains exactly which layer disagreed.
 *               Suitable as input to media_items.reason and to
 *               surface back to the user when an upload is refused.
 */
export interface ClassifyResult {
  readonly type: MediaType;
  readonly extension: string | null;
  readonly mimeType: string | null;
  readonly reason: string;
}
