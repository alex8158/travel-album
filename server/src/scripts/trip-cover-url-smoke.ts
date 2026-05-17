// Manual smoke test for the derived trip cover_url (P3.T8).
//
// Usage: npm run smoke:trip-cover-url
//
// Exercises `deriveCoverUrl(trip, mediaRepo)` directly (no HTTP) and
// asserts the three-priority rule:
//
//   1. trip.coverMediaId pinned → use that media's thumbnail
//   2. coverMediaId NULL → use oldest active image with a thumbnail
//   3. otherwise → placeholder
//
// Plus the fall-through edges:
//   * Pin points at a soft-deleted media → fall through to priority 2
//   * Pin points at a non-image media → fall through to priority 2
//   * Pin points at an image with no thumbnail yet → fall through to
//     priority 2
//   * Pin points at a non-existent media id → fall through to priority 2
//
// And ordering edges for priority 2:
//   * Soft-deleted images are skipped
//   * Images without thumbnail are skipped
//   * Oldest created_at wins
//
// No DB writes from the helper itself — assertion: trips table values
// never mutate while deriveCoverUrl runs.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { MediaRepository } from "../media/index.js";
import {
  deriveCoverUrl,
  PLACEHOLDER_COVER_URL,
  TripRepository,
  TripService,
  type Trip,
} from "../trips/index.js";

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

function insertMedia(
  db: SqliteDatabase,
  args: {
    readonly tripId: string;
    readonly type: "image" | "video" | "unknown";
    readonly createdAt: string;
    readonly thumbnailPath?: string | null;
    readonly deletedAt?: string;
  },
): string {
  const id = randomUUID();
  const now = args.createdAt;
  db.prepare(
    `INSERT INTO media_items
       (id, trip_id, type, original_path, mime_type, extension, file_size,
        thumbnail_path, status, user_decision, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, 'image/jpeg', 'jpg', 1024,
             ?, 'uploaded', 'undecided', ?, ?, ?)`,
  ).run(
    id,
    args.tripId,
    args.type,
    args.type === "image" ? `trips/${args.tripId}/originals/${id}.jpg` : null,
    args.thumbnailPath ?? null,
    now,
    now,
    args.deletedAt ?? null,
  );
  return id;
}

