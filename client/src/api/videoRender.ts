// Video render API client (P11.T7 — consumes P11.T5 server surface).
//
//   POST /api/trips/:tripId/render
//        body: { planId?, mode?, overwrite? }
//        200:  RenderTripResult
//
// The render endpoint enqueues a `video_render` job and returns
// immediately. The actual ffmpeg work runs on the video-channel
// executor. The client polls `GET /api/jobs/:jobId` to follow
// progress (see hooks/useJobPolling.ts).

export type RenderTripMode = "preview" | "final";
export type RenderTripOutcome = "created" | "reset" | "skipped" | "forced";

export interface RenderTripResult {
  readonly tripId: string;
  readonly planId: string;
  readonly mediaId: string;
  readonly jobId: string;
  readonly mode: RenderTripMode;
  readonly outcome: RenderTripOutcome;
  readonly reason?: string;
}

export interface RenderTripBody {
  readonly planId?: string;
  readonly mode?: RenderTripMode;
  readonly overwrite?: boolean;
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

export async function renderTrip(
  tripId: string,
  body: RenderTripBody = {},
): Promise<RenderTripResult> {
  const res = await fetch(`/api/trips/${encodeURIComponent(tripId)}/render`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res));
  }
  return (await res.json()) as RenderTripResult;
}

/** Compute the canonical `/storage/<logicalPath>` URL for the
 * `edited.mp4` derived file the render worker writes. The
 * worker's convention (P11.T5) is
 * `trips/{tripId}/derived/{firstMediaId}/edited.mp4` — the
 * caller passes the render result's `tripId` + `mediaId`. */
export function editedVideoStorageUrl(args: { tripId: string; mediaId: string }): string {
  return `/storage/trips/${encodeURIComponent(args.tripId)}/derived/${encodeURIComponent(args.mediaId)}/edited.mp4`;
}
