// Image enhance job (P8.T1 — constant only; handler lands in P8.T2).
//
// This module hosts the `image_enhance` job_type token now so the
// enqueue endpoint (P8.T1) can reference a single canonical value
// without forcing the sharp pipeline (P8.T2) to land first.
//
// Per design.md §6.2.2 / §6.2.7, `image_enhance` is part of the image
// channel — same executor + concurrency budget as
// `image_thumbnail / image_metadata / image_hash / image_quality_* /
// image_quality_finalize`. The handler (P8.T2) will register itself
// at boot in `server/src/index.ts` alongside the other image workers.
//
// Why a placeholder module instead of inlining the constant in
// `mediaService.ts`?
//   * Mirrors the codebase convention: every other image-channel
//     handler (`imageHashWorker`, `imageQualityBlurWorker`,
//     `imageQualityExposureWorker`, etc.) owns its own job_type
//     constant inside its module. Putting the token here lets P8.T2
//     extend this same file with `makeImageEnhanceHandler` later
//     without a constant-move refactor.
//   * Keeps the Service layer free of low-level token strings — the
//     Service imports the symbolic constant, not the literal.
//
// No other exports yet — `makeImageEnhanceHandler` and
// `ImageEnhanceHandlerDeps` are intentionally absent until P8.T2.

/** Closed job_type token. Registered by `server/src/index.ts` boot
 * once the handler lands in P8.T2; the enqueue endpoint added in
 * P8.T1 already inserts rows with this exact string. */
export const IMAGE_ENHANCE_JOB_TYPE = "image_enhance";
