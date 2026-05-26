// Audio processing toolkit (P11.T2).
//
// Reusable FFmpeg-based audio-processing building blocks shared by
// future workers / API handlers (P11.T4 plan generation, P11.T5
// render, P11.T8 multi-video composition). This module is NOT a
// JobHandler — it has no `processing_jobs` row or `media_versions`
// write side-effects. Callers (future workers) own that integration.
//
// Design constraints (CLAUDE.md §3 + P11.T2 prompt):
//   * Every ffmpeg invocation goes through `spawn(cmd, [...args])`
//     so argv entries are passed verbatim — no shell, no interpolation,
//     no unescaped path injection. Callers pass already-resolved file
//     paths (use `resolveUnderRoot` upstream).
//   * Filter-string construction is centralised in *pure* helpers
//     (`buildAfadeFilter`, `buildAtrimFilter`, `buildLoudnormFilter`)
//     so smoke tests can assert exact argv shape without spawning
//     ffmpeg.
//   * Every async runner enforces a bounded `timeoutMs` (SIGKILL on
//     overrun), bounded `MAX_STDERR_BYTES` log retention, and
//     temp-file behaviour mirroring `videoOptimizeWorker.ts` so the
//     conventions stay uniform across the video / audio pipeline.
//   * `prepareBackgroundMusic` rejects `targetDurationSec <= 0` and
//     non-finite values BEFORE spawning ffmpeg, eliminating any
//     possibility of `-stream_loop -1` without a `-t` cap (the
//     "infinite-loop / runaway encode" failure mode flagged in the
//     P11.T2 prompt).
//   * `findDefaultAudioCandidates` is graceful: missing directory
//     returns `[]`, empty directory returns `[]`, populated
//     directory returns the audio files filtered + sorted. The
//     caller can decide whether "no music available" is an error
//     or a fallback path — base features (P11.T1 optimize) MUST
//     keep working even without bundled music (CLAUDE.md §2.8 spirit).
//
// Scope per docs/tasks.md P11.T2 — strictly the audio-processing
// toolkit. Explicitly NOT in scope (P11.T3 onwards):
//   * `audio_library` SQLite schema / repository (P11.T3).
//   * `POST /api/audio-library/*` API surface (P11.T6).
//   * Edit-plan generation + audioPolicy resolution (P11.T4).
//   * Render / compose orchestration + `media_versions` writes
//     (P11.T5 / P11.T8).
//   * Frontend audio selection UI (P11.T7).
//   * Ducking / vocal preservation / multi-track mixing / AI music
//     selection — out of scope per the prompt's explicit list.

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "../logger.js";

/** Bounded log retention for ffmpeg stderr — same convention as the
 * video workers (videoOptimizeWorker / videoProxyWorker / etc.). */
const MAX_STDERR_BYTES = 4096;

/** EBU R128 reference levels. Reasonable defaults for web playback:
 * `I=-16 LUFS` matches the YouTube / Spotify normalization target,
 * `TP=-1.5 dBTP` keeps headroom for inter-sample peaks, and `LRA=11`
 * is the published "music + speech mixed" loudness range default.
 * Single-pass loudnorm is non-deterministic on the dB scale but
 * good enough for V1; P11.T5 may upgrade to two-pass once a
 * dedicated render worker lands (recorded as a known limit in
 * progress.md R-144). */
export const DEFAULT_AUDIO_LOUDNORM_I = -16;
export const DEFAULT_AUDIO_LOUDNORM_TP = -1.5;
export const DEFAULT_AUDIO_LOUDNORM_LRA = 11;

/** Closed audio-extension whitelist used by `findDefaultAudioCandidates`.
 * Lowercased for case-insensitive matching against on-disk filenames.
 * Mirrors the audio types FFmpeg's libavformat handles natively
 * without external libraries — anything outside this list is silently
 * skipped from discovery (the caller can opt into broader formats by
 * extending the env / config in a future P11.T3 phase). */
const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  "mp3",
  "m4a",
  "aac",
  "wav",
  "flac",
  "ogg",
  "opus",
]);

