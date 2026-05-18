// Manual smoke test for the duplicate group user-confirmation
// surface (P5.T7).
//
// Usage: npm run smoke:duplicate-group-confirm
//
// Boots a minimal Express app with just the Dedup router wired,
// listens on an ephemeral port, drives `POST .../recommend` +
// `POST .../confirm` over fetch, and asserts on:
//   * Happy-path field writes (recommended_media_id, user_confirmed,
//     items.user_decision).
//   * Cross-group leak guard (mediaId not in target group → 400).
//   * Idempotency (same payload twice = same final state).
//   * "Change my mind" (different mediaId on already-confirmed
//     group flips the items accordingly).
//   * Body / path validation (400 VALIDATION_FAILED).
//   * 404 for missing group.
//   * The engine's protection rule still holds: a `user_confirmed`
//     group is NOT re-grouped by a subsequent runExactForTrip /
//     runSimilarForTrip call.
//   * Cross-group isolation: confirming group A does not touch
//     group B's recommended / user_confirmed / items.

import express from "express";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { DedupEngine, DedupService, DuplicateGroupsRepository } from "../dedup/index.js";
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

function nowIso(): string {
  return new Date().toISOString();
}

function seedMedia(db: SqliteDatabase, args: { tripId: string; fileHash?: string | null }): string {
  const mediaId = randomUUID();
  const now = nowIso();
  db.prepare(
    `INSERT INTO media_items
       (id, trip_id, type, original_path, mime_type, extension, file_size,
        file_hash, status, user_decision, created_at, updated_at)
     VALUES (?, ?, 'image', ?, 'image/jpeg', 'jpg', 1024,
             ?, 'uploaded', 'undecided', ?, ?)`,
  ).run(
    mediaId,
    args.tripId,
    `trips/${args.tripId}/originals/${mediaId}.jpg`,
    args.fileHash ?? null,
    now,
    now,
  );
  return mediaId;
}

/**
 * Seed two media that share `fileHash` and POST .../dedup/exact to
 * the engine so we end up with one freshly-created exact group of
 * two members. Returns { tripId, groupId, mediaIds[] }.
 */
async function seedTripWithExactGroup(args: {
  tripService: TripService;
  db: SqliteDatabase;
  base: string;
  fileHash: string;
  title: string;
}): Promise<{ tripId: string; groupId: string; mediaIds: string[] }> {
  const trip = args.tripService.createTrip({ title: args.title });
  const m1 = seedMedia(args.db, { tripId: trip.id, fileHash: args.fileHash });
  const m2 = seedMedia(args.db, { tripId: trip.id, fileHash: args.fileHash });
  const exactRes = await fetch(
    `${args.base}/api/trips/${encodeURIComponent(trip.id)}/dedup/exact`,
    { method: "POST" },
  );
  if (!exactRes.ok) throw new Error("dedup/exact seed failed");
  const listRes = (await (
    await fetch(`${args.base}/api/trips/${encodeURIComponent(trip.id)}/duplicate-groups`)
  ).json()) as { groups: Array<{ id: string }> };
  const groupId = listRes.groups[0]?.id ?? "";
  if (!groupId) throw new Error("seed exact group: groupId missing");
  return { tripId: trip.id, groupId, mediaIds: [m1, m2] };
}

