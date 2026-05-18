// Manual smoke test for the Dedup API (P5.T5).
//
// Usage: npm run smoke:dedup-api
//
// Boots a minimal Express app with just the Dedup router wired up,
// listens on an ephemeral port, hits each endpoint via fetch, and
// asserts on status / response shape. Underlying DedupEngine
// correctness is covered by smoke:dedup-exact / smoke:dedup-similar;
// this smoke focuses on the HTTP edge — validation, path binding,
// trip-existence checking, body parsing, and the response envelope
// shape.
//
// Coverage:
//   * POST /api/trips/:tripId/dedup/exact happy → 200 + groupType='exact'
//   * POST /api/trips/:tripId/dedup/similar happy → 200 + groupType='similar'
//   * POST /api/trips/:tripId/dedup/run happy → 200 + { exact, similar }
//   * run order: exact runs first; similar cohort overlapping exact
//     members is skipped (cohortsSkippedByReason populated)
//   * Idempotency: a second call yields groupsCreated=0 and surfaces
//     `cohortsSkippedByReason["already-grouped"] >= 1`
//   * 400 for malformed tripId (path validation)
//   * 404 for missing / soft-deleted trip
//   * 400 for invalid hammingThreshold (negative / > 64 / non-int)
//   * hammingThreshold body field is forwarded to the engine
//     (verified by surfacing it back in the response payload)
//   * Cross-trip safety: body has no mediaId / tripId fields that
//     can leak the scope — confirmed by the schema rejecting
//     unknown keys silently (no-op) and the route only reading
//     tripId from the URL path.
//   * NULL hash / video / soft-deleted media still excluded at the
//     engine level (sanity check that wiring did not bypass filters).

import express from "express";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import {
  DEFAULT_SIMILAR_HAMMING_THRESHOLD,
  DedupEngine,
  DedupService,
  DuplicateGroupsRepository,
} from "../dedup/index.js";
import { createLogger } from "../logger.js";
import { MediaRepository } from "../media/index.js";
import { makeErrorHandler, notFoundHandler } from "../middleware/errorHandler.js";
import { requestIdMiddleware } from "../middleware/requestId.js";
import { makeDedupRouter } from "../routes/dedup.js";
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

const D_HASH_TAIL = "0000000000000000";
const BASE_P = "abcdef0123456789";

function flipPHashBits(base: string, bitsToFlip: readonly number[]): string {
  const nibbles: number[] = [];
  for (let i = 0; i < 16; i += 1) nibbles.push(parseInt(base[i] as string, 16));
  for (const bit of bitsToFlip) {
    const nibbleIdx = 15 - Math.floor(bit / 4);
    const shiftInNibble = bit % 4;
    nibbles[nibbleIdx] = (nibbles[nibbleIdx] as number) ^ (1 << shiftInNibble);
  }
  return nibbles.map((n) => n.toString(16)).join("");
}

function fullPHash(p16: string): string {
  return p16 + D_HASH_TAIL;
}

function nowIso(): string {
  return new Date().toISOString();
}

