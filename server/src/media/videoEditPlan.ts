// Video Edit Plan — pure types + rule engine (P11.T4).
//
// "Edit plan" is a JSON document describing a future video edit:
// which clips to take from which source media, in what order, at
// what target duration, with which transitions, and with what
// audio policy. This file ONLY produces the plan — it never invokes
// FFmpeg, never writes processing_jobs, never writes media_versions.
// The future P11.T5 render worker is the actual consumer.
//
// Why a separate "plan" abstraction:
//   * The plan is the contract between the rule engine (P11.T4) /
//     future AI refiner (P11.T4+) and the renderer (P11.T5). Splitting
//     them at this boundary lets the renderer evolve without coupling
//     to source-selection logic, and lets the rule engine evolve
//     without touching ffmpeg.
//   * The plan is JSON-serialisable so it can round-trip through DB
//     storage, HTTP responses, manual edits in a future UI (P11.T7),
//     and re-runs without re-decoding any media files.
//
// Pure-function design:
//   * `buildEditPlan` takes already-resolved candidate `MediaItem`s +
//     an already-resolved (or null) `AudioLibraryView` for the BGM.
//     The caller (`VideoEditPlanService`) does the DB lookups; this
//     module is a deterministic transformation.
//   * Tests / smokes can construct inputs in-memory and assert on the
//     output without booting a DB.
//
// Scope per docs/tasks.md P11.T4 — strictly plan generation.
// Explicitly NOT in scope (P11.T5 onwards):
//   * Calling ffmpeg / writing files (P11.T5 render worker).
//   * Writing `processing_jobs` / `media_versions` (P11.T5).
//   * Multi-video composition (P11.T8).
//   * AI plan refinement against real models (the `aiRefinePlan`
//     interface is reserved here but defaults to a no-op pass-through
//     when AI is disabled — V1 default).
//   * Frontend preview (P11.T7).

import type { AudioLibraryView } from "./audioLibraryRepository.js";
import type { MediaItem } from "./mediaTypes.js";

/** Plan schema version. Bump when the JSON shape changes in a
 * breaking way so renderers can refuse incompatible plans. */
export const EDIT_PLAN_VERSION = "1.0";

/** Closed style enum. Maps to a default target duration when the
 * caller doesn't supply `targetDurationSec` explicitly. */
export type EditPlanStyle = "short" | "standard" | "long";

/** Target durations per style (seconds). Tuned for typical
 * social-media playback windows. */
export const EDIT_PLAN_STYLE_TARGETS: Readonly<Record<EditPlanStyle, number>> = {
  short: 15,
  standard: 30,
  long: 60,
};

export const EDIT_PLAN_DEFAULT_STYLE: EditPlanStyle = "standard";

/** Hard floor on individual clip duration. Sub-3s cuts look choppy
 * and are usually a sign the rule engine ran out of source material;
 * we clamp the per-clip cap to this floor so even small trips get
 * watchable clips. */
export const MIN_CLIP_DURATION_SECONDS = 3;

/** Closed aspect ratio enum. Plan metadata only — actual rendering
 * crop / pad happens in P11.T5. */
export type EditPlanAspectRatio = "16:9" | "9:16" | "1:1" | "4:5";
export const EDIT_PLAN_DEFAULT_ASPECT_RATIO: EditPlanAspectRatio = "16:9";

/** Closed resolution enum. Plan metadata only. */
export type EditPlanResolution = "720p" | "1080p" | "4k";
export const EDIT_PLAN_DEFAULT_RESOLUTION: EditPlanResolution = "1080p";

/** Closed transition enum. V1 defaults to `none` — fancier
 * transitions (fade / crossfade / slide) are P11.T5+ render polish. */
export type EditPlanTransitionKind = "none" | "fade" | "crossfade";
export const EDIT_PLAN_DEFAULT_TRANSITION: EditPlanTransitionKind = "none";

/** Audio policy modes that survive into the resolved plan. The
 * input layer accepts a few extra synonyms (e.g. when only a
 * `backgroundAudioId` is provided without an explicit `audioMode`
 * the resolver upgrades to `replace_with_library`), but only these
 * three values land in the plan's `audioPolicy.mode`. */
export type EditPlanAudioMode = "keep_original" | "mute" | "replace_with_library";