// ---------------------------------------------------------------------------
// shared settings types
// ---------------------------------------------------------------------------

/**
 * Runtime tunables. Production wiring populates these from
 * `config.video.audio.*`; smokes / unit tests can construct values
 * inline. Mirrors the videoProxyWorker / videoOptimizeWorker pattern.
 */
export interface AudioProcessorSettings {
  /** Path to the `ffmpeg` binary (PATH lookup when "ffmpeg"). */
  readonly ffmpegPath: string;
  /** Wall-clock cap for the ffmpeg child process. */
  readonly timeoutMs: number;
  /** EBU R128 `loudnorm` integrated loudness target (LUFS). */
  readonly loudnormI: number;
  /** EBU R128 `loudnorm` true peak target (dBTP). */
  readonly loudnormTP: number;
  /** EBU R128 `loudnorm` loudness range (LU). */
  readonly loudnormLRA: number;
  /** Default `afade` in-duration (seconds). 0 disables. */
  readonly fadeInSeconds: number;
  /** Default `afade` out-duration (seconds). 0 disables. */
  readonly fadeOutSeconds: number;
  /** Whether loudnorm should be applied by default. Callers can
   * still override per-call via the per-op options. */
  readonly loudnormEnabled: boolean;
}

/** Sensible defaults so the toolkit can be exercised without the
 * full config layer (smoke tests, future CLI). */
export const DEFAULT_AUDIO_PROCESSOR_SETTINGS: AudioProcessorSettings = {
  ffmpegPath: "ffmpeg",
  timeoutMs: 300_000,
  loudnormI: DEFAULT_AUDIO_LOUDNORM_I,
  loudnormTP: DEFAULT_AUDIO_LOUDNORM_TP,
  loudnormLRA: DEFAULT_AUDIO_LOUDNORM_LRA,
  fadeInSeconds: 1.5,
  fadeOutSeconds: 2,
  loudnormEnabled: true,
};

// ---------------------------------------------------------------------------
// pure filter builders (testable without ffmpeg)
// ---------------------------------------------------------------------------

/**
 * Build an `atrim` filter string with optional start / end / duration
 * components.
 *
 * Returns the filter chain `atrim=...,asetpts=PTS-STARTPTS` so the
 * trimmed result starts at PTS=0 (otherwise downstream filters /
 * containers see a non-zero start, which most players handle but
 * some workflows treat as a leading silence).
 *
 * `startSec`, `endSec`, `duration` are all optional and at least one
 * must be present; ffmpeg's `atrim` ignores missing axes. The helper
 * preserves whichever the caller supplies.
 */
export function buildAtrimFilter(opts: {
  readonly startSec?: number;
  readonly endSec?: number;
  readonly duration?: number;
}): string {
  const parts: string[] = [];
  if (opts.startSec !== undefined && Number.isFinite(opts.startSec) && opts.startSec >= 0) {
    parts.push(`start=${opts.startSec}`);
  }
  if (opts.endSec !== undefined && Number.isFinite(opts.endSec) && opts.endSec > 0) {
    parts.push(`end=${opts.endSec}`);
  }
  if (opts.duration !== undefined && Number.isFinite(opts.duration) && opts.duration > 0) {
    parts.push(`duration=${opts.duration}`);
  }
  if (parts.length === 0) {
    throw new Error(
      "buildAtrimFilter: at least one of startSec / endSec / duration must be provided as a positive finite value",
    );
  }
  return `atrim=${parts.join(":")},asetpts=PTS-STARTPTS`;
}

/**
 * Build an `afade` chain (in + out) — returns `null` when both fades
 * are disabled (0 or negative) so the caller can omit the filter
 * link entirely.
 *
 * The fade-out timing depends on knowing the total audio duration:
 * the chain emits `afade=t=out:st={total-outSec}:d={outSec}`. Callers
 * MUST pass a `totalDurationSec` that matches what they will trim /
 * loop to, otherwise the fade out will land on the wrong sample
 * range (no audible damage; just suboptimal).
 *
 * The `in` fade always starts at 0; we don't expose a configurable
 * `st=` offset in V1 because every consumer wants the BGM to fade in
 * from the start of the rendered clip.
 */
