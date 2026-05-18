// ImageWorker.hash (P5.T2).
//
// Job handler registered as `image_hash` on the image-channel
// JobQueue. For one media row:
//   1. Resolve the original via `media_items.original_path`.
//   2. Read the bytes through the existing LocalStorageProvider.
//   3. Compute the file-level SHA256 (exact-duplicate signal — P5.T3).
//   4. Compute pHash (DCT-based, 64 bits) and dHash (gradient-based,
//      64 bits) perceptual signatures (similar-duplicate signal —
//      P5.T4).
//   5. Persist via MediaRepository.updateImageHashes:
//        * `media_items.file_hash` ← SHA256 hex (64 chars)
//        * `media_items.perceptual_hash` ← pHashHex(16) + dHashHex(16)
//          = 32 hex chars
//
// Scope per docs/tasks.md P5.T2 — strictly hash compute + persist.
// Explicitly NOT in scope:
//   * Duplicate grouping (P5.T3 / P5.T4) — that consumes these
//     columns through `Dedup_Engine.exact` / `.similar`.
//   * Recommendation / quality scoring (P5.T7 / P6.T5).
//   * Triggering this job from the upload path (R-41-style chaining
//     is a later concern; today the row is created by reprocess /
//     manual seed and picked up by JobQueue).
//
// Idempotency:
//   * Hashes are deterministic over the same bytes — re-running on
//     the same media writes the same values. UPDATE just overwrites.
//   * `media_items.original_path` is never written by this handler
//     (CLAUDE.md §2.1 — originals are immutable).
//
// Failure modes:
//   * Media row missing / soft-deleted → throw → JobQueue marks job
//     `failed` with the thrown message.
//   * Media type ≠ image → throw (the handler refuses to hash video
//     bytes; video hashing is a P9 concern with different semantics).
//   * Original path missing → throw.
//   * Source file empty or storage read error → throw.
//   * sharp fails to decode (corrupted / unsupported format) → throw.
//
// Algorithm — pHash (DCT):
//   1. sharp: resize source to 32×32 grayscale, raw bytes.
//   2. Compute the separable 2-D DCT-II of the 32×32 image (rows
//      then columns).
//   3. Take the top-left 8×8 block of DCT coefficients (low
//      frequencies — these encode coarse structure that survives
//      rescaling / mild JPEG re-encoding).
//   4. Compute the median of the 64 coefficients. Threshold: bit = 1
//      if coeff > median, else 0. Median-based (rather than mean-
//      based) keeps the hash robust against a single huge DC value.
//   5. Output: 64 bits packed MSB-first → 16-char lowercase hex.
//
// Algorithm — dHash (gradient):
//   1. sharp: resize source to 9×8 grayscale, raw bytes.
//   2. For each of 8 rows, compare 8 horizontal pairs (left vs right
//      neighbour): bit = 1 if left > right, else 0.
//   3. Output: 64 bits packed MSB-first → 16-char lowercase hex.
//
// Both algorithms run on small buffers (1024 / 72 bytes after
// resize) — the JS-side cost is negligible compared to the sharp
// resize itself.

import { createHash } from "node:crypto";
import type { Readable } from "node:stream";

import sharp from "sharp";

import type { Logger } from "../logger.js";
import type { MediaRepository } from "../media/index.js";
import type { LocalStorageProvider } from "../storage/index.js";

import type { JobHandler } from "./handlerRegistry.js";

/** Closed job_type token. Registered by `server/src/index.ts` boot. */
export const IMAGE_HASH_JOB_TYPE = "image_hash";

/** Side length of the grayscale image fed to the pHash DCT. */
const PHASH_RESIZE = 32;
/** Side length of the low-frequency DCT block used as the pHash. */
const PHASH_DCT_BLOCK = 8;
/** Width of the grayscale image fed to dHash (height is `DHASH_HEIGHT`). */
const DHASH_WIDTH = 9;
const DHASH_HEIGHT = 8;

export interface ImageHashHandlerDeps {
  readonly storage: LocalStorageProvider;
  readonly mediaRepo: MediaRepository;
  readonly logger: Logger;
}

/**
 * Build the `image_hash` handler. Register the returned value on
 * the JobQueue's image-channel handler Map at boot.
 */