/**
 * Resolved audio policy embedded in the plan. The P11.T5 render
 * worker reads this directly and feeds the fields into the P11.T2
 * audio toolkit:
 *   * `keep_original` — pass through the per-clip audio tracks.
 *   * `mute`          — `-an` on the rendered video (no audio stream).
 *   * `replace_with_library` — `prepareBackgroundMusic` +
 *                              `replaceVideoAudio` against
 *                              `backgroundAudioId`.
 *
 * Field-level semantics:
 *   * `backgroundAudioId` — non-null ONLY when mode is
 *     `replace_with_library`. The resolver guarantees the id refers
 *     to an active `audio_library` row at plan-generation time.
 *   * `removeOriginalAudio` — duplicate signal driven by `mode`:
 *     true for `mute` and `replace_with_library`, false for
 *     `keep_original`. Exposed explicitly so the renderer doesn't
 *     have to encode mode → strip logic again.
 *   * `loudnorm` / `fadeInSeconds` / `fadeOutSeconds` / `loopToFit`
 *     — passed straight through to `prepareBackgroundMusic`. Only
 *     meaningful when `mode === 'replace_with_library'`; the
 *     resolver still sets sensible defaults for the other modes so
 *     a future worker that wants to honour them (e.g. fade-in on
 *     keep_original) has consistent data.
 *   * `targetDurationSec` — total runtime the BGM should be
 *     prepared to (matches the plan's top-level `targetDurationSec`).
 *     Stored on the audio policy too so the renderer can call
 *     `prepareBackgroundMusic(target=this)` without re-deriving.
 */
export interface EditPlanAudioPolicy {
  readonly mode: EditPlanAudioMode;
  readonly backgroundAudioId: string | null;
  readonly removeOriginalAudio: boolean;
  readonly loudnorm: boolean;
  readonly fadeInSeconds: number;
  readonly fadeOutSeconds: number;
  readonly loopToFit: boolean;
  readonly targetDurationSec: number;
}

/** One clip in the edit plan's `clips[]` array. Order is meaningful
 * — the renderer concats clips in `order` ASC (which equals array
 * index for plans produced by `buildEditPlan`). */
export interface EditPlanClip {
  readonly mediaId: string;
  /** Logical path of the source media (relative to the storage
   * root). The renderer resolves this against the configured
   * `LocalStorageProvider` root before feeding it to ffmpeg. */
  readonly sourcePath: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly durationSec: number;
  readonly order: number;
  /** Human-readable explanation of why this clip / region was
   * picked. Required (CLAUDE.md §3.8 — recommendations must be
   * explainable). For V1 rule engine the reason is a short
   * descriptor like "first 7s of the source video"; AI refiners
   * may produce richer prose. */
  readonly reason: string;
}

/** One transition descriptor between consecutive clips. V1 always
 * emits `none` between every adjacent pair; the array is kept on
 * the plan so future versions can replace individual entries
 * without restructuring the shape. */
export interface EditPlanTransition {
  readonly fromClipOrder: number;
  readonly toClipOrder: number;
  readonly kind: EditPlanTransitionKind;
  readonly durationSec: number;
}

/** Closed warning code enum. Each code maps to a single condition
 * for stable, language-agnostic UI / log handling. The
 * `message` field carries a human-readable English explanation. */
export type EditPlanWarningCode =
  | "no_video_candidates"
  | "media_not_found"
  | "media_not_video"
  | "media_missing_duration"
  | "media_missing_path"
  | "background_audio_not_found"
  | "background_audio_inactive"
  | "insufficient_source_material"
  | "target_duration_clamped";

