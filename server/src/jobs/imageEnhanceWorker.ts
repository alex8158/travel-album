// Image enhance worker (P8.T1 constant + P8.T2 handler + P8.T3 output).
//
// Job handler registered as `image_enhance` on the image-channel
// executor (P3.T2). For one media row:
//
//   1. Resolve the original via `media_items.original_path`. Active
//      rows only — soft-deleted media surface as a failure (matches
//      the recycle-bin contract: the P8.T1 trigger already 404s
//      soft-deleted media, this is a belt-and-suspenders re-check
//      because the executor may pick up a job whose row was
//      soft-deleted between enqueue and dequeue).
//   2. Read original bytes through the LocalStorageProvider.
//   3. Run sharp in a deterministic 6-step pipeline:
//        a. .rotate()               — EXIF orientation
//        b. .modulate({ b, s })     — modest brightness + saturation
//        c. .linear(a, b)           — mild multiplicative contrast +
//                                     small black-point shift
//        d. .gamma(g)               — tonal lift
//        e. .sharpen(sigma, m1, m2) — light unsharp mask
//        f. .jpeg({ quality, mozjpeg })  — output
//      Every coefficient flows from `config.quality.enhance.*`.
//      Defaults (set in `config/index.ts`) keep changes within ±5%
//      of the source on typical photos — requirements §7.9 acceptance
//      #5 explicitly forbids over-saturation / over-sharpening.
//   4. Write the result to `derived/{mediaId}/enhanced.jpg` via
//      `storage.putDerived` with `overwrite:true` (so the job is
//      idempotent — a retry / re-enqueue regenerates the same file).
//   5. UPSERT a row in `media_versions(version_type='enhanced')`
//      pointing at the derived path; `params` is a JSON blob that
//      records every coefficient + worker version so a future
//      re-tune can be told apart from prior outputs.
//
// Scope per docs/tasks.md P8.T2 + P8.T3 — sharp pipeline + derived
// file + media_versions row are inseparable from a single handler's
// perspective (the worker can't claim "success" without all three).
// The two tasks land together in one commit; tasks.md marks both
// `[x]`; `progress.md` records the rationale.
//
// Explicitly NOT in scope (P8.T4 / P8.T5):
//   * The version-switching API (`GET /api/media/:id/versions`,
//     `POST /api/media/:id/select-version`).
//   * The frontend before-vs-after compare view.
//   * The `cover_url` / preview path on `media_items` is NOT mutated
//     here — the gallery should keep showing the original preview;
//     "selecting" the enhanced version is the P8.T4 user action.
//
// Failure modes (all throw → executor marks the job `failed` and
// retries per the JobQueue back-off policy; original file is NEVER
// overwritten):
//   * Media row missing / soft-deleted.
//   * media.type !== 'image' (defence in depth — P8.T1 already
//     guards at enqueue, but a row that was an image at enqueue and
//     a video at dequeue is theoretically possible).
//   * original_path is NULL.
//   * Original file empty / sharp can't read it.
//   * Storage write fails.

import type { Readable } from "node:stream";

import sharp from "sharp";

import type { Logger } from "../logger.js";
import type { MediaRepository, MediaVersionsRepository } from "../media/index.js";
import type { LocalStorageProvider } from "../storage/index.js";

import type { JobHandler } from "./handlerRegistry.js";

/** Closed job_type token. Registered by `server/src/index.ts` boot
 * once the handler lands in P8.T2; the enqueue endpoint added in
 * P8.T1 already inserts rows with this exact string. */
export const IMAGE_ENHANCE_JOB_TYPE = "image_enhance";

/** Logical relpath inside `derived/{mediaId}/`. Stable so a future
 * version-switching API (P8.T4) can reference it by convention. */
const ENHANCED_FILENAME = "enhanced.jpg";

/** Output MIME for the enhanced derivative. Always JPEG (sharp
 * `.jpeg({ mozjpeg: true })`); webp would be a tighter file but
 * design §6.2 specifies jpg for `enhanced` so a user can download
 * the file directly from the UI later. */
const ENHANCED_MIME = "image/jpeg";

/**
 * Tunables for the enhance pipeline. Every field flows from
 * `config.quality.enhance.*`; defaults live in `config/index.ts`
 * with documented bounds.
 *
 * The handler treats this object as a closed set — additions need
 * a matching env knob + a config-layer validator update.
 */
export interface EnhanceSettings {
  /** Hard upper bound on output's longest edge. */
  readonly maxEdge: number;
  /** sharp.modulate brightness multiplier (1.0 = identity). */
  readonly brightness: number;
  /** sharp.modulate saturation multiplier (1.0 = identity). */
  readonly saturation: number;
  /** sharp.gamma value (1.0 = identity; documented range [1.0, 3.0]). */
  readonly gamma: number;
  /** sharp.linear multiplier `a` (1.0 = identity). */
  readonly linearA: number;
  /** sharp.linear offset `b` (0 = identity). */
  readonly linearB: number;
  /** sharp.sharpen sigma (Gaussian σ; 0 disables sharpen). */
  readonly sharpenSigma: number;
  /** sharp.sharpen flat-area boost. */
  readonly sharpenM1: number;
  /** sharp.sharpen jagged-area boost. */
  readonly sharpenM2: number;
  /** Output JPEG quality (1..100). */
  readonly jpegQuality: number;
  /** Stamped into `media_versions.params` for traceability. */
  readonly workerVersion: string;
}

