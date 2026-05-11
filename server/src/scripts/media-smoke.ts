// Manual smoke test for the Media read API (P2.T5).
//
// Usage: npm run smoke:media
//
// Builds a private throwaway SQLite DB, runs every migration, seeds a
// trip with a handful of media_items rows (direct repo INSERTs — the
// upload path is already covered by smoke:upload), and drives every
// branch of MediaService:
//
//   * getMediaById — found / missing / soft-deleted
//   * listMediaForTrip — happy / empty / trip missing / soft-deleted
//     trip / pagination / order / soft-deleted rows filtered
//   * Service-level zod validation rejects bad ids / bad pagination
//
// Exits 1 if any required behaviour fails. Always cleans up.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { NotFoundError, ValidationError } from "../errors/AppError.js";
import { MediaRepository, MediaService } from "../media/index.js";
import type { MediaInsertData } from "../media/index.js";
import { TripRepository, TripService } from "../trips/index.js";

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
// fixture helpers
// ---------------------------------------------------------------------------

interface SeedMediaOptions {
  readonly mediaRepo: MediaRepository;
  readonly tripId: string;
  readonly type: "image" | "video" | "unknown";
  readonly extension: string | null;
  readonly originalPath: string | null;
  readonly createdAt: string;
}

function seedMedia(opts: SeedMediaOptions): string {
  const id = randomUUID();
  const data: MediaInsertData = {
    id,
    tripId: opts.tripId,
    type: opts.type,
    originalPath: opts.originalPath,
    fileSize: opts.originalPath !== null ? 1024 : 0,
    mimeType: opts.type === "image" ? "image/jpeg" : opts.type === "video" ? "video/mp4" : null,
    extension: opts.extension,
    createdAt: opts.createdAt,
    updatedAt: opts.createdAt,
  };
  opts.mediaRepo.insert(data);
  return id;
}

/**
 * Direct UPDATE for soft-deleting a media row. Used purely as a test
 * fixture; the real soft-delete path lands in P7 and is not part of
 * this task.
 */
