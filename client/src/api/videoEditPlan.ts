// Video edit plan API client (P11.T7 — consumes P11.T4 server
// surface).
//
//   POST /api/trips/:tripId/generate-edit-plan
//        body: GenerateEditPlanBody (all fields optional)
//        200:  VideoEditPlan
//
// The plan shape mirrors server `VideoEditPlan` from
// `server/src/media/videoEditPlan.ts`. We keep field-for-field
// parity by hand (OpenAPI client generation is a later concern).

export type EditPlanStyle = "short" | "standard" | "long";
export type EditPlanAudioMode = "keep_original" | "mute" | "replace_with_library";
export type EditPlanAspectRatio = "16:9" | "9:16" | "1:1" | "4:5";
export type EditPlanResolution = "720p" | "1080p" | "4k";
export type EditPlanTransitionKind = "none" | "fade" | "crossfade";
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

export interface EditPlanClip {
  readonly mediaId: string;
  readonly sourcePath: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly durationSec: number;
  readonly order: number;
  readonly reason: string;
}

export interface EditPlanTransition {
  readonly fromClipOrder: number;
  readonly toClipOrder: number;
  readonly kind: EditPlanTransitionKind;
  readonly durationSec: number;
}

export interface EditPlanWarning {
  readonly code: EditPlanWarningCode;
  readonly message: string;
  readonly mediaId?: string;
  readonly audioId?: string;
  readonly details?: Record<string, unknown>;
}

export interface VideoEditPlan {
  readonly version: string;
  readonly id?: string;
  readonly tripId: string;
  readonly style: EditPlanStyle;
  readonly targetDurationSec: number;
  readonly totalDurationSec: number;
  readonly resolution: EditPlanResolution;
  readonly aspectRatio: EditPlanAspectRatio;
  readonly sourceMediaIds: readonly string[];
  readonly clips: readonly EditPlanClip[];
  readonly transitions: readonly EditPlanTransition[];
  readonly audioPolicy: EditPlanAudioPolicy;
  readonly warnings: readonly EditPlanWarning[];
  readonly createdAt: string;
  readonly aiRefined: boolean;
}

export interface GenerateEditPlanBody {
  readonly targetDurationSec?: number;
  readonly style?: EditPlanStyle;
  readonly mediaIds?: readonly string[];
  readonly audioMode?: EditPlanAudioMode;
  readonly backgroundAudioId?: string;
  readonly aspectRatio?: EditPlanAspectRatio;
  readonly resolution?: EditPlanResolution;
}

interface ApiErrorEnvelope {
  error?: { code?: string; message?: string };
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const envelope = (await res.json()) as ApiErrorEnvelope | null;
    if (envelope?.error?.message) return envelope.error.message;
  } catch {
    /* fall through */
  }
  return `HTTP ${res.status}`;
}

export async function generateEditPlan(
  tripId: string,
  body: GenerateEditPlanBody = {},
  signal?: AbortSignal,
): Promise<VideoEditPlan> {
  const init: RequestInit = {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  if (signal) init.signal = signal;
  const res = await fetch(
    `/api/trips/${encodeURIComponent(tripId)}/generate-edit-plan`,
    init,
  );
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  return (await res.json()) as VideoEditPlan;
}
