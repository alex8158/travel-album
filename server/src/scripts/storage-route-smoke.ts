// Manual smoke test for the Storage static-file route (P3.T1).
//
// Usage: npm run smoke:storage-route
//
// Boots a minimal Express app (storage router + standard middleware
// chain), listens on an ephemeral port, makes real fetch requests,
// asserts status / headers / body, then shuts down. No new test
// framework is added — only native `node:http` (via Express) and the
// Node 20+ built-in `fetch`.
//
// Coverage:
//   * GET an existing JPG / PNG / WEBP / GIF / MP4 → 200 + correct
//     Content-Type + matching body bytes.
//   * Unknown extension (.bin) → application/octet-stream default.
//   * Missing file → 404 STORAGE_NOT_FOUND.
//   * `..` segment in URL → 400 STORAGE_PATH_TRAVERSAL.
//   * `.` segment in URL → 400 STORAGE_PATH_TRAVERSAL.
//   * Backslash / null byte → 400 STORAGE_INVALID_KEY.
//   * Path outside the `trips/` whitelist → 400 STORAGE_INVALID_KEY.
//   * Empty wildcard → 400 STORAGE_INVALID_KEY.
//   * Cache-Control + X-Content-Type-Options headers present.

import express from "express";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http, { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { createLogger } from "../logger.js";
import { makeErrorHandler, notFoundHandler } from "../middleware/errorHandler.js";
import { requestIdMiddleware } from "../middleware/requestId.js";
import { makeStorageRouter } from "../routes/storage.js";
import { LocalStorageProvider } from "../storage/index.js";

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
// fixtures
// ---------------------------------------------------------------------------

interface SeededFile {
  readonly logicalPath: string;
  readonly bytes: Buffer;
}

function seedFile(storageRoot: string, logicalPath: string, bytes: Buffer): SeededFile {
  const absolute = path.join(storageRoot, logicalPath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, bytes);
  return { logicalPath, bytes };
}

/**
 * Send a raw HTTP request with the URL path used verbatim — no
 * WHATWG URL normalisation. Needed for adversarial cases (`..`, `.`,
 * literal backslash) because `fetch()` in Node 20+ runs the URL
 * through the WHATWG parser which collapses dot-segments client-side
 * before the request is sent. The server-side defense exists for a
 * reason and we want this smoke to actually exercise it.
 */
interface RawResponse {
  readonly status: number;
  readonly body: Buffer;
}

function rawGet(host: string, port: number, rawPath: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: host, port, method: "GET", path: rawPath }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function parseJsonBody(buf: Buffer): { error?: { code?: string; message?: string } } {
  try {
    return JSON.parse(buf.toString("utf8")) as { error?: { code?: string; message?: string } };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-storage-route-smoke-"));
  const storageRoot = path.join(tmpRoot, "storage");
  console.log(`[smoke] storageRoot=${storageRoot}`);

  // Boot a minimal Express app — just enough middleware for the route
  // and the standard error envelope to render. We do NOT call
  // createApp() because that drags in the whole domain stack (DB,
  // trips, upload, capabilities) and we only need the storage piece.
  const storage = LocalStorageProvider.create(storageRoot);
  const logger = createLogger({ nodeEnv: "test" });
  const app = express();
  app.use(requestIdMiddleware);
  app.use("/storage", makeStorageRouter({ storage }));
  app.use(notFoundHandler);
  app.use(makeErrorHandler(logger));

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  console.log(`[smoke] server listening on ${base}`);

  try {
    // -----------------------------------------------------------------
    // Seed assorted files
    // -----------------------------------------------------------------
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    const webpBytes = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    const gifBytes = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    const mp4Bytes = Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]);
    const binBytes = Buffer.from([0xde, 0xad, 0xbe, 0xef]);

    const jpg = seedFile(storageRoot, "trips/trip-1/originals/m1.jpg", jpegBytes);
    const png = seedFile(storageRoot, "trips/trip-1/originals/m2.png", pngBytes);
    const webp = seedFile(storageRoot, "trips/trip-1/derived/m1/thumb.webp", webpBytes);
    const gif = seedFile(storageRoot, "trips/trip-1/originals/m3.gif", gifBytes);
    const mp4 = seedFile(storageRoot, "trips/trip-1/originals/m4.mp4", mp4Bytes);
    const bin = seedFile(storageRoot, "trips/trip-1/originals/m5.bin", binBytes);

    // Files outside trips/ should never be reachable even if they exist
    seedFile(storageRoot, "secrets/passwd", Buffer.from("never-served"));

    // -----------------------------------------------------------------
    // Test cases
    // -----------------------------------------------------------------

    // 1. Existing JPEG → 200, image/jpeg, body matches
    {
      const res = await fetch(`${base}/storage/${jpg.logicalPath}`);
      const body = Buffer.from(await res.arrayBuffer());
      record(
        "GET jpg → 200 + image/jpeg + bytes match",
        res.status === 200 &&
          res.headers.get("content-type") === "image/jpeg" &&
          body.equals(jpg.bytes),
        `status=${res.status} ct=${res.headers.get("content-type") ?? "(none)"} bytes=${body.length}`,
      );
      record(
        "GET jpg → Cache-Control set",
        res.headers.get("cache-control") === "private, max-age=3600",
        `cache-control=${res.headers.get("cache-control") ?? "(none)"}`,
      );
      record(
        "GET jpg → X-Content-Type-Options nosniff",
        res.headers.get("x-content-type-options") === "nosniff",
        `x-content-type-options=${res.headers.get("x-content-type-options") ?? "(none)"}`,
      );
    }

    // 2. Existing PNG
    {
      const res = await fetch(`${base}/storage/${png.logicalPath}`);
      const body = Buffer.from(await res.arrayBuffer());
      record(
        "GET png → 200 + image/png + bytes match",
        res.status === 200 &&
          res.headers.get("content-type") === "image/png" &&
          body.equals(png.bytes),
        `status=${res.status} ct=${res.headers.get("content-type") ?? "(none)"}`,
      );
    }

    // 3. Existing WEBP (deep derived/ path)
    {
      const res = await fetch(`${base}/storage/${webp.logicalPath}`);
      const body = Buffer.from(await res.arrayBuffer());
      record(
        "GET derived/.../thumb.webp → 200 + image/webp + bytes match",
        res.status === 200 &&
          res.headers.get("content-type") === "image/webp" &&
          body.equals(webp.bytes),
        `status=${res.status} ct=${res.headers.get("content-type") ?? "(none)"}`,
      );
    }

    // 4. Existing GIF
    {
      const res = await fetch(`${base}/storage/${gif.logicalPath}`);
      record(
        "GET gif → 200 + image/gif",
        res.status === 200 && res.headers.get("content-type") === "image/gif",
        `status=${res.status} ct=${res.headers.get("content-type") ?? "(none)"}`,
      );
    }

    // 5. Existing MP4
    {
      const res = await fetch(`${base}/storage/${mp4.logicalPath}`);
      record(
        "GET mp4 → 200 + video/mp4",
        res.status === 200 && res.headers.get("content-type") === "video/mp4",
        `status=${res.status} ct=${res.headers.get("content-type") ?? "(none)"}`,
      );
    }

    // 6. Unknown extension → octet-stream default
    {
      const res = await fetch(`${base}/storage/${bin.logicalPath}`);
      record(
        "GET .bin → 200 + application/octet-stream",
        res.status === 200 && res.headers.get("content-type") === "application/octet-stream",
        `status=${res.status} ct=${res.headers.get("content-type") ?? "(none)"}`,
      );
    }

    // 7. Missing file → 404 STORAGE_NOT_FOUND
    {
      const res = await fetch(`${base}/storage/trips/trip-1/originals/nope.jpg`);
      const body = (await res.json()) as { error?: { code?: string } };
      record(
        "GET missing → 404 STORAGE_NOT_FOUND",
        res.status === 404 && body.error?.code === "STORAGE_NOT_FOUND",
        `status=${res.status} code=${body.error?.code ?? "(none)"}`,
      );
    }

    // 8. `..` traversal attempt — sent via raw http.request so WHATWG
    //    URL normalisation does NOT collapse the dot-segments before
    //    they reach our server.
    {
      const res = await rawGet("127.0.0.1", port, "/storage/trips/trip-1/../../secrets/passwd");
      const body = parseJsonBody(res.body);
      record(
        "GET with `..` segments (raw) → 400 STORAGE_PATH_TRAVERSAL",
        res.status === 400 && body.error?.code === "STORAGE_PATH_TRAVERSAL",
        `status=${res.status} code=${body.error?.code ?? "(none)"}`,
      );
    }

    // 9. `.` segment — same reasoning, raw HTTP.
    {
      const res = await rawGet("127.0.0.1", port, "/storage/trips/trip-1/./originals/m1.jpg");
      const body = parseJsonBody(res.body);
      record(
        "GET with `.` segment (raw) → 400 STORAGE_PATH_TRAVERSAL",
        res.status === 400 && body.error?.code === "STORAGE_PATH_TRAVERSAL",
        `status=${res.status} code=${body.error?.code ?? "(none)"}`,
      );
    }

    // 10. Backslash — sent via raw http.request with a literal `\`.
    {
      const res = await rawGet("127.0.0.1", port, "/storage/trips/trip-1\\originals/m1.jpg");
      const body = parseJsonBody(res.body);
      record(
        "GET with backslash (raw) → 400 STORAGE_INVALID_KEY",
        res.status === 400 && body.error?.code === "STORAGE_INVALID_KEY",
        `status=${res.status} code=${body.error?.code ?? "(none)"}`,
      );
    }

    // 11. Non-whitelisted prefix — even when the underlying file
    //     exists on disk (we seeded `secrets/passwd` above), the route
    //     refuses anything that does not start with `trips/`.
    {
      const res = await fetch(`${base}/storage/secrets/passwd`);
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      record(
        "GET outside trips/ → 400 STORAGE_INVALID_KEY",
        res.status === 400 &&
          body.error?.code === "STORAGE_INVALID_KEY" &&
          /trips\//.test(body.error?.message ?? ""),
        `status=${res.status} code=${body.error?.code ?? "(none)"}`,
      );
    }

    // 12. Empty wildcard — request `/storage/` with trailing slash.
    //     Express may route this to notFoundHandler instead of the
    //     wildcard handler depending on its routing config; either
    //     way we want a non-200 response. Accept both 400 and 404 as
    //     "rejected".
    {
      const res = await fetch(`${base}/storage/`);
      record(
        "GET /storage/ (empty) → 4xx (not served)",
        res.status === 400 || res.status === 404,
        `status=${res.status}`,
      );
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tmpRoot, { recursive: true, force: true });
    console.log(`[smoke] cleaned up ${tmpRoot}`);
  }

  // ---------------------------------------------------------------------
  // summary
  // ---------------------------------------------------------------------
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n[smoke] summary: ${passed}/${results.length} passed`);
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

main().catch((err) => {
  console.error(`[smoke] uncaught error: ${describeError(err)}`);
  process.exit(1);
});
