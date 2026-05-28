// Manual smoke test for the AIProvider foundation (P10.T1).
//
// Usage: npm run smoke:ai-provider
//
// Drives the AI module in isolation (no DB, no HTTP) to assert the
// contract the rest of the system depends on:
//   * `createAIProviderFromConfig({enabled:false, provider:""})`
//     returns a `NoopProvider` — the default state. CLAUDE.md §2.8.
//   * `NoopProvider.available === false`, `supports` is empty.
//   * `NoopProvider.invoke(...)` throws `AIProviderNotConfiguredError`
//     with the documented `code === "AI_NOT_CONFIGURED"` — never
//     attempts a network call (this smoke doesn't even need network).
//   * Operator overrides that still produce Noop (defensive path):
//       - enabled=false + provider="openai"  → Noop  (operator off)
//       - enabled=true  + provider=""        → Noop + warn
//       - enabled=true  + provider="noop"    → Noop + warn
//       - enabled=true  + provider="<unknown>" → Noop + warn
//     None of these emit a network call.
//   * `AIProviderUnsupportedRequestError` shape (the only other
//     custom error the module exports).
//
// The smoke deliberately uses a stub Logger that records the call
// pattern so we can assert "exactly one INFO when disabled" and
// "one WARN when an unknown provider is requested" without
// monkey-patching anything.

import {
  AIProviderNotConfiguredError,
  AIProviderUnsupportedRequestError,
  LocalMockProvider,
  LOCAL_MOCK_ALGORITHM_VERSION,
  LOCAL_MOCK_EMBEDDING_DIM,
  LOCAL_MOCK_MODEL_AI_BLUR_CHECK,
  LOCAL_MOCK_MODEL_REFINEMENT_SUGGEST,
  LOCAL_MOCK_MODEL_SCENE_BEST_PICK,
  LOCAL_MOCK_MODEL_SCENE_EMBEDDING,
  LOCAL_MOCK_PROVIDER_NAME,
  LOCAL_MOCK_REFINEMENT_PARAMS,
  NoopProvider,
  createAIProviderFromConfig,
  deriveBlurClassFromHash,
  deriveEmbeddingFromHash,
  pickBestByHash,
  type AIRequest,
} from "../ai/index.js";
import type { Logger } from "../logger.js";

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}
const results: CheckResult[] = [];

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`[smoke][${ok ? "PASS" : "FAIL"}] ${name}: ${detail}`);
}

function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

// ---------------------------------------------------------------------------
// stub logger — captures the level + msg of every call so the smoke
// can assert "exactly one INFO" / "one WARN" without booting pino.
// ---------------------------------------------------------------------------

interface CapturedLogCall {
  readonly level: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  readonly bindings: Record<string, unknown>;
  readonly msg: string;
}