export interface EditPlanWarning {
  readonly code: EditPlanWarningCode;
  readonly message: string;
  readonly mediaId?: string;
  readonly audioId?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface VideoEditPlan {
  readonly version: typeof EDIT_PLAN_VERSION;
  /** Optional persistence id. Populated by
   * `VideoEditPlanService.generatePlan` after the plan is written
   * to `edit_plans` (P11.T5). Pure `buildEditPlan` outputs OMIT
   * this field; tests / callers using the rule engine directly
   * keep getting the same shape they did pre-P11.T5. */
  readonly id?: string;
  readonly tripId: string;
  readonly style: EditPlanStyle;
  readonly targetDurationSec: number;
  /** Actual total duration achieved by the clips[]; can be less
   * than `targetDurationSec` when there isn't enough source
   * material (a `insufficient_source_material` warning is also
   * emitted in that case). */
  readonly totalDurationSec: number;
  readonly resolution: EditPlanResolution;
  readonly aspectRatio: EditPlanAspectRatio;
  /** Ordered list of source media ids the plan touches. Same
   * sequence as `clips.map(c => c.mediaId)`, kept as a top-level
   * convenience field so future consumers (e.g. cleanup jobs)
   * don't have to walk the clips array. */
  readonly sourceMediaIds: readonly string[];
  readonly clips: readonly EditPlanClip[];
  readonly transitions: readonly EditPlanTransition[];
  readonly audioPolicy: EditPlanAudioPolicy;
  readonly warnings: readonly EditPlanWarning[];
  readonly createdAt: string;
  /** AI-refined plans flip this to `true` so the P11.T5 renderer
   * can log / surface that the plan was processed by an external
   * model. V1 rule-engine plans always have `false`. */
  readonly aiRefined: boolean;
}

/**
 * Audio policy resolution input. The caller (`VideoEditPlanService`)
 * pre-resolves `backgroundAudio` from `audio_library`; this module
 * just decides which mode to land in and emits any warnings.
 *
 * Note: `requestedMode` is what the caller asked for (or absent
 * means "auto"); the final policy may differ (e.g. when the
 * requested audio id can't be resolved we fall back to
 * `keep_original` + warning).
 */
export interface AudioPolicyResolutionInput {
  readonly requestedMode?: EditPlanAudioMode;
  readonly requestedBackgroundAudioId?: string;
  /** Resolved row from audio_library; null when not found or
   * inactive. */
  readonly backgroundAudio: AudioLibraryView | null;
  readonly targetDurationSec: number;
  /** Defaults from config layer (`config.video.audio.*`). */
  readonly defaults: {
    readonly loudnorm: boolean;
    readonly fadeInSeconds: number;
    readonly fadeOutSeconds: number;
  };
}

export interface AudioPolicyResolutionResult {
  readonly policy: EditPlanAudioPolicy;
  readonly warnings: readonly EditPlanWarning[];
}

/**
 * Resolve the audioPolicy block of an edit plan.
 *
 * The mode-resolution table:
 *
 *   | requested | bgAudio   | resolved mode               | warnings        |
 *   |-----------|-----------|-----------------------------|-----------------|
 *   | undefined | null      | keep_original               | none            |
 *   | undefined | provided  | replace_with_library        | none            |
 *   | mute      | any       | mute                        | none            |
 *   | keep_orig | any       | keep_original               | none            |
 *   | replace_* | null      | keep_original (fallback)    | bg-audio-* code |
 *   | replace_* | provided  | replace_with_library        | none            |
 *
 * The "fallback" branch fires when the caller explicitly asked
 * for `replace_with_library` but the resolved `backgroundAudio`
 * is null (id missing, deactivated, or simply not provided).
 * Per the P11.T4 prompt we degrade gracefully rather than
 * throwing.
 */
export function resolveAudioPolicy(input: AudioPolicyResolutionInput): AudioPolicyResolutionResult {
  const warnings: EditPlanWarning[] = [];
  const inferredMode: EditPlanAudioMode =
    input.requestedMode ??
    (input.requestedBackgroundAudioId !== undefined && input.requestedBackgroundAudioId.length > 0
      ? "replace_with_library"
      : "keep_original");

  // Warn when the user asked for a specific bg audio but it
  // couldn't be resolved. The two warning codes
  // (`background_audio_not_found` and `background_audio_inactive`)
  // are emitted by the caller before getting here based on the
  // findById result; this module only checks that "we have an
  // audio row" if mode is replace_with_library.
  if (inferredMode === "replace_with_library" && input.backgroundAudio === null) {
    if (
      input.requestedBackgroundAudioId !== undefined &&
      input.requestedBackgroundAudioId.length > 0
    ) {
      // The caller's findAudioById returned null OR an inactive row;
      // we don't know which from this layer. The Service layer
      // emits the precise warning (not_found vs inactive); we just
      // fall back here.
    }
    return {
      policy: {
        mode: "keep_original",
        backgroundAudioId: null,
        removeOriginalAudio: false,
        loudnorm: false,
        fadeInSeconds: input.defaults.fadeInSeconds,
        fadeOutSeconds: input.defaults.fadeOutSeconds,
        loopToFit: false,
        targetDurationSec: input.targetDurationSec,
      },
      warnings,
    };
  }

  if (inferredMode === "mute") {
    return {
      policy: {
        mode: "mute",
        backgroundAudioId: null,
        removeOriginalAudio: true,
        loudnorm: false,
        fadeInSeconds: 0,
        fadeOutSeconds: 0,
        loopToFit: false,
        targetDurationSec: input.targetDurationSec,
      },
      warnings,
    };
  }

  if (inferredMode === "replace_with_library") {
    // input.backgroundAudio is guaranteed non-null here (handled
    // the null case above).
    return {
      policy: {
        mode: "replace_with_library",
        backgroundAudioId: input.backgroundAudio!.id,
        removeOriginalAudio: true,
        loudnorm: input.defaults.loudnorm,
        fadeInSeconds: input.defaults.fadeInSeconds,
        fadeOutSeconds: input.defaults.fadeOutSeconds,
        loopToFit: true,
        targetDurationSec: input.targetDurationSec,
      },
      warnings,
    };
  }

  // Default: keep_original
  return {
    policy: {
      mode: "keep_original",
      backgroundAudioId: null,
      removeOriginalAudio: false,
      loudnorm: false,
      fadeInSeconds: input.defaults.fadeInSeconds,
      fadeOutSeconds: input.defaults.fadeOutSeconds,
      loopToFit: false,
      targetDurationSec: input.targetDurationSec,
    },
    warnings,
  };
}

/**
 * Compute the per-clip duration cap: target / N, clamped to
 * `MIN_CLIP_DURATION_SECONDS`. Pure function for unit-testability.
 *
 * Edge cases:
 *   * `numCandidates === 0` returns 0; the caller should detect
 *     this earlier and emit `no_video_candidates`.
 *   * `target / N < MIN_CLIP_DURATION_SECONDS` means we'd be
 *     making sub-3s cuts → return the floor (clips may overflow
 *     the target; the caller truncates the last clip).
 */
export function computePerClipCapSeconds(targetDurationSec: number, numCandidates: number): number {
  if (numCandidates <= 0) return 0;
  const even = targetDurationSec / numCandidates;
  return Math.max(MIN_CLIP_DURATION_SECONDS, even);
}

/** Per-candidate input to `buildEditPlan`. The Service layer
 * pre-filters the trip's media (video-only, non-soft-deleted,
 * `originalPath !== null`, `duration !== null && > 0`) and emits
 * appropriate warnings BEFORE constructing this array; the rule
 * engine assumes the candidates are valid. */
export interface EditPlanCandidate {
  readonly media: MediaItem;
  /** Numeric duration (seconds). Service guarantees `> 0` here. */
  readonly durationSec: number;
}

export interface BuildEditPlanInput {
  readonly tripId: string;
  readonly style: EditPlanStyle;
  readonly targetDurationSec: number;
  readonly aspectRatio: EditPlanAspectRatio;
  readonly resolution: EditPlanResolution;
  readonly candidates: readonly EditPlanCandidate[];
  readonly audioPolicy: EditPlanAudioPolicy;
  /** Warnings already collected by the Service before calling
   * `buildEditPlan` (e.g. media-not-found, background-audio-*).
   * The rule engine appends its own warnings (e.g.
   * `insufficient_source_material`) without losing those. */
  readonly priorWarnings: readonly EditPlanWarning[];
  /** Clock override; default `() => new Date()`. */
  readonly now?: () => Date;
}

/**
 * Build an edit plan from already-resolved inputs. Pure transformation.
 *
 * The clip-selection rule (V1):
 *   1. Compute a per-clip cap: `max(MIN_CLIP_DURATION_SECONDS, target / N)`.
 *   2. For each candidate in array order, take the first
 *      `min(durationSec, perClipCap)` seconds (`startSec=0`).
 *   3. Stop when cumulative duration reaches the target. If the
 *      LAST clip would overshoot, truncate its `endSec` so the
 *      total lands exactly at the target.
 *   4. If the loop exhausts candidates without reaching target,
 *      emit `insufficient_source_material` and leave
 *      `totalDurationSec < targetDurationSec`.
 *
 * Why "first N seconds" rather than middle / end:
 *   * Deterministic + reproducible across runs without per-segment
 *     scoring infrastructure (which is video_segments / P9.T7
 *     territory; a future iteration may upgrade the rule engine
 *     to consume those scores).
 *   * No metadata dependency beyond duration — works even for
 *     videos whose `video_segment_quality` worker hasn't run.
 *   * Mirrors the "preview / pilot frame" intuition: the start of
 *     a clip usually frames the scene best.
 *
 * The `aiRefined` flag is always `false` here; the optional AI
 * refiner (P11.T4 prompt — interface only, no real model) lives
 * in `aiRefinePlan` below.
 */
export function buildEditPlan(input: BuildEditPlanInput): VideoEditPlan {
  const clock = input.now ?? (() => new Date());
  const now = clock().toISOString();
  const warnings: EditPlanWarning[] = [...input.priorWarnings];

  if (input.candidates.length === 0) {
    return {
      version: EDIT_PLAN_VERSION,
      tripId: input.tripId,
      style: input.style,
      targetDurationSec: input.targetDurationSec,
      totalDurationSec: 0,
      resolution: input.resolution,
      aspectRatio: input.aspectRatio,
      sourceMediaIds: [],
      clips: [],
      transitions: [],
      audioPolicy: input.audioPolicy,
      warnings: ensureNoVideoCandidatesWarning(warnings),
      createdAt: now,
      aiRefined: false,
    };
  }

  const perClipCap = computePerClipCapSeconds(input.targetDurationSec, input.candidates.length);

  const clips: EditPlanClip[] = [];
  let cumulative = 0;
  for (let i = 0; i < input.candidates.length; i += 1) {
    const cand = input.candidates[i]!;
    const naturalClipDur = Math.min(cand.durationSec, perClipCap);
    let clipDur = naturalClipDur;
    let reason = `first ${roundTo2(clipDur)}s of source (rule_engine_v1)`;

    if (cumulative + clipDur > input.targetDurationSec) {
      const remaining = input.targetDurationSec - cumulative;
      if (remaining <= 0) {
        // Already at target — don't emit a degenerate 0-duration clip.
        break;
      }
      clipDur = remaining;
      reason = `first ${roundTo2(clipDur)}s of source (truncated to fit target)`;
    }

    clips.push({
      mediaId: cand.media.id,
      sourcePath: cand.media.originalPath ?? "",
      startSec: 0,
      endSec: clipDur,
      durationSec: clipDur,
      order: clips.length,
      reason,
    });
    cumulative += clipDur;
    if (cumulative >= input.targetDurationSec - 1e-6) {
      break;
    }
  }

  // If we didn't reach the target, flag it.
  if (cumulative + 1e-6 < input.targetDurationSec) {
    warnings.push({
      code: "insufficient_source_material",
      message: `Selected clips total ${roundTo2(cumulative)}s, short of the ${roundTo2(input.targetDurationSec)}s target. Consider lowering the target duration or adding more source videos.`,
      details: {
        achievedSec: roundTo2(cumulative),
        targetSec: roundTo2(input.targetDurationSec),
        clipCount: clips.length,
      },
    });
  }

  // V1: every transition is `none`. Emit them anyway so the renderer
  // sees a complete picture and future versions can swap entries.
  const transitions: EditPlanTransition[] = [];
  for (let i = 1; i < clips.length; i += 1) {
    transitions.push({
      fromClipOrder: i - 1,
      toClipOrder: i,
      kind: EDIT_PLAN_DEFAULT_TRANSITION,
      durationSec: 0,
    });
  }

  return {
    version: EDIT_PLAN_VERSION,
    tripId: input.tripId,
    style: input.style,
    targetDurationSec: input.targetDurationSec,
    totalDurationSec: roundTo2(cumulative),
    resolution: input.resolution,
    aspectRatio: input.aspectRatio,
    sourceMediaIds: clips.map((c) => c.mediaId),
    clips,
    transitions,
    audioPolicy: input.audioPolicy,
    warnings,
    createdAt: now,
    aiRefined: false,
  };
}

function ensureNoVideoCandidatesWarning(
  warnings: readonly EditPlanWarning[],
): readonly EditPlanWarning[] {
  if (warnings.some((w) => w.code === "no_video_candidates")) {
    return warnings;
  }
  return [
    ...warnings,
    {
      code: "no_video_candidates",
      message:
        "No video media available for this trip. Upload videos or restore soft-deleted videos before generating an edit plan.",
    },
  ];
}

function roundTo2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// AI refinement — reserved interface (P11.T4)
// ---------------------------------------------------------------------------

export interface AiRefinePlanInput {
  readonly plan: VideoEditPlan;
  /** Free-form context the future AI pass may want; V1 ignores. */
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface AiRefinePlanRefiner {
  /** A future P11.T5+ implementation may swap in a real model.
   * V1 only accepts the noop refiner. */
  readonly refine: (input: AiRefinePlanInput) => Promise<VideoEditPlan>;
}

/** Default refiner — identity pass-through. CLAUDE.md §2.8 spirit:
 * AI is opt-in; the base path must work without any model
 * available. The flag `aiRefined` is intentionally NOT flipped to
 * `true` here so consumers can tell a noop pass from a real refiner
 * run. */
export const noopPlanRefiner: AiRefinePlanRefiner = {
  refine: async (input) => input.plan,
};

/**
 * Optional AI plan refinement step. The Service layer reads
 * `config.video.editPlan.aiEnabled` and routes through either the
 * supplied refiner OR `noopPlanRefiner`. V1 always uses the noop.
 *
 * Keeping the interface here (and not under `ai/`) so the plan
 * domain stays self-contained and refiner implementations import
 * the plan types — not the other way around.
 */
export async function aiRefinePlan(
  input: AiRefinePlanInput,
  refiner: AiRefinePlanRefiner = noopPlanRefiner,
): Promise<VideoEditPlan> {
  return refiner.refine(input);
}
