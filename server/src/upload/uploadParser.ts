// Multipart upload parser (P2.T4).
//
// Thin wrapper around `busboy` that:
//   1. Streams each multipart file part to a private staging directory
//      under `os.tmpdir()` — never inside `storage/`, so a half-uploaded
//      file cannot leak into the canonical originals tree.
//   2. Captures the first N bytes (default 64, well above every magic
//      pattern in classify/magicNumbers.ts) into an in-memory buffer
//      so File_Classifier can run without a second disk read.
//   3. Enforces `maxFileSize` via busboy's `limits.fileSize`. When a
//      part exceeds the limit busboy emits 'limit' on the file stream
//      and stops feeding data; the parser records `truncated=true` and
//      lets UploadService convert that into a per-file "failed"
//      result.
//   4. Returns a `cleanup()` callback so the caller can always remove
//      the staging directory in a `finally` block.
//
// The parser intentionally accepts a generic `Readable` body rather
// than a `Request` directly, so the smoke test can feed it a synthetic
// multipart body without booting Express.
//
// Pure side-effect of running: writes into `os.tmpdir()/travel-album-
// upload-XXXXXX/`. The directory is removed unconditionally by the
// `cleanup()` callback returned in the result.

import busboy from "busboy";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface StagedFile {
  /** multipart field name (e.g. "files"). */
  readonly fieldName: string;
  /** The filename the client supplied. Untrusted; only used as a hint. */
  readonly originalFilename: string;
  /** The Content-Type the client supplied. Untrusted; only used as a hint. */
  readonly declaredMimeType: string;
  /** Absolute path of the staged file on disk. */
  readonly stagingPath: string;
  /**
   * First ≤ `headBytesTarget` bytes of the file. Empty (length 0) when
   * the file was empty or when the underlying pipeline errored before
   * any data arrived.
   */
  readonly headBytes: Uint8Array;
  /** Number of bytes actually received from the client. */
  readonly size: number;
  /**
   * True iff the part exceeded `maxFileSize` and busboy truncated the
   * stream. UploadService converts this into a per-file failure.
   */
  readonly truncated: boolean;
  /**
   * Set when staging itself failed (e.g. disk full). UploadService
   * converts this into a per-file failure with the original message.
   */
  readonly error?: { readonly code: string; readonly message: string };
}

export interface ParseUploadArgs {
  readonly headers: IncomingHttpHeaders;
  readonly body: Readable;
  readonly maxFileSize: number;
  /** Defaults to 64; classifier magic patterns are all ≤ 12 bytes. */
  readonly headBytesTarget?: number;
}

export interface ParseUploadResult {
  readonly files: readonly StagedFile[];
  readonly stagingDir: string;
  readonly cleanup: () => Promise<void>;
}

const DEFAULT_HEAD_BYTES = 64;

export async function parseUpload(args: ParseUploadArgs): Promise<ParseUploadResult> {
  const headBytesTarget = args.headBytesTarget ?? DEFAULT_HEAD_BYTES;
  const stagingDir = await mkdtemp(join(tmpdir(), "travel-album-upload-"));
  const cleanup = async (): Promise<void> => {
    try {
      await rm(stagingDir, { recursive: true, force: true });
    } catch {
      // best-effort; the OS will reap tmpdir entries eventually.
    }
  };

  try {
    const files = await runBusboy({
      headers: args.headers,
      body: args.body,
      maxFileSize: args.maxFileSize,
      headBytesTarget,
      stagingDir,
    });
    return { files, stagingDir, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

interface RunBusboyArgs {
  readonly headers: IncomingHttpHeaders;
  readonly body: Readable;
  readonly maxFileSize: number;
  readonly headBytesTarget: number;
  readonly stagingDir: string;
}

function runBusboy(args: RunBusboyArgs): Promise<StagedFile[]> {
  return new Promise<StagedFile[]>((resolve, reject) => {
    // busboy accepts a plain headers record; Express' IncomingHttpHeaders
    // satisfies that contract structurally.
    const bb = busboy({
      headers: args.headers as Record<string, string | string[] | undefined>,
      limits: { fileSize: args.maxFileSize },
    });

    const filePromises: Promise<StagedFile>[] = [];
    let parserError: Error | null = null;
    let settled = false;

    const settleReject = (err: unknown): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    bb.on("file", (fieldName, fileStream, info) => {
      filePromises.push(
        stageFile({
          fieldName,
          fileStream,
          originalFilename: info.filename ?? "",
          declaredMimeType: info.mimeType ?? "",
          stagingDir: args.stagingDir,
          headBytesTarget: args.headBytesTarget,
        }),
      );
    });

    bb.on("error", (err: unknown) => {
      parserError = err instanceof Error ? err : new Error(String(err));
    });

    bb.on("close", () => {
      Promise.all(filePromises).then(
        (results) => {
          if (settled) return;
          if (parserError) {
            settled = true;
            reject(parserError);
            return;
          }
          settled = true;
          resolve(results);
        },
        (err) => settleReject(err),
      );
    });

    args.body.on("error", (err) => settleReject(err));
    args.body.pipe(bb);
  });
}

interface StageFileArgs {
  readonly fieldName: string;
  readonly fileStream: Readable;
  readonly originalFilename: string;
  readonly declaredMimeType: string;
  readonly stagingDir: string;
  readonly headBytesTarget: number;
}

async function stageFile(args: StageFileArgs): Promise<StagedFile> {
  const stagingPath = join(args.stagingDir, `${randomUUID()}.bin`);
  const writeStream = createWriteStream(stagingPath);

  const headChunks: Buffer[] = [];
  let headSize = 0;
  let totalSize = 0;
  let truncated = false;

  args.fileStream.on("data", (chunk: Buffer) => {
    if (headSize < args.headBytesTarget) {
      const need = args.headBytesTarget - headSize;
      const slice = chunk.subarray(0, need);
      headChunks.push(slice);
      headSize += slice.length;
    }
    totalSize += chunk.length;
  });

  args.fileStream.on("limit", () => {
    truncated = true;
  });

  try {
    await pipeline(args.fileStream, writeStream);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      fieldName: args.fieldName,
      originalFilename: args.originalFilename,
      declaredMimeType: args.declaredMimeType,
      stagingPath,
      headBytes: new Uint8Array(),
      size: totalSize,
      truncated,
      error: { code: "UPLOAD_STAGING_FAILED", message },
    };
  }

  return {
    fieldName: args.fieldName,
    originalFilename: args.originalFilename,
    declaredMimeType: args.declaredMimeType,
    stagingPath,
    headBytes: new Uint8Array(Buffer.concat(headChunks, headSize)),
    size: totalSize,
    truncated,
  };
}