function tripsRowCount(
  db: SqliteDatabase,
  tripId: string,
): {
  coverMediaId: string | null;
  updatedAt: string;
} {
  const row = db
    .prepare(`SELECT cover_media_id, updated_at FROM trips WHERE id = ?`)
    .get(tripId) as { cover_media_id: string | null; updated_at: string };
  return { coverMediaId: row.cover_media_id, updatedAt: row.updated_at };
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-trip-cover-url-smoke-"));
  const dbPath = path.join(tmpRoot, "smoke.db");
  console.log(`[smoke] dbPath=${dbPath}`);

  const dbHandle = openDatabase(dbPath);
  try {
    runMigrations(dbHandle.db);

    const tripService = new TripService(new TripRepository(dbHandle.db));
    const mediaRepo = new MediaRepository(dbHandle.db);

    // -------------------------------------------------------------------
    // CASE 1: empty trip → placeholder
    // -------------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Empty trip" });
      const url = deriveCoverUrl(trip, mediaRepo);
      record("empty trip → placeholder URL", url === PLACEHOLDER_COVER_URL, `url=${url}`);
    }

    // -------------------------------------------------------------------
    // CASE 2: trip with one thumbnailed image, no pin → derive that
    // -------------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "One image trip" });
      const thumbPath = `trips/${trip.id}/derived/m1/thumb.webp`;
      insertMedia(dbHandle.db, {
        tripId: trip.id,
        type: "image",
        thumbnailPath: thumbPath,
        createdAt: "2026-05-01T00:00:00.000Z",
      });
      const url = deriveCoverUrl(trip, mediaRepo);
      record(
        "single-image trip → /storage/<thumbnail_path>",
        url === `/storage/${thumbPath}`,
        `url=${url}`,
      );
    }

    // -------------------------------------------------------------------
    // CASE 3: trip with multiple images → pick oldest
    // -------------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Multi-image trip" });
      const olderPath = `trips/${trip.id}/derived/m-older/thumb.webp`;
      const newerPath = `trips/${trip.id}/derived/m-newer/thumb.webp`;
      insertMedia(dbHandle.db, {
        tripId: trip.id,
        type: "image",
        thumbnailPath: newerPath,
        createdAt: "2026-05-01T02:00:00.000Z",
      });
      insertMedia(dbHandle.db, {
        tripId: trip.id,
        type: "image",
        thumbnailPath: olderPath,
        createdAt: "2026-05-01T00:00:00.000Z",
      });
      const url = deriveCoverUrl(trip, mediaRepo);
      record(
        "multi-image trip → oldest thumbnail wins",
        url === `/storage/${olderPath}`,
        `url=${url}`,
      );
    }

    // -------------------------------------------------------------------
    // CASE 4: image without thumbnail is skipped
    // -------------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Mixed thumb trip" });
      // Old image without thumbnail (still processing).
      insertMedia(dbHandle.db, {
        tripId: trip.id,
        type: "image",
        thumbnailPath: null,
        createdAt: "2026-05-01T00:00:00.000Z",
      });
      // Newer image with thumbnail.
      const newerPath = `trips/${trip.id}/derived/m-newer/thumb.webp`;
      insertMedia(dbHandle.db, {
        tripId: trip.id,
        type: "image",
        thumbnailPath: newerPath,
        createdAt: "2026-05-01T02:00:00.000Z",
      });
      const url = deriveCoverUrl(trip, mediaRepo);
      record(
        "image without thumbnail skipped → newer thumbnailed wins",
        url === `/storage/${newerPath}`,
        `url=${url}`,
      );
    }

    // -------------------------------------------------------------------
    // CASE 5: video / unknown media never act as cover
    // -------------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Video-only trip" });
      insertMedia(dbHandle.db, {
        tripId: trip.id,
        type: "video",
        thumbnailPath: `trips/${trip.id}/derived/v1/thumb.webp`,
        createdAt: "2026-05-01T00:00:00.000Z",
      });
      insertMedia(dbHandle.db, {
        tripId: trip.id,
        type: "unknown",
        thumbnailPath: null,
        createdAt: "2026-05-01T01:00:00.000Z",
      });
      const url = deriveCoverUrl(trip, mediaRepo);
      record(
        "trip with only video/unknown → placeholder",
        url === PLACEHOLDER_COVER_URL,
        `url=${url}`,
      );
    }

    // -------------------------------------------------------------------
    // CASE 6: soft-deleted images are skipped
    // -------------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Soft-deleted trip" });
      insertMedia(dbHandle.db, {
        tripId: trip.id,
        type: "image",
        thumbnailPath: `trips/${trip.id}/derived/m-deleted/thumb.webp`,
        createdAt: "2026-05-01T00:00:00.000Z",
        deletedAt: "2026-05-01T01:00:00.000Z",
      });
      const url = deriveCoverUrl(trip, mediaRepo);
      record(
        "trip with only soft-deleted image → placeholder",
        url === PLACEHOLDER_COVER_URL,
        `url=${url}`,
      );
    }

    // -------------------------------------------------------------------
    // CASE 7: explicit pin to a thumbnailed image → priority 1 wins
    // -------------------------------------------------------------------
    let pinnedTripId = "";
    {
      const trip = tripService.createTrip({ title: "Pinned trip" });
      pinnedTripId = trip.id;
      const olderPath = `trips/${trip.id}/derived/m-older/thumb.webp`;
      const pinnedPath = `trips/${trip.id}/derived/m-pinned/thumb.webp`;
      // Older image — would win on priority 2.
      insertMedia(dbHandle.db, {
        tripId: trip.id,
        type: "image",
        thumbnailPath: olderPath,
        createdAt: "2026-05-01T00:00:00.000Z",
      });
      // Newer image — pinned via cover_media_id.
      const pinnedId = insertMedia(dbHandle.db, {
        tripId: trip.id,
        type: "image",
        thumbnailPath: pinnedPath,
        createdAt: "2026-05-01T05:00:00.000Z",
      });
      // Set the pin.
      const pinned = tripService.updateTrip(trip.id, { coverMediaId: pinnedId });
      const url = deriveCoverUrl(pinned, mediaRepo);
      record(
        "explicit pin wins over older derived image",
        url === `/storage/${pinnedPath}`,
        `url=${url}`,
      );
    }

    // -------------------------------------------------------------------
    // CASE 8: pin to non-existent media → fall through to priority 2
    // -------------------------------------------------------------------
    {
      // Build a synthetic Trip with a bogus coverMediaId — don't go
      // through tripService.updateTrip because the FK would reject.
      const trip = tripService.createTrip({ title: "Bogus-pin trip" });
      const derivedPath = `trips/${trip.id}/derived/m1/thumb.webp`;
      insertMedia(dbHandle.db, {
        tripId: trip.id,
        type: "image",
        thumbnailPath: derivedPath,
        createdAt: "2026-05-01T00:00:00.000Z",
      });
      const fakeTrip: Trip = {
        ...trip,
        coverMediaId: "definitely-not-a-real-media-id",
      };
      const url = deriveCoverUrl(fakeTrip, mediaRepo);
      record(
        "pin to non-existent media → fall through to derived",
        url === `/storage/${derivedPath}`,
        `url=${url}`,
      );
    }

    // -------------------------------------------------------------------
    // CASE 9: pin to media without thumbnail yet → fall through
    // -------------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Pin-no-thumb trip" });
      const fallbackPath = `trips/${trip.id}/derived/m-fallback/thumb.webp`;
      const pinnedId = insertMedia(dbHandle.db, {
        tripId: trip.id,
        type: "image",
        thumbnailPath: null,
        createdAt: "2026-05-01T00:00:00.000Z",
      });
      // A second image WITH a thumbnail.
      insertMedia(dbHandle.db, {
        tripId: trip.id,
        type: "image",
        thumbnailPath: fallbackPath,
        createdAt: "2026-05-01T02:00:00.000Z",
      });
      const pinned = tripService.updateTrip(trip.id, { coverMediaId: pinnedId });
      const url = deriveCoverUrl(pinned, mediaRepo);
      record(
        "pin to image without thumbnail → fall through to oldest thumbnailed",
        url === `/storage/${fallbackPath}`,
        `url=${url}`,
      );
    }

    // -------------------------------------------------------------------
    // CASE 10: pin to a video media → fall through to derived image
    // -------------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Pin-video trip" });
      const imgPath = `trips/${trip.id}/derived/m-image/thumb.webp`;
      const videoId = insertMedia(dbHandle.db, {
        tripId: trip.id,
        type: "video",
        thumbnailPath: `trips/${trip.id}/derived/m-video/video_cover.jpg`,
        createdAt: "2026-05-01T00:00:00.000Z",
      });
      insertMedia(dbHandle.db, {
        tripId: trip.id,
        type: "image",
        thumbnailPath: imgPath,
        createdAt: "2026-05-01T02:00:00.000Z",
      });
      const pinned = tripService.updateTrip(trip.id, { coverMediaId: videoId });
      const url = deriveCoverUrl(pinned, mediaRepo);
      record(
        "pin to video media → fall through to derived image",
        url === `/storage/${imgPath}`,
        `url=${url}`,
      );
    }

    // -------------------------------------------------------------------
    // CASE 11: helper is read-only — trips row never mutates
    // -------------------------------------------------------------------
    {
      const before = tripsRowCount(dbHandle.db, pinnedTripId);
      // Call deriveCoverUrl many times — should not touch the DB.
      const trip = tripService.getTripById(pinnedTripId);
      for (let i = 0; i < 5; i += 1) {
        deriveCoverUrl(trip, mediaRepo);
      }
      const after = tripsRowCount(dbHandle.db, pinnedTripId);
      record(
        "deriveCoverUrl does not write to trips (cover_media_id unchanged)",
        before.coverMediaId === after.coverMediaId,
        `before=${String(before.coverMediaId)} after=${String(after.coverMediaId)}`,
      );
      record(
        "deriveCoverUrl does not write to trips (updated_at unchanged)",
        before.updatedAt === after.updatedAt,
        `before=${before.updatedAt} after=${after.updatedAt}`,
      );
    }

    // -------------------------------------------------------------------
    // CASE 12: PLACEHOLDER_COVER_URL is the documented constant
    // -------------------------------------------------------------------
    {
      record(
        "PLACEHOLDER_COVER_URL constant matches '/placeholder-cover.svg'",
        PLACEHOLDER_COVER_URL === "/placeholder-cover.svg",
        `value=${PLACEHOLDER_COVER_URL}`,
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
