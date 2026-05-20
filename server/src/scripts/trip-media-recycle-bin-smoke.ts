// Manual smoke test for the trip media recycle-bin view (P7.T4).
//
// Usage: npm run smoke:trip-media-recycle-bin
//
// Coverage:
//   * Default `listMediaForTrip(tripId)` still hides soft-deleted
//     media (regression — gallery must not regress on the deleted
//     filter).
//   * `listMediaForTrip(tripId, { onlyDeleted: true })` returns ONLY
//     soft-deleted media for the trip.
//   * Ordering: rows come back `deleted_at DESC` (newest-deleted
//     first), `id DESC` as tie-break.
//   * Empty case: a trip with no deletes yields an empty recycle-bin
//     list (no throw, no leak of other trips' deletes).
//   * Trip scoping: deletes from a sibling trip do NOT appear in the
//     current trip's recycle-bin view.
//   * `onlyDeleted` wins over `includeDeleted` when both are set (the
//     Service-level admin knob still composes cleanly).
//   * Restore chain (the actual user flow):
//       1. Soft-delete media in a trip.
//       2. Confirm it appears in the onlyDeleted view.
//       3. Call `restoreMedia(id)`.
//       4. Onced restored: it leaves the onlyDeleted view and
//          re-appears in the default gallery list.
//   * Route schema parses `?onlyDeleted=true` (truthy) and rejects
//     malformed values — keeps the public HTTP contract honest.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { DuplicateGroupsRepository } from "../dedup/index.js";
import { JobRepository } from "../jobs/index.js";
import { createLogger } from "../logger.js";
import {
  MediaAnalysisRepository,
  MediaRepository,
  MediaService,
  MediaVersionsRepository,
  listMediaOptionsSchema,
  type MediaSoftDeleteDeps,
} from "../media/index.js";
import { LocalStorageProvider } from "../storage/index.js";
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
// fixtures
// ---------------------------------------------------------------------------

function seedMedia(
  db: SqliteDatabase,
  args: {
    tripId: string;
    createdAt?: string;
    status?: string;
  },
): string {
  const mediaId = randomUUID();
  const now = args.createdAt ?? new Date().toISOString();
  const status = args.status ?? "processed";
  db.prepare(
    `INSERT INTO media_items
       (id, trip_id, type, original_path, thumbnail_path,
        mime_type, extension, file_size,
        status, user_decision, created_at, updated_at)
     VALUES (?, ?, 'image', ?, ?,
             'image/jpeg', 'jpg', 1024,
             ?, 'undecided', ?, ?)`,
  ).run(
    mediaId,
    args.tripId,
    `trips/${args.tripId}/originals/${mediaId}.jpg`,
    `trips/${args.tripId}/derived/${mediaId}/thumb.webp`,
    status,
    now,
    now,
  );
  return mediaId;
}

