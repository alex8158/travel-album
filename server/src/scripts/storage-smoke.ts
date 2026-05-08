// Manual smoke test for the LocalStorageProvider (P0.T7).
//
// Usage:
//   npm run smoke:storage
//
// Creates a private temp directory, exercises every public method
// (putOriginal, putDerived, read, remove, exists) plus a few negative
// paths (overwrite refusal, traversal attempts, double-remove). Prints
// the outcome of each step and removes the temp directory at the end.
// Exits with status 1 if any required behaviour fails.

import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { LocalStorageProvider, StorageError } from "../storage/index.js";

interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const results: CheckResult[] = [];

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  const tag = ok ? "PASS" : "FAIL";
  console.log(`[smoke][${tag}] ${name}: ${detail}`);
}

function describeError(err: unknown): string {
  if (err instanceof StorageError) {
    return `${err.name}(${err.code}, status=${err.statusCode}): ${err.message}`;
  }
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  return String(err);
}

async function readToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "tas-storage-smoke-"));
  console.log(`[smoke] storage root = ${root}`);

  try {
    const provider = LocalStorageProvider.create(root);
    record("provider.root resolved", provider.root === root, `root=${provider.root}`);

    const tripId = "trip-001";
    const mediaId = "media-abc";
    const originalContent = Buffer.from("hello, original!\n", "utf8");

    // 1. putOriginal — happy path
    const stored = await provider.putOriginal({
      tripId,
      mediaId,
      extension: "txt",
      data: originalContent,
    });
    record(
      "putOriginal places at canonical path",
      stored.logicalPath === `trips/${tripId}/originals/${mediaId}.txt` &&
        stored.size === originalContent.length,
      `path=${stored.logicalPath} size=${stored.size}`,
    );

    // 2. exists hit / miss
    const existsHit = await provider.exists(stored.logicalPath);
    const existsMiss = await provider.exists("trips/no-such/originals/none.txt");
    record(
      "exists discriminates hit/miss",
      existsHit && !existsMiss,
      `hit=${existsHit} miss=${existsMiss}`,
    );

    // 3. putOriginal refuses overwrite
    {
      let threw: unknown;
      try {
        await provider.putOriginal({
          tripId,
          mediaId,
          extension: "txt",
          data: originalContent,
        });
      } catch (err) {
        threw = err;
      }
      record(
        "putOriginal refuses overwrite",
        threw instanceof StorageError && threw.code === "STORAGE_ALREADY_EXISTS",
        describeError(threw),
      );
    }

    // 4. putDerived — happy path
    const thumbV1 = await provider.putDerived({
      tripId,
      mediaId,
      relPath: "thumb.webp",
      data: Buffer.from("thumb-v1"),
    });
    record(
      "putDerived places at canonical path",
      thumbV1.logicalPath === `trips/${tripId}/derived/${mediaId}/thumb.webp`,
      `path=${thumbV1.logicalPath} size=${thumbV1.size}`,
    );

    // 5. putDerived refuses overwrite by default
    {
      let threw: unknown;
      try {
        await provider.putDerived({
          tripId,
          mediaId,
          relPath: "thumb.webp",
          data: Buffer.from("thumb-v2"),
        });
      } catch (err) {
        threw = err;
      }
      record(
        "putDerived refuses overwrite by default",
        threw instanceof StorageError && threw.code === "STORAGE_ALREADY_EXISTS",
        describeError(threw),
      );
    }

    // 6. putDerived(overwrite=true) replaces content
    const thumbV2Content = Buffer.from("thumb-v2-longer-content");
    const thumbV2 = await provider.putDerived({
      tripId,
      mediaId,
      relPath: "thumb.webp",
      data: thumbV2Content,
      overwrite: true,
    });
    record(
      "putDerived overwrite=true replaces",
      thumbV2.size === thumbV2Content.length,
      `new size=${thumbV2.size}`,
    );

    // 7. putDerived nested relPath (frames/, segments/)
    const frame = await provider.putDerived({
      tripId,
      mediaId,
      relPath: "frames/00001.jpg",
      data: Buffer.from("frame-bytes"),
    });
    record(
      "putDerived supports nested relPath",
      frame.logicalPath.endsWith("/derived/media-abc/frames/00001.jpg"),
      `path=${frame.logicalPath}`,
    );

    // 8. read returns matching content
    const readBack = await readToString(await provider.read(stored.logicalPath));
    record(
      "read returns the bytes that were written",
      readBack === originalContent.toString("utf8"),
      `bytes=${JSON.stringify(readBack)}`,
    );

    // 9. read missing throws NOT_FOUND
    {
      let threw: unknown;
      try {
        await provider.read("trips/no-such/originals/missing.bin");
      } catch (err) {
        threw = err;
      }
      record(
        "read on missing path throws NOT_FOUND",
        threw instanceof StorageError && threw.code === "STORAGE_NOT_FOUND",
        describeError(threw),
      );
    }

    // 10. remove existing returns removed:true; second call returns removed:false
    const rm1 = await provider.remove(stored.logicalPath);
    const rm2 = await provider.remove(stored.logicalPath);
    record(
      "remove distinguishes first delete vs missing",
      rm1.removed === true && rm2.removed === false,
      `first=${JSON.stringify(rm1)} second=${JSON.stringify(rm2)}`,
    );

    // 11. Path traversal / invalid input is rejected on every entry point
    const traversalCases: { name: string; run: () => Promise<unknown> }[] = [
      {
        name: "tripId with slash",
        run: () =>
          provider.putOriginal({
            tripId: "../escape",
            mediaId,
            extension: "txt",
            data: Buffer.from("x"),
          }),
      },
      {
        name: "extension with dot/slash",
        run: () =>
          provider.putOriginal({
            tripId,
            mediaId,
            extension: "tx/t",
            data: Buffer.from("x"),
          }),
      },
      {
        name: "relPath dotdot segment",
        run: () =>
          provider.putDerived({
            tripId,
            mediaId,
            relPath: "../escape.bin",
            data: Buffer.from("x"),
          }),
      },
      {
        name: "relPath absolute",
        run: () =>
          provider.putDerived({
            tripId,
            mediaId,
            relPath: "/etc/passwd",
            data: Buffer.from("x"),
          }),
      },
      {
        name: "relPath null byte",
        run: () =>
          provider.putDerived({
            tripId,
            mediaId,
            relPath: "thumb\u0000.webp",
            data: Buffer.from("x"),
          }),
      },
      {
        name: "relPath backslash",
        run: () =>
          provider.putDerived({
            tripId,
            mediaId,
            relPath: "frames\\01.jpg",
            data: Buffer.from("x"),
          }),
      },
      {
        name: "read with absolute path",
        run: () => provider.read("/etc/passwd"),
      },
      {
        name: "read with dotdot prefix",
        run: () => provider.read("../escape.bin"),
      },
    ];

    for (const tc of traversalCases) {
      let threw: unknown;
      try {
        await tc.run();
      } catch (err) {
        threw = err;
      }
      const ok =
        threw instanceof StorageError &&
        (threw.code === "STORAGE_INVALID_KEY" || threw.code === "STORAGE_PATH_TRAVERSAL");
      record(`traversal/invalid: ${tc.name}`, ok, describeError(threw));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    console.log(`[smoke] cleaned up ${root}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[smoke] summary: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    console.log(`[smoke] failures:`);
    for (const f of failed) {
      console.log(`  - ${f.name}: ${f.detail}`);
    }
    process.exit(1);
  }
}

void main().catch((err) => {
  console.error("[smoke] unexpected error:", err);
  process.exit(1);
});
