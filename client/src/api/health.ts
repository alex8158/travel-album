// Health API client (P10.T6 — first client-side use of /api/health).
//
// Mirrors the server's `GET /api/health` shape (server/src/routes/
// health.ts). Used by the P10.T6 UI to know whether to enable the
// "AI Refine" affordance: `capabilities.aiEnabled === false` means
// the server's `AI_ENABLED` config flag is off (CLAUDE.md §2.8 default
// state), so we grey out the button up front instead of letting the
// user click through and discover the 501.
//
// `aiEnabled` is the env-config signal, NOT the runtime provider
// `available` flag — those can diverge when `AI_ENABLED=true` but
// `AI_PROVIDER` points at an unknown id (the factory falls back to
// `NoopProvider`, which has `available=false`, but capabilities
// only reflects the env flag). For the UI gate this is acceptable:
// the misconfigured case still produces a clear 501 banner on
// click; a future health-endpoint extension can plumb the
// provider's `available` flag through (would close R-135 in
// progress.md when it lands).

interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId?: string;
    details?: unknown;
  };
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const envelope = (await res.json()) as ApiErrorEnvelope | null;
    if (envelope?.error?.message) return envelope.error.message;
  } catch {
    // Non-JSON error body; fall through.
  }
  return `HTTP ${res.status}`;
}

/**
 * Capabilities snapshot served by `GET /api/health`. Optional fields
 * are tolerated so an older server can stream a compatible
 * response. The client treats any missing flag as `false` (safer
 * default; matches "feature not advertised → assume off").
 */
export interface HealthCapabilities {
  readonly ffmpegAvailable: boolean;
  readonly ffmpegVersion: string | null;
  readonly ffprobeAvailable: boolean;
  readonly ffprobeVersion: string | null;
  readonly permanentDeleteEnabled: boolean;
  readonly aiEnabled: boolean;
}

export interface HealthStorage {
  readonly available: boolean;
  readonly resolvedRoot: string;
}

export interface HealthResponse {
  readonly status: "ok";
  readonly requestId?: string;
  readonly capabilities: HealthCapabilities;
  readonly storage: HealthStorage;
}

/**
 * Fetch the server's frozen capabilities snapshot.
 *
 * Throws on non-2xx responses (the unified envelope's `error.message`
 * is lifted into `Error.message`). Callers that prefer a "don't
 * block the page on health" stance can swallow the rejection and
 * default capabilities to false / null.
 */
export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const init: RequestInit = { headers: { Accept: "application/json" } };
  if (signal) init.signal = signal;
  const res = await fetch("/api/health", init);
  if (!res.ok) throw new Error(await readErrorMessage(res));
  return (await res.json()) as HealthResponse;
}
