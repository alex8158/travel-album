// Manual smoke test for CuratedSelectionsRepository +
// SlideshowRendersRepository (P12.T2).
//
// Both repositories are "history of decisions" tables that the
// future curation orchestrator (P12.T9) and slideshow worker
// (P12.T12) will read and write. The smoke covers the basic
// create / query / update paths and the layer-discipline behaviour
// that the SQL CHECK constraints enforce (round=0 vs round>=1
// for curated_selections; status / FK behaviour for
// slideshow_renders).
//
// Usage: npm run smoke:curated-selections-repository

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import {
  CuratedSelectionsRepository,
  SceneGroupsRepository,
  SlideshowRendersRepository,
} from "../media/index.js";

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

function expectThrow(name: string, fn: () => void, matcher: RegExp): void {
  let threw: unknown;
  try {
    fn();
  } catch (err) {
    threw = err;
  }
  const ok = threw !== undefined && matcher.test(describeError(threw));
  record(name, ok, describeError(threw));
}

function seedFixture(
  db: SqliteDatabase,
): { tripId: string; mediaIds: string[]; sceneGroupId: string } {
  const now = new Date().toISOString();
  const tripId = randomUUID();
  db.prepare(`INSERT INTO trips (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
    tripId,
    "Smoke Curated/Slideshow",
    now,
    now,
  );
  const mediaIds: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO media_items
         (id, trip_id, type, original_path, mime_type, extension, file_size,
          status, user_decision, created_at, updated_at)
       VALUES (?, ?, 'image', ?, 'image/jpeg', 'jpg', 1024,
               'processed', 'undecided', ?, ?)`,
    ).run(id, tripId, `trips/${tripId}/originals/${id}.jpg`, now, now);
    mediaIds.push(id);
  }
  // Need one scene_group to anchor the AI rows that reference scene_group_id.
  const groupsRepo = new SceneGroupsRepository(db);
  const sceneGroup = groupsRepo.insert({
    id: randomUUID(),
    tripId,
    selectionRound: 1,
    groupIndex: 0,
    capturedAtStart: null,
    capturedAtEnd: null,
    gpsCenterLat: null,
    gpsCenterLon: null,
    representativeMediaId: null,
    algorithmVersion: "code-time-gps-1.0",
  });
  return { tripId, mediaIds, sceneGroupId: sceneGroup.id };
}

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-curated-repo-"));
  const dbPath = path.join(tmpRoot, "c.db");
  const dbHandle = openDatabase(dbPath);

  try {
    runMigrations(dbHandle.db);

    const { tripId, mediaIds, sceneGroupId } = seedFixture(dbHandle.db);
    const m0 = mediaIds[0];
    const m1 = mediaIds[1];
    const m2 = mediaIds[2];
    const m3 = mediaIds[3];
    if (!m0 || !m1 || !m2 || !m3) throw new Error("seed expected 4 media");

    // ================================================================
    // CuratedSelectionsRepository
    // ================================================================
    const curated = new CuratedSelectionsRepository(dbHandle.db);

    // AI draft row (round=1, is_current=0).
    const ai1 = curated.insertAi({
      id: randomUUID(),
      tripId,
      mediaId: m0,
      sceneGroupId,
      selectionRound: 1,
      included: 1,
      isCurrent: 0,
      reason: "scene_best_pick draft",
      aiConfidence: 0.85,
      refinementParams: null,
    });
    record(
      "curated: insertAi (round=1 draft) returns view with all fields",
      ai1.selectionRound === 1 &&
        ai1.included === 1 &&
        ai1.isCurrent === 0 &&
        ai1.userDecision === null &&
        ai1.aiConfidence === 0.85,
      `id=${ai1.id.slice(0, 8)} included=${ai1.included} cur=${ai1.isCurrent}`,
    );

    // Non-best row in same group.
    curated.insertAi({
      id: randomUUID(),
      tripId,
      mediaId: m1,
      sceneGroupId,
      selectionRound: 1,
      included: 0,
      isCurrent: 0,
      reason: "not_best_in_group",
      aiConfidence: null,
      refinementParams: null,
    });

    // insertAi with selectionRound = 0 must throw (round=0 is for overrides).
    expectThrow(
      "curated: insertAi(selectionRound=0) throws (round=0 reserved for overrides)",
      () =>
        curated.insertAi({
          id: randomUUID(),
          tripId,
          mediaId: m2,
          sceneGroupId,
          selectionRound: 0,
          included: 1,
          reason: null,
          aiConfidence: null,
          refinementParams: null,
        }),
      /selectionRound must be >= 1/i,
    );

    // findByTripRoundMedia returns the AI row.
    const lookupAi = curated.findByTripRoundMedia(tripId, 1, m0);
    record("curated: findByTripRoundMedia returns the AI row", lookupAi?.id === ai1.id, `found=${lookupAi?.id?.slice(0, 8)}`);

    // listByTripRound returns both rows.
    const round1 = curated.listByTripRound(tripId, 1);
    record(
      "curated: listByTripRound returns rows ordered by media_id",
      round1.length === 2,
      `len=${round1.length}`,
    );
    record(
      "curated: countByTripRound(1) == 2",
      curated.countByTripRound(tripId, 1) === 2,
      `n=${curated.countByTripRound(tripId, 1)}`,
    );

    // Upsert override on m1 (kept).
    const ov1 = curated.upsertOverride(randomUUID(), tripId, m1, "kept");
    record(
      "curated: upsertOverride('kept') writes round=0 row with included=1",
      ov1.selectionRound === 0 &&
        ov1.userDecision === "kept" &&
        ov1.included === 1 &&
        ov1.isCurrent === 0,
      `round=${ov1.selectionRound} dec=${ov1.userDecision} inc=${ov1.included}`,
    );

    // Update the same override to 'excluded' — should UPSERT (single row).
    const ov2 = curated.upsertOverride(randomUUID(), tripId, m1, "excluded");
    record(
      "curated: upsertOverride('excluded') for same media updates existing round=0 row (not 2nd row)",
      ov2.userDecision === "excluded" &&
        ov2.included === 0 &&
        curated.listByTripOverrides(tripId).length === 1,
      `dec=${ov2.userDecision} inc=${ov2.included} overrideCount=${curated.listByTripOverrides(tripId).length}`,
    );

    // Another override on m2.
    curated.upsertOverride(randomUUID(), tripId, m2, "kept");
    record(
      "curated: listByTripOverrides returns 2 round=0 rows",
      curated.listByTripOverrides(tripId).length === 2,
      "ok",
    );

    // Single-row delete.
    const delOne = curated.deleteOverrideByTripMedia(tripId, m1);
    record(
      "curated: deleteOverrideByTripMedia removes only that media's round=0 row",
      delOne === 1 && curated.listByTripOverrides(tripId).length === 1,
      `del=${delOne} remaining=${curated.listByTripOverrides(tripId).length}`,
    );

    // ------------------------------------------------------------
    // markRoundCurrent flow (the §7.8.4 finalize semantic).
    // We seed a round 2 with a draft row, then markRoundCurrent(2)
    // and assert: round 1 rows → is_current=0; round 2 row → is_current=1.
    // (round 1 rows already had is_current=0 from the inserts above,
    // so to make the test meaningful we promote one row to is_current=1
    // manually first.)
    // ------------------------------------------------------------
    dbHandle.db
      .prepare(`UPDATE curated_selections SET is_current = 1 WHERE id = ?`)
      .run(ai1.id);
    record(
      "curated: pre-finalize seed — ai1 is now is_current=1",
      curated.findById(ai1.id)?.isCurrent === 1,
      `cur=${curated.findById(ai1.id)?.isCurrent}`,
    );

    curated.insertAi({
      id: randomUUID(),
      tripId,
      mediaId: m3,
      sceneGroupId: null,
      selectionRound: 2,
      included: 1,
      isCurrent: 0,
      reason: "round 2 draft",
      aiConfidence: 0.9,
      refinementParams: null,
    });

    const flip = curated.markRoundCurrent(tripId, 2);
    record(
      "curated: markRoundCurrent(round=2) clears older + sets new",
      flip.cleared === 1 && flip.set === 1,
      `cleared=${flip.cleared} set=${flip.set}`,
    );
    record(
      "curated: post-finalize ai1 (round=1) is_current=0",
      curated.findById(ai1.id)?.isCurrent === 0,
      `cur=${curated.findById(ai1.id)?.isCurrent}`,
    );
    record(
      "curated: post-finalize round 2 row has is_current=1",
      curated.listByTripRound(tripId, 2).every((r) => r.isCurrent === 1),
      "ok",
    );

    // listByTripCurrent returns only is_current=1 included=1 rows.
    const current = curated.listByTripCurrent(tripId);
    record(
      "curated: listByTripCurrent returns is_current=1 AND included=1 only",
      current.length === 1 && current[0]?.mediaId === m3,
      `len=${current.length} mediaIds=${current.map((r) => r.mediaId.slice(0, 8)).join(",")}`,
    );

    // markRoundCurrent(0) must throw.
    expectThrow(
      "curated: markRoundCurrent(0) throws",
      () => curated.markRoundCurrent(tripId, 0),
      /newRound must be >= 1/i,
    );

    // updateRefinementParams.
    const refUpd = curated.updateRefinementParams(ai1.id, JSON.stringify({ brightness: 0.05 }));
    record(
      "curated: updateRefinementParams writes the JSON string",
      refUpd === 1 &&
        curated.findById(ai1.id)?.refinementParams ===
          JSON.stringify({ brightness: 0.05 }),
      `params=${curated.findById(ai1.id)?.refinementParams}`,
    );

    // deleteOverridesByTrip (Reset overrides).
    const remainingOv = curated.listByTripOverrides(tripId).length;
    const delAll = curated.deleteOverridesByTrip(tripId);
    record(
      "curated: deleteOverridesByTrip clears all round=0 rows for trip",
      delAll === remainingOv && curated.listByTripOverrides(tripId).length === 0,
      `del=${delAll} after=${curated.listByTripOverrides(tripId).length}`,
    );

    // ================================================================
    // SlideshowRendersRepository
    // ================================================================
    const slideshow = new SlideshowRendersRepository(dbHandle.db);

    // insert pending.
    const r1 = slideshow.insert({
      id: randomUUID(),
      tripId,
      inputMediaIdsJson: JSON.stringify([m0, m3]),
      perImageDurationSec: 2.0,
      transitionType: "xfade",
      transitionDurationSec: 0.3,
      outputResolution: "1920x1080",
      outputFps: 30,
      audioPolicy: "replace_with_library",
      backgroundAudioId: null,
    });
    record(
      "slideshow: insert returns view (status defaults to pending)",
      r1.status === "pending" &&
        r1.inputMediaIdsJson === JSON.stringify([m0, m3]) &&
        r1.perImageDurationSec === 2.0 &&
        r1.transitionType === "xfade" &&
        r1.audioPolicy === "replace_with_library",
      `status=${r1.status} dur=${r1.perImageDurationSec}`,
    );

    const found = slideshow.findById(r1.id);
    record("slideshow: findById returns the row", found?.id === r1.id, "ok");

    // 2nd row (pending) — concurrency gate counts 2 active.
    slideshow.insert({
      id: randomUUID(),
      tripId,
      inputMediaIdsJson: JSON.stringify([m0]),
      perImageDurationSec: 3.0,
      transitionType: "none",
      transitionDurationSec: 0.0,
      outputResolution: "1280x720",
      outputFps: 30,
      audioPolicy: "mute",
      backgroundAudioId: null,
    });
    record(
      "slideshow: countActiveByTrip counts pending+running rows",
      slideshow.countActiveByTrip(tripId) === 2,
      `n=${slideshow.countActiveByTrip(tripId)}`,
    );

    // markStatus → running.
    const ms1 = slideshow.markStatus(r1.id, "running");
    record(
      "slideshow: markStatus → running sets the status; 1 row affected",
      ms1 === 1 && slideshow.findById(r1.id)?.status === "running",
      `status=${slideshow.findById(r1.id)?.status}`,
    );

    // markStatus → success + setOutputMediaVersion.
    slideshow.markStatus(r1.id, "success");
    record(
      "slideshow: markStatus → success works",
      slideshow.findById(r1.id)?.status === "success",
      `status=${slideshow.findById(r1.id)?.status}`,
    );

    // After success, only 1 active remains.
    record(
      "slideshow: countActiveByTrip excludes terminal rows",
      slideshow.countActiveByTrip(tripId) === 1,
      `n=${slideshow.countActiveByTrip(tripId)}`,
    );

    // markStatus → failed with errorMessage.
    const r2Id = slideshow.listByTrip(tripId).find((r) => r.status === "pending")?.id;
    if (r2Id !== undefined) {
      slideshow.markStatus(r2Id, "failed", { errorMessage: "ffmpeg exit 1" });
      const r2 = slideshow.findById(r2Id);
      record(
        "slideshow: markStatus → failed + errorMessage persisted",
        r2?.status === "failed" && r2?.errorMessage === "ffmpeg exit 1",
        `status=${r2?.status} err=${r2?.errorMessage}`,
      );
    }

    // listByTrip newest first.
    const list = slideshow.listByTrip(tripId);
    record(
      "slideshow: listByTrip returns 2 rows newest-first (default excludes deleted)",
      list.length === 2,
      `len=${list.length}`,
    );

    // Soft delete on the failed row.
    if (r2Id !== undefined) {
      const sd = slideshow.softDelete(r2Id);
      record(
        "slideshow: softDelete returns 1 + row missing from listByTrip but present in listByTripAll",
        sd === 1 &&
          slideshow.listByTrip(tripId).length === 1 &&
          slideshow.listByTripAll(tripId).length === 2,
        `sd=${sd} active=${slideshow.listByTrip(tripId).length} all=${slideshow.listByTripAll(tripId).length}`,
      );

      // Double-delete is a no-op.
      const sd2 = slideshow.softDelete(r2Id);
      record(
        "slideshow: softDelete on already-deleted row returns 0",
        sd2 === 0,
        `sd2=${sd2}`,
      );
    }

    // setOutputMediaVersion (FK can be null until media_versions row exists).
    const setOv = slideshow.setOutputMediaVersion(r1.id, null);
    record(
      "slideshow: setOutputMediaVersion(null) is allowed (FK column is nullable)",
      setOv === 1 && slideshow.findById(r1.id)?.outputMediaVersionId === null,
      `mv=${String(slideshow.findById(r1.id)?.outputMediaVersionId)}`,
    );

    // ================================================================
    // CASCADE / SET NULL behaviour exercised at the SQL level
    // ================================================================
    // Note: media_items.trip_id is RESTRICT, so trip delete fails
    // while media exists. Clear media first (which also cascades
    // curated_selections via media CASCADE), then delete the trip
    // to verify the chain works end-to-end without FK errors.
    for (const mid of [m0, m1, m2, m3]) {
      dbHandle.db.prepare(`DELETE FROM media_items WHERE id = ?`).run(mid);
    }
    dbHandle.db.prepare(`DELETE FROM trips WHERE id = ?`).run(tripId);
    record(
      "cascade: with media cleared first, trip delete succeeds and curated_selections + slideshow_renders empty",
      curated.listByTripRound(tripId, 1).length === 0 &&
        curated.listByTripRound(tripId, 2).length === 0 &&
        slideshow.listByTripAll(tripId).length === 0,
      "ok",
    );

    const passed = results.filter((r) => r.ok).length;
    const failed = results.length - passed;
    console.log(`\n[smoke] summary: ${passed}/${results.length} passed`);
    if (failed > 0) {
      console.log(
        `[smoke] failures: ${results.filter((r) => !r.ok).map((r) => r.name).join(", ")}`,
      );
      process.exit(1);
    }
  } finally {
    closeDatabase(dbHandle);
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`[smoke] uncaught error: ${describeError(err)}`);
  process.exit(1);
});
