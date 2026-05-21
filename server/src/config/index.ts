// Centralised runtime configuration for the Travel Album backend.
//
// Responsibilities (P0.T4):
//   1. Load `.env` (optional) from server/.env then <repo-root>/.env, first match wins.
//   2. Validate the merged environment with zod, applying safe defaults.
//   3. Expose a strongly-typed `Config` object grouped by concern.
//   4. Throw on startup if required variables are missing or invalid.
//
// Threshold and weight defaults follow docs/design.md §11.1. The list of
// variables mirrors docs/tasks.md P0.T4 and the example values in `.env.example`.

import { config as dotenvConfig } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// ---------------------------------------------------------------------------
// .env file loading
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
// In dev (tsx): here = <repo>/server/src/config
// After build:  here = <repo>/server/dist/config
// Both resolve to the same server/ and repo root via "..", "..".
const serverDir = resolve(here, "..", "..");
const repoRoot = resolve(serverDir, "..");

function loadDotenvFiles(): string[] {
  const candidates = [resolve(serverDir, ".env"), resolve(repoRoot, ".env")];
  const loaded: string[] = [];
  for (const path of candidates) {
    if (existsSync(path)) {
      // override:false → first-loaded value wins, later files only fill gaps.
      dotenvConfig({ path, override: false });
      loaded.push(path);
    }
  }
  return loaded;
}

// ---------------------------------------------------------------------------
// zod helpers
// ---------------------------------------------------------------------------

const stripEmpty = (v: unknown): unknown =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const parseBool = (v: unknown): unknown => {
  if (typeof v !== "string") return v;
  const t = v.trim().toLowerCase();
  if (t === "") return undefined;
  if (["true", "1", "yes", "on"].includes(t)) return true;
  if (["false", "0", "no", "off"].includes(t)) return false;
  return v; // let zod fail with a helpful message
};

const intPositive = (def: number) =>
  z.preprocess(stripEmpty, z.coerce.number().int().positive().default(def));

const intNonNeg = (def: number) =>
  z.preprocess(stripEmpty, z.coerce.number().int().nonnegative().default(def));

const numNonNeg = (def: number) =>
  z.preprocess(stripEmpty, z.coerce.number().nonnegative().default(def));

const strDefault = (def: string) => z.preprocess(stripEmpty, z.string().default(def));

const strOptional = z.preprocess(stripEmpty, z.string().min(1).optional());

const boolDefault = (def: boolean) => z.preprocess(parseBool, z.boolean().default(def));

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