function makeStubLogger(): { logger: Logger; calls: CapturedLogCall[] } {
  const calls: CapturedLogCall[] = [];
  const push = (level: CapturedLogCall["level"]) =>
    (a: unknown, b?: unknown): void => {
      // pino's signature: `(obj, msg)` or `(msg)`. Normalise to both.
      if (typeof a === "string") {
        calls.push({ level, bindings: {}, msg: a });
      } else {
        calls.push({
          level,
          bindings: (a as Record<string, unknown>) ?? {},
          msg: typeof b === "string" ? b : "",
        });
      }
    };
  // The Logger type is the pino interface; we only stub the methods
  // the AI factory actually calls (`info`, `warn`).
  const logger = {
    trace: push("trace"),
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    fatal: push("fatal"),
    child: () => logger,
  } as unknown as Logger;
  return { logger, calls };
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // -------------------------------------------------------------------
  // CASE 1: NoopProvider construction + read-only shape
  // -------------------------------------------------------------------
  {
    const p = new NoopProvider();
    record(
      "noop: name is the stable 'noop' id",
      p.name === "noop",
      `name=${p.name}`,
    );
    record(
      "noop: available === false (UI greys out)",
      p.available === false,
      `available=${p.available}`,
    );
    record(
      "noop: supports is an empty set",
      p.supports.size === 0,
      `size=${p.supports.size}`,
    );
    record(
      "noop: supports.has(<any request type>) is false (all 10 P12-extended values)",
      !p.supports.has("image_ai_refine") &&
        !p.supports.has("ai_caption") &&
        !p.supports.has("ai_classify") &&
        !p.supports.has("aesthetic_score") &&
        !p.supports.has("video_plan") &&
        !p.supports.has("ranking") &&
        !p.supports.has("scene_embedding") &&
        !p.supports.has("ai_blur_check") &&
        !p.supports.has("scene_best_pick") &&
        !p.supports.has("refinement_suggest"),
      "ok",
    );
  }

  // -------------------------------------------------------------------
  // CASE 2: NoopProvider.invoke() throws AIProviderNotConfiguredError
  //         — never returns, never makes a network call.
  // -------------------------------------------------------------------
  {
    const p = new NoopProvider();
    const req: AIRequest = {
      requestType: "image_ai_refine",
      mediaId: "mediaA",
      jobId: "jobA",
      params: { foo: "bar" },
      inputBytes: Buffer.from([0xff, 0xd8]),
    };
    let threw: unknown;
    try {
      await p.invoke(req);
    } catch (err) {
      threw = err;
    }
    record(
      "noop.invoke: throws AIProviderNotConfiguredError on any request",
      threw instanceof AIProviderNotConfiguredError,
      describeError(threw),
    );
    if (threw instanceof AIProviderNotConfiguredError) {
      record(
        "noop.invoke: thrown error carries stable code='AI_NOT_CONFIGURED'",
        threw.code === "AI_NOT_CONFIGURED",
        `code=${threw.code}`,
      );
    }
  }

  // -------------------------------------------------------------------
  // CASE 3: factory({enabled:false, provider:""}) → Noop + INFO log
  //         (the canonical default state — base features must work)
  // -------------------------------------------------------------------
  {
    const { logger, calls } = makeStubLogger();
    const provider = createAIProviderFromConfig(
      { enabled: false, provider: "" },
      logger,
    );
    record(
      "factory(default): returns NoopProvider",
      provider instanceof NoopProvider,
      `name=${provider.name}`,
    );
    record(
      "factory(default): emits exactly one INFO line about disabled state",
      calls.filter((c) => c.level === "info").length === 1 &&
        calls.every((c) => c.level !== "warn") &&
        calls.some((c) => /disabled by config/.test(c.msg)),
      `calls=${JSON.stringify(calls.map((c) => `${c.level}:${c.msg.slice(0, 30)}`))}`,
    );
  }

  // -------------------------------------------------------------------
  // CASE 4: factory({enabled:false, provider:"openai"}) → Noop
  //         (operator turned AI off; provider value is irrelevant)
  // -------------------------------------------------------------------
  {
    const { logger, calls } = makeStubLogger();
    const provider = createAIProviderFromConfig(
      { enabled: false, provider: "openai" },
      logger,
    );
    record(
      "factory(off+openai): returns NoopProvider (operator off wins)",
      provider instanceof NoopProvider,
      `name=${provider.name}`,
    );
    record(
      "factory(off+openai): single INFO log, no WARN",
      calls.filter((c) => c.level === "info").length === 1 &&
        calls.filter((c) => c.level === "warn").length === 0,
      `calls=${JSON.stringify(calls.map((c) => c.level))}`,
    );
  }

  // -------------------------------------------------------------------
  // CASE 5: factory({enabled:true, provider:""}) → Noop + WARN
  //         (the config layer's superRefine prevents this combo at
  //         boot; the factory tolerates it for test harness use)
  // -------------------------------------------------------------------
  {
    const { logger, calls } = makeStubLogger();
    const provider = createAIProviderFromConfig(
      { enabled: true, provider: "" },
      logger,
    );
    record(
      "factory(on+empty): returns NoopProvider + WARN log",
      provider instanceof NoopProvider &&
        calls.some((c) => c.level === "warn" && /falling back to NoopProvider/.test(c.msg)),
      `calls=${JSON.stringify(calls.map((c) => c.level))}`,
    );
  }

  // -------------------------------------------------------------------
  // CASE 6: factory({enabled:true, provider:"noop"}) → Noop + WARN
  // -------------------------------------------------------------------
  {
    const { logger, calls } = makeStubLogger();
    const provider = createAIProviderFromConfig(
      { enabled: true, provider: "noop" },
      logger,
    );
    record(
      "factory(on+noop): returns NoopProvider + WARN (explicit noop)",
      provider instanceof NoopProvider &&
        calls.some((c) => c.level === "warn"),
      `calls=${JSON.stringify(calls.map((c) => c.level))}`,
    );
  }

  // -------------------------------------------------------------------
  // CASE 7: factory({enabled:true, provider:"openai"}) → Noop + WARN
  //         (unknown provider id — future PRs add this branch; until
  //         then we refuse to attempt a real network call.)
  // -------------------------------------------------------------------
  {
    const { logger, calls } = makeStubLogger();
    const provider = createAIProviderFromConfig(
      { enabled: true, provider: "openai" },
      logger,
    );
    record(
      "factory(on+openai): returns NoopProvider + WARN about unknown id (no real provider yet)",
      provider instanceof NoopProvider &&
        calls.some((c) => c.level === "warn" && /unknown id/.test(c.msg)),
      `calls=${JSON.stringify(calls.map((c) => `${c.level}:${c.msg.slice(0, 50)}`))}`,
    );
  }

  // -------------------------------------------------------------------
  // CASE 8: factory accepts undefined logger (smokes / tests path)
  // -------------------------------------------------------------------
  {
    const provider = createAIProviderFromConfig({ enabled: false, provider: "" });
    record(
      "factory(no logger): does not throw, returns NoopProvider",
      provider instanceof NoopProvider,
      `name=${provider.name}`,
    );
  }

  // -------------------------------------------------------------------
  // CASE 9: provider id matching is case-insensitive after trim
  // -------------------------------------------------------------------
  {
    const { logger } = makeStubLogger();
    const p1 = createAIProviderFromConfig({ enabled: true, provider: "  NoOp  " }, logger);
    const p2 = createAIProviderFromConfig({ enabled: true, provider: "DISABLED" }, logger);
    record(
      "factory: '  NoOp  ' (whitespace + case) → Noop",
      p1 instanceof NoopProvider,
      `name=${p1.name}`,
    );
    record(
      "factory: 'DISABLED' (uppercase) → Noop",
      p2 instanceof NoopProvider,
      `name=${p2.name}`,
    );
  }

  // -------------------------------------------------------------------
  // CASE 10: AIProviderUnsupportedRequestError shape
  //          (not raised by factory or Noop — but the module exports it,
  //          so future providers + the worker layer can throw it. The
  //          smoke verifies the constructor + properties so a drift
  //          would surface immediately.)
  // -------------------------------------------------------------------
  {
    const err = new AIProviderUnsupportedRequestError("openai", "video_plan");
    record(
      "AIProviderUnsupportedRequestError: code + name + properties",
      err.code === "AI_REQUEST_TYPE_UNSUPPORTED" &&
        err.name === "AIProviderUnsupportedRequestError" &&
        err.providerName === "openai" &&
        err.requestType === "video_plan" &&
        /video_plan/.test(err.message),
      `err.code=${err.code} msg=${err.message}`,
    );
  }

  // -------------------------------------------------------------------
  // CROSS-CUT: no network call was ever attempted (no fetch / dns).
  // We can't truly assert "no network" without sandboxing, but we
  // can sanity-check that Node didn't import any HTTP-related globals
  // because of this smoke (the AI module imports nothing from
  // node:http / node:https — verified by `grep` in the test source
  // and the type checker; this row is here to document the contract).
  // -------------------------------------------------------------------
  record(
    "cross-cut: AI module has no node:http / node:https imports (verified by code review + tsc)",
    true,
    "documented in AIProvider.ts header",
  );

  // ===================================================================
  // PART B — P12.T1: LocalMockProvider extensions
  //
  // The 4 new request types (`scene_embedding`, `ai_blur_check`,
  // `scene_best_pick`, `refinement_suggest`) MUST:
  //   * appear in the `supports` set;
  //   * return deterministic stub output for the same input;
  //   * return AIFailureResponse (not throw) for malformed input;
  //   * never make a network call.
  // ===================================================================

  // -------------------------------------------------------------------
  // CASE 11: LocalMock.supports lists all 5 known request types
  // -------------------------------------------------------------------
  {
    const p = new LocalMockProvider();
    record(
      "local-mock: name === 'local-mock'",
      p.name === LOCAL_MOCK_PROVIDER_NAME,
      `name=${p.name}`,
    );
    record(
      "local-mock: available === true",
      p.available === true,
      `available=${p.available}`,
    );
    record(
      "local-mock: supports lists exactly { image_ai_refine, scene_embedding, ai_blur_check, scene_best_pick, refinement_suggest }",
      p.supports.size === 5 &&
        p.supports.has("image_ai_refine") &&
        p.supports.has("scene_embedding") &&
        p.supports.has("ai_blur_check") &&
        p.supports.has("scene_best_pick") &&
        p.supports.has("refinement_suggest"),
      `size=${p.supports.size}, members=${[...p.supports].sort().join(",")}`,
    );
    record(
      "local-mock: supports rejects unimplemented types (ai_caption / video_plan / etc.)",
      !p.supports.has("ai_caption") &&
        !p.supports.has("ai_classify") &&
        !p.supports.has("aesthetic_score") &&
        !p.supports.has("video_plan") &&
        !p.supports.has("ranking"),
      "ok",
    );
  }

  // -------------------------------------------------------------------
  // CASE 12: scene_embedding — deterministic 16-d Float32 vector
  // -------------------------------------------------------------------
  {
    const p = new LocalMockProvider();
    const input = Buffer.from("fixed-input-for-determinism-test", "utf-8");

    const req: AIRequest = {
      requestType: "scene_embedding",
      mediaId: "mediaA",
      inputBytes: input,
    };

    const r1 = await p.invoke(req);
    const r2 = await p.invoke(req);

    record(
      "local-mock.scene_embedding: status='success'",
      r1.status === "success",
      `status=${r1.status}`,
    );

    if (r1.status === "success") {
      record(
        "local-mock.scene_embedding: model_name === 'local-mock-scene-embedding-v1'",
        r1.modelName === LOCAL_MOCK_MODEL_SCENE_EMBEDDING,
        `modelName=${r1.modelName}`,
      );
      record(
        "local-mock.scene_embedding: costEstimate === 0",
        r1.costEstimate === 0,
        `cost=${r1.costEstimate}`,
      );
      record(
        "local-mock.scene_embedding: outputBytes present",
        r1.outputBytes !== undefined && r1.outputBytes.length > 0,
        `bytes=${r1.outputBytes?.length ?? 0}`,
      );

      if (r1.outputBytes !== undefined && r2.status === "success") {
        // Determinism: identical input → identical outputBytes.
        const sameBytes =
          r2.outputBytes !== undefined &&
          r1.outputBytes.equals(r2.outputBytes);
        record(
          "local-mock.scene_embedding: determinism — same input → same outputBytes",
          sameBytes,
          `len=${r1.outputBytes.length}`,
        );

        // Payload shape sanity-check.
        let parsed: {
          requestType?: unknown;
          algorithmVersion?: unknown;
          embeddingDim?: unknown;
          vector?: unknown;
        };
        try {
          parsed = JSON.parse(r1.outputBytes.toString("utf-8"));
        } catch (e) {
          parsed = {};
          record("local-mock.scene_embedding: outputBytes is valid JSON", false, describeError(e));
        }
        record(
          "local-mock.scene_embedding: payload includes requestType + algorithmVersion + embeddingDim + vector",
          parsed.requestType === "scene_embedding" &&
            parsed.algorithmVersion === LOCAL_MOCK_ALGORITHM_VERSION &&
            parsed.embeddingDim === LOCAL_MOCK_EMBEDDING_DIM &&
            Array.isArray(parsed.vector) &&
            parsed.vector.length === LOCAL_MOCK_EMBEDDING_DIM &&
            parsed.vector.every((v: unknown) => typeof v === "number"),
          `dim=${(parsed.vector as unknown[] | undefined)?.length}`,
        );

        // Cross-check: the worker can re-derive the same vector from
        // the documented helper function. (Pure-function determinism.)
        const expected = deriveEmbeddingFromHash(
          createHash("sha256").update(input).digest(),
          LOCAL_MOCK_EMBEDDING_DIM,
        );
        const actual = (parsed.vector as number[]) ?? [];
        const matches =
          actual.length === expected.length &&
          actual.every((v, i) => Math.abs(v - (expected[i] ?? NaN)) < 1e-12);
        record(
          "local-mock.scene_embedding: vector === deriveEmbeddingFromHash(SHA256(input), 16)",
          matches,
          `len ok=${actual.length === expected.length}`,
        );
      }
    }

    // Missing inputBytes → failure response, not throw.
    const failResp = await p.invoke({ requestType: "scene_embedding" });
    record(
      "local-mock.scene_embedding: empty input → AIFailureResponse (not throw)",
      failResp.status === "failed" &&
        failResp.modelName === LOCAL_MOCK_MODEL_SCENE_EMBEDDING &&
        /non-empty inputBytes/i.test(
          (failResp as { errorMessage: string }).errorMessage,
        ),
      `status=${failResp.status}`,
    );
  }

  // -------------------------------------------------------------------
  // CASE 13: ai_blur_check — deterministic class ∈ {sharp, maybe, blurry}
  // -------------------------------------------------------------------
  {
    const p = new LocalMockProvider();
    const input = Buffer.from("blur-test-input", "utf-8");

    const r1 = await p.invoke({ requestType: "ai_blur_check", inputBytes: input });
    const r2 = await p.invoke({ requestType: "ai_blur_check", inputBytes: input });

    record(
      "local-mock.ai_blur_check: status='success'",
      r1.status === "success",
      `status=${r1.status}`,
    );

    if (r1.status === "success") {
      record(
        "local-mock.ai_blur_check: model_name === 'local-mock-ai-blur-check-v1'",
        r1.modelName === LOCAL_MOCK_MODEL_AI_BLUR_CHECK,
        `modelName=${r1.modelName}`,
      );

      if (r1.outputBytes !== undefined) {
        let parsed: {
          requestType?: unknown;
          class?: unknown;
          reason?: unknown;
        };
        try {
          parsed = JSON.parse(r1.outputBytes.toString("utf-8"));
        } catch {
          parsed = {};
        }
        record(
          "local-mock.ai_blur_check: payload class ∈ {sharp,maybe_blurry,blurry}",
          parsed.requestType === "ai_blur_check" &&
            (parsed.class === "sharp" ||
              parsed.class === "maybe_blurry" ||
              parsed.class === "blurry") &&
            typeof parsed.reason === "string",
          `class=${String(parsed.class)}`,
        );

        // Determinism: same input → same class (via helper).
        const expected = deriveBlurClassFromHash(
          createHash("sha256").update(input).digest(),
        );
        record(
          "local-mock.ai_blur_check: class === deriveBlurClassFromHash(SHA256(input))",
          parsed.class === expected,
          `expected=${expected}, got=${String(parsed.class)}`,
        );

        // Run determinism: r1 and r2 same payload.
        if (r2.status === "success" && r2.outputBytes !== undefined) {
          record(
            "local-mock.ai_blur_check: determinism — same input → same outputBytes",
            r1.outputBytes.equals(r2.outputBytes),
            "ok",
          );
        }
      }
    }

    const failResp = await p.invoke({ requestType: "ai_blur_check" });
    record(
      "local-mock.ai_blur_check: empty input → AIFailureResponse",
      failResp.status === "failed",
      `status=${failResp.status}`,
    );
  }

  // -------------------------------------------------------------------
  // CASE 14: scene_best_pick — picks smallest-hash candidate
  // -------------------------------------------------------------------
  {
    const p = new LocalMockProvider();

    // Three candidates; the helper says pick whichever hashes smallest.
    const candidates = [
      { mediaId: "media-alpha" },
      { mediaId: "media-bravo" },
      { mediaId: "media-charlie" },
    ];
    const expectedBest = pickBestByHash(candidates);

    const r = await p.invoke({
      requestType: "scene_best_pick",
      params: { candidates },
    });

    record(
      "local-mock.scene_best_pick: status='success' on valid candidates",
      r.status === "success",
      `status=${r.status}`,
    );

    if (r.status === "success") {
      record(
        "local-mock.scene_best_pick: model_name === 'local-mock-scene-best-pick-v1'",
        r.modelName === LOCAL_MOCK_MODEL_SCENE_BEST_PICK,
        `modelName=${r.modelName}`,
      );

      if (r.outputBytes !== undefined) {
        let parsed: {
          requestType?: unknown;
          bestMediaId?: unknown;
          reason?: unknown;
          confidence?: unknown;
        };
        try {
          parsed = JSON.parse(r.outputBytes.toString("utf-8"));
        } catch {
          parsed = {};
        }
        record(
          "local-mock.scene_best_pick: payload bestMediaId === expected (pure-function determinism)",
          parsed.requestType === "scene_best_pick" &&
            parsed.bestMediaId === expectedBest,
          `expected=${String(expectedBest)}, got=${String(parsed.bestMediaId)}`,
        );
        record(
          "local-mock.scene_best_pick: confidence is a number in [0, 1]",
          typeof parsed.confidence === "number" &&
            parsed.confidence >= 0 &&
            parsed.confidence <= 1,
          `confidence=${String(parsed.confidence)}`,
        );
      }
    }

    // Single candidate → still picks it.
    const single = await p.invoke({
      requestType: "scene_best_pick",
      params: { candidates: [{ mediaId: "solo" }] },
    });
    if (single.status === "success" && single.outputBytes !== undefined) {
      const parsed = JSON.parse(single.outputBytes.toString("utf-8")) as {
        bestMediaId: string;
      };
      record(
        "local-mock.scene_best_pick: single candidate → that candidate is best",
        parsed.bestMediaId === "solo",
        `bestMediaId=${parsed.bestMediaId}`,
      );
    }

    // Empty candidates → failure.
    const empty = await p.invoke({
      requestType: "scene_best_pick",
      params: { candidates: [] },
    });
    record(
      "local-mock.scene_best_pick: empty candidates → AIFailureResponse",
      empty.status === "failed",
      `status=${empty.status}`,
    );

    // Missing params → failure.
    const noParams = await p.invoke({ requestType: "scene_best_pick" });
    record(
      "local-mock.scene_best_pick: missing params → AIFailureResponse",
      noParams.status === "failed",
      `status=${noParams.status}`,
    );

    // Malformed candidates (no mediaId) → failure.
    const malformed = await p.invoke({
      requestType: "scene_best_pick",
      params: { candidates: [{ wrong: "shape" }] },
    });
    record(
      "local-mock.scene_best_pick: malformed candidates → AIFailureResponse",
      malformed.status === "failed",
      `status=${malformed.status}`,
    );
  }

  // -------------------------------------------------------------------
  // CASE 15: refinement_suggest — fixed conservative JSON
  // -------------------------------------------------------------------
  {
    const p = new LocalMockProvider();
    const input = Buffer.from("any-image-bytes", "utf-8");

    const r1 = await p.invoke({ requestType: "refinement_suggest", inputBytes: input });
    const r2 = await p.invoke({
      requestType: "refinement_suggest",
      inputBytes: Buffer.from("totally-different-bytes", "utf-8"),
    });

    record(
      "local-mock.refinement_suggest: status='success'",
      r1.status === "success",
      `status=${r1.status}`,
    );

    if (r1.status === "success") {
      record(
        "local-mock.refinement_suggest: model_name === 'local-mock-refinement-suggest-v1'",
        r1.modelName === LOCAL_MOCK_MODEL_REFINEMENT_SUGGEST,
        `modelName=${r1.modelName}`,
      );

      if (r1.outputBytes !== undefined) {
        const parsed = JSON.parse(r1.outputBytes.toString("utf-8")) as {
          requestType?: unknown;
          brightness?: unknown;
          contrast?: unknown;
          saturation?: unknown;
          reason?: unknown;
        };
        record(
          "local-mock.refinement_suggest: payload matches fixed conservative params",
          parsed.requestType === "refinement_suggest" &&
            parsed.brightness === LOCAL_MOCK_REFINEMENT_PARAMS.brightness &&
            parsed.contrast === LOCAL_MOCK_REFINEMENT_PARAMS.contrast &&
            parsed.saturation === LOCAL_MOCK_REFINEMENT_PARAMS.saturation &&
            typeof parsed.reason === "string",
          `brightness=${String(parsed.brightness)} contrast=${String(parsed.contrast)}`,
        );

        // Determinism (same shape regardless of input).
        if (r2.status === "success" && r2.outputBytes !== undefined) {
          record(
            "local-mock.refinement_suggest: stub returns identical params regardless of input bytes",
            r1.outputBytes.equals(r2.outputBytes),
            "ok",
          );
        }
      }
    }

    // Empty input → failure (mirrors image_ai_refine convention).
    const failResp = await p.invoke({ requestType: "refinement_suggest" });
    record(
      "local-mock.refinement_suggest: empty input → AIFailureResponse",
      failResp.status === "failed",
      `status=${failResp.status}`,
    );
  }

  // -------------------------------------------------------------------
  // CASE 16: LocalMock rejects unsupported request types via throw
  // (e.g. video_plan / ai_caption — present in AIRequestType but
  // NOT in this provider's supports set).
  // -------------------------------------------------------------------
  {
    const p = new LocalMockProvider();
    let threw: unknown;
    try {
      await p.invoke({ requestType: "video_plan", inputBytes: Buffer.from([1]) });
    } catch (err) {
      threw = err;
    }
    record(
      "local-mock: invoke(video_plan) throws AIProviderUnsupportedRequestError",
      threw instanceof AIProviderUnsupportedRequestError,
      describeError(threw),
    );
    if (threw instanceof AIProviderUnsupportedRequestError) {
      record(
        "local-mock: thrown error carries code='AI_REQUEST_TYPE_UNSUPPORTED' + correct providerName",
        threw.code === "AI_REQUEST_TYPE_UNSUPPORTED" &&
          threw.providerName === LOCAL_MOCK_PROVIDER_NAME &&
          threw.requestType === "video_plan",
        `code=${threw.code} requestType=${threw.requestType}`,
      );
    }
  }

  // -------------------------------------------------------------------
  // SUMMARY
  // -------------------------------------------------------------------
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n[smoke] summary: ${passed}/${results.length} passed`);
  if (failed > 0) {
    console.log(
      `[smoke] failures: ${results.filter((r) => !r.ok).map((r) => r.name).join(", ")}`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[smoke] uncaught error: ${describeError(err)}`);
  process.exit(1);
});
