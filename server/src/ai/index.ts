// Public surface for the AI domain (P10.T1).
//
// Importers reach for `../ai` rather than the individual files so a
// future move (e.g. extracting providers into a sub-package) is a
// one-file rename. P10.T1 is bootstrapping — the only concrete
// provider that ships is `NoopProvider`; the factory below already
// has the dispatch shape that future provider PRs will plug into.
//
// Wiring contract (CLAUDE.md §2.8):
//   * `createAIProviderFromConfig({ enabled: false, provider: "" })`
//     → NoopProvider (default state — base features must work).
//   * `createAIProviderFromConfig({ enabled: false, provider: "openai" })`
//     → NoopProvider (operator explicitly disabled AI; the
//     non-empty provider string is ignored).
//   * `createAIProviderFromConfig({ enabled: true, provider: "" })`
//     → NoopProvider + WARN log. The config layer's superRefine
//     already rejects this combination at boot, so it should be
//     unreachable in practice; the factory still tolerates it for
//     test harness flexibility.
//   * `createAIProviderFromConfig({ enabled: true, provider: <unknown> })`
//     → NoopProvider + WARN log. Future PRs replace this branch
//     with a dispatch (`openai` → OpenAIProvider, etc.).

import type { Logger } from "../logger.js";

import { NoopProvider } from "./NoopProvider.js";

export {
  AIProviderNotConfiguredError,
  AIProviderUnsupportedRequestError,
  type AIInvocationStatus,
  type AIFailureResponse,
  type AIProvider,
  type AIRequest,
  type AIRequestType,
  type AIResponse,
  type AISuccessResponse,
} from "./AIProvider.js";
export { NoopProvider } from "./NoopProvider.js";
export {
  AiInvocationsRepository,
  type AiInvocationInsertData,
  type AiInvocationRow,
} from "./aiInvocationsRepository.js";

/**
 * `processing_jobs.job_type` token for the image-channel AI refine
 * worker (P10.T3 enqueue path; P10.T5 worker handler).
 *
 * Kept as a single string constant so the route layer, the future
 * worker registry, and the smoke harness all import it from one
 * place — drift between the route's enqueue and the worker's
 * registration would surface immediately as "no handler for job
 * type 'image_ai_refine'" at runtime, but compile-time alignment
 * via this const eliminates the typo class entirely.
 *
 * Matches the closed-set value `'image_ai_refine'` in:
 *   * `AIRequestType` (TS union in AIProvider.ts).
 *   * `ai_invocations.request_type` CHECK enum (migration 012).
 * R-121 (progress.md): these three are hand-aligned today; a
 * future refactor can extract a single source-of-truth constant
 * the SQL CHECK reads too. For P10.T3 the three-way alignment is
 * the minimum invariant.
 */
export const IMAGE_AI_REFINE_JOB_TYPE = "image_ai_refine";

/** Subset of `Config['ai']` the factory needs. Imported as a
 * structural type to avoid a circular dep with the config module. */
export interface AIProviderFactoryConfig {
  readonly enabled: boolean;
  readonly provider: string;
}

/** Provider registry — extend this when a real provider lands.
 * Closed set: anything not in this map falls back to NoopProvider
 * with a WARN log. Matching is case-insensitive after trim. */
const KNOWN_PROVIDER_IDS: readonly string[] = ["noop", "disabled"] as const;

/**
 * Decide which `AIProvider` implementation to use at boot.
 *
 * @param config — typically `config.ai` from `loadConfig()`.
 * @param logger — optional; when present, emits one structured INFO
 *   line summarising the choice + one WARN when the operator's
 *   AI_PROVIDER value is unknown. The logger argument is optional
 *   so smokes can drive the factory without booting the logger.
 */
export function createAIProviderFromConfig(
  config: AIProviderFactoryConfig,
  logger?: Logger,
): import("./AIProvider.js").AIProvider {
  const providerToken = config.provider.trim().toLowerCase();

  if (!config.enabled) {
    logger?.info(
      { aiEnabled: false, providerToken },
      "ai: disabled by config — NoopProvider in use; base features unaffected",
    );
    return new NoopProvider();
  }

  // AI_ENABLED=true reached. The superRefine in `config/index.ts`
  // already requires AI_PROVIDER to be non-empty in this branch,
  // but defensive: tolerate an empty value here and warn.
  if (providerToken === "" || providerToken === "noop" || providerToken === "disabled") {
    logger?.warn(
      { aiEnabled: true, providerToken },
      "ai: AI_ENABLED=true but provider is empty / 'noop' / 'disabled' — falling back to NoopProvider",
    );
    return new NoopProvider();
  }

  // Unknown provider id — future PRs add the openai / gemini /
  // bedrock / local-mock branches here. Until then, refuse to
  // attempt real network calls and stay safe.
  logger?.warn(
    {
      aiEnabled: true,
      providerToken,
      knownProviderIds: KNOWN_PROVIDER_IDS,
    },
    "ai: AI_PROVIDER is set to an unknown id; no concrete provider is wired yet — falling back to NoopProvider",
  );
  return new NoopProvider();
}
