// AudioLibraryService — business surface for the audio library
// (P11.T3).
//
// Owns:
//   * `listSystemAudio()` — the BGM picker read path. Active
//     system rows ordered by display_name.
//   * `findById(id)` — single-row lookup, returns null on miss.
//   * `seedDefaultDirectory(dir, options?)` — discover audio files
//     under a directory, compute checksum + best-effort ffprobe
//     metadata, and UPSERT into `audio_library` with source_type
//     = 'system'. Idempotent: re-running produces no duplicates.
//
// Red lines (P11.T3 prompt):
//   * No frontend; no HTTP route surface (P11.T6 territory).
//   * Graceful when the default directory is missing or empty —
//     base features (P11.T1 video_optimize / etc.) must keep
//     working without bundled audio (CLAUDE.md §2.8).
//   * ffprobe not available → per-file degradation, not
//     whole-seed failure. `duration_seconds = null` is acceptable
//     (column is nullable per migration 014); the row still goes
//     in so the operator can fix the missing probe later.
//   * `.gitkeep` and other dotfiles are NEVER inserted (handled
//     by `findDefaultAudioCandidates` upstream).
//   * Files outside the known audio-extension whitelist
//     (`AUDIO_EXTENSIONS` in audioProcessor.ts) are silently
//     skipped — README.txt / image files / etc.
//
// Out of scope (P11.T6 onwards):
//   * User uploads (`source_type='user'`).
//   * URL imports (downloader + SSRF guards).
//   * Deactivating rows whose on-disk file disappeared. Recorded
//     as a known limit (R-145) in progress.md: re-seeding with
//     a missing file does NOT toggle the existing row off; the
//     row is left as-is so historical edit plans that reference
//     it still have a discoverable record. A future cleanup job
//     can mark such rows inactive.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import { findDefaultAudioCandidates, type DefaultAudioCandidate } from "../jobs/audioProcessor.js";
import type { Logger } from "../logger.js";

import {
  AudioLibraryRepository,
  type AudioLibraryUpsertOutcome,
  type AudioLibraryView,
} from "./audioLibraryRepository.js";

/** Closed audio MIME map keyed by lowercased extension. Mirrors
 * the whitelist in `audioProcessor.ts`. Falls back to
 * `application/octet-stream` if the extension is not recognised
 * (the row is still inserted; future P11.T6 may probe more
 * deeply with ffprobe). */
const AUDIO_MIME_BY_EXT: Readonly<Record<string, string>> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  flac: "audio/flac",
  ogg: "audio/ogg",
  opus: "audio/opus",
};

/** Hard cap on the ffprobe spawn — 15s comfortably covers any
 * audio file we'd ever bundle (the longest royalty-free tracks
 * are a few minutes; ffprobe processes them in milliseconds).
 * If a probe stalls past this we drop the metadata and write the
 * row with `duration=null` — the rest of the seed must not block. */
const FFPROBE_TIMEOUT_MS = 15_000;
const MAX_FFPROBE_STDERR_BYTES = 4096;

/**
 * Per-file outcome enum exported alongside the summary.
 *
 * `inserted` / `updated` / `unchanged` mirror the repository's
 * upsert outcomes. `skipped` is reserved for entries the discovery
 * step returned but the runner decided not to write (currently
 * unused — all discovered candidates are upserted — but kept in
 * the type so the smoke can assert on a closed set).
 */
export type AudioLibrarySeedOutcome = AudioLibraryUpsertOutcome | "skipped" | "failed";

export interface AudioLibrarySeedItem {
  readonly filename: string;
  readonly outcome: AudioLibrarySeedOutcome;
  /** Present when `outcome === 'failed'`. */
  readonly error?: string;
  /** Present when `outcome` is 'inserted' / 'updated' / 'unchanged'. */
  readonly id?: string;
}

