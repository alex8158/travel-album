// Hex string Hamming distance helper (P5.T4).
//
// Used by `DedupEngine.runSimilarForTrip` to compare the pHash half
// of `media_items.perceptual_hash`. Kept in its own file so the
// algorithm is trivially testable in isolation from the SQLite /
// repository plumbing.
//
// Format note: P5.T2 stores `perceptual_hash` as
//   pHashHex(16) + dHashHex(16) = 32 hex chars
// so the caller slices the first 16 chars to compute pHash distance.

/** Maximum bit-level Hamming distance for a 64-bit (16-hex) hash. */
export const HEX16_MAX_BITS = 64;

/** Regex matching a lowercase or uppercase hex string of any length. */
const HEX_PATTERN = /^[0-9a-fA-F]+$/;

/**
 * Bit-level Hamming distance between two hex strings.
 *
 *   * Compares only the first `hexLen` characters of each input (so a
 *     32-char perceptual_hash can be split into "first 16 = pHash" by
 *     the caller without slicing twice).
 *   * Returns `null` when either input is shorter than `hexLen` or
 *     contains non-hex characters — gives the caller a single
 *     deterministic "bad input" signal instead of throwing on a
 *     suspect row.
 *
 * The bit count uses XOR + Brian-Kernighan-style popcount per nibble.
 * For a 16-hex input that's 16 nibbles, each ≤ 4 set bits → constant
 * upper bound on work per pair. No bigint, no buffer alloc — the
 * pairwise compare loop in DedupEngine runs millions of iterations
 * per Trip in the worst case, so the helper stays tight.
 */
export function hexHammingDistance(a: string, b: string, hexLen: number): number | null {
  if (hexLen <= 0) return null;
  if (a.length < hexLen || b.length < hexLen) return null;
  // Cheap up-front hex check on the slices we'll actually examine.
  // The caller is encouraged to pre-validate but we don't trust it.
  if (!HEX_PATTERN.test(a.slice(0, hexLen)) || !HEX_PATTERN.test(b.slice(0, hexLen))) {
    return null;
  }
  let distance = 0;
  for (let i = 0; i < hexLen; i += 1) {
    // parseInt with radix 16 over a single char is fast in V8 and
    // avoids charCodeAt arithmetic that's harder to read. The
    // pre-filter above guarantees a finite [0,15] result.
    const va = parseInt(a[i] as string, 16);
    const vb = parseInt(b[i] as string, 16);
    let xor = va ^ vb;
    while (xor !== 0) {
      distance += xor & 1;
      xor >>>= 1;
    }
  }
  return distance;
}