function softDeleteMediaFixture(db: SqliteDatabase, mediaId: string, deletedAt: string): void {
  db.prepare(`UPDATE media_items SET deleted_at = ?, status = 'deleted' WHERE id = ?`).run(
    deletedAt,
    mediaId,
  );
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-media-smoke-"));
  const dbPath = path.join(tmpRoot, "smoke.db");
  console.log(`[smoke] dbPath=${dbPath}`);

  const dbHandle = openDatabase(dbPath);
  try {
    const migration = runMigrations(dbHandle.db);
    record(
      "migrations applied",
      migration.appliedNow.includes("002_create_media_items.sql"),
      `appliedNow=${JSON.stringify(migration.appliedNow)}`,
    );

    const tripRepo = new TripRepository(dbHandle.db);
    const tripService = new TripService(tripRepo);
    const mediaRepo = new MediaRepository(dbHandle.db);
    const mediaService = new MediaService(mediaRepo, tripService);

    // Two trips: one populated, one empty. Plus a soft-deleted trip to
    // verify that path 404s.
    const tripA = tripService.createTrip({ title: "Trip A — populated" });
    const tripB = tripService.createTrip({ title: "Trip B — empty" });
    const tripC = tripService.createTrip({ title: "Trip C — will be soft-deleted" });
    tripService.softDeleteTrip(tripC.id);

    // Seed 5 media items into tripA with monotonically increasing
    // createdAt so the newest-first ordering is observable. Mix types
    // and include one unknown (no original_path).
    const t = "2026-05-01T00:00:";
    const m1 = seedMedia({
      mediaRepo,
      tripId: tripA.id,
      type: "image",
      extension: "jpg",
      originalPath: `trips/${tripA.id}/originals/m1.jpg`,
      createdAt: `${t}00.000Z`,
    });
    const m2 = seedMedia({
      mediaRepo,
      tripId: tripA.id,
      type: "video",
      extension: "mp4",
      originalPath: `trips/${tripA.id}/originals/m2.mp4`,
      createdAt: `${t}01.000Z`,
    });
    const m3 = seedMedia({
      mediaRepo,
      tripId: tripA.id,
      type: "unknown",
      extension: "txt",
      originalPath: null,
      createdAt: `${t}02.000Z`,
    });
    const m4 = seedMedia({
      mediaRepo,
      tripId: tripA.id,
      type: "image",
      extension: "png",
      originalPath: `trips/${tripA.id}/originals/m4.png`,
      createdAt: `${t}03.000Z`,
    });
    const m5 = seedMedia({
      mediaRepo,
      tripId: tripA.id,
      type: "image",
      extension: "webp",
      originalPath: `trips/${tripA.id}/originals/m5.webp`,
      createdAt: `${t}04.000Z`,
    });

    // Soft-delete one row to verify the default filter hides it.
    softDeleteMediaFixture(dbHandle.db, m3, "2026-05-01T01:00:00.000Z");

    // ---------------------------------------------------------------------
    // getMediaById — happy path
    // ---------------------------------------------------------------------
    {
      const got = mediaService.getMediaById(m1);
      record(
        "getMediaById returns the expected row",
        got.id === m1 && got.tripId === tripA.id && got.type === "image" && got.extension === "jpg",
        `id=${got.id} type=${got.type} ext=${got.extension}`,
      );
      record(
        "getMediaById projects required columns",
        typeof got.createdAt === "string" &&
          typeof got.updatedAt === "string" &&
          got.deletedAt === null &&
          got.status === "uploaded" &&
          got.userDecision === "undecided" &&
          got.fileSize === 1024,
        `status=${got.status} userDecision=${got.userDecision} fileSize=${String(got.fileSize)}`,
      );
    }

    // ---------------------------------------------------------------------
    // getMediaById — missing id → NotFoundError
    // ---------------------------------------------------------------------
    {
      let threw: unknown;
      try {
        mediaService.getMediaById("nope-does-not-exist");
      } catch (err) {
        threw = err;
      }
      record(
        "getMediaById on missing id → NotFoundError",
        threw instanceof NotFoundError,
        describeError(threw),
      );
    }

    // ---------------------------------------------------------------------
    // getMediaById — soft-deleted row → NotFoundError (hidden by default)
    // ---------------------------------------------------------------------
    {
      let threw: unknown;
      try {
        mediaService.getMediaById(m3);
      } catch (err) {
        threw = err;
      }
      record(
        "getMediaById on soft-deleted row → NotFoundError",
        threw instanceof NotFoundError,
        describeError(threw),
      );
    }

    // ---------------------------------------------------------------------
    // getMediaById — malformed id → ValidationError
    // ---------------------------------------------------------------------
    {
      let threw: unknown;
      try {
        mediaService.getMediaById("not a valid id!!!");
      } catch (err) {
        threw = err;
      }
      record(
        "getMediaById on malformed id → ValidationError",
        threw instanceof ValidationError,
        describeError(threw),
      );
    }

    // ---------------------------------------------------------------------
    // listMediaForTrip — populated trip, default pagination, newest first
    // ---------------------------------------------------------------------
    {
      const list = mediaService.listMediaForTrip(tripA.id);
      // 4 active rows (m1..m5 minus the soft-deleted m3), ordered
      // newest-first by createdAt.
      const expectedOrder = [m5, m4, m2, m1];
      const actualOrder = list.map((r) => r.id);
      record(
        "listMediaForTrip returns active rows newest-first",
        list.length === 4 && expectedOrder.every((id, i) => actualOrder[i] === id),
        `expected=${JSON.stringify(expectedOrder)} actual=${JSON.stringify(actualOrder)}`,
      );
      record(
        "listMediaForTrip excludes soft-deleted m3",
        !actualOrder.includes(m3),
        `m3=${m3} actual=${JSON.stringify(actualOrder)}`,
      );
      record(
        "listMediaForTrip rows all have deletedAt === null",
        list.every((r) => r.deletedAt === null),
        `count=${list.length}`,
      );
    }

    // ---------------------------------------------------------------------
    // listMediaForTrip — pagination
    // ---------------------------------------------------------------------
    {
      const page1 = mediaService.listMediaForTrip(tripA.id, { limit: 2, offset: 0 });
      const page2 = mediaService.listMediaForTrip(tripA.id, { limit: 2, offset: 2 });
      const page3 = mediaService.listMediaForTrip(tripA.id, { limit: 2, offset: 4 });
      record(
        "listMediaForTrip limit=2 offset=0 → first 2 newest",
        page1.length === 2 && page1[0]?.id === m5 && page1[1]?.id === m4,
        `ids=${JSON.stringify(page1.map((r) => r.id))}`,
      );
      record(
        "listMediaForTrip limit=2 offset=2 → next 2",
        page2.length === 2 && page2[0]?.id === m2 && page2[1]?.id === m1,
        `ids=${JSON.stringify(page2.map((r) => r.id))}`,
      );
      record(
        "listMediaForTrip limit=2 offset=4 → empty (past end)",
        page3.length === 0,
        `len=${page3.length}`,
      );
    }

    // ---------------------------------------------------------------------
    // listMediaForTrip — empty trip → empty array (200, not 404)
    // ---------------------------------------------------------------------
    {
      const list = mediaService.listMediaForTrip(tripB.id);
      record("listMediaForTrip on empty trip → []", list.length === 0, `len=${list.length}`);
    }

    // ---------------------------------------------------------------------
    // listMediaForTrip — missing trip → NotFoundError
    // ---------------------------------------------------------------------
    {
      let threw: unknown;
      try {
        mediaService.listMediaForTrip("trip-does-not-exist");
      } catch (err) {
        threw = err;
      }
      record(
        "listMediaForTrip on missing trip → NotFoundError",
        threw instanceof NotFoundError,
        describeError(threw),
      );
    }

    // ---------------------------------------------------------------------
    // listMediaForTrip — soft-deleted trip → NotFoundError
    // ---------------------------------------------------------------------
    {
      let threw: unknown;
      try {
        mediaService.listMediaForTrip(tripC.id);
      } catch (err) {
        threw = err;
      }
      record(
        "listMediaForTrip on soft-deleted trip → NotFoundError",
        threw instanceof NotFoundError,
        describeError(threw),
      );
    }

    // ---------------------------------------------------------------------
    // listMediaForTrip — malformed tripId → ValidationError
    // ---------------------------------------------------------------------
    {
      let threw: unknown;
      try {
        mediaService.listMediaForTrip("not a valid id!!!");
      } catch (err) {
        threw = err;
      }
      record(
        "listMediaForTrip on malformed tripId → ValidationError",
        threw instanceof ValidationError,
        describeError(threw),
      );
    }

    // ---------------------------------------------------------------------
    // listMediaForTrip — bad pagination → ValidationError
    // ---------------------------------------------------------------------
    {
      let threw: unknown;
      try {
        mediaService.listMediaForTrip(tripA.id, { limit: -1 });
      } catch (err) {
        threw = err;
      }
      record(
        "listMediaForTrip negative limit → ValidationError",
        threw instanceof ValidationError,
        describeError(threw),
      );
    }
    {
      let threw: unknown;
      try {
        mediaService.listMediaForTrip(tripA.id, { offset: -5 });
      } catch (err) {
        threw = err;
      }
      record(
        "listMediaForTrip negative offset → ValidationError",
        threw instanceof ValidationError,
        describeError(threw),
      );
    }
    {
      let threw: unknown;
      try {
        // includeDeleted is the Service-level escape hatch. It is not
        // exposed on the HTTP layer; tests below verify the toggle
        // works at the Service layer for future restore callers.
        mediaService.listMediaForTrip(tripA.id, { limit: 999_999 });
      } catch (err) {
        threw = err;
      }
      record(
        "listMediaForTrip limit > 200 → ValidationError",
        threw instanceof ValidationError,
        describeError(threw),
      );
    }

    // ---------------------------------------------------------------------
    // Service-level includeDeleted toggle — soft-deleted row visible
    // ---------------------------------------------------------------------
    {
      const list = mediaService.listMediaForTrip(tripA.id, { includeDeleted: true });
      record(
        "Service-level includeDeleted=true surfaces soft-deleted m3",
        list.length === 5 && list.some((r) => r.id === m3 && r.deletedAt !== null),
        `len=${list.length}, deleted-visible=${String(list.some((r) => r.id === m3))}`,
      );
    }

    // ---------------------------------------------------------------------
    // Repository.findById with includeDeleted — surfaces soft-deleted
    // ---------------------------------------------------------------------
    {
      const row = mediaRepo.findById(m3, { includeDeleted: true });
      record(
        "Repository.findById includeDeleted=true surfaces soft-deleted m3",
        row !== null && row.id === m3 && row.deletedAt !== null,
        `row=${row ? `id=${row.id} deletedAt=${row.deletedAt}` : "null"}`,
      );
    }
  } finally {
    closeDatabase(dbHandle);
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