const schema = z
  .object({
    // Runtime — NODE_ENV is the only variable WITHOUT a default; missing it
    // makes startup fail (per task requirement).
    NODE_ENV: z.preprocess(stripEmpty, z.enum(["development", "test", "production"])),
    PORT: intPositive(3000),

    // Storage (design §5)
    STORAGE_DRIVER: z.preprocess(stripEmpty, z.enum(["local", "s3"]).default("local")),
    STORAGE_LOCAL_ROOT: strDefault("./storage"),

    // Database (design §4)
    DATABASE_PATH: strDefault("./data/app.db"),

    // Workers (design §1.2 / §9.2)
    IMAGE_WORKER_CONCURRENCY: intPositive(2),
    VIDEO_WORKER_CONCURRENCY: intPositive(1),
    AI_WORKER_CONCURRENCY: intPositive(1),
    JOB_RETRY_MAX: intNonNeg(3),
    // P4.T2 retry backoff: delay = min(base * 2^retry_count, max).
    JOB_RETRY_BASE_DELAY_MS: intPositive(1000),
    JOB_RETRY_MAX_DELAY_MS: intPositive(60_000),
    ZOMBIE_TIMEOUT_MS: intPositive(1_800_000),

    // External binaries (design §8.4) — optional; fall back to PATH lookup.
    FFMPEG_PATH: strOptional,
    FFPROBE_PATH: strOptional,

    // AI (design §7.6 / §11.1) — disabled by default
    AI_ENABLED: boolDefault(false),
    AI_PROVIDER: strDefault(""),
    AI_DAILY_LIMIT: intNonNeg(0),
    AI_TRIP_LIMIT: intNonNeg(0),

    // Upload (requirements §7.2)
    UPLOAD_MAX_FILE_SIZE: intPositive(524_288_000), // 500 MB
    UPLOAD_ALLOWED_IMAGE_EXT: strDefault("jpg,jpeg,png,webp,heic"),
    UPLOAD_ALLOWED_VIDEO_EXT: strDefault("mp4,mov,m4v,avi,mkv"),

    // Delete (design §4.3) — first-version main flow keeps this off
    PERMANENT_DELETE_ENABLED: boolDefault(false),

    // Image quality thresholds (design §11.1)
    BLUR_THRESHOLD_BLURRY: numNonNeg(50),
    BLUR_THRESHOLD_MAYBE: numNonNeg(120),
    // P6.T2 image_quality.blur worker — operational knobs. Both have
    // safe defaults so the worker is usable on a fresh checkout.
    //   * MAX_EDGE controls the resize target before Laplacian variance
    //     compute: smaller = faster + less memory but loses fine detail.
    //     512 is the project default; matches roughly the "preview"
    //     resolution and gives stable variance numbers in the 0..300
    //     range over real photos.
    //   * WORKER_VERSION is stamped into `media_analysis.raw_result`
    //     so a later re-run can be told apart from older results; bump
    //     when the algorithm changes (different kernel, different
    //     normalisation, etc).
    IMAGE_QUALITY_BLUR_MAX_EDGE: intPositive(512),
    IMAGE_QUALITY_BLUR_WORKER_VERSION: strDefault("1.0"),
    // P6.T3 image_quality.exposure worker — operational knobs.
    //   * MAX_EDGE: resize target before histogram compute. Smaller =
    //     faster, less RAM, but slightly coarser ratios. 512 matches
    //     blur for consistency.
    //   * UNDER_MEAN_THRESHOLD / OVER_MEAN_THRESHOLD: classify by
    //     mean luminance (0..255). Anything below 70 / above 185 is
    //     a candidate for under / over even before pixel ratios are
    //     considered. Defaults sit close to the photographic
    //     "Zone 3" / "Zone 7" rules of thumb.
    //   * DARK_PIXEL_RATIO_THRESHOLD / BRIGHT_PIXEL_RATIO_THRESHOLD:
    //     fraction of pixels below "dark cutoff" (≤30) / above
    //     "bright cutoff" (≥225). When EITHER passes its threshold,
    //     the image is also flagged under / over regardless of mean.
    //     The cutoffs themselves (30 / 225) are algorithm internals
    //     baked into the worker — they describe "what counts as a
    //     shadow / highlight pixel" and changing them changes the
    //     algorithm shape rather than its threshold tuning.
    //   * WORKER_VERSION: stamped into raw_result.$.exposure for
    //     traceability across algorithm bumps.
    IMAGE_QUALITY_EXPOSURE_MAX_EDGE: intPositive(512),
    EXPOSURE_UNDER_MEAN_THRESHOLD: numNonNeg(70),
    EXPOSURE_OVER_MEAN_THRESHOLD: numNonNeg(185),
    EXPOSURE_DARK_PIXEL_RATIO_THRESHOLD: numNonNeg(0.5),
    EXPOSURE_BRIGHT_PIXEL_RATIO_THRESHOLD: numNonNeg(0.5),
    IMAGE_QUALITY_EXPOSURE_WORKER_VERSION: strDefault("1.0"),
    // P6.T4 image_quality.color worker — operational knobs.
    //   * MAX_EDGE: resize target before HSV / channel-balance compute.
    //     512 matches blur / exposure for consistency.
    //   * LOW_SATURATION_THRESHOLD: meanSaturation (0..1) below this →
    //     classify `color-low-saturation`. 0.10 catches near-greyscale
    //     content while leaving low-key but still colourful photos alone.
    //   * HIGH_SATURATION_THRESHOLD: meanSaturation (0..1) above this →
    //     `color-high-saturation`. 0.75 covers overly punchy edits or
    //     stylised filters.
    //   * COLOR_CAST_THRESHOLD: when max(meanR, meanG, meanB) -
    //     min(...) exceeds this (in 0..255 channel-mean units), the
    //     image is flagged with the dominant cast direction. 30 ≈ a
    //     visually obvious tint without being trigger-happy on warm
    //     sunset scenes etc.
    //   * LOW_CONTRAST_THRESHOLD: luminance standard deviation below
    //     this (0..255 scale) → `color-low-contrast`. 30 ≈ a hazy /
    //     muddy scene.
    //   * WORKER_VERSION: stamped into raw_result.$.color for traceability.
    IMAGE_QUALITY_COLOR_MAX_EDGE: intPositive(512),
    COLOR_LOW_SATURATION_THRESHOLD: numNonNeg(0.1),
    COLOR_HIGH_SATURATION_THRESHOLD: numNonNeg(0.75),
    COLOR_CAST_THRESHOLD: numNonNeg(30),
    COLOR_LOW_CONTRAST_THRESHOLD: numNonNeg(30),
    IMAGE_QUALITY_COLOR_WORKER_VERSION: strDefault("1.0"),
    // P6.T5 image_quality.finalize worker — weighted aggregation of
    // the three per-dimension scores into the composite quality_score.
    // The defaults follow the P6.T5 prompt's recommendation: blur is
    // the loudest signal, exposure is secondary, colour is a soft
    // penalty that doesn't dominate. Separate from `QUALITY_WEIGHT_*`
    // which still includes a resolution slot (no per-row column for
    // that yet; left for P6.T7 / P9 to fill in).
    //   * COLOR_FLOOR caps how far the colour dimension can drag the
    //     composite down: effective_color = floor + (1 - floor) ×
    //     color_score, so even color_score = 0 contributes `floor`
    //     to the weighted sum. Default 0.5 keeps "low-saturation
    //     high-contrast" stylistic images near the top of the band
    //     when blur + exposure are clean.
    IMAGE_QUALITY_FINALIZE_BLUR_WEIGHT: numNonNeg(0.45),
    IMAGE_QUALITY_FINALIZE_EXPOSURE_WEIGHT: numNonNeg(0.35),
    IMAGE_QUALITY_FINALIZE_COLOR_WEIGHT: numNonNeg(0.2),
    IMAGE_QUALITY_FINALIZE_COLOR_FLOOR: numNonNeg(0.5),
    IMAGE_QUALITY_FINALIZE_WORKER_VERSION: strDefault("1.0"),
    // P8.T2 image_enhance worker — conservative one-tap enhancement.
    // The defaults are tuned to produce a perceptible-but-subtle lift
    // on typical phone / mirrorless travel photos without crossing
    // into the over-cooked Instagram-filter territory called out by
    // requirements §7.9 acceptance #5 ("不应过度饱和、过度锐化或明显失真").
    // Every knob is overridable via env so a future re-tune doesn't
    // require code changes.
    //
    //   * MAX_EDGE — upper bound on the longest edge of the enhanced
    //     output. We deliberately do NOT downscale below this; the
    //     enhance file mirrors the original's resolution so users get
    //     a usable replacement (not a thumbnail). 4096 covers ~12MP
    //     and matches the modern phone capture size.
    //   * BRIGHTNESS / SATURATION / GAMMA / LINEAR_A / LINEAR_B —
    //     deterministic sharp params. Multiplicative `linear(a, b)`
    //     gives a mild S-curve when paired with `gamma`. Defaults
    //     stay within ±5% of the source mid-tones.
    //   * SHARPEN_SIGMA / SHARPEN_M1 / SHARPEN_M2 — light unsharp
    //     mask. `m2 = 2.0` caps the high-frequency boost so we don't
    //     ring noisy regions (the prompt explicitly forbids
    //     "过度锐化"). Sigma 0.6 keeps the operation
    //     scale-invariant on phone-resolution photos.
    //   * JPEG_QUALITY — output quality. 88 is the sweet spot for
    //     visible-detail preservation without inflating file size.
    //   * WORKER_VERSION — stamped into `media_versions.params` so a
    //     future re-tune can be told apart from older outputs.
    IMAGE_ENHANCE_MAX_EDGE: intPositive(4096),
    IMAGE_ENHANCE_BRIGHTNESS: numNonNeg(1.0),
    IMAGE_ENHANCE_SATURATION: numNonNeg(1.05),
    IMAGE_ENHANCE_GAMMA: numNonNeg(1.05),
    IMAGE_ENHANCE_LINEAR_A: numNonNeg(1.05),
    IMAGE_ENHANCE_LINEAR_B: z.preprocess(stripEmpty, z.coerce.number().default(-3)),
    IMAGE_ENHANCE_SHARPEN_SIGMA: numNonNeg(0.6),
    IMAGE_ENHANCE_SHARPEN_M1: numNonNeg(0.5),
    IMAGE_ENHANCE_SHARPEN_M2: numNonNeg(2.0),
    IMAGE_ENHANCE_JPEG_QUALITY: intPositive(88),
    IMAGE_ENHANCE_WORKER_VERSION: strDefault("1.0"),
    // P9.T3 video_cover worker — FFmpeg-extracted cover frame for
    // videos. Output lands at `derived/{mediaId}/video_cover.jpg`
    // (per design.md §7.5 / §8.1) and is mirrored onto
    // media_items.thumbnail_path so the existing gallery / cover
    // URL pipeline surfaces it uniformly with image thumbnails.
    //
    //   * MAX_EDGE — upper bound on the longest edge of the cover
    //     JPEG. 1280 covers HD-class previews and keeps the file
    //     compact (typical 100-300 KB at q=2). Larger cover doesn't
    //     buy meaningful gallery quality.
    //   * JPEG_QUALITY — ffmpeg's `-q:v` (range 2-31, lower = better).
    //     2 = sharp visually-lossless; matches the photographic
    //     intent of cover frames.
    //   * FALLBACK_SEEK_SECONDS — when duration is known, the
    //     worker seeks `min(duration/2, FALLBACK_SEEK_SECONDS)`.
    //     5s is a sweet spot: short enough that decoder seek is
    //     cheap, late enough to skip startup glitches (camera
    //     auto-focus, fade-in). When duration is unknown (e.g.
    //     P9.T2 hasn't run yet) the worker falls back to seek 0.
    //   * TIMEOUT_MS — wall-clock cap for the ffmpeg child process.
    //     30s handles even slow remote storage; longer would
    //     suggest the host has a deeper problem.
    //   * WORKER_VERSION — stamped into `media_versions.params` so
    //     a future re-tune can be diffed against historical covers.
    VIDEO_COVER_MAX_EDGE: intPositive(1280),
    VIDEO_COVER_JPEG_QUALITY: intPositive(2),
    VIDEO_COVER_FALLBACK_SEEK_SECONDS: numNonNeg(5),
    VIDEO_COVER_TIMEOUT_MS: intPositive(30_000),
    VIDEO_COVER_WORKER_VERSION: strDefault("1.0"),
    // P9.T4 video_proxy worker — H.264 / AAC 720p low-res proxy.
    // The proxy is a derived file used by the future video API +
    // detail-page playback so the original (potentially 4K / GoPro
    // .MOV) isn't hit on every read. Output: `derived/{mediaId}/
    // video_proxy.mp4`. Persisted as `media_versions(version_type=
    // 'video_proxy')`. The original is never modified or deleted.
    //
    //   * TARGET_HEIGHT — height of the proxy (px). Width is
    //     auto-computed to preserve aspect, rounded to even (yuv420p
    //     requires it). 720 is the design.md §8.1 default and a
    //     sensible HD-ish ceiling for travel content.
    //   * CRF — constant rate factor (libx264 0..51, lower = better
    //     quality + larger file). 28 is the design.md §8.1 default,
    //     visually solid for previews while keeping files small.
    //   * PRESET — speed/size trade. `veryfast` is the sweet spot
    //     for a proxy: ~3× faster than `medium` with only ~10%
    //     file-size growth at the same CRF.
    //   * VIDEO_CODEC / AUDIO_CODEC — H.264 + AAC for maximum
    //     browser compatibility. `libx264` is the libav default;
    //     `aac` is the built-in low-complexity encoder.
    //   * AUDIO_BITRATE_KBPS — 128 kbps stereo is the perceptual
    //     "indistinguishable from source" threshold for AAC-LC.
    //   * TIMEOUT_MS — wall-clock cap for ffmpeg. 5 minutes covers
    //     a typical phone video at TARGET_HEIGHT=720; the
    //     concurrency budget (VIDEO_WORKER_CONCURRENCY=1) means
    //     proxies serialise so a slow source can't starve the
    //     channel for too long. Bumpable for archival 4K dumps.
    //   * WORKER_VERSION — stamped into `media_versions.params` so
    //     a future re-tune can be diffed against historical proxies.
    VIDEO_PROXY_TARGET_HEIGHT: intPositive(720),
    VIDEO_PROXY_CRF: intNonNeg(28),
    VIDEO_PROXY_PRESET: strDefault("veryfast"),
    VIDEO_PROXY_VIDEO_CODEC: strDefault("libx264"),
    VIDEO_PROXY_AUDIO_CODEC: strDefault("aac"),
    VIDEO_PROXY_AUDIO_BITRATE_KBPS: intPositive(128),
    VIDEO_PROXY_TIMEOUT_MS: intPositive(300_000),
    VIDEO_PROXY_WORKER_VERSION: strDefault("1.0"),
    // P9.T5 video_keyframes worker — fixed-interval frame extraction.
    // Output: `derived/{mediaId}/frames/frame_NNNNNN.jpg` + a sibling
    // `manifest.json` listing the (index, timestampSec, filePath,
    // width, height) of every emitted frame. Downstream consumers
    // (P9.T7 segment quality, P9.T8 Video API) read the manifest
    // file from disk — there's no DB-side persistence for
    // keyframes, by design (no new migration; see R-104).
    //
    //   * INTERVAL_SEC — base interval between emitted frames. 2s
    //     matches the existing VIDEO_KEYFRAME_INTERVAL default
    //     (design.md §11.1). Quite dense for typical phone clips
    //     but cheap because proxies are 720p.
    //   * MAX_FRAMES — hard cap on emitted frames per video. The
    //     handler computes an "effective interval" that grows above
    //     INTERVAL_SEC when a long video would otherwise exceed
    //     this cap (e.g. a 1-hour video at 2s = 1800 frames → with
    //     cap=200 the effective interval becomes 18s). Keeps disk
    //     bounded and downstream segment scoring tractable.
    //   * JPEG_QUALITY — ffmpeg `-q:v` (range 2-31, lower = better).
    //     2 = sharp visually-lossless; matches video_cover worker
    //     so downstream quality comparisons stay apples-to-apples.
    //   * TIMEOUT_MS — wall-clock cap. 5 minutes covers typical
    //     phone videos at the cap; long 4K archives may need more.
    //   * WORKER_VERSION — stamped into the manifest for
    //     traceability across algorithm bumps.
    VIDEO_KEYFRAMES_INTERVAL_SEC: numNonNeg(2),
    VIDEO_KEYFRAMES_MAX_FRAMES: intPositive(200),
    VIDEO_KEYFRAMES_JPEG_QUALITY: intPositive(2),
    VIDEO_KEYFRAMES_TIMEOUT_MS: intPositive(300_000),
    VIDEO_KEYFRAMES_WORKER_VERSION: strDefault("1.0"),
    PHASH_DISTANCE_MAX: intNonNeg(8),
    QUALITY_WEIGHT_RESOLUTION: numNonNeg(0.3),
    QUALITY_WEIGHT_SHARPNESS: numNonNeg(0.4),
    QUALITY_WEIGHT_EXPOSURE: numNonNeg(0.2),
    QUALITY_WEIGHT_COLOR: numNonNeg(0.1),

    // Video parameters (design §8 / §11.1)
    VIDEO_SEGMENT_DURATION: intPositive(10),
    VIDEO_PROXY_HEIGHT: intPositive(720),
    VIDEO_KEYFRAME_INTERVAL: intPositive(2),
    BLACK_DETECT_DURATION: numNonNeg(0.5),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.BLUR_THRESHOLD_MAYBE <= cfg.BLUR_THRESHOLD_BLURRY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["BLUR_THRESHOLD_MAYBE"],
        message: `BLUR_THRESHOLD_MAYBE (${cfg.BLUR_THRESHOLD_MAYBE}) must be greater than BLUR_THRESHOLD_BLURRY (${cfg.BLUR_THRESHOLD_BLURRY}); higher Laplacian variance means a sharper image.`,
      });
    }

    if (cfg.EXPOSURE_UNDER_MEAN_THRESHOLD >= cfg.EXPOSURE_OVER_MEAN_THRESHOLD) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["EXPOSURE_OVER_MEAN_THRESHOLD"],
        message: `EXPOSURE_OVER_MEAN_THRESHOLD (${cfg.EXPOSURE_OVER_MEAN_THRESHOLD}) must be greater than EXPOSURE_UNDER_MEAN_THRESHOLD (${cfg.EXPOSURE_UNDER_MEAN_THRESHOLD}); brightness goes 0..255 with under-exposure at the dark end.`,
      });
    }
    for (const [key, value] of [
      ["EXPOSURE_DARK_PIXEL_RATIO_THRESHOLD", cfg.EXPOSURE_DARK_PIXEL_RATIO_THRESHOLD],
      ["EXPOSURE_BRIGHT_PIXEL_RATIO_THRESHOLD", cfg.EXPOSURE_BRIGHT_PIXEL_RATIO_THRESHOLD],
    ] as const) {
      if (value > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} (${value}) must be in [0, 1]; it is a pixel-fraction threshold.`,
        });
      }
    }
    if (cfg.EXPOSURE_OVER_MEAN_THRESHOLD > 255) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["EXPOSURE_OVER_MEAN_THRESHOLD"],
        message: `EXPOSURE_OVER_MEAN_THRESHOLD (${cfg.EXPOSURE_OVER_MEAN_THRESHOLD}) must be ≤ 255; the luminance scale tops out there.`,
      });
    }

    if (cfg.COLOR_LOW_SATURATION_THRESHOLD >= cfg.COLOR_HIGH_SATURATION_THRESHOLD) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["COLOR_HIGH_SATURATION_THRESHOLD"],
        message: `COLOR_HIGH_SATURATION_THRESHOLD (${cfg.COLOR_HIGH_SATURATION_THRESHOLD}) must be greater than COLOR_LOW_SATURATION_THRESHOLD (${cfg.COLOR_LOW_SATURATION_THRESHOLD}); they bracket the "normal" saturation band.`,
      });
    }
    for (const [key, value] of [
      ["COLOR_LOW_SATURATION_THRESHOLD", cfg.COLOR_LOW_SATURATION_THRESHOLD],
      ["COLOR_HIGH_SATURATION_THRESHOLD", cfg.COLOR_HIGH_SATURATION_THRESHOLD],
    ] as const) {
      if (value > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} (${value}) must be in [0, 1]; HSV saturation is normalised.`,
        });
      }
    }
    for (const [key, value] of [
      ["COLOR_CAST_THRESHOLD", cfg.COLOR_CAST_THRESHOLD],
      ["COLOR_LOW_CONTRAST_THRESHOLD", cfg.COLOR_LOW_CONTRAST_THRESHOLD],
    ] as const) {
      if (value > 255) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} (${value}) must be ≤ 255; channel means / luminance are on the 0..255 scale.`,
        });
      }
    }

    const finalizeSum =
      cfg.IMAGE_QUALITY_FINALIZE_BLUR_WEIGHT +
      cfg.IMAGE_QUALITY_FINALIZE_EXPOSURE_WEIGHT +
      cfg.IMAGE_QUALITY_FINALIZE_COLOR_WEIGHT;
    if (finalizeSum <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["IMAGE_QUALITY_FINALIZE_BLUR_WEIGHT"],
        message: `Finalize weights sum to ${finalizeSum}; at least one dimension must have a positive weight.`,
      });
    }
    if (cfg.IMAGE_QUALITY_FINALIZE_COLOR_FLOOR > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["IMAGE_QUALITY_FINALIZE_COLOR_FLOOR"],
        message: `IMAGE_QUALITY_FINALIZE_COLOR_FLOOR (${cfg.IMAGE_QUALITY_FINALIZE_COLOR_FLOOR}) must be in [0, 1]; it's the lower-bound for the tempered colour contribution.`,
      });
    }

    // P8.T2: clamp enhance knobs so a misconfigured env can't produce
    // visibly broken images. Hard caps come from sharp's documented
    // safe range; the soft caps reflect requirements §7.9's "no
    // over-saturation / over-sharpening" guard.
    if (cfg.IMAGE_ENHANCE_JPEG_QUALITY < 1 || cfg.IMAGE_ENHANCE_JPEG_QUALITY > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["IMAGE_ENHANCE_JPEG_QUALITY"],
        message: `IMAGE_ENHANCE_JPEG_QUALITY (${cfg.IMAGE_ENHANCE_JPEG_QUALITY}) must be in [1, 100]; sharp.jpeg.quality is a percentage.`,
      });
    }
    for (const [key, value] of [
      ["IMAGE_ENHANCE_BRIGHTNESS", cfg.IMAGE_ENHANCE_BRIGHTNESS],
      ["IMAGE_ENHANCE_SATURATION", cfg.IMAGE_ENHANCE_SATURATION],
      ["IMAGE_ENHANCE_GAMMA", cfg.IMAGE_ENHANCE_GAMMA],
      ["IMAGE_ENHANCE_LINEAR_A", cfg.IMAGE_ENHANCE_LINEAR_A],
    ] as const) {
      // Soft cap at 2.0 — anything above doubles the channel and is
      // almost certainly an operator error (sharp accepts it but the
      // output will look like a filter, not an enhancement).
      if (value > 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} (${value}) must be ≤ 2.0 to avoid over-cooked enhancement; reduce or unset to use the default.`,
        });
      }
    }
    // sharp.gamma requires 1.0 ≤ gamma ≤ 3.0 (per sharp docs). 1.0 is
    // a pass-through, which matches the "no enhancement" identity.
    if (cfg.IMAGE_ENHANCE_GAMMA < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["IMAGE_ENHANCE_GAMMA"],
        message: `IMAGE_ENHANCE_GAMMA (${cfg.IMAGE_ENHANCE_GAMMA}) must be ≥ 1.0 (sharp.gamma's documented range starts at 1.0; 1.0 is identity).`,
      });
    }
    // P9.T3 video_cover JPEG quality is ffmpeg's `-q:v` (range 2-31,
    // lower is better; 31 is unusable, 2 is visually lossless). Clamp
    // here so a misconfigured env can't produce a sub-pixel cover.
    if (cfg.VIDEO_COVER_JPEG_QUALITY < 2 || cfg.VIDEO_COVER_JPEG_QUALITY > 31) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["VIDEO_COVER_JPEG_QUALITY"],
        message: `VIDEO_COVER_JPEG_QUALITY (${cfg.VIDEO_COVER_JPEG_QUALITY}) must be in [2, 31]; ffmpeg's -q:v range.`,
      });
    }
    if (cfg.VIDEO_COVER_MAX_EDGE < 64) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["VIDEO_COVER_MAX_EDGE"],
        message: `VIDEO_COVER_MAX_EDGE (${cfg.VIDEO_COVER_MAX_EDGE}) must be ≥ 64; below that the cover is a thumbnail not a cover.`,
      });
    }
    // P9.T4 video_proxy guards. CRF range from libx264 docs (0..51,
    // lower = better; 0 is lossless, 51 is unwatchable). target
    // height ≥ 144 (240p / WebRTC floor) — anything smaller is a
    // thumbnail, not a video proxy.
    if (cfg.VIDEO_PROXY_CRF > 51) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["VIDEO_PROXY_CRF"],
        message: `VIDEO_PROXY_CRF (${cfg.VIDEO_PROXY_CRF}) must be ≤ 51; libx264's CRF range.`,
      });
    }
    if (cfg.VIDEO_PROXY_TARGET_HEIGHT < 144) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["VIDEO_PROXY_TARGET_HEIGHT"],
        message: `VIDEO_PROXY_TARGET_HEIGHT (${cfg.VIDEO_PROXY_TARGET_HEIGHT}) must be ≥ 144; below that the proxy isn't a video.`,
      });
    }
    // P9.T5 video_keyframes guards. `-q:v` shares the same ffmpeg
    // range as video_cover. `intervalSec ≥ 0.5` avoids degenerate
    // sub-half-second sampling that doesn't help downstream segment
    // scoring. `maxFrames ≤ 10000` is a paranoid upper bound to
    // protect disk from a misconfigured env (10k frames @ ~100KB
    // each = ~1GB).
    if (cfg.VIDEO_KEYFRAMES_JPEG_QUALITY < 2 || cfg.VIDEO_KEYFRAMES_JPEG_QUALITY > 31) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["VIDEO_KEYFRAMES_JPEG_QUALITY"],
        message: `VIDEO_KEYFRAMES_JPEG_QUALITY (${cfg.VIDEO_KEYFRAMES_JPEG_QUALITY}) must be in [2, 31]; ffmpeg's -q:v range.`,
      });
    }
    if (cfg.VIDEO_KEYFRAMES_INTERVAL_SEC < 0.5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["VIDEO_KEYFRAMES_INTERVAL_SEC"],
        message: `VIDEO_KEYFRAMES_INTERVAL_SEC (${cfg.VIDEO_KEYFRAMES_INTERVAL_SEC}) must be ≥ 0.5; sub-half-second sampling doesn't help downstream scoring.`,
      });
    }
    if (cfg.VIDEO_KEYFRAMES_MAX_FRAMES > 10_000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["VIDEO_KEYFRAMES_MAX_FRAMES"],
        message: `VIDEO_KEYFRAMES_MAX_FRAMES (${cfg.VIDEO_KEYFRAMES_MAX_FRAMES}) must be ≤ 10000; higher would risk disk blow-up.`,
      });
    }

    // x264 preset must be one of its documented values; out-of-set
    // strings cause ffmpeg to exit immediately at runtime, but
    // failing here gives a clearer message than the stderr dump.
    {
      const allowedPresets: ReadonlyArray<string> = [
        "ultrafast",
        "superfast",
        "veryfast",
        "faster",
        "fast",
        "medium",
        "slow",
        "slower",
        "veryslow",
        "placebo",
      ];
      if (!allowedPresets.includes(cfg.VIDEO_PROXY_PRESET)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["VIDEO_PROXY_PRESET"],
          message: `VIDEO_PROXY_PRESET ('${cfg.VIDEO_PROXY_PRESET}') must be one of: ${allowedPresets.join(", ")}.`,
        });
      }
    }
    // sharpen.flat (m1) and sharpen.jagged (m2) cap at 3 per sharp
    // docs; sigma should stay below 10 to keep the operation a sharpen
    // rather than a blur-detect.
    if (cfg.IMAGE_ENHANCE_SHARPEN_M2 > 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["IMAGE_ENHANCE_SHARPEN_M2"],
        message: `IMAGE_ENHANCE_SHARPEN_M2 (${cfg.IMAGE_ENHANCE_SHARPEN_M2}) must be ≤ 3.0 (sharp.sharpen.m2 cap; higher rings the output).`,
      });
    }
    if (cfg.IMAGE_ENHANCE_SHARPEN_SIGMA > 10) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["IMAGE_ENHANCE_SHARPEN_SIGMA"],
        message: `IMAGE_ENHANCE_SHARPEN_SIGMA (${cfg.IMAGE_ENHANCE_SHARPEN_SIGMA}) must be ≤ 10.0 to remain a sharpen op.`,
      });
    }

    const weightSum =
      cfg.QUALITY_WEIGHT_RESOLUTION +
      cfg.QUALITY_WEIGHT_SHARPNESS +
      cfg.QUALITY_WEIGHT_EXPOSURE +
      cfg.QUALITY_WEIGHT_COLOR;
    if (Math.abs(weightSum - 1) > 0.05) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["QUALITY_WEIGHT_*"],
        message: `Quality weights must sum to ~1.0 (got ${weightSum.toFixed(3)}).`,
      });
    }

    if (cfg.AI_ENABLED && cfg.AI_PROVIDER.trim() === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AI_PROVIDER"],
        message: "AI_PROVIDER must be set when AI_ENABLED=true.",
      });
    }
  });