export function buildAfadeFilter(opts: {
  readonly inSeconds: number;
  readonly outSeconds: number;
  readonly totalDurationSec: number;
}): string | null {
  if (!Number.isFinite(opts.totalDurationSec) || opts.totalDurationSec <= 0) {
    throw new Error(
      `buildAfadeFilter: totalDurationSec must be a positive finite number (got ${opts.totalDurationSec})`,
    );
  }
  const chain: string[] = [];
  if (Number.isFinite(opts.inSeconds) && opts.inSeconds > 0) {
    chain.push(`afade=t=in:st=0:d=${opts.inSeconds}`);
  }
  if (Number.isFinite(opts.outSeconds) && opts.outSeconds > 0) {
    // Clamp the fade-out start so it never goes negative — happens
    // when totalDurationSec < outSeconds (very short clip + long
    // fade); without clamping ffmpeg accepts it but the curve is
    // degenerate.
    const outStart = Math.max(0, opts.totalDurationSec - opts.outSeconds);
    chain.push(`afade=t=out:st=${outStart}:d=${opts.outSeconds}`);
  }
  return chain.length === 0 ? null : chain.join(",");
}

/**
 * Build a `loudnorm` (single-pass) filter expression. V1 stays on
 * single-pass — two-pass measures the input then re-renders with
 * measured-LUFS targets, which the future P11.T5 render worker may
 * upgrade to once it has the room for two ffmpeg passes per render
 * (the cost is one extra full decode). Single-pass is good enough
 * for "no clipping + roughly even loudness" goals; recorded as
 * R-144 in progress.md.
 */
export function buildLoudnormFilter(opts: {
  readonly I: number;
  readonly TP: number;
  readonly LRA: number;
}): string {
  if (![opts.I, opts.TP, opts.LRA].every((n) => Number.isFinite(n))) {
    throw new Error(
      `buildLoudnormFilter: I/TP/LRA must all be finite numbers (got I=${opts.I}, TP=${opts.TP}, LRA=${opts.LRA})`,
    );
  }
  return `loudnorm=I=${opts.I}:TP=${opts.TP}:LRA=${opts.LRA}`;
}

/**
 * Compose an `-af` filter chain by joining the provided non-null
 * segments with `,`. Returns `null` when every segment is null — the
 * caller should then omit the `-af` flag entirely so ffmpeg copies
 * audio without filtering. Pure helper to keep the spawn-side code
 * simple.
 */
export function joinAfChain(...segments: ReadonlyArray<string | null>): string | null {
  const kept = segments.filter((s): s is string => typeof s === "string" && s.length > 0);
  return kept.length === 0 ? null : kept.join(",");
}

// ---------------------------------------------------------------------------
// async ffmpeg runners
// ---------------------------------------------------------------------------

export interface StripAudioOptions {
  /** Optional override of the wall-clock timeout. */
  readonly timeoutMs?: number;
  /** Optional logger; the runner emits a single INFO line on
   * success. Pass `undefined` to silence. */
  readonly logger?: Logger;
}

/**
 * Strip the audio track from a video. Output preserves video stream
 * via `-c:v copy` (no re-encode → fast + no quality loss) and uses
 * `-an` to drop audio entirely.
 *
 * Use cases:
 *   * Generating a silent video before re-muxing with a new BGM.
 *   * Producing the `mute` variant of an edit plan (P11.T4 audioPolicy
 *     mode='mute').
 *
 * The output file is rewritten via `-y`. Callers should put the
 * output path under `derived/{mediaId}/...` (or a tmp dir if it's
 * an intermediate artefact).
 */