export interface ImageEnhanceHandlerDeps {
  readonly storage: LocalStorageProvider;
  readonly mediaRepo: MediaRepository;
  readonly mediaVersionsRepo: MediaVersionsRepository;
  readonly settings: EnhanceSettings;
  readonly logger: Logger;
}

/**
 * Build the `image_enhance` handler. Register the returned value
 * on the executor's `JobHandlerRegistry` at boot.
 */
export function makeImageEnhanceHandler(deps: ImageEnhanceHandlerDeps): JobHandler {
  return async (job) => {
    const correlation = { jobId: job.id, mediaId: job.mediaId };

    // ---- 1. Resolve media row ------------------------------------------
    const media = deps.mediaRepo.findById(job.mediaId);
    if (media === null) {
      throw new Error(`media not found or soft-deleted: ${job.mediaId}`);
    }
    if (media.type !== "image") {
      throw new Error(`media is not an image (type='${media.type}'); refusing to enhance`);
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

    // ---- 3. sharp pipeline --------------------------------------------
    // Steps run in deterministic order so the same input + same
    // settings always produce the same output (hash-stable). EVERY
    // sharp call is rebuilt from the same source buffer to avoid
    // accidental in-place mutation (sharp instances are
    // single-consumer).
    const { settings } = deps;

    // Start from a fresh instance so we don't accidentally chain off
    // the metadata-only one above.
    let pipeline = sharp(sourceBuf).rotate();

    // Bound the long edge — the enhanced file should not blow up
    // beyond the original (typically a no-op since we set the cap
    // high). `withoutEnlargement` prevents upscaling tiny inputs.
    pipeline = pipeline.resize({
      width: settings.maxEdge,
      height: settings.maxEdge,
      fit: "inside",
      withoutEnlargement: true,
    });

    // Step a: brightness + saturation (modulate). Modest multipliers
    // keep this from looking like a filter.
    pipeline = pipeline.modulate({
      brightness: settings.brightness,
      saturation: settings.saturation,
    });

    // Step b: mild multiplicative contrast + small black-point shift.
    // `linear(a, b)` applies `out = a * in + b` per-channel.
    pipeline = pipeline.linear(settings.linearA, settings.linearB);

    // Step c: gamma tonal lift. sharp requires gamma ≥ 1.0; the
    // config layer enforces that.
    pipeline = pipeline.gamma(settings.gamma);

    // Step d: light unsharp mask. Skip the call entirely when sigma
    // is zero so the user can dial sharpen off without paying for an
    // identity blur kernel.
    if (settings.sharpenSigma > 0) {
      pipeline = pipeline.sharpen({
        sigma: settings.sharpenSigma,
        m1: settings.sharpenM1,
        m2: settings.sharpenM2,
      });
    }

    // Step e: JPEG encode. mozjpeg=true gives ~10% smaller files at
    // the same visual quality. quality flows from config (default 88).
    const out = await pipeline
      .jpeg({ quality: settings.jpegQuality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });

    // ---- 4. Persist derived file --------------------------------------
    // overwrite:true keeps the handler idempotent — a retry / re-run
    // regenerates the file cleanly. We NEVER touch the original
    // (CLAUDE.md §2.1).
    const stored = await deps.storage.putDerived({
      tripId: media.tripId,
      mediaId: media.id,
      relPath: ENHANCED_FILENAME,
      data: out.data,
      overwrite: true,
    });

    // ---- 5. UPSERT media_versions row ---------------------------------
    // Records every knob so a future re-tune (e.g. WORKER_VERSION
    // bump) can be diffed against historical outputs. `media_id +
    // version_type='enhanced'` is UNIQUE per migration 005 / 006, so
    // a re-run on the same media replaces the row in place.
    const now = new Date().toISOString();
    const paramsJson = JSON.stringify({
      sharpVersion: sharp.versions?.vips ?? null,
      workerVersion: settings.workerVersion,
      pipeline: [
        "rotate",
        `resize(maxEdge=${settings.maxEdge}, fit=inside, withoutEnlargement)`,
        `modulate(brightness=${settings.brightness}, saturation=${settings.saturation})`,
        `linear(${settings.linearA}, ${settings.linearB})`,
        `gamma(${settings.gamma})`,
        settings.sharpenSigma > 0
          ? `sharpen(sigma=${settings.sharpenSigma}, m1=${settings.sharpenM1}, m2=${settings.sharpenM2})`
          : "sharpen(skipped, sigma=0)",
        `jpeg(quality=${settings.jpegQuality}, mozjpeg=true)`,
      ],
    });
    deps.mediaVersionsRepo.upsert({
      mediaId: media.id,
      versionType: "enhanced",
      filePath: stored.logicalPath,
      mimeType: ENHANCED_MIME,
      width: out.info.width,
      height: out.info.height,
      fileSize: out.info.size,
      params: paramsJson,
      now,
    });

    deps.logger.info(
      {
        ...correlation,
        enhancedPath: stored.logicalPath,
        width: out.info.width,
        height: out.info.height,
        bytes: out.info.size,
        workerVersion: settings.workerVersion,
      },
      "image_enhance: derived enhanced.jpg written + media_versions upserted",
    );
  };
}

/**
 * Drain a node Readable into a single Buffer. Used to feed sharp,
 * which prefers a Buffer over a stream when the same source has to
 * be read multiple times. Identical helper to the one in
 * `imageThumbnailWorker.ts` — kept locally to avoid a cross-module
 * dependency for a four-line utility.
 */
async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}
