// Manual smoke test for Upload_Manager (P2.T4).
//
// Usage: npm run smoke:upload
//
// Builds a private throwaway SQLite DB + LocalStorageProvider rooted
// in a temp directory, instantiates the full UploadService stack with
// real dependencies, and drives every required outcome of the upload
// pipeline using synthetic multipart bodies. Exits 1 if any required
// behaviour fails. Always cleans up.
//
// Coverage (matches the user spec's required points):
//   * Successful image upload (JPEG).
//   * Successful video upload (MP4 ftyp).
//   * Multi-file upload (image + video in the same request) — proves
//     per-file isolation.
//   * Classifier-rejected file (text content with .txt name) → row
//     written with type='unknown', no job, no original file.
//   * Spoofed extension (.jpg with PNG header) → unknown (format-level
//     mismatch caught by the classifier).
//   * Trip not found → NotFoundError thrown (whole-request failure).
//   * Empty multipart payload → BadRequestError thrown.
//   * Zero-byte file → failed with UPLOAD_EMPTY_FILE.
//   * Oversized file → failed with UPLOAD_FILE_TOO_LARGE.
//   * media_items + processing_jobs rows actually inserted (queried
//     directly via sqlite3 prepared statements).
//   * Storage compensation on DB failure: with a poisoned JobRepository
//     the transaction rolls back AND the original file is removed.

import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { classify } from "../classify/index.js";
import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { NotFoundError, BadRequestError } from "../errors/AppError.js";
import { JobRepository } from "../jobs/index.js";
import { createLogger } from "../logger.js";
import { MediaRepository } from "../media/index.js";
import { LocalStorageProvider } from "../storage/index.js";
import { TripRepository, TripService } from "../trips/index.js";
import { UploadService } from "../upload/index.js";
import type { UploadResult } from "../upload/index.js";

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
  // Keep one PASS / FAIL line per case so the npm output is grep-able.
  console.log(`[smoke][${ok ? "PASS" : "FAIL"}] ${name}: ${detail}`);
}

function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

// ---------------------------------------------------------------------------
// synthetic magic bytes
// ---------------------------------------------------------------------------

/**
 * Minimal JPEG: SOI marker (FF D8 FF) + a few bytes of payload + EOI
 * (FF D9). The classifier only inspects the first ≤ 12 bytes; the
 * remainder is just to give the upload a non-trivial size.
 */
function syntheticJpeg(): Buffer {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const body = Buffer.alloc(256, 0x20);
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([head, body, eoi]);
}

/**
 * Minimal PNG: 8-byte signature + dummy chunk bytes. Same role as
 * syntheticJpeg — the classifier only needs the signature.
 */
function syntheticPng(): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const filler = Buffer.alloc(128, 0);
  return Buffer.concat([sig, filler]);
}

/**
 * Synthetic ISO BMFF "ftyp" box matching the supported MP4 brands.
 * Bytes 0-3: box size (32). Bytes 4-7: "ftyp". Bytes 8-11: major brand.
 * Bytes 12-15: minor version (0). Bytes 16+: compatible brands.
 */
function syntheticMp4(): Buffer {
  const box = Buffer.alloc(32, 0);
  box.writeUInt32BE(32, 0);
  box.write("ftyp", 4, "ascii");
  box.write("isom", 8, "ascii");
  box.writeUInt32BE(0, 12);
  box.write("iso2", 16, "ascii");
  box.write("mp41", 20, "ascii");
  box.write("mp42", 24, "ascii");
  box.write("avc1", 28, "ascii");
  const tail = Buffer.alloc(128, 0);
  return Buffer.concat([box, tail]);
}

// ---------------------------------------------------------------------------
// multipart builder
// ---------------------------------------------------------------------------

interface MultipartPart {
  readonly fieldName: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly content: Buffer;
}

interface MultipartPayload {
  readonly headers: Record<string, string>;
  readonly body: () => Readable;
}

/**
 * Hand-assembled multipart/form-data body. busboy parses this just
 * like a real browser upload would.
 */
