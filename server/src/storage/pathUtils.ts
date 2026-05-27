// Storage path validators and canonical layout helpers (P0.T7).
//
// Layout (per docs/design.md §5.2):
//   {root}/trips/{tripId}/originals/{mediaId}.{extension}
//   {root}/trips/{tripId}/derived/{mediaId}/{relPath}
//
// Every untrusted input must be validated BEFORE it touches the file
// system. We layer three independent checks:
//   1. Per-segment regex (rejects "..", null bytes, slashes, etc.).
//   2. POSIX normalisation + manual prefix check ("../", absolute).
//   3. After resolving against the storage root, require the result to
//      be a descendant of the root via path.relative.
// Any of the three can reject; the redundancy is deliberate.

import path from "node:path";
import { invalidKey, pathTraversal } from "./errors.js";

const VALID_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const VALID_EXT_RE = /^[A-Za-z0-9]{1,8}$/;
// Each segment of a relPath: alnum, dot, underscore, dash. No slashes,
// no whitespace, no null. Length 1-128 to avoid pathological inputs.
const VALID_REL_SEGMENT_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function assertValidId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !VALID_ID_RE.test(value)) {
    throw invalidKey(`${label} must match /^[A-Za-z0-9_-]{1,128}$/, got: ${printableValue(value)}`);
  }
}

export function assertValidExtension(ext: unknown): asserts ext is string {
  if (typeof ext !== "string" || !VALID_EXT_RE.test(ext)) {
    throw invalidKey(`extension must match /^[A-Za-z0-9]{1,8}$/, got: ${printableValue(ext)}`);
  }
}

/**
 * Validate a relative path written within a derived/{mediaId}/ directory.
 * Returns the input unchanged once verified; throws StorageError otherwise.
 */
export function assertSafeRelPath(relPath: unknown): string {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw invalidKey(`relPath must be a non-empty string, got: ${printableValue(relPath)}`);
  }
  if (relPath.includes("\0")) {
    throw invalidKey("relPath contains null byte");
  }
  if (relPath.includes("\\")) {
    throw invalidKey("relPath must use forward slashes only");
  }
  if (path.isAbsolute(relPath)) {
    throw invalidKey(`relPath must be relative, got: ${relPath}`);
  }
  const segments = relPath.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") {
      throw pathTraversal(`relPath contains forbidden segment "${seg}": ${relPath}`);
    }
    if (!VALID_REL_SEGMENT_RE.test(seg)) {
      throw invalidKey(`relPath segment "${seg}" must match /^[A-Za-z0-9._-]{1,128}$/`);
    }
  }
  return relPath;
}

/** Compose the canonical logical path for an original file. */
export function originalLogicalPath(tripId: string, mediaId: string, extension: string): string {
  assertValidId(tripId, "tripId");
  assertValidId(mediaId, "mediaId");
  assertValidExtension(extension);
  return `trips/${tripId}/originals/${mediaId}.${extension}`;
}

/** Compose the canonical logical path for a derived file. */
export function derivedLogicalPath(tripId: string, mediaId: string, relPath: string): string {
  assertValidId(tripId, "tripId");
  assertValidId(mediaId, "mediaId");
  const safe = assertSafeRelPath(relPath);
  return `trips/${tripId}/derived/${mediaId}/${safe}`;
}

/** P11.T6 — closed subdir enum for `audio_library/{kind}/`.
 *
 *   * `user`     — user-uploaded files (`POST /api/audio-library/upload`)
 *   * `imported` — files downloaded from a URL (`POST /api/audio-library/import-url`)
 *
 * `system` is intentionally NOT in this enum: bundled defaults live
 * OUTSIDE the storage root at the configured `DEFAULT_AUDIO_LIBRARY_DIR`
 * (P11.T2 / P11.T3 convention; default `server/assets/audio/default/`).
 * Writing user-owned audio under the same on-disk tree as the
 * git-tracked system audio would mix mutable + immutable assets,
 * which is exactly what these subdirs separate.
 */
export type AudioLibrarySubdir = "user" | "imported";

/** Compose the canonical logical path for an audio_library file. */
export function audioLibraryLogicalPath(
  subdir: AudioLibrarySubdir,
  audioId: string,
  extension: string,
): string {
  if (subdir !== "user" && subdir !== "imported") {
    throw invalidKey(
      `audio_library subdir must be 'user' or 'imported', got: ${printableValue(subdir)}`,
    );
  }
  assertValidId(audioId, "audioId");
  assertValidExtension(extension);
  return `audio_library/${subdir}/${audioId}.${extension}`;
}

/**
 * Resolve a logical path under the given storage root, double-checking
 * that the resolved absolute path remains inside the root. Throws
 * StorageError on any sign of escape.
 */
export function resolveUnderRoot(root: string, logicalPath: unknown): string {
  if (typeof logicalPath !== "string" || logicalPath.length === 0) {
    throw invalidKey(`logicalPath must be a non-empty string, got: ${printableValue(logicalPath)}`);
  }
  if (logicalPath.includes("\0")) {
    throw invalidKey("logicalPath contains null byte");
  }
  if (logicalPath.includes("\\")) {
    throw invalidKey("logicalPath must use forward slashes only");
  }
  if (path.isAbsolute(logicalPath)) {
    throw invalidKey(`logicalPath must be relative, got: ${logicalPath}`);
  }
  const normalised = path.posix.normalize(logicalPath);
  if (normalised === ".." || normalised.startsWith("../") || normalised.startsWith("/")) {
    throw pathTraversal(`logicalPath escapes root: ${logicalPath}`);
  }
  const absolute = path.resolve(root, normalised);
  const rel = path.relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw pathTraversal(`Resolved path escapes root: ${logicalPath} -> ${absolute}`);
  }
  return absolute;
}

function printableValue(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}
