// File classifier (P2.T3).
//
// Pure-function entry point that combines the three layers prescribed
// by docs/design.md §6.3:
//
//   1. Content-Type (declaredMimeType)
//   2. Filename extension
//   3. File-head magic bytes
//
// Decision rule (locked by user spec, P2.T3 confirmation):
//
//   * Magic is the deciding signal. If the head bytes do not match
//     any supported pattern the result is `unknown` (with reason).
//     The goal is to defeat spoofed filenames per requirements §7.3
//     verification 3 — anything pretending to be jpg/mp4/etc. without
//     the right header bytes is rejected.
//
//   * Extension and MIME may CONTRADICT the magic decision, in which
//     case the file is rejected with a precise reason. They may also
//     be MISSING / NEUTRAL, which contributes no constraint.
//
//   * "Neutral" MIME values are: undefined, empty/whitespace, and
//     "application/octet-stream" (the spec-confirmed exempt set).
//
//   * The filename must have a basename. An empty / pure-separator
//     filename short-circuits to `unknown` even if the head bytes
//     look like a real format.
//
// The classifier is a pure function: no I/O, no logging, no throws.
// All inputs are validated locally; malformed inputs return
// `unknown` with a descriptive reason.

import { matchMagic, type MagicMatch } from "./magicNumbers.js";
import type { ClassifyInput, ClassifyOptions, ClassifyResult, MediaType } from "./types.js";

const IMAGE_MIME_PREFIX = "image/";
const VIDEO_MIME_PREFIX = "video/";

/**
 * MIME values that count as "no signal" rather than a contradicting
 * declaration. `application/octet-stream` is the catch-all browsers
 * use when they cannot determine a type.
 */
const NEUTRAL_MIME_VALUES: ReadonlySet<string> = new Set(["", "application/octet-stream"]);

/**
 * Per-extension allowlist of compatible magic.format strings. Used
 * for the format-level "扩展名支持但 magic 明显不匹配" check, so a
 * `.jpg` file whose head bytes are PNG is rejected as a likely
 * rename / spoof even though both belong to the image type.
 *
 * Multi-entry sets cover legitimate ISO BMFF brand interchange:
 *   * `.mp4` may legitimately carry an M4V brand (rare but valid),
 *     and vice-versa — both are video and the type is correct, so
 *     we accept the cross.
 *   * `.mov` we treat strictly: a real .mov should have the `qt  `
 *     brand. A .mov file written with an mp4 brand is unusual and
 *     P2.T4's metadata layer can correct it; classifier is happy to
 *     reject so the user knows their filename is misleading.
 *
 * Only extensions in the configured allowlists need entries here.
 * Anything not listed falls back to the previous type-level check,
 * which already rejects (extensionConflict will see no entry and
 * skip the format check, but the wider extension-not-in-allowlist
 * branch handles unknown extensions).
 */
const EXTENSION_FORMAT_COMPATIBILITY: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["jpg", new Set(["jpeg"])],
  ["jpeg", new Set(["jpeg"])],
  ["png", new Set(["png"])],
  ["webp", new Set(["webp"])],
  ["heic", new Set(["heic"])],
  ["mp4", new Set(["mp4", "m4v"])],
  ["mov", new Set(["mov"])],
  ["m4v", new Set(["m4v", "mp4"])],
  ["avi", new Set(["avi"])],
  ["mkv", new Set(["mkv"])],
]);