export interface AudioLibrarySeedSummary {
  /** Directory the runner scanned (logged + smoke-friendly). */
  readonly directory: string;
  /** Whether the directory existed when the runner started. */
  readonly directoryExisted: boolean;
  /** Number of candidates the discovery step returned. */
  readonly scanned: number;
  readonly inserted: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly skipped: number;
  readonly failed: number;
  readonly items: readonly AudioLibrarySeedItem[];
}

export interface SeedDefaultDirectoryOptions {
  /**
   * Path to the `ffprobe` binary (defaults to "ffprobe" — PATH
   * lookup). When ffprobe is genuinely unavailable the runner
   * degrades to `duration=null` rather than failing the whole
   * pass. Smoke tests set this to a known-bad path to exercise
   * the degradation branch.
   */
  readonly ffprobePath?: string;
  /**
   * Override the clock. Default `() => new Date()`. Smokes pin
   * this so timestamps are deterministic.
   */
  readonly now?: () => Date;
  /**
   * Override the UUID factory. Default `randomUUID()`. Smokes
   * pin this so inserted IDs are deterministic / inspectable.
   */
  readonly uuid?: () => string;
  /** Optional logger; one INFO line per inserted/updated row,
   * one WARN per per-file failure. */
  readonly logger?: Logger;
}

import { randomUUID } from "node:crypto";

export class AudioLibraryService {
  constructor(private readonly repo: AudioLibraryRepository) {}

  /**
   * Read path for the BGM picker. Currently returns active
   * `system` rows only — `user` uploads will be surfaced via
   * a separate method once P11.T6 lands.
   */
  listSystemAudio(): readonly AudioLibraryView[] {
    return this.repo.listActiveBySourceType("system");
  }

  /**
   * Read-by-id pass-through. Returns null on miss.
   */
  findById(id: string): AudioLibraryView | null {
    return this.repo.findById(id);
  }

  /**
   * Discover audio files under `dir`, compute checksum +
   * best-effort metadata, and UPSERT each into `audio_library`.
   * Returns a summary the caller / smoke can assert on.
   *
   * Behavioural contract (P11.T3 prompt hard requirements):
   *   1. Missing directory → returns `{ scanned: 0, directoryExisted: false }`.
   *      No throw. No log spam (just a single INFO).
   *   2. Empty directory → `{ scanned: 0, directoryExisted: true }`. Same.
   *   3. `.gitkeep` / dotfiles / non-audio extensions are silently
   *      skipped (filter happens in `findDefaultAudioCandidates`).
   *   4. ffprobe unavailable / per-file probe failure → row is
   *      still written with `duration=null`. The outcome counter
   *      shows `inserted` / `updated`, NOT `failed`. The `failed`
   *      bucket is reserved for genuine write failures (DB
   *      constraint violation, fs.stat ENOENT mid-flight, etc.).
   *   5. Re-running yields the same row IDs (UPSERT by
   *      `(source_type, checksum)`); operator-edited surface
   *      (display_name / tags / metadata_json / is_active) is
   *      preserved.
   */
  async seedDefaultDirectory(
    dir: string,
    options: SeedDefaultDirectoryOptions = {},
  ): Promise<AudioLibrarySeedSummary> {
    const clock = options.now ?? (() => new Date());
    const uuid = options.uuid ?? (() => randomUUID());
    const ffprobePath = options.ffprobePath ?? "ffprobe";
    const logger = options.logger;

    // `findDefaultAudioCandidates` swallows ENOENT and returns
    // []. We separately detect "directory existed" via fs.stat
    // to surface that distinction in the summary (useful for
    // smokes asserting graceful fallback).
    let directoryExisted = true;
    try {
      const dirStat = await stat(dir);
      directoryExisted = dirStat.isDirectory();
    } catch (err) {
      if (isENOENT(err)) {
        directoryExisted = false;
      } else {
        // Permission denied or similar — surface to caller. This
        // is genuinely unexpected on the operator-controlled
        // default directory.
        throw err;
      }
    }

    const candidates = await findDefaultAudioCandidates(dir);
    if (candidates.length === 0) {
      logger?.info(
        { directory: dir, directoryExisted, scanned: 0 },
        "audioLibrary.seedDefaultDirectory: no audio files discovered (graceful fallback)",
      );
      return {
        directory: dir,
        directoryExisted,
        scanned: 0,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        skipped: 0,
        failed: 0,
        items: [],
      };
    }

    const items: AudioLibrarySeedItem[] = [];
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;
    let failed = 0;

    for (const cand of candidates) {
      try {
        const item = await this.seedOneCandidate(cand, {
          ffprobePath,
          nowIso: clock().toISOString(),
          uuid,
          ...(logger !== undefined ? { logger } : {}),
        });
        items.push(item);
        switch (item.outcome) {
          case "inserted":
            inserted += 1;
            break;
          case "updated":
            updated += 1;
            break;
          case "unchanged":
            unchanged += 1;
            break;
          case "skipped":
            skipped += 1;
            break;
          case "failed":
            failed += 1;
            break;
        }
      } catch (err) {
        // Last-resort net for an unexpected throw inside
        // `seedOneCandidate` — keep the rest of the seed
        // running. Per-file failure must NOT cascade.
        const errMsg = err instanceof Error ? err.message : String(err);
        items.push({ filename: cand.filename, outcome: "failed", error: errMsg });
        failed += 1;
        logger?.warn(
          { filename: cand.filename, err: errMsg },
          "audioLibrary.seedDefaultDirectory: per-file failure (continuing)",
        );
      }
    }

    return {
      directory: dir,
      directoryExisted,
      scanned: candidates.length,
      inserted,
      updated,
      unchanged,
      skipped,
      failed,
      items,
    };
  }