function buildMultipart(parts: readonly MultipartPart[]): MultipartPayload {
  const boundary = `----TASmokeBoundary${randomBytes(8).toString("hex")}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, "utf8"));
    chunks.push(
      Buffer.from(
        `Content-Disposition: form-data; name="${part.fieldName}"; filename="${part.filename}"\r\n`,
        "utf8",
      ),
    );
    chunks.push(Buffer.from(`Content-Type: ${part.mimeType}\r\n\r\n`, "utf8"));
    chunks.push(part.content);
    chunks.push(Buffer.from("\r\n", "utf8"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  const body = Buffer.concat(chunks);
  return {
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.length),
    },
    body: () => Readable.from(body),
  };
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-upload-smoke-"));
  const dbPath = path.join(tmpRoot, "smoke.db");
  const storageRoot = path.join(tmpRoot, "storage");

  console.log(`[smoke] tmpRoot=${tmpRoot}`);

  const dbHandle = openDatabase(dbPath);
  try {
    const migration = runMigrations(dbHandle.db);
    record(
      "migrations applied",
      migration.appliedNow.includes("004_create_processing_jobs.sql") &&
        migration.appliedNow.includes("002_create_media_items.sql"),
      `appliedNow=${JSON.stringify(migration.appliedNow)}`,
    );

    const storage = LocalStorageProvider.create(storageRoot);

    const tripRepo = new TripRepository(dbHandle.db);
    const tripService = new TripService(tripRepo);
    const mediaRepo = new MediaRepository(dbHandle.db);
    const jobRepo = new JobRepository(dbHandle.db);
    const logger = createLogger({ nodeEnv: "test" });

    const trip = tripService.createTrip({ title: "Upload Smoke Trip" });
    const tripId = trip.id;
    record("seed trip", typeof tripId === "string" && tripId.length > 0, `tripId=${tripId}`);

    // P2.T3 classify() option matching the dev-default allowlist.
    const classifyOptions = {
      imageExtensions: ["jpg", "jpeg", "png", "webp", "heic"],
      videoExtensions: ["mp4", "mov", "m4v", "avi", "mkv"],
    } as const;

    // Sanity: confirm the synthetic bytes really classify how we expect
    // before we trust the smoke results.
    const jpegBytes = syntheticJpeg();
    const pngBytes = syntheticPng();
    const mp4Bytes = syntheticMp4();
    record(
      "jpeg synth classifies as image/jpeg",
      classify(
        { filename: "x.jpg", declaredMimeType: "image/jpeg", headBytes: jpegBytes.subarray(0, 16) },
        classifyOptions,
      ).type === "image",
      "JPEG SOI ok",
    );
    record(
      "mp4 synth classifies as video/mp4",
      classify(
        { filename: "x.mp4", declaredMimeType: "video/mp4", headBytes: mp4Bytes.subarray(0, 32) },
        classifyOptions,
      ).type === "video",
      "ftyp isom brand ok",
    );
    record(
      "png synth classifies as image/png",
      classify(
        { filename: "x.png", declaredMimeType: "image/png", headBytes: pngBytes.subarray(0, 16) },
        classifyOptions,
      ).type === "image",
      "PNG signature ok",
    );

    // The "regular" UploadService for the bulk of the tests.
    const uploadService = new UploadService({
      db: dbHandle.db,
      storage,
      tripService,
      mediaRepo,
      jobRepo,
      classifyOptions,
      maxFileSize: 5 * 1024 * 1024,
      logger,
    });

    // ---------------------------------------------------------------------
    // CASE 1: multi-file upload — one image + one video together
    // ---------------------------------------------------------------------
    {
      const payload = buildMultipart([
        {
          fieldName: "files",
          filename: "vacation.jpg",
          mimeType: "image/jpeg",
          content: jpegBytes,
        },
        {
          fieldName: "files",
          filename: "clip.mp4",
          mimeType: "video/mp4",
          content: mp4Bytes,
        },
      ]);

      const out = await uploadService.handleUpload({
        tripId,
        headers: payload.headers,
        body: payload.body(),
      });

      const [a, b] = out.results;
      const okShape =
        out.results.length === 2 &&
        a?.status === "accepted" &&
        a.type === "image" &&
        a.extension === "jpg" &&
        a.jobType === "image_thumbnail" &&
        b?.status === "accepted" &&
        b.type === "video" &&
        b.extension === "mp4" &&
        b.jobType === "video_metadata";
      record("multi-file image+video accepted", okShape, summarizeResults(out));

      if (a?.status === "accepted") {
        record("image written to originals/", await storage.exists(a.originalPath), a.originalPath);
        record(
          "image media_items row exists",
          rowExists(dbHandle.db, "media_items", a.mediaId),
          `mediaId=${a.mediaId}`,
        );
        record(
          "image processing_jobs row exists",
          rowExists(dbHandle.db, "processing_jobs", a.jobId),
          `jobId=${a.jobId}`,
        );
        record(
          "image media_items.status defaults to 'uploaded'",
          getColumn(dbHandle.db, "media_items", a.mediaId, "status") === "uploaded",
          "status=uploaded",
        );
        record(
          "image processing_jobs.status defaults to 'pending'",
          getColumn(dbHandle.db, "processing_jobs", a.jobId, "status") === "pending",
          "status=pending",
        );
        record(
          "image processing_jobs.job_type = image_thumbnail",
          getColumn(dbHandle.db, "processing_jobs", a.jobId, "job_type") === "image_thumbnail",
          "job_type=image_thumbnail",
        );
      }

      if (b?.status === "accepted") {
        record("video written to originals/", await storage.exists(b.originalPath), b.originalPath);
        record(
          "video processing_jobs.job_type = video_metadata",
          getColumn(dbHandle.db, "processing_jobs", b.jobId, "job_type") === "video_metadata",
          "job_type=video_metadata",
        );
      }
    }

    // ---------------------------------------------------------------------
    // CASE 2: classifier-rejected unknown (text/plain in a .txt file)
    // ---------------------------------------------------------------------
    {
      const txtPayload = buildMultipart([
        {
          fieldName: "files",
          filename: "notes.txt",
          mimeType: "text/plain",
          content: Buffer.from("hello travel album", "utf8"),
        },
      ]);

      const out = await uploadService.handleUpload({
        tripId,
        headers: txtPayload.headers,
        body: txtPayload.body(),
      });
      const item = out.results[0];
      const okShape =
        out.results.length === 1 &&
        item?.status === "rejected_unknown" &&
        item.type === "unknown" &&
        item.extension === "txt";
      record("txt file recorded as rejected_unknown", okShape, summarizeResults(out));

      if (item?.status === "rejected_unknown") {
        record(
          "txt media_items row exists with type=unknown",
          rowExists(dbHandle.db, "media_items", item.mediaId) &&
            getColumn(dbHandle.db, "media_items", item.mediaId, "type") === "unknown",
          `mediaId=${item.mediaId}`,
        );
        record(
          "txt media_items.original_path is NULL",
          getColumn(dbHandle.db, "media_items", item.mediaId, "original_path") === null,
          "original_path IS NULL",
        );
        record(
          "txt did NOT create a processing_jobs row",
          countJobsForMedia(dbHandle.db, item.mediaId) === 0,
          "no jobs",
        );
      }
    }

    // ---------------------------------------------------------------------
    // CASE 3: spoofed extension — .jpg filename but PNG header bytes
    // ---------------------------------------------------------------------
    {
      const spoof = buildMultipart([
        {
          fieldName: "files",
          filename: "trojan.jpg",
          mimeType: "image/jpeg",
          content: pngBytes,
        },
      ]);
      const out = await uploadService.handleUpload({
        tripId,
        headers: spoof.headers,
        body: spoof.body(),
      });
      const item = out.results[0];
      record(
        "spoofed .jpg/PNG header → rejected_unknown",
        out.results.length === 1 && item?.status === "rejected_unknown",
        summarizeResults(out),
      );
      if (item?.status === "rejected_unknown") {
        record(
          "spoofed file reason mentions extension mismatch",
          /extension/i.test(item.reason) || /spoof|expects/i.test(item.reason),
          item.reason,
        );
        record(
          "spoofed file NOT written to storage (no path)",
          // rejected_unknown items have no originalPath at all
          !("originalPath" in (item as unknown as Record<string, unknown>)),
          "no originalPath field",
        );
      }
    }

    // ---------------------------------------------------------------------
    // CASE 4: trip not found → NotFoundError
    // ---------------------------------------------------------------------
    {
      const payload = buildMultipart([
        {
          fieldName: "files",
          filename: "x.jpg",
          mimeType: "image/jpeg",
          content: jpegBytes,
        },
      ]);
      let threw: unknown;
      try {
        await uploadService.handleUpload({
          tripId: "trip-does-not-exist",
          headers: payload.headers,
          body: payload.body(),
        });
      } catch (err) {
        threw = err;
      }
      record(
        "trip not found → NotFoundError",
        threw instanceof NotFoundError,
        describeError(threw),
      );
    }

    // ---------------------------------------------------------------------
    // CASE 5: empty multipart payload (no parts) → BadRequestError
    // ---------------------------------------------------------------------
    {
      const empty = buildMultipart([]);
      let threw: unknown;
      try {
        await uploadService.handleUpload({
          tripId,
          headers: empty.headers,
          body: empty.body(),
        });
      } catch (err) {
        threw = err;
      }
      record(
        "empty payload → BadRequestError",
        threw instanceof BadRequestError,
        describeError(threw),
      );
    }

    // ---------------------------------------------------------------------
    // CASE 6: zero-byte file part → failed with UPLOAD_EMPTY_FILE
    // ---------------------------------------------------------------------
    {
      const zero = buildMultipart([
        {
          fieldName: "files",
          filename: "empty.jpg",
          mimeType: "image/jpeg",
          content: Buffer.alloc(0),
        },
      ]);
      const out = await uploadService.handleUpload({
        tripId,
        headers: zero.headers,
        body: zero.body(),
      });
      const item = out.results[0];
      record(
        "zero-byte file → failed UPLOAD_EMPTY_FILE",
        item?.status === "failed" && item.error.code === "UPLOAD_EMPTY_FILE",
        summarizeResults(out),
      );
    }

    // ---------------------------------------------------------------------
    // CASE 7: oversized file → failed with UPLOAD_FILE_TOO_LARGE
    // ---------------------------------------------------------------------
    {
      const smallLimitSvc = new UploadService({
        db: dbHandle.db,
        storage,
        tripService,
        mediaRepo,
        jobRepo,
        classifyOptions,
        maxFileSize: 16, // bytes; anything realistic will trip this
        logger,
      });
      const big = buildMultipart([
        {
          fieldName: "files",
          filename: "huge.jpg",
          mimeType: "image/jpeg",
          content: jpegBytes, // > 16 bytes
        },
      ]);
      const out = await smallLimitSvc.handleUpload({
        tripId,
        headers: big.headers,
        body: big.body(),
      });
      const item = out.results[0];
      record(
        "oversized file → failed UPLOAD_FILE_TOO_LARGE",
        item?.status === "failed" && item.error.code === "UPLOAD_FILE_TOO_LARGE",
        summarizeResults(out),
      );
    }

    // ---------------------------------------------------------------------
    // CASE 8: per-file failure isolation — one good + one too-big in
    //          the same multipart request. The good one must still land
    //          in DB + storage; the bad one returns failed without
    //          affecting the good one.
    // ---------------------------------------------------------------------
    {
      const small = new UploadService({
        db: dbHandle.db,
        storage,
        tripService,
        mediaRepo,
        jobRepo,
        classifyOptions,
        maxFileSize: 64, // jpegBytes (≈ 264 b) trips; mp4Bytes (160 b) trips too
        logger,
      });
      // Use a file < 64 bytes for the good part. jpegBytes is too big,
      // so synthesise a tiny JPEG (header + 8 b of payload + EOI).
      const tinyJpeg = Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        Buffer.alloc(8, 0x20),
        Buffer.from([0xff, 0xd9]),
      ]); // 14 bytes
      const mixed = buildMultipart([
        {
          fieldName: "files",
          filename: "ok.jpg",
          mimeType: "image/jpeg",
          content: tinyJpeg,
        },
        {
          fieldName: "files",
          filename: "huge.jpg",
          mimeType: "image/jpeg",
          content: jpegBytes,
        },
      ]);
      const out = await small.handleUpload({
        tripId,
        headers: mixed.headers,
        body: mixed.body(),
      });
      const [a, b] = out.results;
      record(
        "mixed batch: small ok + huge rejected, no cross-impact",
        out.results.length === 2 &&
          a?.status === "accepted" &&
          b?.status === "failed" &&
          b.error.code === "UPLOAD_FILE_TOO_LARGE",
        summarizeResults(out),
      );
    }

    // ---------------------------------------------------------------------
    // CASE 9: DB rollback compensation — poison JobRepository so the
    //          transaction throws AFTER the original is written. Expect:
    //          (a) failed result with DB_INSERT_FAILED
    //          (b) no media_items row for the attempted mediaId
    //          (c) the original file removed from storage
    // ---------------------------------------------------------------------
    {
      // Cast through unknown to satisfy ts-strict — we only need the
      // shape JobRepository's consumer relies on (the `insert` method).
      class PoisonedJobRepo {
        insert(): void {
          throw new Error("simulated job insert failure");
        }
      }
      const poisonedSvc = new UploadService({
        db: dbHandle.db,
        storage,
        tripService,
        mediaRepo,
        jobRepo: new PoisonedJobRepo() as unknown as JobRepository,
        classifyOptions,
        maxFileSize: 5 * 1024 * 1024,
        logger,
      });
      // Capture how many media_items / processing_jobs exist before
      // the poisoned call so we can prove neither grew.
      const mediaBefore = countRows(dbHandle.db, "media_items");
      const jobsBefore = countRows(dbHandle.db, "processing_jobs");

      const payload = buildMultipart([
        {
          fieldName: "files",
          filename: "rollback.jpg",
          mimeType: "image/jpeg",
          content: jpegBytes,
        },
      ]);
      const out = await poisonedSvc.handleUpload({
        tripId,
        headers: payload.headers,
        body: payload.body(),
      });
      const item = out.results[0];
      record(
        "rollback compensation: poisoned jobRepo → failed DB_INSERT_FAILED",
        item?.status === "failed" && item.error.code === "DB_INSERT_FAILED",
        summarizeResults(out),
      );
      const mediaAfter = countRows(dbHandle.db, "media_items");
      const jobsAfter = countRows(dbHandle.db, "processing_jobs");
      record(
        "rollback compensation: media_items row count unchanged",
        mediaAfter === mediaBefore,
        `before=${mediaBefore} after=${mediaAfter}`,
      );
      record(
        "rollback compensation: processing_jobs row count unchanged",
        jobsAfter === jobsBefore,
        `before=${jobsBefore} after=${jobsAfter}`,
      );
      // The compensating remove() should have wiped the original file.
      // We don't know its exact mediaId (the run rolled back) but we
      // can scan the originals dir for the trip and confirm only the
      // earlier accepted uploads remain.
      const acceptedCount = await countOriginals(storage, tripId);
      // Accepted uploads up to this point: case 1 image + case 1 video
      // + case 8 small image = 3.
      record(
        "rollback compensation: originals/ count matches accepted",
        acceptedCount === 3,
        `originals=${acceptedCount}, expected 3`,
      );
    }
  } finally {
    closeDatabase(dbHandle);
    await rm(tmpRoot, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------------
  // summary
  // ---------------------------------------------------------------------
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n[smoke] ${passed} passed, ${failed} failed, ${results.length} total`);
  if (failed > 0) {
    console.log(
      `[smoke] failures: ${results
        .filter((r) => !r.ok)
        .map((r) => r.name)
        .join(", ")}`,
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// DB / storage helpers
// ---------------------------------------------------------------------------

function rowExists(
  db: SqliteDatabase,
  table: "media_items" | "processing_jobs",
  id: string,
): boolean {
  const row = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id);
  return row !== undefined;
}

function getColumn(
  db: SqliteDatabase,
  table: "media_items" | "processing_jobs",
  id: string,
  column: string,
): unknown {
  const row = db.prepare(`SELECT ${column} FROM ${table} WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? row[column] : undefined;
}

function countJobsForMedia(db: SqliteDatabase, mediaId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM processing_jobs WHERE media_id = ?`)
    .get(mediaId) as { n: number } | undefined;
  return row?.n ?? -1;
}

function countRows(db: SqliteDatabase, table: "media_items" | "processing_jobs"): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | undefined;
  return row?.n ?? -1;
}

async function countOriginals(storage: LocalStorageProvider, tripId: string): Promise<number> {
  const { readdir } = await import("node:fs/promises");
  try {
    const entries = await readdir(path.join(storage.root, "trips", tripId, "originals"));
    return entries.length;
  } catch {
    return 0;
  }
}

function summarizeResults(out: UploadResult): string {
  return out.results
    .map((r) => {
      if (r.status === "accepted") return `${r.fieldName}:${r.originalFilename}=accepted/${r.type}`;
      if (r.status === "rejected_unknown")
        return `${r.fieldName}:${r.originalFilename}=rejected_unknown/${r.extension ?? "(noext)"}`;
      return `${r.fieldName}:${r.originalFilename}=failed/${r.error.code}`;
    })
    .join(", ");
}

main().catch((err) => {
  console.error(`[smoke] uncaught error: ${describeError(err)}`);
  process.exit(1);
});
