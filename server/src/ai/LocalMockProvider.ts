// LocalMockProvider (P10.T7 — acceptance fixture; P12.T1 extended).
//
// A deterministic, no-network, no-secret AIProvider implementation
// used to validate AI-dependent pipelines (image refine, curated
// album, etc.) without depending on a real SaaS provider. Operators
// activate it via:
//
//   AI_ENABLED=true
//   AI_PROVIDER=local-mock
//
// Intentionally NOT a default. The factory in
// `server/src/ai/index.ts` only returns this class when
// `AI_PROVIDER` matches the literal `'local-mock'` (case-
// insensitive after trim) — every other state still falls back
// to `NoopProvider`. CLAUDE.md §2.8 stays intact: base features
// continue to work when AI is off.
//
// Supported request types (P12.T1 extension):
//
//   * `image_ai_refine`     — P10.T7: gentle sharp tint + saturation
//                             drop, returns refined JPEG bytes.
//   * `scene_embedding`     — P12.T1: returns a deterministic 16-d
//                             Float32 pseudo-embedding derived from
//                             SHA256(inputBytes), JSON-encoded.
//   * `ai_blur_check`       — P12.T1: returns {class, reason} JSON,
//                             class derived from SHA256(inputBytes)
//                             mod 3 → sharp / maybe_blurry / blurry.
//                             Deterministic by input bytes.
//   * `scene_best_pick`     — P12.T1: input is `params.candidates`
//                             = [{mediaId}, ...]; output is JSON
//                             {bestMediaId, reason, confidence} —
//                             picks the candidate with the smallest
//                             SHA256(mediaId) (lexicographic).
//   * `refinement_suggest`  — P12.T1: returns JSON {brightness:0.05,
//                             contrast:0.05, ...} — fixed conservative
//                             "mild brightening + contrast" params.
//                             Deterministic regardless of input.
//
// Determinism contract:
//   * Same `inputBytes` (or `params.candidates`) → identical output
//     bytes across runs. The smoke harness asserts this for each
//     request type so any drift surfaces immediately.
//   * No randomness; no `Date.now()` in the response payload (the
//     audit-row `durationMs` is the only timing-dependent value).
//   * `costEstimate = 0` for every type (LocalMock is free).
//
// What this provider does NOT do:
//   * Network calls of any kind. The provider's source file does
//     not import `node:http` / `node:https` / `node:net` / any
//     `fetch` polyfill — verifiable by grep.
//   * Touch the database. The worker layer (P10.T5 / P12.T4+) does
//     that.
//   * Read environment variables / config — fully self-contained.
//
// Failure modes (uniform across all request types):
//   * Unsupported `requestType` (not in `supports`) → throws
//     `AIProviderUnsupportedRequestError`.
//   * Missing / malformed input (e.g. empty `inputBytes` for image-
//     based types) → returns an `AIFailureResponse` (NOT a thrown
//     error) so the worker's structured-failure branch runs.
//   * `scene_best_pick` with empty / malformed `params.candidates`
//     → `AIFailureResponse` ("no candidates").
//
// `raw` is INTENTIONALLY omitted from every success response
// (R-134 hygiene): the provider returns NO opaque payload, so
// `media_versions.params.raw` / `ai_invocations.raw_response`
// (when those columns exist) land as `null`. The `responseSummary`
// is short, sanitized, and never echoes input bytes' hash or
// provider secrets.

import { createHash } from "node:crypto";

import sharp from "sharp";

import {
  AIProviderUnsupportedRequestError,
  type AIFailureResponse,
  type AIProvider,
  type AIRequest,
  type AIRequestType,
  type AIResponse,
  type AISuccessResponse,
} from "./AIProvider.js";

const LOCAL_MOCK_SUPPORTS: ReadonlySet<AIRequestType> = Object.freeze(
  new Set<AIRequestType>([
    "image_ai_refine",
    "scene_embedding",
    "ai_blur_check",
    "scene_best_pick",
    "refinement_suggest",
  ]),
);

/** Stable id for audit rows. */
export const LOCAL_MOCK_PROVIDER_NAME = "local-mock";

/** Per-request-type model names. Bumping any of these would break
 * smoke fixtures that assert against them — version deliberately
 * when the stub's behaviour changes. */
