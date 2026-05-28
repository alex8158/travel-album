// AIProvider interface (P10.T1).
//
// The single public abstraction for every external AI / model call
// the project makes. Future provider plugins (OpenAI / Gemini /
// Bedrock / a local mock for tests) implement this same shape, and
// the rest of the codebase only ever depends on `AIProvider` — not
// on any specific provider's SDK.
//
// V1 ships ONE concrete implementation:
//   * `NoopProvider` — always reports `available=false` and throws
//     `AIProviderNotConfiguredError` on `invoke()`. Returned by the
//     `createAIProviderFromConfig()` factory whenever
//     `AI_ENABLED=false` (the default) or `AI_PROVIDER` is empty /
//     unknown. CLAUDE.md §2.8 — base features must work without AI.
//
// The interface is deliberately minimal:
//   * No per-provider config bag (each provider's `ctor` reads its
//     own env keys).
//   * No per-call streaming hooks (V1 is request/response).
//   * No retry policy (the JobQueue's retry budget is the right
//     place; provider-side retries would double-count quota).
//
// Cross-task red lines this module enforces by construction:
//   * Providers MUST be pure side-effect-on-network. They never
//     write to the DB, never read user_decision, never touch
//     media_items / media_versions / video_segments — those are
//     the AI worker's responsibility (P10.T5+).
//   * Providers MUST NOT throw on `available` checks; callers
//     branch on `provider.available` first to render UI affordances
//     (P10.T6: grey-out "AI Refine" button when `available=false`).
//   * Providers MUST surface cost + duration on every response (or
//     `null` if unmeasurable); the audit table `ai_invocations`
//     stores them verbatim.

/**
 * Closed set of AI request types. Mirrors the CHECK enum on
 * `ai_invocations.request_type` (migrations 012 + 018). A future
 * request type requires both a schema migration AND an extension
 * of this union — the schema is the single source of truth, this
 * type is its TypeScript mirror.
 *
 * P12.T1 added 4 new values for the curated-album pipeline (see
 * design.md §7.8). The closed enum is now 10 values; any new
 * value MUST land in three places at once:
 *   1. `ai_invocations.request_type` CHECK (a new STRICT-rebuild
 *      migration).
 *   2. This TypeScript union.
 *   3. Every concrete `AIProvider` implementation's `supports` set
 *      (a provider may decline a value but the enum must list it).
 */
export type AIRequestType =
  | "image_ai_refine"
  | "ai_caption"
  | "ai_classify"
  | "aesthetic_score"
  | "video_plan"
  | "ranking"
  // P12.T1 — curated-album pipeline AI calls
  | "scene_embedding"
  | "ai_blur_check"
  | "scene_best_pick"
  | "refinement_suggest";

/**
 * Closed set of audit row statuses. Mirrors the CHECK enum on
 * `ai_invocations.status` (migration 012).
 */
export type AIInvocationStatus = "pending" | "success" | "failed";

/**
 * Per-call input. Providers should treat unknown `params` keys as
 * opaque — different request types may have wildly different shapes
 * (an `image_ai_refine` carries `inputBytes`; an `ai_caption` may
 * carry `language`). The `requestType` discriminator is the
 * provider's switch.
 *
 * `mediaId` / `jobId` are passed through for audit-trail correlation
 * only; providers MUST NOT use them to read or write DB state.
 */
export interface AIRequest {
  readonly requestType: AIRequestType;
  /** Audit-trail correlation; opaque to the provider. */
  readonly mediaId?: string;
  readonly jobId?: string;
  /** Per-request-type opaque payload. Provider documents the shape. */
  readonly params?: Record<string, unknown>;
  /** Input bytes (e.g. the source image to refine). Optional because
   * some request types are pure-text (caption from a media id). */
  readonly inputBytes?: Buffer;
}

/**
 * Success-shape response. The worker layer (P10.T5+) is responsible
 * for translating `outputBytes` to a `media_versions` row and
 * writing the audit row.
 */