function seedMedia(
  db: SqliteDatabase,
  args: {
    tripId: string;
    fileHash?: string | null;
    perceptualHash?: string | null;
    type?: "image" | "video";
    softDeleted?: boolean;
  },
): string {
  const mediaId = randomUUID();
  const now = nowIso();
  db.prepare(
    `INSERT INTO media_items
       (id, trip_id, type, original_path, mime_type, extension, file_size,
        file_hash, perceptual_hash, status, user_decision,
        created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?,
             ?, ?, ?, 'undecided',
             ?, ?, ?)`,
  ).run(
    mediaId,
    args.tripId,
    args.type ?? "image",
    `trips/${args.tripId}/originals/${mediaId}.${args.type === "video" ? "mp4" : "jpg"}`,
    args.type === "video" ? "video/mp4" : "image/jpeg",
    args.type === "video" ? "mp4" : "jpg",
    1024,
    args.fileHash ?? null,
    args.perceptualHash ?? null,
    args.softDeleted === true ? "deleted" : "uploaded",
    now,
    now,
    args.softDeleted === true ? now : null,
  );
  return mediaId;
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-dedup-api-smoke-"));
  const dbPath = path.join(tmpRoot, "smoke.db");
  console.log(`[smoke] dbPath=${dbPath}`);

  const dbHandle = openDatabase(dbPath);
  const logger = createLogger({ nodeEnv: "test" });

  let server: ReturnType<typeof createServer> | null = null;
  try {
    runMigrations(dbHandle.db);

    const tripService = new TripService(new TripRepository(dbHandle.db));
    const mediaRepo = new MediaRepository(dbHandle.db);
    const duplicateGroupsRepo = new DuplicateGroupsRepository(dbHandle.db);
    const dedupEngine = new DedupEngine({ mediaRepo, duplicateGroupsRepo, logger });
    const dedupService = new DedupService(dedupEngine, tripService);

    // Minimal Express app — only the dedup router + standard error
    // pipeline. Other routers (trips / media / storage / jobs) are
    // not needed for this surface check.
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use(requestIdMiddleware);
    app.use("/api", makeDedupRouter({ service: dedupService }));
    app.use(notFoundHandler);
    app.use(makeErrorHandler(logger));

    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    console.log(`[smoke] server listening on ${base}`);

    // -----------------------------------------------------------------
    // CASE 1: POST /dedup/exact happy path
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case1" });
      seedMedia(dbHandle.db, { tripId: trip.id, fileHash: "h-case1" });
      seedMedia(dbHandle.db, { tripId: trip.id, fileHash: "h-case1" });

      const res = await fetch(`${base}/api/trips/${encodeURIComponent(trip.id)}/dedup/exact`, {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      const body = (await res.json()) as {
        tripId: string;
        groupType: string;
        groupsCreated: number;
        mediaScanned: number;
        cohortsSkippedByReason: Record<string, number>;
      };
      record(
        "POST /dedup/exact → 200 + groupType='exact' + groupsCreated=1 + mediaScanned=2",
        res.status === 200 &&
          body.groupType === "exact" &&
          body.tripId === trip.id &&
          body.groupsCreated === 1 &&
          body.mediaScanned === 2,
        `status=${res.status} body=${JSON.stringify(body)}`,
      );
      record(
        "POST /dedup/exact → cohortsSkippedByReason is an object (empty on first run)",
        typeof body.cohortsSkippedByReason === "object" &&
          Object.keys(body.cohortsSkippedByReason).length === 0,
        `byReason=${JSON.stringify(body.cohortsSkippedByReason)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 2: idempotency — second call yields 0 created + reason count
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case2 idempotent" });
      seedMedia(dbHandle.db, { tripId: trip.id, fileHash: "h-case2" });
      seedMedia(dbHandle.db, { tripId: trip.id, fileHash: "h-case2" });

      const url = `${base}/api/trips/${encodeURIComponent(trip.id)}/dedup/exact`;
      const first = (await (await fetch(url, { method: "POST" })).json()) as {
        groupsCreated: number;
      };
      const second = (await (await fetch(url, { method: "POST" })).json()) as {
        groupsCreated: number;
        cohortsSkippedByReason: Record<string, number>;
      };
      record(
        "exact idempotency: first call creates 1, second creates 0 + already-grouped count >= 1",
        first.groupsCreated === 1 &&
          second.groupsCreated === 0 &&
          (second.cohortsSkippedByReason["already-grouped"] ?? 0) >= 1,
        `first=${JSON.stringify(first)} second=${JSON.stringify(second)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 3: POST /dedup/similar happy path (with hammingThreshold)
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case3" });
      seedMedia(dbHandle.db, {
        tripId: trip.id,
        perceptualHash: fullPHash(BASE_P),
      });
      // distance 5 — comfortably within default threshold 8
      seedMedia(dbHandle.db, {
        tripId: trip.id,
        perceptualHash: fullPHash(flipPHashBits(BASE_P, [0, 1, 2, 3, 4])),
      });

      const res = await fetch(`${base}/api/trips/${encodeURIComponent(trip.id)}/dedup/similar`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ hammingThreshold: 8 }),
      });
      const body = (await res.json()) as {
        groupType: string;
        hammingThreshold: number;
        groupsCreated: number;
        cohortsSkippedByReason: Record<string, number>;
      };
      record(
        "POST /dedup/similar → 200 + groupType='similar' + threshold forwarded + 1 group",
        res.status === 200 &&
          body.groupType === "similar" &&
          body.hammingThreshold === 8 &&
          body.groupsCreated === 1,
        `status=${res.status} body=${JSON.stringify(body)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 4: POST /dedup/similar uses default threshold when body
    // omits hammingThreshold; empty body OK.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case4 default threshold" });
      seedMedia(dbHandle.db, { tripId: trip.id, perceptualHash: fullPHash(BASE_P) });
      seedMedia(dbHandle.db, {
        tripId: trip.id,
        perceptualHash: fullPHash(flipPHashBits(BASE_P, [0, 1, 2])),
      });
      const res = await fetch(`${base}/api/trips/${encodeURIComponent(trip.id)}/dedup/similar`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await res.json()) as {
        hammingThreshold: number;
        groupsCreated: number;
      };
      record(
        "POST /dedup/similar default threshold: response.hammingThreshold == default + group created",
        res.status === 200 &&
          body.hammingThreshold === DEFAULT_SIMILAR_HAMMING_THRESHOLD &&
          body.groupsCreated === 1,
        `body=${JSON.stringify(body)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 5: POST /dedup/run happy path — exact then similar.
    // Seed both an exact pair (file_hash) and a similar pair
    // (perceptual_hash) within the same trip but for DIFFERENT
    // media so each algorithm creates its own group. Verify exact
    // ran first by checking it's present in `body.exact`.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case5 run" });
      // exact pair
      seedMedia(dbHandle.db, { tripId: trip.id, fileHash: "h-case5-exact" });
      seedMedia(dbHandle.db, { tripId: trip.id, fileHash: "h-case5-exact" });
      // similar pair (no file_hash so they're not in any exact cohort)
      seedMedia(dbHandle.db, {
        tripId: trip.id,
        perceptualHash: fullPHash(flipPHashBits(BASE_P, [10, 11, 12])),
      });
      seedMedia(dbHandle.db, {
        tripId: trip.id,
        perceptualHash: fullPHash(flipPHashBits(BASE_P, [10, 11, 12, 13])),
      });
      const res = await fetch(`${base}/api/trips/${encodeURIComponent(trip.id)}/dedup/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ hammingThreshold: 8 }),
      });
      const body = (await res.json()) as {
        tripId: string;
        exact: { groupType: string; groupsCreated: number };
        similar: { groupType: string; groupsCreated: number; hammingThreshold: number };
      };
      record(
        "POST /dedup/run → 200 + exact.created=1 + similar.created=1 + threshold forwarded",
        res.status === 200 &&
          body.exact.groupType === "exact" &&
          body.exact.groupsCreated === 1 &&
          body.similar.groupType === "similar" &&
          body.similar.groupsCreated === 1 &&
          body.similar.hammingThreshold === 8,
        `body=${JSON.stringify(body)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 6: /dedup/run: similar respects exact group created in
    // the same call. Seed 2 media that share BOTH file_hash AND
    // pHash within threshold. After run: exact creates the group;
    // similar skips overlapping cohort.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case6 ordering" });
      seedMedia(dbHandle.db, {
        tripId: trip.id,
        fileHash: "h-case6",
        perceptualHash: fullPHash(BASE_P),
      });
      seedMedia(dbHandle.db, {
        tripId: trip.id,
        fileHash: "h-case6",
        perceptualHash: fullPHash(flipPHashBits(BASE_P, [0, 1, 2])),
      });
      const res = await fetch(`${base}/api/trips/${encodeURIComponent(trip.id)}/dedup/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ hammingThreshold: 8 }),
      });
      const body = (await res.json()) as {
        exact: { groupsCreated: number };
        similar: {
          groupsCreated: number;
          cohortsSkippedByReason: Record<string, number>;
        };
      };
      record(
        "run ordering: exact creates 1, similar skips overlapping cohort (groupsCreated=0)",
        body.exact.groupsCreated === 1 &&
          body.similar.groupsCreated === 0 &&
          (body.similar.cohortsSkippedByReason["already-grouped"] ?? 0) >= 1,
        `body=${JSON.stringify(body)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 7: 400 for malformed tripId
    // -----------------------------------------------------------------
    {
      // `bad.id` contains a dot — entityIdSchema rejects.
      const res = await fetch(`${base}/api/trips/bad.id/dedup/exact`, { method: "POST" });
      const body = (await res.json()) as { error?: { code?: string } };
      record(
        "malformed tripId → 400 VALIDATION_FAILED",
        res.status === 400 && body.error?.code === "VALIDATION_FAILED",
        `status=${res.status} code=${body.error?.code ?? "(none)"}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 8: 404 for missing trip
    // -----------------------------------------------------------------
    {
      const res = await fetch(
        `${base}/api/trips/${encodeURIComponent("never-such-trip")}/dedup/exact`,
        { method: "POST" },
      );
      const body = (await res.json()) as { error?: { code?: string } };
      record(
        "missing trip → 404 NOT_FOUND",
        res.status === 404 && body.error?.code === "NOT_FOUND",
        `status=${res.status} code=${body.error?.code ?? "(none)"}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 9: 404 for soft-deleted trip
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case9 soft-delete" });
      tripService.softDeleteTrip(trip.id);
      const res = await fetch(`${base}/api/trips/${encodeURIComponent(trip.id)}/dedup/exact`, {
        method: "POST",
      });
      const body = (await res.json()) as { error?: { code?: string } };
      record(
        "soft-deleted trip → 404 NOT_FOUND",
        res.status === 404 && body.error?.code === "NOT_FOUND",
        `status=${res.status} code=${body.error?.code ?? "(none)"}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 10: 400 for invalid hammingThreshold (negative)
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case10 negative threshold" });
      const res = await fetch(`${base}/api/trips/${encodeURIComponent(trip.id)}/dedup/similar`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ hammingThreshold: -1 }),
      });
      const body = (await res.json()) as { error?: { code?: string } };
      record(
        "hammingThreshold < 0 → 400 VALIDATION_FAILED",
        res.status === 400 && body.error?.code === "VALIDATION_FAILED",
        `status=${res.status} code=${body.error?.code ?? "(none)"}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 11: 400 for invalid hammingThreshold (> 64)
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case11 too-large threshold" });
      const res = await fetch(`${base}/api/trips/${encodeURIComponent(trip.id)}/dedup/similar`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ hammingThreshold: 65 }),
      });
      const body = (await res.json()) as { error?: { code?: string } };
      record(
        "hammingThreshold > 64 → 400 VALIDATION_FAILED",
        res.status === 400 && body.error?.code === "VALIDATION_FAILED",
        `status=${res.status} code=${body.error?.code ?? "(none)"}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 12: 400 for invalid hammingThreshold (non-integer)
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case12 non-int threshold" });
      const res = await fetch(`${base}/api/trips/${encodeURIComponent(trip.id)}/dedup/similar`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ hammingThreshold: 4.7 }),
      });
      const body = (await res.json()) as { error?: { code?: string } };
      record(
        "non-integer hammingThreshold → 400 VALIDATION_FAILED",
        res.status === 400 && body.error?.code === "VALIDATION_FAILED",
        `status=${res.status} code=${body.error?.code ?? "(none)"}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 13: hammingThreshold overrides default — set it to 1 so
    // the previous "distance 5" pair would NOT cluster.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case13 tight threshold" });
      seedMedia(dbHandle.db, { tripId: trip.id, perceptualHash: fullPHash(BASE_P) });
      seedMedia(dbHandle.db, {
        tripId: trip.id,
        perceptualHash: fullPHash(flipPHashBits(BASE_P, [0, 1, 2, 3, 4])),
      });
      const res = await fetch(`${base}/api/trips/${encodeURIComponent(trip.id)}/dedup/similar`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ hammingThreshold: 1 }),
      });
      const body = (await res.json()) as {
        hammingThreshold: number;
        groupsCreated: number;
      };
      record(
        "tight threshold (1) overrides default: 0 groups created + threshold echoed",
        res.status === 200 && body.hammingThreshold === 1 && body.groupsCreated === 0,
        `body=${JSON.stringify(body)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 14: filters still apply — soft-deleted / video / NULL
    // hash media should not show up in mediaScanned.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case14 filters" });
      // One valid pair (will form a group)
      seedMedia(dbHandle.db, { tripId: trip.id, fileHash: "h-case14" });
      seedMedia(dbHandle.db, { tripId: trip.id, fileHash: "h-case14" });
      // soft-deleted (excluded)
      seedMedia(dbHandle.db, {
        tripId: trip.id,
        fileHash: "h-case14",
        softDeleted: true,
      });
      // video (excluded)
      seedMedia(dbHandle.db, { tripId: trip.id, fileHash: "h-case14", type: "video" });
      // NULL hash (excluded)
      seedMedia(dbHandle.db, { tripId: trip.id, fileHash: null });

      const res = await fetch(`${base}/api/trips/${encodeURIComponent(trip.id)}/dedup/exact`, {
        method: "POST",
      });
      const body = (await res.json()) as {
        mediaScanned: number;
        groupsCreated: number;
      };
      record(
        "filters: only 2 valid rows scanned, 1 group created (excludes soft-deleted/video/NULL)",
        res.status === 200 && body.mediaScanned === 2 && body.groupsCreated === 1,
        `body=${JSON.stringify(body)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 15: cross-trip safety — body cannot smuggle in another
    // trip's mediaId. The schema strips unknown keys, the route
    // only reads tripId from the URL path. Seeding two trips and
    // hitting trip A's endpoint must NOT affect trip B's state.
    // -----------------------------------------------------------------
    {
      const tripA = tripService.createTrip({ title: "Case15-A" });
      const tripB = tripService.createTrip({ title: "Case15-B" });
      seedMedia(dbHandle.db, { tripId: tripB.id, fileHash: "h-case15-cross" });
      seedMedia(dbHandle.db, { tripId: tripB.id, fileHash: "h-case15-cross" });

      // Attempt to "smuggle" tripB's id via body — schema should
      // silently strip it (zod default `.strict` is NOT used; the
      // schema accepts unknown keys but ignores them).
      const res = await fetch(`${base}/api/trips/${encodeURIComponent(tripA.id)}/dedup/exact`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ tripId: tripB.id, mediaIds: ["x", "y"] }),
      });
      const body = (await res.json()) as {
        tripId: string;
        mediaScanned: number;
        groupsCreated: number;
      };
      record(
        "cross-trip safety: tripA endpoint scans tripA only (mediaScanned=0); body keys ignored",
        res.status === 200 &&
          body.tripId === tripA.id &&
          body.mediaScanned === 0 &&
          body.groupsCreated === 0,
        `body=${JSON.stringify(body)}`,
      );
      // And tripB is untouched (no groups).
      const tripBGroups = duplicateGroupsRepo.listByTripId(tripB.id);
      record(
        "cross-trip safety: tripB groups not created by the tripA call",
        tripBGroups.length === 0,
        `tripB groups=${tripBGroups.length}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 16: response carries detailed cohortsSkipped list AND
    // aggregated cohortsSkippedByReason. Seed a user_confirmed
    // exact group and rerun — verify both shapes.
    // -----------------------------------------------------------------
    {
      const trip = tripService.createTrip({ title: "Case16 user_confirmed" });
      const m1 = seedMedia(dbHandle.db, { tripId: trip.id, fileHash: "h-case16" });
      const m2 = seedMedia(dbHandle.db, { tripId: trip.id, fileHash: "h-case16" });
      // Seed an existing user_confirmed exact group containing
      // both members via the repository directly.
      const groupId = randomUUID();
      const now = nowIso();
      duplicateGroupsRepo.createGroupWithItems(
        {
          id: groupId,
          tripId: trip.id,
          groupType: "exact",
          recommendedMediaId: m1,
          confidence: 1.0,
          similarityScore: 1.0,
          userConfirmed: true,
          createdAt: now,
          updatedAt: now,
        },
        [
          {
            id: randomUUID(),
            mediaId: m1,
            similarityScore: 1.0,
            recommendation: "keep",
            reason: "user kept",
            userDecision: "keep",
            createdAt: now,
            updatedAt: now,
          },
          {
            id: randomUUID(),
            mediaId: m2,
            similarityScore: 1.0,
            recommendation: "remove",
            reason: "user removed",
            userDecision: "remove",
            createdAt: now,
            updatedAt: now,
          },
        ],
      );

      const res = await fetch(`${base}/api/trips/${encodeURIComponent(trip.id)}/dedup/exact`, {
        method: "POST",
      });
      const body = (await res.json()) as {
        groupsCreated: number;
        cohortsSkipped: { mediaIds: string[]; reason: string }[];
        cohortsSkippedByReason: Record<string, number>;
      };
      record(
        "user_confirmed protection: API skips overlapping cohort (groupsCreated=0, byReason populated)",
        body.groupsCreated === 0 &&
          (body.cohortsSkippedByReason["already-grouped"] ?? 0) === 1 &&
          body.cohortsSkipped.length === 1 &&
          body.cohortsSkipped[0]?.reason === "already-grouped",
        `body=${JSON.stringify(body)}`,
      );
    }
  } finally {
    if (server !== null) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
    }
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