export function makeImageHashHandler(deps: ImageHashHandlerDeps): JobHandler {
  return async (job) => {
    const correlation = { jobId: job.id, mediaId: job.mediaId };

    // ---- 1. Resolve media row ------------------------------------------
    const media = deps.mediaRepo.findById(job.mediaId);
    if (media === null) {
      throw new Error(`media not found or soft-deleted: ${job.mediaId}`);
    }
    if (media.type !== "image") {
      throw new Error(`media is not an image (type='${media.type}'); refusing to hash`);
    }
    if (media.originalPath === null) {
      throw new Error("media has no original_path; cannot read source bytes");
    }

    // ---- 2. Read original bytes ----------------------------------------
    const sourceStream = await deps.storage.read(media.originalPath);
    const sourceBuf = await streamToBuffer(sourceStream);
    if (sourceBuf.length === 0) {
      throw new Error("original file is empty");
    }

    // ---- 3. SHA256 over the raw file bytes -----------------------------
    // Deliberately hashes the on-disk bytes, NOT a normalised /
    // re-encoded representation. P5.T3 `Dedup_Engine.exact` matches
    // strict byte equality, so two files differing in even one EXIF
    // byte must hash differently.
    const fileHash = createHash("sha256").update(sourceBuf).digest("hex");

    // ---- 4. pHash + dHash ----------------------------------------------
    // sharp().rotate() honours EXIF Orientation so the perceptual hash
    // matches the displayed image — a portrait phone photo with
    // rotation tag and the same image visually rotated should produce
    // the same pHash / dHash, which is the dedup engine's expectation.
    const pHash = await computePHash(sourceBuf);
    const dHash = await computeDHash(sourceBuf);
    const perceptualHash = pHash + dHash; // 16 + 16 = 32 hex chars

    // ---- 5. Persist on media_items -------------------------------------
    const now = new Date().toISOString();
    const changed = deps.mediaRepo.updateImageHashes({
      mediaId: media.id,
      fileHash,
      perceptualHash,
      updatedAt: now,
    });
    if (changed === 0) {
      // Row was soft-deleted between findById and the UPDATE — race
      // with a user soft-delete or another worker. Hash compute work
      // is sunk; log + continue. The handler still succeeds because
      // the side-effect we wanted (writing onto an active row) was
      // simply no longer applicable, not erroneous.
      deps.logger.warn(
        { ...correlation, mediaId: media.id },
        "image_hash: media row not updated (likely soft-deleted mid-job)",
      );
    }

    deps.logger.info(
      {
        ...correlation,
        originalPath: media.originalPath,
        fileBytes: sourceBuf.length,
        // Hashes themselves are not PII but logging them is also not
        // useful in volume; emit lengths + a short prefix so log
        // diagnostics can spot the "all-zero" / "all the same" bugs
        // without dumping the full digest.
        fileHashPrefix: fileHash.slice(0, 12),
        perceptualHashPrefix: perceptualHash.slice(0, 12),
      },
      "image_hash: hashes computed and persisted",
    );
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

/**
 * Compute the DCT-II based pHash of an image. Returns 16 lowercase
 * hex chars (64 bits). Exported for the smoke / future unit tests.
 *
 * The function fully owns the sharp pipeline — callers pass the raw
 * source bytes and the function takes care of rotate + resize +
 * grayscale + raw extraction.
 */
export async function computePHash(sourceBuf: Buffer): Promise<string> {
  const resized = await sharp(sourceBuf)
    .rotate()
    .resize(PHASH_RESIZE, PHASH_RESIZE, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer();
  // sharp's `.raw()` after `.grayscale()` emits 1 byte per pixel.
  if (resized.length !== PHASH_RESIZE * PHASH_RESIZE) {
    throw new Error(
      `pHash: unexpected grayscale buffer length ${resized.length} (expected ${
        PHASH_RESIZE * PHASH_RESIZE
      })`,
    );
  }

  // Convert to a 2-D Float64 matrix for the DCT compute.
  const pixels: number[][] = [];
  for (let y = 0; y < PHASH_RESIZE; y += 1) {
    const row: number[] = new Array(PHASH_RESIZE);
    for (let x = 0; x < PHASH_RESIZE; x += 1) {
      row[x] = resized[y * PHASH_RESIZE + x] as number;
    }
    pixels.push(row);
  }

  const dct = dct2D(pixels);
  // Take top-left 8×8 block.
  const block: number[] = [];
  for (let y = 0; y < PHASH_DCT_BLOCK; y += 1) {
    for (let x = 0; x < PHASH_DCT_BLOCK; x += 1) {
      block.push(dct[y]![x]!);
    }
  }
  const median = medianOf(block);
  const bits: number[] = block.map((v) => (v > median ? 1 : 0));
  return bitsToHex(bits);
}

/**
 * Compute the gradient-based dHash. Returns 16 lowercase hex chars
 * (64 bits). Exported for the smoke / future unit tests.
 */
export async function computeDHash(sourceBuf: Buffer): Promise<string> {
  const resized = await sharp(sourceBuf)
    .rotate()
    .resize(DHASH_WIDTH, DHASH_HEIGHT, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer();
  if (resized.length !== DHASH_WIDTH * DHASH_HEIGHT) {
    throw new Error(
      `dHash: unexpected grayscale buffer length ${resized.length} (expected ${
        DHASH_WIDTH * DHASH_HEIGHT
      })`,
    );
  }
  const bits: number[] = [];
  for (let y = 0; y < DHASH_HEIGHT; y += 1) {
    for (let x = 0; x < DHASH_WIDTH - 1; x += 1) {
      const left = resized[y * DHASH_WIDTH + x] as number;
      const right = resized[y * DHASH_WIDTH + x + 1] as number;
      bits.push(left > right ? 1 : 0);
    }
  }
  return bitsToHex(bits);
}

/**
 * Separable 2-D DCT-II of an N×N matrix. Implemented as N row-wise
 * 1-D DCTs followed by N column-wise 1-D DCTs over the intermediate
 * result. Returns a new N×N matrix of doubles.
 *
 * O(N³) — fine for N=32 (≈32 768 multiplications, < 1 ms on a laptop
 * CPU). The handler runs once per media so the constant doesn't
 * matter; readability wins over a fancy FFT.
 */
function dct2D(input: readonly number[][]): number[][] {
  const N = input.length;
  // Row-wise pass.
  const rowDct: number[][] = [];
  for (let y = 0; y < N; y += 1) {
    rowDct.push(dct1D(input[y] as readonly number[]));
  }
  // Column-wise pass on the row-DCT result.
  const out: number[][] = Array.from({ length: N }, () => new Array<number>(N).fill(0));
  for (let x = 0; x < N; x += 1) {
    const col: number[] = new Array<number>(N);
    for (let y = 0; y < N; y += 1) col[y] = rowDct[y]![x]!;
    const colDct = dct1D(col);
    for (let y = 0; y < N; y += 1) out[y]![x] = colDct[y]!;
  }
  return out;
}

/**
 * Standard 1-D DCT-II of an N-vector.
 *   X[k] = sum_{n=0..N-1} x[n] * cos( pi/N * (n + 0.5) * k )
 *
 * No normalisation factor is applied; the pHash threshold is the
 * median of the resulting block, so any uniform scaling cancels out.
 */
function dct1D(input: readonly number[]): number[] {
  const N = input.length;
  const out: number[] = new Array<number>(N).fill(0);
  for (let k = 0; k < N; k += 1) {
    let sum = 0;
    for (let n = 0; n < N; n += 1) {
      sum += (input[n] as number) * Math.cos((Math.PI / N) * (n + 0.5) * k);
    }
    out[k] = sum;
  }
  return out;
}

/**
 * Sort-and-pick median of a numeric array. Operates on a shallow
 * copy so the caller's input is preserved. For pHash we expect
 * length 64 → cost is negligible.
 */
function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * Pack an array of 0/1 bits into a lowercase hex string, MSB-first
 * within each nibble. Length must be a multiple of 4. For 64 bits the
 * result is exactly 16 chars.
 */
function bitsToHex(bits: readonly number[]): string {
  if (bits.length % 4 !== 0) {
    throw new Error(`bitsToHex: bit count ${bits.length} not divisible by 4`);
  }
  let out = "";
  for (let i = 0; i < bits.length; i += 4) {
    const nibble =
      ((bits[i] as number) << 3) |
      ((bits[i + 1] as number) << 2) |
      ((bits[i + 2] as number) << 1) |
      (bits[i + 3] as number);
    out += nibble.toString(16);
  }
  return out;
}
