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
