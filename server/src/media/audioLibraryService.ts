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
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat, unlink } from "node:fs/promises";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline as streamPipeline } from "node:stream/promises";
import { URL } from "node:url";

import { findDefaultAudioCandidates, type DefaultAudioCandidate } from "../jobs/audioProcessor.js";
import type { Logger } from "../logger.js";
import { AppError, BadRequestError } from "../errors/AppError.js";
import { ERROR_CODES } from "../errors/errorCodes.js";
import type { JobRepository } from "../jobs/jobRepository.js";
import type { LocalStorageProvider } from "../storage/index.js";
import { resolveUnderRoot } from "../storage/index.js";

import {
  AudioLibraryRepository,
  type AudioLibrarySourceType,
  type AudioLibraryUpsertOutcome,
  type AudioLibraryView,
} from "./audioLibraryRepository.js";

import { EditPlansRepository } from "./editPlansRepository.js";

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

/** P11.T6 — extension whitelist for user uploads + URL imports.
 * Mirrors the system-seed whitelist from `audioProcessor.ts`. The
 * one extra `.aif` / `.aiff` etc. could be added in a future
 * extension; V1 keeps the same closed set across all three source
 * types for consistency. */
const UPLOAD_ALLOWED_EXTENSIONS = new Set(["mp3", "m4a", "aac", "wav", "flac", "ogg", "opus"]);

/** P11.T6 — MIME whitelist (paired with the extension above). When
 * the client supplies an unrecognised MIME but a recognised
 * extension, we accept and rely on ffprobe to verify. When BOTH
 * are unrecognised we reject. */
const UPLOAD_ALLOWED_MIME_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/aac",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/flac",
  "audio/x-flac",
  "audio/ogg",
  "audio/opus",
  "application/ogg",
]);

/** P11.T6 — options bundle the new constructor accepts. The Service
 * gains writability + URL-import capability on top of the P11.T3
 * read-only behaviour. */
export interface AudioLibraryServiceWriteDeps {
  readonly storage: LocalStorageProvider;
  readonly jobRepo: JobRepository;
  readonly editPlansRepo: EditPlansRepository;
  /** Maximum byte size for uploads + URL downloads. Defaults to
   * 50 MB; flowed from `config.audioLibrary.maxUploadBytes`. */
  readonly maxUploadBytes: number;
  /** URL-import wall-clock cap. */
  readonly importTimeoutMs: number;
  /** User-Agent string the URL-import downloader sends. */
  readonly importUserAgent: string;
  /** Optional logger. */
  readonly logger?: Logger;
}

/** P11.T6 — input to `uploadAudio`. The route layer parses the
 * multipart payload (busboy) and hands the Service a buffered
 * representation: a temp file on disk + declared MIME / filename. */
export interface UploadAudioInput {
  /** Absolute path of the staged file on disk (will be moved /
   * copied by the Service to its final location). */
  readonly stagingPath: string;
  /** Bytes the client uploaded. */
  readonly sizeBytes: number;
  /** Filename the client supplied. Untrusted; used only for
   * extension inference + display_name default. */
  readonly originalFilename: string;
  /** MIME the client declared. Untrusted; only one of several
   * inputs that resolve the extension. */
  readonly declaredMimeType: string;
  /** Optional display name override. */
  readonly displayName?: string;
  /** Optional tags override. */
  readonly tags?: string;
}

export interface ImportAudioUrlInput {
  readonly url: string;
  /** Optional display name override. */
  readonly name?: string;
  /** Optional tags override. */
  readonly tags?: string;
}

/** Result shape for `uploadAudio` / `importFromUrl`. */
export interface AudioLibraryWriteResult {
  readonly id: string;
  readonly sourceType: AudioLibrarySourceType;
  readonly displayName: string;
  readonly filePath: string;
  readonly relativePath: string | null;
  readonly mimeType: string | null;
  readonly durationSeconds: number | null;
  readonly sizeBytes: number;
  readonly checksum: string;
}

/** Result shape for `deleteAudio`. */
export interface AudioLibraryDeleteResult {
  readonly id: string;
  readonly deleted: boolean;
  /** Logical path of the file that was removed (when deleted=true). */
  readonly removedFilePath: string | null;
}