type RawConfig = z.infer<typeof schema>;

// ---------------------------------------------------------------------------
// Public Config shape (grouped by concern)
// ---------------------------------------------------------------------------

export type NodeEnv = "development" | "test" | "production";
export type StorageDriver = "local" | "s3";

export interface Config {
  nodeEnv: NodeEnv;
  port: number;
  storage: {
    driver: StorageDriver;
    localRoot: string;
  };
  database: {
    path: string;
  };
  workers: {
    imageConcurrency: number;
    videoConcurrency: number;
    aiConcurrency: number;
    jobRetryMax: number;
    jobRetryBaseDelayMs: number;
    jobRetryMaxDelayMs: number;
    zombieTimeoutMs: number;
  };
  ffmpeg: {
    ffmpegPath: string | undefined;
    ffprobePath: string | undefined;
  };
  ai: {
    enabled: boolean;
    provider: string;
    dailyLimit: number;
    tripLimit: number;
  };
  upload: {
    maxFileSize: number;
    allowedImageExt: readonly string[];
    allowedVideoExt: readonly string[];
  };
  delete: {
    permanentDeleteEnabled: boolean;
  };
  quality: {
    blurThresholdBlurry: number;
    blurThresholdMaybe: number;
    /** P6.T2 image_quality.blur worker knobs. */
    blur: {
      maxEdge: number;
      workerVersion: string;
    };
    /** P6.T3 image_quality.exposure worker knobs. */
    exposure: {
      maxEdge: number;
      underMeanThreshold: number;
      overMeanThreshold: number;
      darkPixelRatioThreshold: number;
      brightPixelRatioThreshold: number;
      workerVersion: string;
    };
    /** P6.T4 image_quality.color worker knobs. */
    color: {
      maxEdge: number;
      lowSaturationThreshold: number;
      highSaturationThreshold: number;
      castThreshold: number;
      lowContrastThreshold: number;
      workerVersion: string;
    };
    /** P6.T5 image_quality.finalize aggregator knobs. */
    finalize: {
      blurWeight: number;
      exposureWeight: number;
      colorWeight: number;
      colorFloor: number;
      workerVersion: string;
    };
    /** P8.T2 image_enhance worker knobs. */
    enhance: {
      maxEdge: number;
      brightness: number;
      saturation: number;
      gamma: number;
      linearA: number;
      linearB: number;
      sharpenSigma: number;
      sharpenM1: number;
      sharpenM2: number;
      jpegQuality: number;
      workerVersion: string;
    };
    pHashDistanceMax: number;
    weights: {
      resolution: number;
      sharpness: number;
      exposure: number;
      color: number;
    };
  };
  video: {
    segmentDurationSec: number;
    proxyHeight: number;
    keyframeIntervalSec: number;
    blackDetectDurationSec: number;
    /** P9.T3 video_cover worker knobs. */
    cover: {
      maxEdge: number;
      jpegQuality: number;
      fallbackSeekSeconds: number;
      timeoutMs: number;
      workerVersion: string;
    };
    /** P9.T4 video_proxy worker knobs. */
    proxy: {
      targetHeight: number;
      crf: number;
      preset: string;
      videoCodec: string;
      audioCodec: string;
      audioBitrateKbps: number;
      timeoutMs: number;
      workerVersion: string;
    };
    /** P9.T5 video_keyframes worker knobs. */
    keyframes: {
      intervalSec: number;
      maxFrames: number;
      jpegQuality: number;
      timeoutMs: number;
      workerVersion: string;
    };
  };
  meta: {
    /** Absolute paths of `.env` files actually loaded, in load order. */
    loadedDotenvFiles: readonly string[];
  };
}