export async function stripAudio(
  inputPath: string,
  outputPath: string,
  settings: AudioProcessorSettings,
  options: StripAudioOptions = {},
): Promise<void> {
  const args = [
    "-v",
    "error",
    "-i",
    inputPath,
    "-c:v",
    "copy",
    "-an",
    "-movflags",
    "+faststart",
    "-y",
    outputPath,
  ];
  const timeoutMs = options.timeoutMs ?? settings.timeoutMs;
  await runFfmpeg(settings.ffmpegPath, args, timeoutMs, "stripAudio");
  options.logger?.info(
    { inputPath, outputPath },
    "audioProcessor.stripAudio: video re-muxed without audio track",
  );
}

export interface TrimAudioOptions {
  readonly startSec?: number;
  readonly endSec?: number;
  readonly duration?: number;
  readonly timeoutMs?: number;
  readonly logger?: Logger;
}

/**
 * Trim an audio file to a sub-range via `atrim`. At least one of
 * (startSec, endSec, duration) must be a positive finite value;
 * `buildAtrimFilter` validates that.
 *
 * Output container / codec is inferred from the output path's
 * extension — ffmpeg picks the matching muxer automatically. For
 * deterministic results, prefer matching the input extension (e.g.
 * trim mp3 → mp3, m4a → m4a). Re-encoding may happen depending on
 * the requested trim points; that's acceptable for an audio-only
 * post-process.
 */
export async function trimAudio(
  inputPath: string,
  outputPath: string,
  settings: AudioProcessorSettings,
  options: TrimAudioOptions,
): Promise<void> {
  // Defensive duplicate of the validation already in `buildAtrimFilter`
  // — gives the caller a clearer error early than a stderr dump.
  const atrim = buildAtrimFilter({
    ...(options.startSec !== undefined ? { startSec: options.startSec } : {}),
    ...(options.endSec !== undefined ? { endSec: options.endSec } : {}),
    ...(options.duration !== undefined ? { duration: options.duration } : {}),
  });
  const args = ["-v", "error", "-i", inputPath, "-af", atrim, "-vn", "-y", outputPath];
  const timeoutMs = options.timeoutMs ?? settings.timeoutMs;
  await runFfmpeg(settings.ffmpegPath, args, timeoutMs, "trimAudio");
  options.logger?.info(
    { inputPath, outputPath, filter: atrim },
    "audioProcessor.trimAudio: ffmpeg atrim succeeded",
  );
}

export interface PrepareBackgroundMusicOptions {
  /** Override the loudnorm enable flag (default: settings.loudnormEnabled). */
  readonly loudnormEnabled?: boolean;
  /** Override the fade-in duration (default: settings.fadeInSeconds). */
  readonly fadeInSeconds?: number;
  /** Override the fade-out duration (default: settings.fadeOutSeconds). */
  readonly fadeOutSeconds?: number;
  /** Wall-clock cap override. */
  readonly timeoutMs?: number;
  /** Optional structured logger. */
  readonly logger?: Logger;
}

/**
 * Produce a background-music track exactly `targetDurationSec` long,
 * starting from `inputMusicPath`. The pipeline:
 *
 *   1. `-stream_loop -1` repeats the input indefinitely; ffmpeg trims
 *      to the requested length via the `-t` cap below. This makes
 *      music shorter than the target loop, and music longer than the
 *      target get hard-trimmed.
 *   2. The audio filter chain applies (in order): `loudnorm` (if
 *      enabled) → `afade` in + out (if non-zero) → output.
 *   3. `-t targetDurationSec` is the HARD CAP on output duration —
 *      this is the single critical guard against infinite-loop /
 *      runaway encodes from a misconfigured `-stream_loop -1`.
 *
 * Invariant: this function REFUSES non-positive / non-finite
 * `targetDurationSec` BEFORE spawning ffmpeg. The `-stream_loop -1`
 * flag has no failsafe of its own — the only thing stopping a
 * runaway encode is the `-t` argument. We validate up front so a
 * coding bug in a future worker can't produce a stuck encode in
 * production.
 */
