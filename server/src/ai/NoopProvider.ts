// NoopProvider (P10.T1).
//
// The default AIProvider returned whenever AI is disabled. CLAUDE.md
// §2.8 — "AI 调用默认关闭。未配置 AI 时，全部基础功能必须仍可用".
// This implementation is the canonical answer to "what runs when
// the operator hasn't picked a provider yet?": every call refuses
// with `AIProviderNotConfiguredError`, every UI affordance can read
// `available === false` and grey itself out, and no per-task code
// path can accidentally fall through to a real network call.
//
// Behaviours:
//   * `name === "noop"` — stable; future audit rows would carry it
//     if anything ever wrote one (P10.T1 has no writers, so audit
//     rows for the noop provider should never exist; if they do,
//     it's a bug in a later task's wiring).
//   * `available === false` — frontend reads this to disable the
//     "AI Refine" button. The flag is also what `createAIProviderFromConfig`
//     uses to decide whether to log an "AI ready" / "AI disabled"
//     line at startup.
//   * `supports` is an empty set — explicitly: no request type is
//     servable. Callers asking via `supports.has(requestType)` get
//     `false` for every type.
//   * `invoke()` always throws `AIProviderNotConfiguredError` —
//     NOT a `failure response`. The distinction matters: a failure
//     response means "the provider tried and failed" (worth retrying,
//     billable in some pricing models); a thrown
//     `AIProviderNotConfiguredError` means "the provider refused to
//     try" (not retryable, not billable, surfaces as
//     `AI_NOT_CONFIGURED` to the API client).

import {
  type AIProvider,
  type AIRequest,
  type AIRequestType,
  type AIResponse,
  AIProviderNotConfiguredError,
} from "./AIProvider.js";

/** Frozen empty set — exported so callers comparing identity (rare)
 * still see the same object across imports. */
const NOOP_SUPPORTS: ReadonlySet<AIRequestType> = Object.freeze(new Set<AIRequestType>());

export class NoopProvider implements AIProvider {
  readonly name = "noop";
  readonly available = false;
  readonly supports: ReadonlySet<AIRequestType> = NOOP_SUPPORTS;

  // Annotated `_req` (not `req`) so eslint's no-unused-vars rule is
  // happy without an `// eslint-disable` comment; future providers
  // delete the underscore the moment they read the input.
  async invoke(_req: AIRequest): Promise<AIResponse> {
    throw new AIProviderNotConfiguredError(
      "AI provider is not configured; set AI_ENABLED=true and AI_PROVIDER to a supported value to enable",
    );
  }
}