function csvList(s: string): string[] {
  return s
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
}

function toConfig(raw: RawConfig, loadedDotenvFiles: readonly string[]): Config {
  return {
    nodeEnv: raw.NODE_ENV,
    port: raw.PORT,
    storage: { driver: raw.STORAGE_DRIVER, localRoot: raw.STORAGE_LOCAL_ROOT },
    database: { path: raw.DATABASE_PATH },
    workers: {
      imageConcurrency: raw.IMAGE_WORKER_CONCURRENCY,
      videoConcurrency: raw.VIDEO_WORKER_CONCURRENCY,
      aiConcurrency: raw.AI_WORKER_CONCURRENCY,
      jobRetryMax: raw.JOB_RETRY_MAX,
      jobRetryBaseDelayMs: raw.JOB_RETRY_BASE_DELAY_MS,
      jobRetryMaxDelayMs: raw.JOB_RETRY_MAX_DELAY_MS,
      zombieTimeoutMs: raw.ZOMBIE_TIMEOUT_MS,
    },
    ffmpeg: {
      ffmpegPath: raw.FFMPEG_PATH,
      ffprobePath: raw.FFPROBE_PATH,
    },
    ai: {
      enabled: raw.AI_ENABLED,
      provider: raw.AI_PROVIDER,
      dailyLimit: raw.AI_DAILY_LIMIT,
      tripLimit: raw.AI_TRIP_LIMIT,
    },
    upload: {
      maxFileSize: raw.UPLOAD_MAX_FILE_SIZE,
      allowedImageExt: csvList(raw.UPLOAD_ALLOWED_IMAGE_EXT),
      allowedVideoExt: csvList(raw.UPLOAD_ALLOWED_VIDEO_EXT),
    },
    delete: { permanentDeleteEnabled: raw.PERMANENT_DELETE_ENABLED },
    quality: {
      blurThresholdBlurry: raw.BLUR_THRESHOLD_BLURRY,
      blurThresholdMaybe: raw.BLUR_THRESHOLD_MAYBE,
      blur: {
        maxEdge: raw.IMAGE_QUALITY_BLUR_MAX_EDGE,
        workerVersion: raw.IMAGE_QUALITY_BLUR_WORKER_VERSION,
      },
      exposure: {
        maxEdge: raw.IMAGE_QUALITY_EXPOSURE_MAX_EDGE,
        underMeanThreshold: raw.EXPOSURE_UNDER_MEAN_THRESHOLD,
        overMeanThreshold: raw.EXPOSURE_OVER_MEAN_THRESHOLD,
        darkPixelRatioThreshold: raw.EXPOSURE_DARK_PIXEL_RATIO_THRESHOLD,
        brightPixelRatioThreshold: raw.EXPOSURE_BRIGHT_PIXEL_RATIO_THRESHOLD,
        workerVersion: raw.IMAGE_QUALITY_EXPOSURE_WORKER_VERSION,
      },
      color: {
        maxEdge: raw.IMAGE_QUALITY_COLOR_MAX_EDGE,
        lowSaturationThreshold: raw.COLOR_LOW_SATURATION_THRESHOLD,
        highSaturationThreshold: raw.COLOR_HIGH_SATURATION_THRESHOLD,
        castThreshold: raw.COLOR_CAST_THRESHOLD,
        lowContrastThreshold: raw.COLOR_LOW_CONTRAST_THRESHOLD,
        workerVersion: raw.IMAGE_QUALITY_COLOR_WORKER_VERSION,
      },
      finalize: {
        blurWeight: raw.IMAGE_QUALITY_FINALIZE_BLUR_WEIGHT,
        exposureWeight: raw.IMAGE_QUALITY_FINALIZE_EXPOSURE_WEIGHT,
        colorWeight: raw.IMAGE_QUALITY_FINALIZE_COLOR_WEIGHT,
        colorFloor: raw.IMAGE_QUALITY_FINALIZE_COLOR_FLOOR,
        workerVersion: raw.IMAGE_QUALITY_FINALIZE_WORKER_VERSION,
      },
      enhance: {
        maxEdge: raw.IMAGE_ENHANCE_MAX_EDGE,
        brightness: raw.IMAGE_ENHANCE_BRIGHTNESS,
        saturation: raw.IMAGE_ENHANCE_SATURATION,
        gamma: raw.IMAGE_ENHANCE_GAMMA,
        linearA: raw.IMAGE_ENHANCE_LINEAR_A,
        linearB: raw.IMAGE_ENHANCE_LINEAR_B,
        sharpenSigma: raw.IMAGE_ENHANCE_SHARPEN_SIGMA,
        sharpenM1: raw.IMAGE_ENHANCE_SHARPEN_M1,
        sharpenM2: raw.IMAGE_ENHANCE_SHARPEN_M2,
        jpegQuality: raw.IMAGE_ENHANCE_JPEG_QUALITY,
        workerVersion: raw.IMAGE_ENHANCE_WORKER_VERSION,
      },
      pHashDistanceMax: raw.PHASH_DISTANCE_MAX,
      weights: {
        resolution: raw.QUALITY_WEIGHT_RESOLUTION,
        sharpness: raw.QUALITY_WEIGHT_SHARPNESS,
        exposure: raw.QUALITY_WEIGHT_EXPOSURE,
        color: raw.QUALITY_WEIGHT_COLOR,
      },
    },
    video: {
      segmentDurationSec: raw.VIDEO_SEGMENT_DURATION,
      proxyHeight: raw.VIDEO_PROXY_HEIGHT,
      keyframeIntervalSec: raw.VIDEO_KEYFRAME_INTERVAL,
      blackDetectDurationSec: raw.BLACK_DETECT_DURATION,
      cover: {
        maxEdge: raw.VIDEO_COVER_MAX_EDGE,
        jpegQuality: raw.VIDEO_COVER_JPEG_QUALITY,
        fallbackSeekSeconds: raw.VIDEO_COVER_FALLBACK_SEEK_SECONDS,
        timeoutMs: raw.VIDEO_COVER_TIMEOUT_MS,
        workerVersion: raw.VIDEO_COVER_WORKER_VERSION,
      },
      proxy: {
        targetHeight: raw.VIDEO_PROXY_TARGET_HEIGHT,
        crf: raw.VIDEO_PROXY_CRF,
        preset: raw.VIDEO_PROXY_PRESET,
        videoCodec: raw.VIDEO_PROXY_VIDEO_CODEC,
        audioCodec: raw.VIDEO_PROXY_AUDIO_CODEC,
        audioBitrateKbps: raw.VIDEO_PROXY_AUDIO_BITRATE_KBPS,
        timeoutMs: raw.VIDEO_PROXY_TIMEOUT_MS,
        workerVersion: raw.VIDEO_PROXY_WORKER_VERSION,
      },
      keyframes: {
        intervalSec: raw.VIDEO_KEYFRAMES_INTERVAL_SEC,
        maxFrames: raw.VIDEO_KEYFRAMES_MAX_FRAMES,
        jpegQuality: raw.VIDEO_KEYFRAMES_JPEG_QUALITY,
        timeoutMs: raw.VIDEO_KEYFRAMES_TIMEOUT_MS,
        workerVersion: raw.VIDEO_KEYFRAMES_WORKER_VERSION,
      },
    },
    meta: { loadedDotenvFiles },
  };
}

/**
 * Custom error so callers can distinguish configuration problems from
 * other runtime failures. The message is already user-friendly.
 */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
  constructor(message: string) {
    super(message);
  }
}

/**
 * Load configuration once at startup.
 *
 * @param env - process.env-shaped object (defaults to actual `process.env`).
 *              Pass an explicit object in tests to avoid global state.
 * @throws {ConfigError} when validation fails.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const loadedDotenvFiles = env === process.env ? loadDotenvFiles() : [];
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new ConfigError(
      `Invalid environment configuration. See .env.example for reference.\n${issues}`,
    );
  }
  return toConfig(result.data, loadedDotenvFiles);
}