export const LOCAL_MOCK_MODEL_NAME = "local-mock-image-refine-v1";
export const LOCAL_MOCK_MODEL_SCENE_EMBEDDING = "local-mock-scene-embedding-v1";
export const LOCAL_MOCK_MODEL_AI_BLUR_CHECK = "local-mock-ai-blur-check-v1";
export const LOCAL_MOCK_MODEL_SCENE_BEST_PICK = "local-mock-scene-best-pick-v1";
export const LOCAL_MOCK_MODEL_REFINEMENT_SUGGEST = "local-mock-refinement-suggest-v1";

/** Fixed embedding dimensionality for the stub. Small enough that
 * the JSON payload stays under a few KB; large enough that clustering
 * unit tests can exercise non-trivial distance computations. */
export const LOCAL_MOCK_EMBEDDING_DIM = 16;

/** Algorithm version stamped into outputs so future stub changes
 * are auditable from media_versions.params / ai_invocations rows
 * without re-reading code history. */
export const LOCAL_MOCK_ALGORITHM_VERSION = "1.0";

// ---------------------------------------------------------------------------
// internal helpers (pure functions — covered by smoke determinism cases)
// ---------------------------------------------------------------------------

/** SHA256 of a buffer (or empty buffer for absent inputs). */
function hashBytes(bytes: Buffer): Buffer {
  return createHash("sha256").update(bytes).digest();
}