export async function prepareBackgroundMusic(
  inputMusicPath: string,
  outputPath: string,
  targetDurationSec: number,
  settings: AudioProcessorSettings,
  options: PrepareBackgroundMusicOptions = {},
): Promise<void> {
  if (!Number.isFinite(targetDurationSec) || targetDurationSec <= 0) {
    throw new Error(
      `prepareBackgroundMusic: targetDurationSec must be a positive finite number (got ${targetDurationSec}); rejecting to prevent infinite-loop encode`,
    );
  }
  const loudnormEnabled = options.loudnormEnabled ?? settings.loudnormEnabled;
  const fadeInSeconds = options.fadeInSeconds ?? settings.fadeInSeconds;
  const fadeOutSeconds = options.fadeOutSeconds ?? settings.fadeOutSeconds;

  const loudnormFilter = loudnormEnabled
    ? buildLoudnormFilter({
        I: settings.loudnormI,
        TP: settings.loudnormTP,
        LRA: settings.loudnormLRA,
      })
    : null;
  const fadeFilter = buildAfadeFilter({
    inSeconds: fadeInSeconds,
    outSeconds: fadeOutSeconds,
    totalDurationSec: targetDurationSec,
  });
  const afChain = joinAfChain(loudnormFilter, fadeFilter);

  const args = [
    "-v",
    "error",
    "-stream_loop",
    "-1",
    "-i",
    inputMusicPath,
    "-t",
    String(targetDurationSec),
    ...(afChain !== null ? ["-af", afChain] : []),
    "-vn",
    "-y",
    outputPath,
  ];
  const timeoutMs = options.timeoutMs ?? settings.timeoutMs;
  await runFfmpeg(settings.ffmpegPath, args, timeoutMs, "prepareBackgroundMusic");
  options.logger?.info(
    {
      inputMusicPath,
      outputPath,
      targetDurationSec,
      loudnorm: loudnormFilter,
      fade: fadeFilter,
    },
    "audioProcessor.prepareBackgroundMusic: ffmpeg loop+trim+filter succeeded",
  );
}

export interface ReplaceVideoAudioOptions {
  /** Wall-clock cap override. */
  readonly timeoutMs?: number;
  /** When true the output is hard-clipped to the shorter of the two
   * streams (default behaviour; matches `-shortest`). When false
   * the output runs as long as the video stream regardless of the
   * music length. */
  readonly clipToShortest?: boolean;
  /** Optional structured logger. */
  readonly logger?: Logger;
}

/**
 * Mux video + a new audio track into a single MP4. Video is copied
 * (`-c:v copy` — no re-encode), audio is transcoded to AAC for
 * browser compatibility. `+faststart` keeps the moov atom at the
 * front so the output can be streamed.
 *
 * When `musicPath` is `null` the function delegates to
 * `stripAudio` — the "no audio" case is a useful slot in
 * audioPolicy='mute', and routing through one well-tested branch
 * keeps the failure modes uniform.
 *
 * NOTE: this function does NOT apply loudnorm / fades — the music
 * track passed in should already be loudness-normalised /
 * fade-in/out shaped (via `prepareBackgroundMusic`). Keeping the
 * concerns separate lets callers pre-bake an audio file once and
 * reuse it across multiple video remux operations without repeating
 * the loudnorm pass.
 */
export async function replaceVideoAudio(
  videoPath: string,
  musicPath: string | null,
  outputPath: string,
  settings: AudioProcessorSettings,
  options: ReplaceVideoAudioOptions = {},
): Promise<void> {
  if (musicPath === null) {
    await stripAudio(videoPath, outputPath, settings, {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
    });
    return;
  }
  const clipToShortest = options.clipToShortest ?? true;
  const args = [
    "-v",
    "error",
    "-i",
    videoPath,
    "-i",
    musicPath,
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    ...(clipToShortest ? ["-shortest"] : []),
    "-movflags",
    "+faststart",
    "-y",
    outputPath,
  ];
  const timeoutMs = options.timeoutMs ?? settings.timeoutMs;
  await runFfmpeg(settings.ffmpegPath, args, timeoutMs, "replaceVideoAudio");
  options.logger?.info(
    { videoPath, musicPath, outputPath, clipToShortest },
    "audioProcessor.replaceVideoAudio: video re-muxed with new audio track",
  );
}