  // -------------------------------------------------------------------------
  // private
  // -------------------------------------------------------------------------

  private async seedOneCandidate(
    cand: DefaultAudioCandidate,
    ctx: {
      readonly ffprobePath: string;
      readonly nowIso: string;
      readonly uuid: () => string;
      readonly logger?: Logger;
    },
  ): Promise<AudioLibrarySeedItem> {
    // Independent of ffprobe — we always need size + checksum
    // because the UPSERT key (source_type, checksum) needs them.
    let size: number;
    try {
      const fileStat = await stat(cand.absolutePath);
      size = fileStat.size;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { filename: cand.filename, outcome: "failed", error: `stat: ${msg}` };
    }

    let checksum: string;
    try {
      checksum = await sha256OfFile(cand.absolutePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { filename: cand.filename, outcome: "failed", error: `checksum: ${msg}` };
    }

    // ffprobe is best-effort — failure here degrades to
    // duration=null but doesn't abort the seed for this file.
    const probe = await probeAudio(cand.absolutePath, ctx.ffprobePath).catch((err: unknown) => {
      ctx.logger?.warn(
        { filename: cand.filename, err: err instanceof Error ? err.message : String(err) },
        "audioLibrary.seedDefaultDirectory: ffprobe failed; degrading to duration=null",
      );
      return { durationSeconds: null };
    });

    const mime = AUDIO_MIME_BY_EXT[cand.extension] ?? "application/octet-stream";
    const baseName = path.basename(cand.filename, path.extname(cand.filename));
    // `name` is the slugified handle — lowercase + alphanumeric +
    // dashes only. `displayName` keeps the original casing for UI.
    const slug = slugify(baseName);

    const upsert = this.repo.upsertBySourceTypeAndChecksum({
      id: ctx.uuid(),
      name: slug,
      displayName: baseName,
      sourceType: "system",
      filePath: cand.absolutePath,
      relativePath: null, // bundled assets live OUTSIDE the storage root; relative_path stays NULL
      mimeType: mime,
      durationSeconds: probe.durationSeconds,
      sizeBytes: size,
      checksum,
      isActive: true,
      tags: null,
      metadataJson: JSON.stringify({
        seededFromDirectory: path.dirname(cand.absolutePath),
        originalFilename: cand.filename,
        extension: cand.extension,
      }),
      now: ctx.nowIso,
    });

    ctx.logger?.info(
      {
        filename: cand.filename,
        id: upsert.id,
        outcome: upsert.outcome,
        durationSeconds: probe.durationSeconds,
        sizeBytes: size,
        mimeType: mime,
      },
      "audioLibrary.seedDefaultDirectory: upserted system audio row",
    );

    return {
      filename: cand.filename,
      outcome: upsert.outcome,
      id: upsert.id,
    };
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/** Compute SHA256 of a file via streaming read — handles files of
 * arbitrary size without holding them in memory. */
async function sha256OfFile(absolutePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(absolutePath);
    stream.on("error", reject);
    stream.on("data", (chunk: string | Buffer) => {
      hash.update(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    stream.on("end", () => {
      resolve(hash.digest("hex"));
    });
  });
}

interface ProbeAudioResult {
  readonly durationSeconds: number | null;
}

/**
 * Spawn `ffprobe -v error -print_format json -show_format -show_streams <abs>`.
 * Returns the duration from `format.duration` (string in seconds).
 *
 * Failure modes that BUBBLE (the caller's `.catch` degrades them
 * to `duration=null`):
 *   * spawn error (binary missing) → rejected with the message
 *   * non-zero exit → rejected with trimmed stderr
 *   * timeout (15s) → SIGKILL + rejected
 *   * non-JSON output → rejected
 *
 * Failure modes that quietly degrade WITHIN this function:
 *   * JSON parsed OK but `format.duration` absent / unparseable →
 *     returns `{ durationSeconds: null }` (the row still gets a
 *     valid mime / size / checksum)
 */
async function probeAudio(absolutePath: string, ffprobePath: string): Promise<ProbeAudioResult> {
  const args = [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    absolutePath,
  ];
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  return new Promise<ProbeAudioResult>((resolve, reject) => {
    let killed = false;
    const child = spawn(ffprobePath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeoutHandle = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, FFPROBE_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.once("error", (err) => {
      clearTimeout(timeoutHandle);
      reject(new Error(`ffprobe spawn failed (audio-library): ${err.message}`));
    });

    child.once("close", (code) => {
      clearTimeout(timeoutHandle);
      if (killed) {
        reject(new Error(`ffprobe timed out after ${FFPROBE_TIMEOUT_MS}ms (audio-library)`));
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks)
          .toString("utf8")
          .slice(0, MAX_FFPROBE_STDERR_BYTES);
        reject(
          new Error(`ffprobe exited ${code} (audio-library): ${stderr.trim() || "(no stderr)"}`),
        );
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(stdoutChunks).toString("utf8")) as {
          format?: { duration?: string };
        };
        const durStr = parsed.format?.duration;
        if (typeof durStr !== "string") {
          resolve({ durationSeconds: null });
          return;
        }
        const dur = Number.parseFloat(durStr);
        resolve({
          durationSeconds: Number.isFinite(dur) && dur >= 0 ? dur : null,
        });
      } catch (err) {
        reject(
          new Error(
            `ffprobe output not parseable (audio-library): ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    });
  });
}

/** ASCII / lowercased / dash-joined slug for the `name` column.
 * Conservative: anything outside [a-z0-9] becomes a dash; runs of
 * dashes collapse; leading/trailing dashes are stripped. Empty
 * inputs map to `"audio"` so the CHECK constraint is satisfied. */
function slugify(input: string): string {
  const lowered = input.toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9]+/g, "-");
  const trimmed = replaced.replace(/^-+|-+$/g, "");
  return trimmed.length === 0 ? "audio" : trimmed;
}

function isENOENT(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
}