/** SHA256 of a string (e.g. mediaId). */
function hashString(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

/** Derive a deterministic Float32 vector from a SHA256 hash:
 * read the hash byte-by-byte, normalise each byte to [-1, 1] in
 * a way that's reproducible across V8 versions. We use
 * `(byte - 128) / 128` to centre the distribution at 0. The
 * resulting vector has L2 norm in a stable range so cosine-
 * similarity smokes get meaningful numbers. */
export function deriveEmbeddingFromHash(hash: Buffer, dim: number): number[] {
  if (hash.length < dim) {
    throw new Error(
      `LocalMockProvider: hash is ${hash.length} bytes, need at least ${dim} for embedding`,
    );
  }
  const vec: number[] = [];
  for (let i = 0; i < dim; i += 1) {
    const byte = hash[i] ?? 0;
    vec.push((byte - 128) / 128);
  }
  return vec;
}

/** Map a 32-byte SHA256 hash to one of 3 blur classes. We sum the
 * first 4 bytes mod 3 to pick the class — deterministic, evenly
 * distributed, and stable. */
export function deriveBlurClassFromHash(
  hash: Buffer,
): "sharp" | "maybe_blurry" | "blurry" {
  const sum =
    (hash[0] ?? 0) + (hash[1] ?? 0) + (hash[2] ?? 0) + (hash[3] ?? 0);
  const idx = sum % 3;
  if (idx === 0) return "sharp";
  if (idx === 1) return "maybe_blurry";
  return "blurry";
}

/** Pick the candidate whose mediaId has the smallest SHA256 hash
 * (lexicographic byte compare). Stable, deterministic, doesn't
 * depend on input thumbnails. */
export function pickBestByHash(
  candidates: ReadonlyArray<{ mediaId: string }>,
): string | null {
  if (candidates.length === 0) return null;
  let bestId: string | null = null;
  let bestHash: Buffer | null = null;
  for (const c of candidates) {
    const h = hashString(c.mediaId);
    if (bestHash === null || Buffer.compare(h, bestHash) < 0) {
      bestId = c.mediaId;
      bestHash = h;
    }
  }
  return bestId;
}

/** Fixed conservative refinement params returned by the stub.
 * Exposed so smokes can assert against the exact shape. */
export const LOCAL_MOCK_REFINEMENT_PARAMS = Object.freeze({
  brightness: 0.05,
  contrast: 0.05,
  saturation: 0,
  shadows: 0,
  highlights: 0,
  crop: null as null | { x: number; y: number; w: number; h: number },
  rotation_deg: 0,
  reason: "mild brightening + slight contrast lift",
});

// ---------------------------------------------------------------------------
// failure-response builder (shared across request types)
// ---------------------------------------------------------------------------

function fail(
  modelName: string,
  startedAt: number,
  errorMessage: string,
): AIFailureResponse {
  return {
    status: "failed",
    provider: LOCAL_MOCK_PROVIDER_NAME,
    modelName,
    costEstimate: 0,
    durationMs: Date.now() - startedAt,
    errorMessage,
  };
}

function ok(
  modelName: string,
  startedAt: number,
  outputBytes: Buffer,
  responseSummary: string,
): AISuccessResponse {
  return {
    status: "success",
    provider: LOCAL_MOCK_PROVIDER_NAME,
    modelName,
    costEstimate: 0,
    durationMs: Date.now() - startedAt,
    outputBytes,
    responseSummary,
    // raw intentionally omitted (R-134)
  };
}

// ---------------------------------------------------------------------------
// LocalMockProvider class
// ---------------------------------------------------------------------------

export class LocalMockProvider implements AIProvider {
  readonly name = LOCAL_MOCK_PROVIDER_NAME;
  readonly available = true;
  readonly supports: ReadonlySet<AIRequestType> = LOCAL_MOCK_SUPPORTS;

  async invoke(req: AIRequest): Promise<AIResponse> {
    if (!this.supports.has(req.requestType)) {
      throw new AIProviderUnsupportedRequestError(this.name, req.requestType);
    }

    // Runtime gate above (supports.has) guarantees only the 5 supported
    // request types reach this switch. TS cannot infer narrowing from
    // a Set.has predicate, so this is NOT an exhaustive switch from
    // the compiler's perspective; we keep the dispatch as a flat
    // switch + an explicit fallthrough throw for defence in depth
    // (if a future P-stage adds an AIRequestType, supports gets it,
    // and the throw catches the missing case).
    switch (req.requestType) {
      case "image_ai_refine":
        return this.invokeImageRefine(req);
      case "scene_embedding":
        return this.invokeSceneEmbedding(req);
      case "ai_blur_check":
        return this.invokeAiBlurCheck(req);
      case "scene_best_pick":
        return this.invokeSceneBestPick(req);
      case "refinement_suggest":
        return this.invokeRefinementSuggest(req);
      default:
        throw new AIProviderUnsupportedRequestError(this.name, req.requestType);
    }
  }

  // -------------------------------------------------------------------------
  // P10.T7: image_ai_refine — deterministic JPEG re-encode
  // -------------------------------------------------------------------------

  private async invokeImageRefine(req: AIRequest): Promise<AIResponse> {
    const startedAt = Date.now();

    if (req.inputBytes === undefined || req.inputBytes.length === 0) {
      return fail(LOCAL_MOCK_MODEL_NAME, startedAt, "local-mock: inputBytes missing or empty");
    }

    let outputBytes: Buffer;
    try {
      outputBytes = await sharp(req.inputBytes)
        .rotate()
        .modulate({ brightness: 1.02, saturation: 0.92 })
        .tint({ r: 240, g: 235, b: 220 })
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer();
    } catch (sharpErr) {
      return fail(
        LOCAL_MOCK_MODEL_NAME,
        startedAt,
        `local-mock: sharp pipeline failed: ${
          sharpErr instanceof Error ? sharpErr.message : String(sharpErr)
        }`,
      );
    }

    return ok(
      LOCAL_MOCK_MODEL_NAME,
      startedAt,
      outputBytes,
      "local-mock: deterministic tint + saturation drop",
    );
  }

  // -------------------------------------------------------------------------
  // P12.T1: scene_embedding — 16-d Float32 vector from input bytes hash
  // -------------------------------------------------------------------------

  private invokeSceneEmbedding(req: AIRequest): AIResponse {
    const startedAt = Date.now();

    if (req.inputBytes === undefined || req.inputBytes.length === 0) {
      return fail(
        LOCAL_MOCK_MODEL_SCENE_EMBEDDING,
        startedAt,
        "local-mock: scene_embedding requires non-empty inputBytes",
      );
    }

    const hash = hashBytes(req.inputBytes);
    const vector = deriveEmbeddingFromHash(hash, LOCAL_MOCK_EMBEDDING_DIM);

    const payload = {
      requestType: "scene_embedding",
      algorithmVersion: LOCAL_MOCK_ALGORITHM_VERSION,
      embeddingDim: LOCAL_MOCK_EMBEDDING_DIM,
      vector,
    };
    const outputBytes = Buffer.from(JSON.stringify(payload), "utf-8");

    return ok(
      LOCAL_MOCK_MODEL_SCENE_EMBEDDING,
      startedAt,
      outputBytes,
      `local-mock: scene_embedding dim=${LOCAL_MOCK_EMBEDDING_DIM}`,
    );
  }

  // -------------------------------------------------------------------------
  // P12.T1: ai_blur_check — classify {sharp, maybe_blurry, blurry}
  // -------------------------------------------------------------------------

  private invokeAiBlurCheck(req: AIRequest): AIResponse {
    const startedAt = Date.now();

    if (req.inputBytes === undefined || req.inputBytes.length === 0) {
      return fail(
        LOCAL_MOCK_MODEL_AI_BLUR_CHECK,
        startedAt,
        "local-mock: ai_blur_check requires non-empty inputBytes",
      );
    }

    const hash = hashBytes(req.inputBytes);
    const blurClass = deriveBlurClassFromHash(hash);

    const payload = {
      requestType: "ai_blur_check",
      algorithmVersion: LOCAL_MOCK_ALGORITHM_VERSION,
      class: blurClass,
      reason: `local-mock deterministic classification by SHA256 prefix → ${blurClass}`,
    };
    const outputBytes = Buffer.from(JSON.stringify(payload), "utf-8");

    return ok(
      LOCAL_MOCK_MODEL_AI_BLUR_CHECK,
      startedAt,
      outputBytes,
      `local-mock: ai_blur_check class=${blurClass}`,
    );
  }

  // -------------------------------------------------------------------------
  // P12.T1: scene_best_pick — pick best from candidates array
  // -------------------------------------------------------------------------

  private invokeSceneBestPick(req: AIRequest): AIResponse {
    const startedAt = Date.now();

    // Input contract: params.candidates = [{mediaId}, ...]
    // (Thumbnail bytes are optional; the stub picks by mediaId hash.)
    const candidates = (req.params?.["candidates"] ?? null) as
      | ReadonlyArray<{ mediaId?: unknown }>
      | null;

    if (!Array.isArray(candidates) || candidates.length === 0) {
      return fail(
        LOCAL_MOCK_MODEL_SCENE_BEST_PICK,
        startedAt,
        "local-mock: scene_best_pick requires non-empty params.candidates: [{mediaId},...]",
      );
    }

    // Validate each candidate has a string mediaId.
    const validCandidates: { mediaId: string }[] = [];
    for (const c of candidates) {
      if (
        c !== null &&
        typeof c === "object" &&
        "mediaId" in c &&
        typeof c.mediaId === "string" &&
        c.mediaId.length > 0
      ) {
        validCandidates.push({ mediaId: c.mediaId });
      }
    }
    if (validCandidates.length === 0) {
      return fail(
        LOCAL_MOCK_MODEL_SCENE_BEST_PICK,
        startedAt,
        "local-mock: scene_best_pick all candidates malformed (need string mediaId)",
      );
    }

    const bestMediaId = pickBestByHash(validCandidates);
    if (bestMediaId === null) {
      return fail(
        LOCAL_MOCK_MODEL_SCENE_BEST_PICK,
        startedAt,
        "local-mock: scene_best_pick unable to pick (unexpected; this should be unreachable)",
      );
    }

    const payload = {
      requestType: "scene_best_pick",
      algorithmVersion: LOCAL_MOCK_ALGORITHM_VERSION,
      bestMediaId,
      reason: `local-mock: smallest SHA256(mediaId) lexicographic from ${validCandidates.length} candidates`,
      confidence: 0.5,
    };
    const outputBytes = Buffer.from(JSON.stringify(payload), "utf-8");

    return ok(
      LOCAL_MOCK_MODEL_SCENE_BEST_PICK,
      startedAt,
      outputBytes,
      `local-mock: scene_best_pick picked from ${validCandidates.length} candidates`,
    );
  }

  // -------------------------------------------------------------------------
  // P12.T1: refinement_suggest — fixed conservative JSON params
  // -------------------------------------------------------------------------

  private invokeRefinementSuggest(req: AIRequest): AIResponse {
    const startedAt = Date.now();

    // Per design.md §7.6, refinement_suggest's input is a thumbnail.
    // We don't actually need to look at it for the stub — but we
    // still reject missing input so the worker's failure branch is
    // exercised symmetrically with the other image-based types.
    if (req.inputBytes === undefined || req.inputBytes.length === 0) {
      return fail(
        LOCAL_MOCK_MODEL_REFINEMENT_SUGGEST,
        startedAt,
        "local-mock: refinement_suggest requires non-empty inputBytes",
      );
    }

    const payload = {
      requestType: "refinement_suggest",
      algorithmVersion: LOCAL_MOCK_ALGORITHM_VERSION,
      ...LOCAL_MOCK_REFINEMENT_PARAMS,
    };
    const outputBytes = Buffer.from(JSON.stringify(payload), "utf-8");

    return ok(
      LOCAL_MOCK_MODEL_REFINEMENT_SUGGEST,
      startedAt,
      outputBytes,
      "local-mock: refinement_suggest mild brightening + contrast",
    );
  }
}