export function classify(input: ClassifyInput, options: ClassifyOptions): ClassifyResult {
  const trimmedFilename = (input.filename ?? "").trim();
  const mime = normaliseMime(input.declaredMimeType);
  const ext = extractExtension(trimmedFilename);

  if (trimmedFilename.length === 0) {
    return reject(null, mime, "filename is empty");
  }

  // Lowercased once so later membership checks are O(1) friendly.
  const imageExts = options.imageExtensions.map((e) => e.toLowerCase());
  const videoExts = options.videoExtensions.map((e) => e.toLowerCase());

  const magic = matchMagic(input.headBytes);

  // Layer 3 (magic) is the deciding signal. No magic match → reject.
  if (magic === null) {
    return reject(ext, mime, magicMissingReason(ext, imageExts, videoExts, input.headBytes.length));
  }

  // Layer 2: extension must not contradict magic when it is present.
  const extConflict = extensionConflict(magic, ext, imageExts, videoExts);
  if (extConflict !== null) {
    return reject(ext, mime, extConflict);
  }

  // Layer 1: MIME must not contradict magic when it is a non-neutral
  // declaration.
  const mimeConflict = mimeContradiction(magic, mime);
  if (mimeConflict !== null) {
    return reject(ext, mime, mimeConflict);
  }

  return {
    type: magic.type,
    extension: ext,
    mimeType: mime,
    reason: `magic=${magic.format}; ext=${ext ?? "(none)"}; mime=${mime ?? "(none)"}`,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function reject(ext: string | null, mime: string | null, reason: string): ClassifyResult {
  return { type: "unknown", extension: ext, mimeType: mime, reason };
}

/**
 * Normalise a Content-Type. Returns `null` for missing / empty /
 * `application/octet-stream` so the caller can treat them uniformly
 * as "no signal". Other values are lowercased and stripped of any
 * `; charset=...` parameter so equality checks are robust.
 */
function normaliseMime(raw: string | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  const main = trimmed.split(";")[0]?.trim() ?? "";
  if (main.length === 0) return null;
  if (NEUTRAL_MIME_VALUES.has(main)) return null;
  return main;
}

/**
 * Extract the basename of `filename` and return its extension
 * (lowercased, no leading dot). Returns null when the filename has
 * no extension (e.g. `myfile`), is a hidden file with no second dot
 * (e.g. `.bashrc`), or has nothing after the last dot.
 */
function extractExtension(filename: string): string | null {
  if (filename.length === 0) return null;
  const lastSlash = Math.max(filename.lastIndexOf("/"), filename.lastIndexOf("\\"));
  const basename = lastSlash >= 0 ? filename.slice(lastSlash + 1) : filename;
  if (basename.length === 0) return null;
  const lastDot = basename.lastIndexOf(".");
  // Reject "no dot" (-1), "leading dot only" (0 → hidden file), and
  // "trailing dot" (last char) so we never return an empty extension.
  if (lastDot <= 0 || lastDot === basename.length - 1) return null;
  return basename.slice(lastDot + 1).toLowerCase();
}

/**
 * Build the reason returned when magic recognised nothing. The
 * specifics depend on whether the extension landed in the allowlist
 * (so the caller knows it looks like a spoof) and whether the head
 * bytes were even long enough to attempt the longest pattern.
 */
function magicMissingReason(
  ext: string | null,
  imageExts: readonly string[],
  videoExts: readonly string[],
  headByteLength: number,
): string {
  if (headByteLength === 0) {
    return "head bytes are empty; no magic pattern can match";
  }
  if (ext !== null && (imageExts.includes(ext) || videoExts.includes(ext))) {
    return `extension ".${ext}" is in the allowlist but the file's magic bytes do not match any supported format (possible spoof or corruption)`;
  }
  if (headByteLength < 12) {
    return `magic bytes do not match any supported format (only ${headByteLength} byte(s) provided; ≥ 12 recommended)`;
  }
  return "magic bytes do not match any supported image or video format";
}

/**
 * Check whether the extension contradicts the magic-derived type.
 * Returns a reason string when there is a conflict, or `null` when
 * the extension is missing (no contradiction) or matches.
 */
function extensionConflict(
  magic: MagicMatch,
  ext: string | null,
  imageExts: readonly string[],
  videoExts: readonly string[],
): string | null {
  if (ext === null) return null;

  const extIsImage = imageExts.includes(ext);
  const extIsVideo = videoExts.includes(ext);

  // Layer 2a: type-level check — image vs video swap.
  if (magic.type === "image") {
    if (!extIsImage) {
      if (extIsVideo) {
        return `magic detected ${magic.format} (image) but extension ".${ext}" is in the video allowlist — possible spoof`;
      }
      return `magic detected ${magic.format} (image) but extension ".${ext}" is not in the image allowlist`;
    }
  } else {
    // magic.type === "video"
    if (!extIsVideo) {
      if (extIsImage) {
        return `magic detected ${magic.format} (video) but extension ".${ext}" is in the image allowlist — possible spoof`;
      }
      return `magic detected ${magic.format} (video) but extension ".${ext}" is not in the video allowlist`;
    }
  }

  // Layer 2b: format-level check — same media type but the bytes
  // claim a different concrete format (e.g. .jpg with PNG header).
  // This is the "扩展名支持但 magic 明显不匹配" case from the
  // user-confirmed semantics; treat as a likely rename / spoof.
  const compatibleFormats = EXTENSION_FORMAT_COMPATIBILITY.get(ext);
  if (compatibleFormats !== undefined && !compatibleFormats.has(magic.format)) {
    const expected = [...compatibleFormats].sort().join(" / ");
    return `magic detected ${magic.format} but extension ".${ext}" expects ${expected} — possible spoof or rename`;
  }

  return null;
}

/**
 * Check whether the (already-normalised) MIME contradicts the
 * magic-derived type. A null MIME (missing / neutral) is a no-op.
 */
function mimeContradiction(magic: MagicMatch, mime: string | null): string | null {
  if (mime === null) return null;
  const expectedPrefix = magic.type === "image" ? IMAGE_MIME_PREFIX : VIDEO_MIME_PREFIX;
  if (mime.startsWith(expectedPrefix)) return null;
  const otherCategory: MediaType = magic.type === "image" ? "video" : "image";
  if (mime.startsWith(magic.type === "image" ? VIDEO_MIME_PREFIX : IMAGE_MIME_PREFIX)) {
    return `magic detected ${magic.format} (${magic.type}) but declared MIME "${mime}" is ${otherCategory}/* — possible spoof`;
  }
  return `magic detected ${magic.format} (${magic.type}) but declared MIME "${mime}" is neither image/* nor video/*`;
}