export interface AISuccessResponse {
  readonly status: "success";
  /** Stable provider id (matches `ai_invocations.provider`). */
  readonly provider: string;
  /** Stable model id (matches `ai_invocations.model_name`). */
  readonly modelName: string;
  /** Provider-reported cost in normalised units. `null` when
   * unavailable; the worker MUST NOT compute a default. */
  readonly costEstimate: number | null;
  /** Wall-clock round-trip duration. */
  readonly durationMs: number;
  /** Output bytes when the call produced a binary artefact (e.g. a
   * refined image). `undefined` for text-only request types. */
  readonly outputBytes?: Buffer;
  /** Short human-readable summary the audit table can keep
   * (e.g. "1024x768 JPEG, 142 KB"). */
  readonly responseSummary?: string;
  /** Provider-specific raw response. Stored verbatim in
   * `ai_invocations.request_params` as JSON when the worker chooses
   * to (audit only). */
  readonly raw?: Record<string, unknown>;
}

/**
 * Failure-shape response. The provider returns this — it does NOT
 * throw — when the call reached the provider but the provider
 * rejected it (rate-limit, content policy, malformed input). For
 * "I cannot even attempt this call" use `AIProviderNotConfiguredError`
 * instead (it's a programmer / configuration error, not a per-call
 * failure).
 */
export interface AIFailureResponse {
  readonly status: "failed";
  readonly provider: string;
  readonly modelName: string;
  readonly costEstimate: number | null;
  readonly durationMs: number;
  /** Human-readable; persisted to `ai_invocations.error_message`. */
  readonly errorMessage: string;
}

export type AIResponse = AISuccessResponse | AIFailureResponse;

/**
 * The single public abstraction. Every concrete provider exports a
 * class implementing this; the factory (`createAIProviderFromConfig`
 * in `./index.ts`) picks one at boot.
 *
 * Lifecycle: construct at boot, single shared instance per process.
 * Per-call state (timeouts, retries) lives inside the provider's
 * `invoke()` implementation.
 */
export interface AIProvider {
  /**
   * Stable identifier matching `ai_invocations.provider`. Examples:
   * `"noop"`, `"openai"`, `"gemini"`, `"bedrock"`, `"local-mock"`.
   * Must be non-empty and stable across restarts so audit rows
   * keep grouping cleanly.
   */
  readonly name: string;
  /**
   * `true` when this provider can actually fulfil requests. Callers
   * (frontend + worker enqueue path) gate their UI on this BEFORE
   * touching `invoke()` so a clear "AI not configured" error reaches
   * the user instead of a stack trace.
   */
  readonly available: boolean;
  /**
   * Closed set of request types this provider supports. Empty for
   * `NoopProvider`. Future provider implementations may support a
   * subset (e.g. an aesthetic-only provider). The worker enqueue
   * path MUST consult this before scheduling a job — a request type
   * outside the set raises `AIProviderUnsupportedRequestError`.
   */
  readonly supports: ReadonlySet<AIRequestType>;
  /**
   * Perform one provider call. The provider:
   *   * Measures wall-clock and reports it in `durationMs` for both
   *     success AND failure shapes.
   *   * Translates network / SDK errors into either `AIFailureResponse`
   *     (the call reached the provider) or throws
   *     `AIProviderNotConfiguredError` / `AIProviderUnsupportedRequestError`
   *     (the call could not be attempted).
   *   * Must NOT side-effect any DB or filesystem state — output
   *     bytes are returned in `outputBytes` and persisted by the
   *     worker.
   */
  invoke(req: AIRequest): Promise<AIResponse>;
}

/**
 * Thrown by providers (and by the factory's chosen fallback) when
 * the call could not be attempted because AI is not configured.
 * The error carries a stable `code` so the global error envelope
 * can translate it to the design.md §11.2 `AI_NOT_CONFIGURED` HTTP
 * code.
 */
export class AIProviderNotConfiguredError extends Error {
  override readonly name = "AIProviderNotConfiguredError";
  readonly code = "AI_NOT_CONFIGURED";
  constructor(message = "AI provider is not configured (AI_ENABLED=false or AI_PROVIDER unset)") {
    super(message);
  }
}

/**
 * Thrown when the configured provider exists but does not support
 * the requested `requestType`. Distinct from
 * `AIProviderNotConfiguredError` so the UI can render a different
 * message ("This action isn't supported by your current AI provider").
 */
export class AIProviderUnsupportedRequestError extends Error {
  override readonly name = "AIProviderUnsupportedRequestError";
  readonly code = "AI_REQUEST_TYPE_UNSUPPORTED";
  readonly requestType: AIRequestType;
  readonly providerName: string;
  constructor(providerName: string, requestType: AIRequestType) {
    super(
      `AI provider '${providerName}' does not support request type '${requestType}'`,
    );
    this.providerName = providerName;
    this.requestType = requestType;
  }
}
