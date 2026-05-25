// LocalMockProvider (P10.T7 — acceptance fixture).
//
// A deterministic, no-network, no-secret AIProvider implementation
// used to validate the full image_ai_refine pipeline (enqueue →
// quota gate → worker → audit → media_versions upsert → frontend
// version compare panel) without depending on a real SaaS
// provider. Operators activate it via:
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
// Behaviour:
//
//   * `name === "local-mock"` — stable id used in audit rows.
//   * `available === true`. The UI route gate passes; the worker
//     can call `invoke()`.
//   * `supports = { 'image_ai_refine' }`. Future request types
//     can be added when the worker counterparts ship.
//   * `invoke({ requestType: 'image_ai_refine', inputBytes })`:
//     - Reads `inputBytes` via sharp.
//     - Applies a deterministic, mild colour modulation (tint +
//       saturation drop) so the output is a real JPEG that's
//       visibly distinguishable from the original — useful for
//       eyeballing the version compare panel.
//     - Re-encodes as JPEG (mozjpeg, q=85). No upscaling, no
//       large allocations: the output is roughly the same byte
//       size as the input.
//     - Returns a success response with `provider='local-mock'`,
//       `modelName='local-mock-image-refine-v1'`,
//       `costEstimate=0`, `durationMs=<measured>`.
//     - **`raw` is omitted** — the provider returns NO opaque
//       payload, so nothing accidentally lands in
//       `media_versions.params.raw` (R-134). The `responseSummary`
//       is a fixed sanitized string (no provider secrets, no
//       echo of the input bytes' hash, etc.).
//
// What this provider does NOT do:
//   * Network calls of any kind. The provider's source file does
//     not import `node:http` / `node:https` / `node:net` / any
//     `fetch` polyfill — verifiable by grep.
//   * Touch the database. The worker layer (P10.T5) does that.
//   * Read environment variables / config — fully self-contained.
//
// Failure modes:
//   * Wrong `requestType` (anything other than 'image_ai_refine')
//     → throws `AIProviderUnsupportedRequestError` (matches the
//     `supports` set declaration; the worker handles this
//     branch).
//   * Missing / empty `inputBytes` → returns an `AIFailureResponse`
//     (NOT a thrown error) so the worker's structured-failure
//     branch is exercised. The audit row records the failure
//     cleanly.
//   * sharp throws (corrupt input) → caught and translated into
//     `AIFailureResponse`; worker logs the original sharp error.

import sharp from "sharp";

import {
  AIProviderUnsupportedRequestError,
  type AIProvider,
  type AIRequest,
  type AIRequestType,
  type AIResponse,
} from "./AIProvider.js";

const LOCAL_MOCK_SUPPORTS: ReadonlySet<AIRequestType> = Object.freeze(
  new Set<AIRequestType>(["image_ai_refine"]),
);

/** Stable id for audit rows. */
export const LOCAL_MOCK_PROVIDER_NAME = "local-mock";

/** Stable model id for audit rows. Bumping this would break smoke
 * fixtures that assert against it — version it deliberately. */
export const LOCAL_MOCK_MODEL_NAME = "local-mock-image-refine-v1";

export class LocalMockProvider implements AIProvider {
  readonly name = LOCAL_MOCK_PROVIDER_NAME;
  readonly available = true;
  readonly supports: ReadonlySet<AIRequestType> = LOCAL_MOCK_SUPPORTS;

  async invoke(req: AIRequest): Promise<AIResponse> {
    // Hard-reject unsupported request types — matches `supports`.
    if (req.requestType !== "image_ai_refine") {
      throw new AIProviderUnsupportedRequestError(this.name, req.requestType);
    }

    const startedAt = Date.now();

    // Defensive: outputBytes is mandatory for image_ai_refine.
    if (req.inputBytes === undefined || req.inputBytes.length === 0) {
      return {
        status: "failed",
        provider: this.name,
        modelName: LOCAL_MOCK_MODEL_NAME,
        costEstimate: 0,
        durationMs: Date.now() - startedAt,
        errorMessage: "local-mock: inputBytes missing or empty",
      };
    }

    // Deterministic transform: gentle tint + saturation drop +
    // JPEG re-encode. mozjpeg=true gives reproducibly-smaller
    // output. Every coefficient is hard-coded so two runs with
    // identical input produce byte-identical output (modulo
    // sharp / libvips version-pinning which is fine for V1).
    let outputBytes: Buffer;
    try {
      outputBytes = await sharp(req.inputBytes)
        .rotate()
        .modulate({ brightness: 1.02, saturation: 0.92 })
        .tint({ r: 240, g: 235, b: 220 })
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer();
    } catch (sharpErr) {
      return {
        status: "failed",
        provider: this.name,
        modelName: LOCAL_MOCK_MODEL_NAME,
        costEstimate: 0,
        durationMs: Date.now() - startedAt,
        errorMessage: `local-mock: sharp pipeline failed: ${
          sharpErr instanceof Error ? sharpErr.message : String(sharpErr)
        }`,
      };
    }

    return {
      status: "success",
      provider: this.name,
      modelName: LOCAL_MOCK_MODEL_NAME,
      costEstimate: 0,
      durationMs: Date.now() - startedAt,
      outputBytes,
      responseSummary: "local-mock: deterministic tint + saturation drop",
      // raw is INTENTIONALLY omitted — R-134 hygiene. The worker
      // writes `raw ?? null` into media_versions.params, so leaving
      // it undefined means `null` lands there. No provider secrets,
      // no input echo, no API response opaque blob.
    };
  }
}
