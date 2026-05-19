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
