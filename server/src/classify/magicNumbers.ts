// Magic-number matcher for the file classifier (P2.T3).
//
// Hand-written, dependency-free. Covers the 5 image and 5 video
// formats listed in requirements §7.2:
//
//   image: jpg / jpeg / png / webp / heic
//   video: mp4 / mov / m4v / avi / mkv
//
// Anything outside that closed set returns `null` so the classifier
// can decide whether to call it `unknown` (with reason). The matcher
// does NOT try to be exhaustive — exotic brands or obscure formats
// (e.g. AVIF, RAW, MPEG-2 TS) will read as null and the classifier
// will reject them. Recorded as P2.T3 risk R-37 / R-40 in
// docs/progress.md.
//
// Reference patterns:
//
//   JPEG : FF D8 FF                                (offset 0)
//   PNG  : 89 50 4E 47 0D 0A 1A 0A                 (offset 0)
//   RIFF : "RIFF" .... "WEBP"                      (image, offset 8)
//          "RIFF" .... "AVI "                      (video, offset 8)
//   MKV  : 1A 45 DF A3                             (offset 0; EBML)
//   ISO BMFF (mp4 / mov / m4v / heic): bytes 4-7 = "ftyp"
//                                       bytes 8-11 = brand (case-
//                                       insensitive lookup table)
//
// All magic patterns require ≤ 12 head bytes; callers should pass
// at least that many. Buffers shorter than the pattern length simply
// fail to match (never throw).

/**
 * The format strings are descriptive (e.g. "jpeg", "mp4"), not
 * normative — the classifier only uses `MagicMatch.type`. They are
 * embedded into reason strings to help debug an unexpected unknown.
 */
export interface MagicMatch {
  readonly type: "image" | "video";
  readonly format: string;
}

const FTYP_OFFSET = 4;
const FTYP_TAG_LEN = 4;
const FTYP_BRAND_OFFSET = 8;
const FTYP_BRAND_LEN = 4;

const FTYP_TAG = "ftyp";

/** ISO BMFF brand → image format (HEIC family). */
const HEIC_BRANDS: ReadonlySet<string> = new Set(["heic", "heix", "heim", "heis", "mif1", "msf1"]);

/**
 * ISO BMFF brand → video format. We treat M4V's specific brand
 * separately so the format string stays informative; functionally
 * both are video.
 */
const MP4_BRANDS: ReadonlySet<string> = new Set([
  "isom",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "mp4v",
  "avc1",
  "mmp4",
  "dash",
  "f4v ",
]);

/**
 * Match the head bytes against the supported magic patterns.
 * Returns null when nothing recognised — including the case where
 * an `ftyp` box is present but the brand is not in our allowlist.
 *
 * Pure / synchronous; safe to call on any Uint8Array including empty
 * or extremely short ones.
 */
export function matchMagic(head: Uint8Array): MagicMatch | null {
  // JPEG — three-byte SOI marker.
  if (startsWith(head, [0xff, 0xd8, 0xff])) {
    return { type: "image", format: "jpeg" };
  }

  // PNG — eight-byte signature.
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { type: "image", format: "png" };
  }

  // RIFF container — 4 bytes "RIFF", 4 bytes size (ignored), then a
  // 4-byte sub-format tag. WEBP and AVI both live here.
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46])) {
    const sub = asciiAt(head, 8, 4);
    if (sub === "WEBP") return { type: "image", format: "webp" };
    if (sub === "AVI ") return { type: "video", format: "avi" };
    // RIFF/WAV and others fall through to null.
  }

  // Matroska (MKV / WebM) — EBML header.
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) {
    return { type: "video", format: "mkv" };
  }

  // ISO Base Media File Format — bytes 4..7 spell "ftyp".
  if (asciiAt(head, FTYP_OFFSET, FTYP_TAG_LEN) === FTYP_TAG) {
    const rawBrand = asciiAt(head, FTYP_BRAND_OFFSET, FTYP_BRAND_LEN);
    if (rawBrand === null) return null;
    const brand = rawBrand.toLowerCase();
    if (HEIC_BRANDS.has(brand)) return { type: "image", format: "heic" };
    if (brand === "qt  ") return { type: "video", format: "mov" };
    // M4V brand has trailing space; preserved exactly.
    if (brand === "m4v ") return { type: "video", format: "m4v" };
    if (MP4_BRANDS.has(brand)) return { type: "video", format: "mp4" };
    // Recognised ISO BMFF container with unknown brand → null.
  }

  return null;
}

// ---------------------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------------------

function startsWith(buf: Uint8Array, prefix: readonly number[]): boolean {
  if (buf.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (buf[i] !== prefix[i]) return false;
  }
  return true;
}

/**
 * Read `length` bytes from `buf` starting at `offset` and decode them
 * as ASCII. Returns null when the buffer is too short — never throws.
 * Bytes outside the printable ASCII range (0x20..0x7e) are still
 * decoded with String.fromCharCode; the caller compares against ASCII
 * tags so non-ASCII bytes will simply not match anything.
 */
function asciiAt(buf: Uint8Array, offset: number, length: number): string | null {
  if (buf.length < offset + length) return null;
  let s = "";
  for (let i = 0; i < length; i += 1) {
    const b = buf[offset + i];
    if (b === undefined) return null;
    s += String.fromCharCode(b);
  }
  return s;
}