export class AudioLibraryService {
  constructor(
    private readonly repo: AudioLibraryRepository,
    /** P11.T6 — optional bundle that unlocks write paths
     * (`uploadAudio` / `importFromUrl` / `deleteAudio`). When
     * omitted the read paths (`listSystemAudio` / `findById` /
     * `listAllActive` / `seedDefaultDirectory`) still work, but
     * any write method throws a programmer-friendly
     * "not configured" error. */
    private readonly writeDeps?: AudioLibraryServiceWriteDeps,
  ) {}

  /**
   * Read path for the BGM picker. Currently returns active
   * `system` rows only — the new P11.T6 `listAllActive` method
   * surfaces all source types.
   */
  listSystemAudio(): readonly AudioLibraryView[] {
    return this.repo.listActiveBySourceType("system");
  }

  /** P11.T6 — list every active row across all source types. The
   * `GET /api/audio-library` default. */
  listAllActive(): readonly AudioLibraryView[] {
    return this.repo.listAllActive();
  }

  /** P11.T6 — same as `listAllActive` but filtered to one source
   * type. Backs `GET /api/audio-library?sourceType=user`. */
  listActiveBySourceType(sourceType: AudioLibrarySourceType): readonly AudioLibraryView[] {
    return this.repo.listActiveBySourceType(sourceType);
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

  // ---------------------------------------------------------------------------
  // P11.T6 — user-facing write paths (upload / URL import / delete)
  // ---------------------------------------------------------------------------

  /**
   * Register a user-uploaded audio file. The route layer parses the
   * multipart payload (busboy) and hands the Service a staged file
   * on disk + the declared filename / MIME / size; this method
   * validates, hashes, ffprobes (best-effort), copies into the
   * audio_library storage tree, and writes the audio_library row.
   *
   * Throws:
   *   * `AppError(AUDIO_EMPTY, 400)` — empty payload
   *   * `AppError(AUDIO_TOO_LARGE, 400)` — exceeds maxUploadBytes
   *   * `AppError(AUDIO_UNSUPPORTED_FORMAT, 400)` — both extension
   *     and declared MIME outside the allowlist
   *   * `Error("audio library write not configured")` — Service
   *     constructed without writeDeps (programmer error)
   *
   * Idempotency: per-file checksum is the primary dedup key. A
   * second upload of identical bytes (same source_type='user')
   * UPSERTs into the same row + overwrites the on-disk file in
   * place — operator-edited surface (display_name / tags) is
   * preserved.
   */
  async uploadAudio(input: UploadAudioInput): Promise<AudioLibraryWriteResult> {
    const deps = this.requireWriteDeps("uploadAudio");

    // ---- Validation ---------------------------------------------------
    if (input.sizeBytes <= 0) {
      throw new AppError(ERROR_CODES.AUDIO_EMPTY, "Uploaded audio file is empty", {
        statusCode: 400,
      });
    }
    if (input.sizeBytes > deps.maxUploadBytes) {
      throw new AppError(
        ERROR_CODES.AUDIO_TOO_LARGE,
        `Uploaded audio (${input.sizeBytes} bytes) exceeds the limit of ${deps.maxUploadBytes} bytes`,
        { statusCode: 400, details: { sizeBytes: input.sizeBytes, limit: deps.maxUploadBytes } },
      );
    }
    const inferredExt = inferAudioExtension(input.originalFilename, input.declaredMimeType);
    if (inferredExt === null) {
      throw new AppError(
        ERROR_CODES.AUDIO_UNSUPPORTED_FORMAT,
        `Unsupported audio format. Allowed extensions: ${[...UPLOAD_ALLOWED_EXTENSIONS].join(", ")}`,
        {
          statusCode: 400,
          details: {
            filename: input.originalFilename,
            declaredMimeType: input.declaredMimeType,
          },
        },
      );
    }

    // ---- Hash + ffprobe (best-effort) --------------------------------
    const checksum = await sha256OfFile(input.stagingPath);
    const probed = await probeAudio(input.stagingPath, "ffprobe").catch((err: unknown) => {
      deps.logger?.warn(
        { filename: input.originalFilename, err: err instanceof Error ? err.message : String(err) },
        "audioLibrary.uploadAudio: ffprobe failed; degrading to duration=null",
      );
      return { durationSeconds: null };
    });

    // ---- Persist on disk + DB ----------------------------------------
    const audioId = randomUUID();
    const stored = await deps.storage.putAudioLibraryFile({
      subdir: "user",
      audioId,
      extension: inferredExt,
      data: await readFile(input.stagingPath),
      overwrite: false,
    });

    const displayName =
      input.displayName !== undefined && input.displayName.length > 0
        ? input.displayName
        : path.basename(input.originalFilename, path.extname(input.originalFilename)) ||
          "Untitled audio";
    const slug = slugify(displayName);
    const mime = UPLOAD_ALLOWED_MIME_TYPES.has(input.declaredMimeType.toLowerCase())
      ? input.declaredMimeType.toLowerCase()
      : (AUDIO_MIME_BY_EXT[inferredExt] ?? "application/octet-stream");

    const nowIso = new Date().toISOString();
    const upsert = this.repo.upsertBySourceTypeAndChecksum({
      id: audioId,
      name: slug,
      displayName,
      sourceType: "user",
      filePath: resolveUnderRoot(deps.storage.root, stored.logicalPath),
      relativePath: stored.logicalPath,
      mimeType: mime,
      durationSeconds: probed.durationSeconds,
      sizeBytes: input.sizeBytes,
      checksum,
      isActive: true,
      ...(input.tags !== undefined ? { tags: input.tags } : { tags: null }),
      metadataJson: JSON.stringify({
        uploadedAt: nowIso,
        originalFilename: input.originalFilename,
        declaredMimeType: input.declaredMimeType,
      }),
      now: nowIso,
    });

    // If the file's checksum already existed and the UPSERT hit an
    // existing row, the new file on disk is redundant — the
    // existing row's `file_path` already points at the prior copy.
    // We removed `overwrite=false` above to be defensive against
    // a future caller resubmitting; for the dedup case the new
    // file just becomes a second copy under a different audioId
    // filename. V1 accepts this small disk overhead in exchange
    // for atomic write semantics; a future cleanup job can dedupe.
    if (upsert.outcome !== "inserted") {
      // Best-effort remove of the just-written redundant file.
      deps.storage.remove(stored.logicalPath).catch(() => {
        /* best-effort cleanup; not critical */
      });
    }

    const finalRow = this.repo.findById(upsert.id)!;
    deps.logger?.info(
      {
        audioId: finalRow.id,
        sourceType: finalRow.sourceType,
        outcome: upsert.outcome,
        sizeBytes: finalRow.sizeBytes,
        durationSeconds: finalRow.durationSeconds,
      },
      "audioLibrary.uploadAudio: row written",
    );
    return {
      id: finalRow.id,
      sourceType: finalRow.sourceType,
      displayName: finalRow.displayName,
      filePath: finalRow.filePath,
      relativePath: finalRow.relativePath,
      mimeType: finalRow.mimeType,
      durationSeconds: finalRow.durationSeconds,
      sizeBytes: finalRow.sizeBytes,
      checksum: finalRow.checksum,
    };
  }

  /**
   * Download an audio file from a user-supplied URL and register
   * it. The downloader enforces:
   *   * Protocol allowlist (http / https only).
   *   * Hostname → IP resolved via `dns.lookup`; private / loopback
   *     / link-local / multicast / CGNAT IPs rejected (SSRF guard
   *     for R-139).
   *   * `lookup` option pinned to the validated IP, so the actual
   *     TCP connection cannot land on a different (un-validated)
   *     IP — narrows the DNS-rebinding window.
   *   * Response status must be 200.
   *   * `Content-Length` (when present) must be ≤ `maxUploadBytes`.
   *   * Streaming size counter aborts mid-download if the body
   *     exceeds `maxUploadBytes` even with no `Content-Length`
   *     header.
   *   * Wall-clock cap from `importTimeoutMs`.
   *   * Content-Type must be in the audio MIME allowlist OR
   *     extension derived from URL must be in the audio extension
   *     allowlist.
   *
   * Throws (all mapped to clear HTTP error codes):
   *   * `AUDIO_IMPORT_FORBIDDEN_URL` (400) — bad URL syntax / non-
   *     http(s) protocol / private IP / DNS lookup failure
   *   * `AUDIO_IMPORT_TOO_LARGE` (400) — exceeds maxUploadBytes
   *   * `AUDIO_UNSUPPORTED_FORMAT` (400) — server returned an
   *     unrecognised audio MIME/extension combo
   *   * `AUDIO_IMPORT_DOWNLOAD_FAILED` (502/400) — non-200 status,
   *     network error, timeout, premature close
   */
  async importFromUrl(input: ImportAudioUrlInput): Promise<AudioLibraryWriteResult> {
    const deps = this.requireWriteDeps("importFromUrl");

    // ---- Parse + validate URL ----------------------------------------
    let parsed: URL;
    try {
      parsed = new URL(input.url);
    } catch {
      throw new AppError(ERROR_CODES.AUDIO_IMPORT_FORBIDDEN_URL, "Invalid URL syntax", {
        statusCode: 400,
        details: { url: input.url },
      });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new AppError(
        ERROR_CODES.AUDIO_IMPORT_FORBIDDEN_URL,
        `Only http:// and https:// URLs are supported (got '${parsed.protocol}')`,
        { statusCode: 400, details: { protocol: parsed.protocol } },
      );
    }
    if (parsed.hostname.length === 0) {
      throw new AppError(ERROR_CODES.AUDIO_IMPORT_FORBIDDEN_URL, "URL has no hostname", {
        statusCode: 400,
      });
    }

    // ---- Resolve hostname → IP + SSRF guard --------------------------
    let lookup: { address: string; family: 4 | 6 };
    try {
      const resolved = await dns.lookup(parsed.hostname);
      lookup = { address: resolved.address, family: resolved.family as 4 | 6 };
    } catch (err) {
      throw new AppError(
        ERROR_CODES.AUDIO_IMPORT_FORBIDDEN_URL,
        `DNS lookup failed for ${parsed.hostname}: ${err instanceof Error ? err.message : String(err)}`,
        { statusCode: 400, details: { hostname: parsed.hostname } },
      );
    }
    if (isBlockedIp(lookup.address)) {
      throw new AppError(
        ERROR_CODES.AUDIO_IMPORT_FORBIDDEN_URL,
        `Resolved IP ${lookup.address} is in a blocked range (private / loopback / link-local / multicast)`,
        { statusCode: 400, details: { hostname: parsed.hostname, resolvedIp: lookup.address } },
      );
    }

    // ---- Stage download to a tmp file --------------------------------
    const tmpDir = await mkdtemp(path.join(tmpdir(), "tas-audio-import-"));
    const tmpPath = path.join(tmpDir, "download.bin");
    try {
      const downloadResult = await downloadToFile({
        parsedUrl: parsed,
        lookup,
        tmpPath,
        maxBytes: deps.maxUploadBytes,
        timeoutMs: deps.importTimeoutMs,
        userAgent: deps.importUserAgent,
        ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
      });

      // ---- Validate response shape ----------------------------------
      const ext = inferAudioExtension(
        downloadResult.suggestedFilename ?? parsed.pathname,
        downloadResult.contentType,
      );
      if (ext === null) {
        throw new AppError(
          ERROR_CODES.AUDIO_UNSUPPORTED_FORMAT,
          `URL response is not a recognised audio format (Content-Type: '${downloadResult.contentType}')`,
          { statusCode: 400, details: { contentType: downloadResult.contentType, url: input.url } },
        );
      }
      if (downloadResult.sizeBytes <= 0) {
        throw new AppError(ERROR_CODES.AUDIO_EMPTY, "Downloaded audio file is empty", {
          statusCode: 400,
        });
      }

      // ---- Hash + ffprobe (best-effort) -----------------------------
      const checksum = await sha256OfFile(tmpPath);
      const probed = await probeAudio(tmpPath, "ffprobe").catch((err: unknown) => {
        deps.logger?.warn(
          { url: input.url, err: err instanceof Error ? err.message : String(err) },
          "audioLibrary.importFromUrl: ffprobe failed; degrading to duration=null",
        );
        return { durationSeconds: null };
      });

      // ---- Persist on disk + DB ------------------------------------
      const audioId = randomUUID();
      const stored = await deps.storage.putAudioLibraryFile({
        subdir: "imported",
        audioId,
        extension: ext,
        data: await readFile(tmpPath),
        overwrite: false,
      });

      const displayName =
        input.name !== undefined && input.name.length > 0
          ? input.name
          : (downloadResult.suggestedFilename !== undefined &&
            downloadResult.suggestedFilename.length > 0
              ? path.basename(
                  downloadResult.suggestedFilename,
                  path.extname(downloadResult.suggestedFilename),
                )
              : path.basename(
                  parsed.pathname || `audio-${audioId}`,
                  path.extname(parsed.pathname),
                )) || `Imported audio`;
      const slug = slugify(displayName);
      const mime = UPLOAD_ALLOWED_MIME_TYPES.has(downloadResult.contentType.toLowerCase())
        ? downloadResult.contentType.toLowerCase()
        : (AUDIO_MIME_BY_EXT[ext] ?? "application/octet-stream");

      const nowIso = new Date().toISOString();
      const upsert = this.repo.upsertBySourceTypeAndChecksum({
        id: audioId,
        name: slug,
        displayName,
        sourceType: "url_import",
        filePath: resolveUnderRoot(deps.storage.root, stored.logicalPath),
        relativePath: stored.logicalPath,
        mimeType: mime,
        durationSeconds: probed.durationSeconds,
        sizeBytes: downloadResult.sizeBytes,
        checksum,
        isActive: true,
        ...(input.tags !== undefined ? { tags: input.tags } : { tags: null }),
        metadataJson: JSON.stringify({
          importedAt: nowIso,
          sourceUrl: input.url,
          resolvedIp: lookup.address,
          contentType: downloadResult.contentType,
        }),
        now: nowIso,
      });

      if (upsert.outcome !== "inserted") {
        deps.storage.remove(stored.logicalPath).catch(() => {
          /* best-effort cleanup */
        });
      }

      const finalRow = this.repo.findById(upsert.id)!;
      deps.logger?.info(
        {
          audioId: finalRow.id,
          sourceType: finalRow.sourceType,
          url: input.url,
          outcome: upsert.outcome,
          sizeBytes: finalRow.sizeBytes,
          durationSeconds: finalRow.durationSeconds,
        },
        "audioLibrary.importFromUrl: row written",
      );
      return {
        id: finalRow.id,
        sourceType: finalRow.sourceType,
        displayName: finalRow.displayName,
        filePath: finalRow.filePath,
        relativePath: finalRow.relativePath,
        mimeType: finalRow.mimeType,
        durationSeconds: finalRow.durationSeconds,
        sizeBytes: finalRow.sizeBytes,
        checksum: finalRow.checksum,
      };
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Delete one audio_library row + its on-disk file.
   *
   * Throws:
   *   * `BadRequestError` — id is unknown / missing
   *   * `AppError(AUDIO_SYSTEM_NOT_DELETABLE, 403)` — system rows
   *     are operator-curated bundles that the user-facing API
   *     refuses to remove. A future admin path may relax this.
   *   * `AppError(AUDIO_IN_USE, 409)` — at least one pending /
   *     running `video_render` job has a plan whose audioPolicy
   *     references this audioId. The render would fail mid-way
   *     when the audio file disappeared; we refuse the delete so
   *     the user picks a different audio or cancels the render
   *     first.
   *
   * Order of operations (best-effort consistency):
   *   1. Find the row (404-ish: BadRequestError if missing).
   *   2. Refuse if source_type='system'.
   *   3. Refuse if referenced by an in-progress render job.
   *   4. Delete the on-disk file (best-effort; not a hard fail
   *      if the file already disappeared — the DB row is still
   *      removed).
   *   5. DELETE the DB row.
   *
   * Step 4 happens BEFORE step 5 so a failed file removal can be
   * surfaced before the DB write commits (mid-step failure leaves
   * an orphan row pointing at a missing file, which is recoverable
   * — vs the reverse leaving an orphan file with no DB record,
   * which the seed runner / cleanup job can't easily reclaim).
   * However: the row's `relative_path` is captured BEFORE step 4
   * so the file removal targets the original path even if the
   * row somehow mutated mid-flight.
   */
  async deleteAudio(id: string): Promise<AudioLibraryDeleteResult> {
    const deps = this.requireWriteDeps("deleteAudio");

    const row = this.repo.findById(id);
    if (row === null) {
      throw new BadRequestError(`Audio not found: ${id}`, { id });
    }
    if (row.sourceType === "system") {
      throw new AppError(
        ERROR_CODES.AUDIO_SYSTEM_NOT_DELETABLE,
        `System-curated audio (${row.displayName}) cannot be deleted via this API`,
        { statusCode: 403, details: { id, sourceType: row.sourceType } },
      );
    }

    // ---- In-use check ------------------------------------------------
    // Walk pending + running video_render jobs for THIS audio id.
    // We don't have an efficient index for "audio referenced by
    // render job", so we scan recent jobs by job_type + status and
    // parse their payload. Reasonable for V1 because the pending
    // queue is bounded by the JobQueue concurrency model + retry
    // policy (typically <10 rows at any moment in normal ops).
    const inFlightJobs = deps.jobRepo.findActiveByType("video_render");
    for (const job of inFlightJobs) {
      let payload: { planId?: string } | null = null;
      try {
        payload = job.payload !== null ? (JSON.parse(job.payload) as { planId?: string }) : null;
      } catch {
        continue;
      }
      const planId = payload?.planId;
      if (typeof planId !== "string" || planId.length === 0) continue;
      const planRow = deps.editPlansRepo.findById(planId);
      if (planRow === null) continue;
      try {
        const plan = JSON.parse(planRow.planJson) as {
          audioPolicy?: { backgroundAudioId?: string | null };
        };
        if (plan.audioPolicy?.backgroundAudioId === id) {
          throw new AppError(
            ERROR_CODES.AUDIO_IN_USE,
            `Audio is referenced by an in-progress render (jobId=${job.id})`,
            {
              statusCode: 409,
              details: { id, jobId: job.id, status: job.status, planId },
            },
          );
        }
      } catch (err) {
        // A corrupt plan_json shouldn't block a delete — fall
        // through. Re-throw if it was OUR own AppError.
        if (err instanceof AppError) throw err;
      }
    }

    // ---- File removal + DB delete -----------------------------------
    let removedFilePath: string | null = null;
    if (row.relativePath !== null) {
      try {
        const result = await deps.storage.remove(row.relativePath);
        removedFilePath = result.removed ? row.relativePath : null;
      } catch (err) {
        deps.logger?.warn(
          {
            id,
            relativePath: row.relativePath,
            err: err instanceof Error ? err.message : String(err),
          },
          "audioLibrary.deleteAudio: storage.remove failed; proceeding with DB delete",
        );
      }
    } else {
      // No relative_path means the file lives outside the storage
      // root (e.g. a `url_import` row whose file_path is absolute
      // outside the root — shouldn't happen in V1 but defensive).
      // Try fs.unlink with the absolute path.
      try {
        await unlink(row.filePath);
        removedFilePath = row.filePath;
      } catch (err) {
        deps.logger?.warn(
          { id, filePath: row.filePath, err: err instanceof Error ? err.message : String(err) },
          "audioLibrary.deleteAudio: fs.unlink failed; proceeding with DB delete",
        );
      }
    }

    const dbChanges = this.repo.deleteById(id);
    deps.logger?.info(
      { id, sourceType: row.sourceType, removedFilePath, dbChanges },
      "audioLibrary.deleteAudio: completed",
    );
    return { id, deleted: dbChanges === 1, removedFilePath };
  }

  // ---------------------------------------------------------------------------
  // private helpers
  // ---------------------------------------------------------------------------

  private requireWriteDeps(opLabel: string): AudioLibraryServiceWriteDeps {
    if (this.writeDeps === undefined) {
      throw new Error(
        `AudioLibraryService.${opLabel} called without writeDeps; service not fully wired`,
      );
    }
    return this.writeDeps;
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

// ---------------------------------------------------------------------------
// P11.T6 — upload / URL-import helpers
// ---------------------------------------------------------------------------

/** Infer the canonical lowercased audio extension for a file. Tries
 * (1) the original filename's extname, (2) the URL pathname's
 * extname, (3) the declared MIME's well-known mapping. Returns
 * null when none of those produce a value in the closed audio
 * extension allowlist. */
function inferAudioExtension(filenameOrUrlPath: string, declaredMime: string): string | null {
  const fromFile = path.extname(filenameOrUrlPath).slice(1).toLowerCase();
  if (UPLOAD_ALLOWED_EXTENSIONS.has(fromFile)) return fromFile;

  // Map MIME → ext (the inverse of AUDIO_MIME_BY_EXT, with some
  // common aliases the wild-internet uses).
  const mimeLc = declaredMime.toLowerCase();
  const MIME_TO_EXT: Readonly<Record<string, string>> = {
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/m4a": "m4a",
    "audio/x-m4a": "m4a",
    "audio/aac": "aac",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "audio/flac": "flac",
    "audio/x-flac": "flac",
    "audio/ogg": "ogg",
    "audio/opus": "opus",
    "application/ogg": "ogg",
  };
  const fromMime = MIME_TO_EXT[mimeLc];
  if (fromMime !== undefined && UPLOAD_ALLOWED_EXTENSIONS.has(fromMime)) return fromMime;

  return null;
}

/** SSRF guard. Returns true when the IP literal falls in a range
 * we refuse to fetch from (private / loopback / link-local /
 * multicast / CGNAT / IPv6 equivalents). The match list is
 * deliberately conservative — false positives just mean "won't
 * import"; false negatives mean SSRF success which is far worse. */
function isBlockedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  return true; // not a valid IP — block (defensive)
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return true;
  const [a, b] = parts as [number, number, number, number];
  // 0.0.0.0/8 "this network"
  if (a === 0) return true;
  // 10.0.0.0/8 private
  if (a === 10) return true;
  // 127.0.0.0/8 loopback
  if (a === 127) return true;
  // 169.254.0.0/16 link-local (AWS metadata: 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 private
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 private
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10 CGNAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 224.0.0.0/4 multicast
  if (a >= 224 && a <= 239) return true;
  // 240.0.0.0/4 reserved
  if (a >= 240) return true;
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const lc = ip.toLowerCase();
  // Loopback
  if (lc === "::1") return true;
  // Unspecified
  if (lc === "::") return true;
  // Link-local fe80::/10
  if (
    lc.startsWith("fe8") ||
    lc.startsWith("fe9") ||
    lc.startsWith("fea") ||
    lc.startsWith("feb")
  ) {
    return true;
  }
  // Unique local fc00::/7
  if (lc.startsWith("fc") || lc.startsWith("fd")) return true;
  // Multicast ff00::/8
  if (lc.startsWith("ff")) return true;
  // IPv4-mapped: validate the embedded IPv4
  if (lc.startsWith("::ffff:")) {
    const v4 = lc.slice(7);
    if (net.isIPv4(v4)) return isBlockedIpv4(v4);
  }
  return false;
}

interface DownloadArgs {
  readonly parsedUrl: URL;
  readonly lookup: { readonly address: string; readonly family: 4 | 6 };
  readonly tmpPath: string;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly userAgent: string;
  readonly logger?: Logger | undefined;
}

interface DownloadResult {
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly suggestedFilename: string | undefined;
}

/** HTTP/HTTPS GET with the SSRF + size + timeout protections
 * documented on `importFromUrl`. `lookup` is pinned to the
 * already-validated IP so the actual TCP connection cannot fall
 * back to a different un-validated resolution. */
function downloadToFile(args: DownloadArgs): Promise<DownloadResult> {
  return new Promise<DownloadResult>((resolve, reject) => {
    const isHttps = args.parsedUrl.protocol === "https:";
    const requestModule = isHttps ? https : http;
    let bytesReceived = 0;
    let timedOut = false;

    // node:http / node:https `lookup` option accepts the
    // callback-style signature documented at
    // https://nodejs.org/api/dns.html#dnslookuphostname-options-callback.
    // We pin EVERY lookup attempt for this request to the IP we
    // pre-validated against the SSRF guard, regardless of what
    // the hostname now resolves to. This is the DNS-rebinding
    // mitigation.
    const pinnedLookup = (
      _hostname: string,
      _opts: unknown,
      cb: (err: NodeJS.ErrnoException | null, address?: string, family?: number) => void,
    ): void => {
      cb(null, args.lookup.address, args.lookup.family);
    };

    const req = requestModule.request(
      {
        method: "GET",
        hostname: args.parsedUrl.hostname,
        port: args.parsedUrl.port || (isHttps ? 443 : 80),
        path: args.parsedUrl.pathname + args.parsedUrl.search,
        // Pin the lookup so the TCP connection lands on the IP we
        // already validated against the SSRF guard.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        lookup: pinnedLookup as any,
        headers: {
          "User-Agent": args.userAgent,
          Accept: "audio/*",
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(
            new AppError(
              ERROR_CODES.AUDIO_IMPORT_DOWNLOAD_FAILED,
              `URL returned HTTP ${res.statusCode}`,
              { statusCode: 400, details: { statusCode: res.statusCode } },
            ),
          );
          return;
        }
        const contentType = String(res.headers["content-type"] ?? "")
          .split(";")[0]!
          .trim();
        const contentLengthHeader = res.headers["content-length"];
        if (typeof contentLengthHeader === "string") {
          const declared = Number.parseInt(contentLengthHeader, 10);
          if (Number.isFinite(declared) && declared > args.maxBytes) {
            res.resume();
            reject(
              new AppError(
                ERROR_CODES.AUDIO_TOO_LARGE,
                `URL declares Content-Length ${declared} bytes, exceeding limit ${args.maxBytes}`,
                {
                  statusCode: 400,
                  details: { declaredBytes: declared, limit: args.maxBytes },
                },
              ),
            );
            return;
          }
        }
        const contentDisposition = res.headers["content-disposition"];
        const suggestedFilename = parseContentDispositionFilename(contentDisposition);

        // Stream to file with a running size counter.
        const out = createWriteStream(args.tmpPath);
        res.on("data", (chunk: Buffer) => {
          bytesReceived += chunk.length;
          if (bytesReceived > args.maxBytes) {
            // Abort: kill the request, the stream, and surface a
            // clear error. Best-effort cleanup of the tmp file.
            req.destroy();
            res.destroy();
            out.destroy();
            unlink(args.tmpPath).catch(() => {
              /* best-effort */
            });
            reject(
              new AppError(
                ERROR_CODES.AUDIO_TOO_LARGE,
                `URL response exceeded ${args.maxBytes} bytes mid-stream`,
                { statusCode: 400, details: { limit: args.maxBytes } },
              ),
            );
          }
        });
        streamPipeline(res, out)
          .then(() => {
            if (timedOut) return; // already rejected
            resolve({
              sizeBytes: bytesReceived,
              contentType,
              ...(suggestedFilename !== undefined
                ? { suggestedFilename }
                : { suggestedFilename: undefined }),
            });
          })
          .catch((err) => {
            if (timedOut) return;
            // The size-cap branch above already rejected; only
            // reject here for genuine pipeline errors.
            if (!(req.destroyed && bytesReceived > args.maxBytes)) {
              reject(
                new AppError(
                  ERROR_CODES.AUDIO_IMPORT_DOWNLOAD_FAILED,
                  `Download pipeline failed: ${err instanceof Error ? err.message : String(err)}`,
                  { statusCode: 400 },
                ),
              );
            }
          });
      },
    );

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      req.destroy();
      reject(
        new AppError(
          ERROR_CODES.AUDIO_IMPORT_DOWNLOAD_FAILED,
          `Download timed out after ${args.timeoutMs}ms`,
          { statusCode: 400, details: { timeoutMs: args.timeoutMs } },
        ),
      );
    }, args.timeoutMs);

    req.on("error", (err) => {
      clearTimeout(timeoutHandle);
      if (timedOut) return;
      reject(
        new AppError(ERROR_CODES.AUDIO_IMPORT_DOWNLOAD_FAILED, `Network error: ${err.message}`, {
          statusCode: 400,
        }),
      );
    });
    req.on("close", () => clearTimeout(timeoutHandle));
    req.end();
  });
}

/** Extract a filename from a Content-Disposition header (best-
 * effort). Returns undefined when not present / unparseable. */
function parseContentDispositionFilename(value: string | undefined | string[]): string | undefined {
  if (typeof value !== "string") return undefined;
  // RFC 6266: `filename="..."` or `filename*=UTF-8''...`.
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(value);
  if (m === null) return undefined;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1];
  }
}