function readRow<T = Record<string, unknown>>(
  db: SqliteDatabase,
  sql: string,
  ...params: unknown[]
): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-dedup-confirm-smoke-"));
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
    const dedupService = new DedupService(dedupEngine, tripService, duplicateGroupsRepo, mediaRepo);

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
    // CASE 1: recommend happy — sets recommended_media_id, leaves
    //          user_confirmed=0 and items.user_decision='undecided'.
    // -----------------------------------------------------------------
    {
      const seeded = await seedTripWithExactGroup({
        tripService,
        db: dbHandle.db,
        base,
        fileHash: "h-case1",
        title: "Case1 recommend",
      });
      const pickedId = seeded.mediaIds[0] as string;
      const res = await fetch(
        `${base}/api/duplicate-groups/${encodeURIComponent(seeded.groupId)}/recommend`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ mediaId: pickedId }),
        },
      );
      const body = (await res.json()) as {
        group: {
          id: string;
          recommendedMediaId: string | null;
          userConfirmed: boolean;
          items: Array<{ mediaId: string; userDecision: string }>;
        };
      };
      record(
        "recommend: 200 + recommended_media_id set + user_confirmed still false",
        res.status === 200 &&
          body.group.id === seeded.groupId &&
          body.group.recommendedMediaId === pickedId &&
          body.group.userConfirmed === false,
        `body=${JSON.stringify(body.group).slice(0, 200)}`,
      );
      record(
        "recommend: items.user_decision unchanged ('undecided' across the board)",
        body.group.items.every((it) => it.userDecision === "undecided"),
        `items=${JSON.stringify(body.group.items.map((i) => i.userDecision))}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 2: recommend with mediaId NOT in the group → 400
    // -----------------------------------------------------------------
    {
      const seeded = await seedTripWithExactGroup({
        tripService,
        db: dbHandle.db,
        base,
        fileHash: "h-case2",
        title: "Case2 cross-group",
      });
      // Seed a different trip with its own media; that media is not a
      // member of seeded.groupId. Attempting to recommend it must fail.
      const otherTrip = tripService.createTrip({ title: "Case2 other trip" });
      const otherMedia = seedMedia(dbHandle.db, { tripId: otherTrip.id, fileHash: "h-other" });
      const res = await fetch(
        `${base}/api/duplicate-groups/${encodeURIComponent(seeded.groupId)}/recommend`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ mediaId: otherMedia }),
        },
      );
      const body = (await res.json()) as { error?: { code?: string } };
      record(
        "recommend: foreign mediaId → 400 INVALID_STATE_TRANSITION",
        res.status === 400 && body.error?.code === "INVALID_STATE_TRANSITION",
        `status=${res.status} code=${body.error?.code ?? "(none)"}`,
      );
      // The group's recommended_media_id stays NULL.
      const rec = readRow<{ recommended_media_id: string | null }>(
        dbHandle.db,
        `SELECT recommended_media_id FROM duplicate_groups WHERE id = ?`,
        seeded.groupId,
      );
      record(
        "recommend: failure does not mutate recommended_media_id",
        rec?.recommended_media_id === null,
        `recommended=${String(rec?.recommended_media_id)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 3: recommend with missing group → 404
    // -----------------------------------------------------------------
    {
      const res = await fetch(
        `${base}/api/duplicate-groups/${encodeURIComponent("never-such-group")}/recommend`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ mediaId: "never-such-media" }),
        },
      );
      const body = (await res.json()) as { error?: { code?: string } };
      record(
        "recommend: missing group → 404 NOT_FOUND",
        res.status === 404 && body.error?.code === "NOT_FOUND",
        `status=${res.status} code=${body.error?.code ?? "(none)"}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 4: recommend with malformed group id → 400
    // -----------------------------------------------------------------
    {
      const res = await fetch(`${base}/api/duplicate-groups/bad.id.shape/recommend`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ mediaId: "anything" }),
      });
      const body = (await res.json()) as { error?: { code?: string } };
      record(
        "recommend: malformed group id → 400 VALIDATION_FAILED",
        res.status === 400 && body.error?.code === "VALIDATION_FAILED",
        `status=${res.status} code=${body.error?.code ?? "(none)"}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 5: recommend with missing body → 400
    // -----------------------------------------------------------------
    {
      const seeded = await seedTripWithExactGroup({
        tripService,
        db: dbHandle.db,
        base,
        fileHash: "h-case5",
        title: "Case5 bad body",
      });
      const res = await fetch(
        `${base}/api/duplicate-groups/${encodeURIComponent(seeded.groupId)}/recommend`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({}),
        },
      );
      const body = (await res.json()) as { error?: { code?: string } };
      record(
        "recommend: missing mediaId in body → 400 VALIDATION_FAILED",
        res.status === 400 && body.error?.code === "VALIDATION_FAILED",
        `status=${res.status} code=${body.error?.code ?? "(none)"}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 6: confirm happy — writes recommended_media_id +
    //          user_confirmed=1 + items.user_decision (keep / remove).
    // -----------------------------------------------------------------
    {
      const seeded = await seedTripWithExactGroup({
        tripService,
        db: dbHandle.db,
        base,
        fileHash: "h-case6",
        title: "Case6 confirm",
      });
      const pickedId = seeded.mediaIds[1] as string;
      const otherId = seeded.mediaIds[0] as string;
      const res = await fetch(
        `${base}/api/duplicate-groups/${encodeURIComponent(seeded.groupId)}/confirm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ recommendedMediaId: pickedId }),
        },
      );
      const body = (await res.json()) as {
        group: {
          id: string;
          recommendedMediaId: string | null;
          userConfirmed: boolean;
          items: Array<{
            mediaId: string;
            userDecision: string;
            recommendation: string;
          }>;
        };
      };
      record(
        "confirm: 200 + recommended_media_id set + user_confirmed=true",
        res.status === 200 &&
          body.group.recommendedMediaId === pickedId &&
          body.group.userConfirmed === true,
        `body=${JSON.stringify(body.group).slice(0, 200)}`,
      );
      const picked = body.group.items.find((it) => it.mediaId === pickedId);
      const other = body.group.items.find((it) => it.mediaId === otherId);
      record(
        "confirm: picked item → user_decision='keep' + recommendation='keep'",
        picked?.userDecision === "keep" && picked?.recommendation === "keep",
        `picked=${JSON.stringify(picked)}`,
      );
      record(
        "confirm: other item → user_decision='remove' + recommendation='remove'",
        other?.userDecision === "remove" && other?.recommendation === "remove",
        `other=${JSON.stringify(other)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 7: confirm with mediaId NOT in group → 400, no mutation
    // -----------------------------------------------------------------
    {
      const seeded = await seedTripWithExactGroup({
        tripService,
        db: dbHandle.db,
        base,
        fileHash: "h-case7",
        title: "Case7 confirm cross-group",
      });
      const otherTrip = tripService.createTrip({ title: "Case7 other trip" });
      const foreignMedia = seedMedia(dbHandle.db, { tripId: otherTrip.id, fileHash: "h-other" });
      const res = await fetch(
        `${base}/api/duplicate-groups/${encodeURIComponent(seeded.groupId)}/confirm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ recommendedMediaId: foreignMedia }),
        },
      );
      const body = (await res.json()) as { error?: { code?: string } };
      record(
        "confirm: foreign mediaId → 400 INVALID_STATE_TRANSITION",
        res.status === 400 && body.error?.code === "INVALID_STATE_TRANSITION",
        `status=${res.status} code=${body.error?.code ?? "(none)"}`,
      );
      const grp = readRow<{ user_confirmed: number; recommended_media_id: string | null }>(
        dbHandle.db,
        `SELECT user_confirmed, recommended_media_id FROM duplicate_groups WHERE id = ?`,
        seeded.groupId,
      );
      record(
        "confirm: failure does not flip user_confirmed or recommended_media_id",
        grp?.user_confirmed === 0 && grp?.recommended_media_id === null,
        `grp=${JSON.stringify(grp)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 8: confirm idempotency — second call with same payload
    //          leaves the same final state.
    // -----------------------------------------------------------------
    {
      const seeded = await seedTripWithExactGroup({
        tripService,
        db: dbHandle.db,
        base,
        fileHash: "h-case8",
        title: "Case8 idempotency",
      });
      const pickedId = seeded.mediaIds[0] as string;
      const url = `${base}/api/duplicate-groups/${encodeURIComponent(seeded.groupId)}/confirm`;
      const init: RequestInit = {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ recommendedMediaId: pickedId }),
      };
      const first = (await (await fetch(url, init)).json()) as {
        group: {
          recommendedMediaId: string | null;
          userConfirmed: boolean;
          items: Array<{ mediaId: string; userDecision: string }>;
        };
      };
      const second = (await (await fetch(url, init)).json()) as typeof first;
      record(
        "confirm: idempotent — recommended + user_confirmed unchanged on second call",
        first.group.recommendedMediaId === second.group.recommendedMediaId &&
          first.group.userConfirmed === second.group.userConfirmed,
        `first=${JSON.stringify({ rec: first.group.recommendedMediaId, conf: first.group.userConfirmed })}`,
      );
      const itemsMatch = first.group.items.every((fIt) => {
        const sIt = second.group.items.find((s) => s.mediaId === fIt.mediaId);
        return sIt?.userDecision === fIt.userDecision;
      });
      record("confirm: idempotent — items.user_decision unchanged on second call", itemsMatch, "");
    }

    // -----------------------------------------------------------------
    // CASE 9: "change my mind" — confirm with a DIFFERENT mediaId on
    //          an already-confirmed group flips the items.
    // -----------------------------------------------------------------
    {
      const seeded = await seedTripWithExactGroup({
        tripService,
        db: dbHandle.db,
        base,
        fileHash: "h-case9",
        title: "Case9 change pick",
      });
      const firstPick = seeded.mediaIds[0] as string;
      const secondPick = seeded.mediaIds[1] as string;
      await fetch(`${base}/api/duplicate-groups/${encodeURIComponent(seeded.groupId)}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ recommendedMediaId: firstPick }),
      });
      const flipRes = await fetch(
        `${base}/api/duplicate-groups/${encodeURIComponent(seeded.groupId)}/confirm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ recommendedMediaId: secondPick }),
        },
      );
      const body = (await flipRes.json()) as {
        group: {
          recommendedMediaId: string | null;
          userConfirmed: boolean;
          items: Array<{ mediaId: string; userDecision: string }>;
        };
      };
      const newPick = body.group.items.find((i) => i.mediaId === secondPick);
      const oldPick = body.group.items.find((i) => i.mediaId === firstPick);
      record(
        "confirm: re-confirm with different mediaId flips items + recommended_media_id",
        body.group.recommendedMediaId === secondPick &&
          body.group.userConfirmed === true &&
          newPick?.userDecision === "keep" &&
          oldPick?.userDecision === "remove",
        `recommended=${body.group.recommendedMediaId} newPick=${newPick?.userDecision} oldPick=${oldPick?.userDecision}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 10: engine protection — a `user_confirmed` group's
    //          members are still in the "already-grouped" set, so
    //          subsequent dedup/exact runs do not duplicate it.
    // -----------------------------------------------------------------
    {
      const seeded = await seedTripWithExactGroup({
        tripService,
        db: dbHandle.db,
        base,
        fileHash: "h-case10",
        title: "Case10 engine protection",
      });
      const pickedId = seeded.mediaIds[0] as string;
      await fetch(`${base}/api/duplicate-groups/${encodeURIComponent(seeded.groupId)}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ recommendedMediaId: pickedId }),
      });
      // Re-run dedup/exact for the same trip. The previously
      // confirmed group should still be the only group, with no
      // duplicates created.
      const rerunRes = await fetch(
        `${base}/api/trips/${encodeURIComponent(seeded.tripId)}/dedup/exact`,
        { method: "POST" },
      );
      const rerun = (await rerunRes.json()) as {
        groupsCreated: number;
        cohortsSkippedByReason: Record<string, number>;
      };
      record(
        "engine protection: rerun exact creates 0 new groups + skips already-grouped",
        rerun.groupsCreated === 0 && (rerun.cohortsSkippedByReason["already-grouped"] ?? 0) === 1,
        `rerun=${JSON.stringify(rerun)}`,
      );
      // user_confirmed still 1; recommended unchanged.
      const grp = readRow<{ user_confirmed: number; recommended_media_id: string | null }>(
        dbHandle.db,
        `SELECT user_confirmed, recommended_media_id FROM duplicate_groups WHERE id = ?`,
        seeded.groupId,
      );
      record(
        "engine protection: user_confirmed=1 + recommended_media_id preserved after rerun",
        grp?.user_confirmed === 1 && grp?.recommended_media_id === pickedId,
        `grp=${JSON.stringify(grp)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 11: cross-group isolation — confirming group A does not
    //          touch group B in the same trip.
    // -----------------------------------------------------------------
    {
      // Seed TWO independent groups in one trip (different fileHash).
      const trip = tripService.createTrip({ title: "Case11 isolation" });
      const aMedia1 = seedMedia(dbHandle.db, { tripId: trip.id, fileHash: "h-iso-a" });
      const aMedia2 = seedMedia(dbHandle.db, { tripId: trip.id, fileHash: "h-iso-a" });
      const bMedia1 = seedMedia(dbHandle.db, { tripId: trip.id, fileHash: "h-iso-b" });
      const bMedia2 = seedMedia(dbHandle.db, { tripId: trip.id, fileHash: "h-iso-b" });
      void aMedia2;
      void bMedia2;
      await fetch(`${base}/api/trips/${encodeURIComponent(trip.id)}/dedup/exact`, {
        method: "POST",
      });
      const listed = (await (
        await fetch(`${base}/api/trips/${encodeURIComponent(trip.id)}/duplicate-groups`)
      ).json()) as {
        groups: Array<{ id: string; items: Array<{ mediaId: string }> }>;
      };
      const groupA = listed.groups.find((g) => g.items.some((i) => i.mediaId === aMedia1));
      const groupB = listed.groups.find((g) => g.items.some((i) => i.mediaId === bMedia1));
      if (!groupA || !groupB) {
        record("isolation: setup found both groups", false, "missing");
      } else {
        await fetch(`${base}/api/duplicate-groups/${encodeURIComponent(groupA.id)}/confirm`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ recommendedMediaId: aMedia1 }),
        });
        const grpA = readRow<{ user_confirmed: number; recommended_media_id: string | null }>(
          dbHandle.db,
          `SELECT user_confirmed, recommended_media_id FROM duplicate_groups WHERE id = ?`,
          groupA.id,
        );
        const grpB = readRow<{ user_confirmed: number; recommended_media_id: string | null }>(
          dbHandle.db,
          `SELECT user_confirmed, recommended_media_id FROM duplicate_groups WHERE id = ?`,
          groupB.id,
        );
        record(
          "isolation: group A confirmed; group B stays user_confirmed=0 + recommended NULL",
          grpA?.user_confirmed === 1 &&
            grpA?.recommended_media_id === aMedia1 &&
            grpB?.user_confirmed === 0 &&
            grpB?.recommended_media_id === null,
          `A=${JSON.stringify(grpA)} B=${JSON.stringify(grpB)}`,
        );
        // Group B items untouched too.
        const bItems = readRow<{ undecided: number }>(
          dbHandle.db,
          `SELECT COUNT(*) AS undecided
           FROM duplicate_group_items
           WHERE group_id = ? AND user_decision = 'undecided'`,
          groupB.id,
        );
        record(
          "isolation: group B items all still 'undecided' after confirming group A",
          bItems?.undecided === 2,
          `bItems.undecided=${bItems?.undecided}`,
        );
      }
    }

    // -----------------------------------------------------------------
    // CASE 12: confirm with malformed body field type → 400
    // -----------------------------------------------------------------
    {
      const seeded = await seedTripWithExactGroup({
        tripService,
        db: dbHandle.db,
        base,
        fileHash: "h-case12",
        title: "Case12 bad body type",
      });
      const res = await fetch(
        `${base}/api/duplicate-groups/${encodeURIComponent(seeded.groupId)}/confirm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          // pass an object instead of a string
          body: JSON.stringify({ recommendedMediaId: { foo: "bar" } }),
        },
      );
      const body = (await res.json()) as { error?: { code?: string } };
      record(
        "confirm: non-string recommendedMediaId → 400 VALIDATION_FAILED",
        res.status === 400 && body.error?.code === "VALIDATION_FAILED",
        `status=${res.status} code=${body.error?.code ?? "(none)"}`,
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