// Sleep enough that ISO timestamps differ. Soft-delete uses
// `new Date().toISOString()` which has ms precision; better-sqlite3
// runs ops faster than 1ms, so we need an explicit pause to make
// `deleted_at DESC` deterministic across two consecutive deletes.
async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-recycle-bin-smoke-"));
  const dbPath = path.join(tmpRoot, "smoke.db");
  const storageRoot = path.join(tmpRoot, "storage");
  console.log(`[smoke] tmpRoot=${tmpRoot}`);

  const dbHandle = openDatabase(dbPath);
  try {
    runMigrations(dbHandle.db);

    const logger = createLogger({ nodeEnv: "test" });
    const storage = LocalStorageProvider.create(storageRoot);
    void storage;
    const tripRepo = new TripRepository(dbHandle.db);
    const tripService = new TripService(tripRepo);
    const mediaRepo = new MediaRepository(dbHandle.db);
    const mediaVersionsRepo = new MediaVersionsRepository(dbHandle.db);
    const mediaAnalysisRepo = new MediaAnalysisRepository(dbHandle.db);
    void mediaAnalysisRepo;
    const duplicateGroupsRepo = new DuplicateGroupsRepository(dbHandle.db);
    const jobRepo = new JobRepository(dbHandle.db);

    const softDeleteDeps: MediaSoftDeleteDeps = {
      db: dbHandle.db,
      tripRepo,
      duplicateGroupsRepo,
      logger,
    };
    const mediaService = new MediaService(
      mediaRepo,
      tripService,
      mediaVersionsRepo,
      jobRepo,
      softDeleteDeps,
    );

    // -----------------------------------------------------------------
    // CASE 1: zod schema accepts onlyDeleted (default false, true,
    //         malformed rejected).
    // -----------------------------------------------------------------
    {
      const parsedDefault = listMediaOptionsSchema.parse({});
      record(
        "schema: defaults onlyDeleted=false",
        parsedDefault.onlyDeleted === false,
        `parsed=${JSON.stringify(parsedDefault)}`,
      );
      const parsedTrue = listMediaOptionsSchema.parse({ onlyDeleted: "true" });
      record(
        "schema: coerces ?onlyDeleted=true to boolean true",
        parsedTrue.onlyDeleted === true,
        `parsed=${JSON.stringify(parsedTrue)}`,
      );
      // strict() rejects unknown keys — sanity check the schema is
      // still strict (so future query bloat is forced to add a field).
      let threw: unknown;
      try {
        listMediaOptionsSchema.parse({ bogusKey: "x" });
      } catch (err) {
        threw = err;
      }
      record(
        "schema: still strict() — unknown query keys rejected",
        threw !== undefined,
        describeError(threw),
      );
    }

    // -----------------------------------------------------------------
    // CASE 2: default list still hides deleted media.
    // -----------------------------------------------------------------
    const trip1 = tripService.createTrip({ title: "Case2 default-hides-deleted" });
    const activeA = seedMedia(dbHandle.db, { tripId: trip1.id });
    const activeB = seedMedia(dbHandle.db, { tripId: trip1.id });
    const deletedA = seedMedia(dbHandle.db, { tripId: trip1.id });
    mediaService.softDeleteMedia(deletedA);
    {
      const def = mediaService.listMediaForTrip(trip1.id);
      record(
        "default: list excludes soft-deleted media",
        def.length === 2 && def.every((m) => m.id !== deletedA),
        `count=${def.length} ids=${def.map((m) => m.id).join(",")}`,
      );
      const ids = new Set(def.map((m) => m.id));
      record(
        "default: list still includes both active rows",
        ids.has(activeA) && ids.has(activeB),
        `ids=${[...ids].join(",")}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 3: onlyDeleted=true returns ONLY soft-deleted media.
    // -----------------------------------------------------------------
    {
      const bin = mediaService.listMediaForTrip(trip1.id, { onlyDeleted: true });
      record(
        "onlyDeleted: returns exactly the soft-deleted rows",
        bin.length === 1 && bin[0]?.id === deletedA,
        `count=${bin.length} ids=${bin.map((m) => m.id).join(",")}`,
      );
      record(
        "onlyDeleted: row carries non-null deletedAt + status='deleted'",
        bin[0]?.deletedAt !== null && bin[0]?.status === "deleted",
        `deletedAt=${String(bin[0]?.deletedAt)} status=${String(bin[0]?.status)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 4: ordering is deleted_at DESC (most-recent first).
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case4 ordering" });
      const m1 = seedMedia(dbHandle.db, { tripId: trip.id });
      const m2 = seedMedia(dbHandle.db, { tripId: trip.id });
      const m3 = seedMedia(dbHandle.db, { tripId: trip.id });
      mediaService.softDeleteMedia(m1);
      await sleep(5);
      mediaService.softDeleteMedia(m2);
      await sleep(5);
      mediaService.softDeleteMedia(m3);
      const bin = mediaService.listMediaForTrip(trip.id, { onlyDeleted: true });
      record(
        "ordering: deleted_at DESC — m3 first, m1 last",
        bin.length === 3 && bin[0]?.id === m3 && bin[1]?.id === m2 && bin[2]?.id === m1,
        `order=${bin.map((m) => m.id).join(",")}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 5: empty case — a trip with no deletes returns [].
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case5 empty bin" });
      seedMedia(dbHandle.db, { tripId: trip.id });
      seedMedia(dbHandle.db, { tripId: trip.id });
      const bin = mediaService.listMediaForTrip(trip.id, { onlyDeleted: true });
      record("empty: bin is empty when no deletes", bin.length === 0, `count=${bin.length}`);
    }

    // -----------------------------------------------------------------
    // CASE 6: trip scoping — sibling trip's deletes don't leak in.
    // -----------------------------------------------------------------
    {
      const tripA = tripService.createTrip({ title: "Case6 trip A" });
      const tripB = tripService.createTrip({ title: "Case6 trip B" });
      const a1 = seedMedia(dbHandle.db, { tripId: tripA.id });
      const b1 = seedMedia(dbHandle.db, { tripId: tripB.id });
      mediaService.softDeleteMedia(a1);
      mediaService.softDeleteMedia(b1);
      const binA = mediaService.listMediaForTrip(tripA.id, { onlyDeleted: true });
      const binB = mediaService.listMediaForTrip(tripB.id, { onlyDeleted: true });
      record(
        "scoping: tripA recycle-bin contains only a1",
        binA.length === 1 && binA[0]?.id === a1,
        `ids=${binA.map((m) => m.id).join(",")}`,
      );
      record(
        "scoping: tripB recycle-bin contains only b1",
        binB.length === 1 && binB[0]?.id === b1,
        `ids=${binB.map((m) => m.id).join(",")}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 7: onlyDeleted wins over includeDeleted.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case7 precedence" });
      const active = seedMedia(dbHandle.db, { tripId: trip.id });
      const deleted = seedMedia(dbHandle.db, { tripId: trip.id });
      mediaService.softDeleteMedia(deleted);
      const bin = mediaService.listMediaForTrip(trip.id, {
        onlyDeleted: true,
        includeDeleted: true,
      });
      record(
        "precedence: onlyDeleted=true beats includeDeleted=true → only deleted rows",
        bin.length === 1 && bin[0]?.id === deleted,
        `count=${bin.length} ids=${bin.map((m) => m.id).join(",")}`,
      );
      // Sanity: with includeDeleted alone we see both (admin / combined view).
      const combined = mediaService.listMediaForTrip(trip.id, { includeDeleted: true });
      record(
        "precedence: includeDeleted alone returns combined active+deleted",
        combined.length === 2 &&
          combined.some((m) => m.id === active) &&
          combined.some((m) => m.id === deleted),
        `count=${combined.length} ids=${combined.map((m) => m.id).join(",")}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 8: restore-from-recycle-bin chain.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case8 restore chain" });
      const m = seedMedia(dbHandle.db, { tripId: trip.id });
      mediaService.softDeleteMedia(m);
      const binBefore = mediaService.listMediaForTrip(trip.id, { onlyDeleted: true });
      record(
        "restore-chain: m is in the recycle bin pre-restore",
        binBefore.some((mm) => mm.id === m),
        `count=${binBefore.length}`,
      );
      mediaService.restoreMedia(m);
      const binAfter = mediaService.listMediaForTrip(trip.id, { onlyDeleted: true });
      record(
        "restore-chain: m is gone from the recycle bin post-restore",
        !binAfter.some((mm) => mm.id === m),
        `count=${binAfter.length}`,
      );
      const galleryAfter = mediaService.listMediaForTrip(trip.id);
      record(
        "restore-chain: m re-appears in the default gallery list",
        galleryAfter.some((mm) => mm.id === m),
        `count=${galleryAfter.length}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 9: pagination still applies to the deleted-only view
    //         (sanity, the bin uses the same LIMIT / OFFSET path).
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case9 pagination" });
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const m = seedMedia(dbHandle.db, { tripId: trip.id });
        ids.push(m);
      }
      for (const id of ids) {
        mediaService.softDeleteMedia(id);
        await sleep(2);
      }
      const page1 = mediaService.listMediaForTrip(trip.id, {
        onlyDeleted: true,
        limit: 2,
        offset: 0,
      });
      const page2 = mediaService.listMediaForTrip(trip.id, {
        onlyDeleted: true,
        limit: 2,
        offset: 2,
      });
      const page3 = mediaService.listMediaForTrip(trip.id, {
        onlyDeleted: true,
        limit: 2,
        offset: 4,
      });
      const total = page1.length + page2.length + page3.length;
      record(
        "pagination: limit=2 over 5 deleted rows produces 2+2+1",
        page1.length === 2 && page2.length === 2 && page3.length === 1 && total === 5,
        `pages=${page1.length},${page2.length},${page3.length}`,
      );
    }
  } finally {
    closeDatabase(dbHandle);
    await rm(tmpRoot, { recursive: true, force: true });
    console.log(`[smoke] cleaned up ${tmpRoot}`);
  }

  // -------------------------------------------------------------------
  // summary
  // -------------------------------------------------------------------
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