// ---------------------------------------------------------------------------
// default audio library discovery
// ---------------------------------------------------------------------------

export interface DefaultAudioCandidate {
  /** Absolute path on disk, ready to feed to ffmpeg `-i`. */
  readonly absolutePath: string;
  /** Filename only (`basename`), for logging / UI labelling. */
  readonly filename: string;
  /** Lowercased extension without the dot. */
  readonly extension: string;
}

/**
 * Discover the bundled default-audio files at `dir`. Designed to be
 * graceful per the P11.T2 prompt:
 *
 *   * Missing directory → returns `[]`. ENOENT is the expected
 *     "developer hasn't dropped any music in yet" state.
 *   * Directory exists but contains no audio files → returns `[]`.
 *   * Directory readable + populated → returns the matching files
 *     sorted alphabetically (deterministic for tests).
 *
 * Any OTHER error (permission denied, symlink loop, EBUSY on the
 * dir) is propagated — those signal infrastructure-level issues the
 * caller / operator should see, not the "no music available"
 * fallback path.
 *
 * Note: this is intentionally a synchronous reader on top of an
 * async filesystem API; it does NOT probe each file for validity.
 * That's the consumer's job (P11.T6 audio-library upload will run
 * the equivalent of `ffprobe` against each upload; the bundled
 * defaults are operator-trusted).
 */
export async function findDefaultAudioCandidates(
  dir: string,
): Promise<readonly DefaultAudioCandidate[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (isENOENT(err)) {
      return [];
    }
    throw err;
  }
  const out: DefaultAudioCandidate[] = [];
  for (const filename of entries) {
    if (filename.startsWith(".")) continue; // ignore dotfiles incl. .gitkeep
    const ext = path.extname(filename).slice(1).toLowerCase();
    if (!AUDIO_EXTENSIONS.has(ext)) continue;
    out.push({
      absolutePath: path.join(dir, filename),
      filename,
      extension: ext,
    });
  }
  out.sort((a, b) => a.filename.localeCompare(b.filename));
  return out;
}

function isENOENT(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
}

// ---------------------------------------------------------------------------
// ffmpeg invocation (shared helper)
// ---------------------------------------------------------------------------

/**
 * Spawn `ffmpeg` with the given argv. Bounded timeout + SIGKILL on
 * overrun. Throws with trimmed stderr on non-zero exit, with the
 * provided `opLabel` (e.g. "stripAudio") in the error message so
 * the caller / operator can tell which audio operation failed
 * from the logs alone.
 *
 * Identical contract to the helpers in `videoProxyWorker.ts` /
 * `videoOptimizeWorker.ts` — kept inline rather than extracted so
 * each worker / utility file stays self-contained (no cross-module
 * dependency for a 20-line helper). The duplicated code is small
 * and stable; the cost of a real abstraction would outweigh the
 * gain at V1.
 */
async function runFfmpeg(
  ffmpegPath: string,
  args: ReadonlyArray<string>,
  timeoutMs: number,
  opLabel: string,
): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `runFfmpeg: timeoutMs must be a positive finite number (got ${timeoutMs}); refusing to spawn ffmpeg without a wall-clock cap`,
    );
  }
  const stderrChunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    let killed = false;
    const child = spawn(ffmpegPath, [...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const timeoutHandle = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.once("error", (err) => {
      clearTimeout(timeoutHandle);
      reject(new Error(`ffmpeg spawn failed (${opLabel}): ${err.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timeoutHandle);
      if (killed) {
        reject(new Error(`ffmpeg ${opLabel} timed out after ${timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").slice(0, MAX_STDERR_BYTES);
        reject(new Error(`ffmpeg ${opLabel} exited ${code}: ${stderr.trim() || "(no stderr)"}`));
        return;
      }
      resolve();
    });
  });
}
