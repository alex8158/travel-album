// Manual smoke test for sceneGroupingService (P12.T4 baseline).
//
// Usage: npm run smoke:scene-grouping-service
//
// Coverage (matches the P12.T4 prompt's test requirements):
//   * 空 trip 不报错                  → empty-trip case
//   * 单媒体可形成单独 group         → singleton case
//   * 多媒体可按规则形成多个 group  → time-gap split case
//   * 重复执行不会重复写入         → idempotency: re-run produces
//                                     same shape with no duplicate
//                                     scene_groups / scene_group_items
//   * scene_groups / scene_group_items 写入正确 → field-by-field
//   * 事务失败可回滚                → simulate failure mid-write by
//                                     pre-poisoning the unique index on
//                                     scene_group_items; the outer
//                                     transaction must roll back ALL
//                                     prior inserts in the same call.
//   * dryRun                           → plan returned, no DB writes
//   * round 0 rejected                 → invariant guard
//   * AI embedding stub                → presence of provider with
//                                       isAvailable=true bumps
//                                       algorithm_version suffix
//                                       WITHOUT invoking computeEmbeddings
//   * P12.T2 repository smoke not broken (regression run separately
//     via npm script).

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import {
  DEFAULT_SCENE_GROUPING_SETTINGS,
  SCENE_GROUPING_ALGORITHM_VERSION_CODE_TIME,
  SCENE_GROUPING_JOB_TYPE,
  runSceneGroupingForTrip,
  type SceneEmbeddingProvider,
  type SceneGroupingDeps,
} from "../jobs/index.js";
import { createLogger } from "../logger.js";
import { SceneGroupItemsRepository, SceneGroupsRepository } from "../media/index.js";

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

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function seedTrip(db: SqliteDatabase, title: string): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO trips (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
    id,
    title,
    now,
    now,
  );
  return id;
}

interface SeedMediaOptions {
  /** EXIF DateTimeOriginal to write into media_versions(type='metadata'). */
  readonly exifCapturedAt?: string;
  /** Override media_items.created_at so the fallback path is testable. */
  readonly createdAt?: string;
  /** quality_score for media_analysis. */
  readonly qualityScore?: number | null;
  /** Override media_items.status (default 'processed'). */
  readonly status?: string;
  /** Override media_items.type (default 'image'). */
  readonly type?: string;
  /** Soft-delete the row. */
  readonly softDeleted?: boolean;
}

/** Insert one media_items row + (optionally) its metadata version
 * (with EXIF DateTimeOriginal) + (optionally) its media_analysis row. */
function seedMedia(db: SqliteDatabase, tripId: string, opts: SeedMediaOptions = {}): string {
  const id = randomUUID();
  const createdAt = opts.createdAt ?? new Date().toISOString();
  const status = opts.status ?? "processed";
  const type = opts.type ?? "image";
  const deletedAt = opts.softDeleted ? createdAt : null;

  db.prepare(
    `INSERT INTO media_items
       (id, trip_id, type, original_path, mime_type, extension, file_size,
        status, user_decision, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, 'image/jpeg', 'jpg', 4096,
             ?, 'undecided', ?, ?, ?)`,
  ).run(id, tripId, type, `trips/${tripId}/originals/${id}.jpg`, status, createdAt, createdAt, deletedAt);

  if (opts.exifCapturedAt !== undefined) {
    db.prepare(
      `INSERT INTO media_versions
         (id, media_id, version_type, file_path, mime_type, params, status)
       VALUES (?, ?, 'metadata', ?, 'application/json', ?, 'ready')`,
    ).run(
      randomUUID(),
      id,
      `trips/${tripId}/originals/${id}.jpg`,
      JSON.stringify({ DateTimeOriginal: opts.exifCapturedAt }),
    );
  }

  if (opts.qualityScore !== undefined && opts.qualityScore !== null) {
    db.prepare(
      `INSERT INTO media_analysis (id, media_id, quality_score, reason)
       VALUES (?, ?, ?, 'seed')`,
    ).run(randomUUID(), id, opts.qualityScore);
  }
  return id;
}

function makeDeps(db: SqliteDatabase, embedding?: SceneEmbeddingProvider): SceneGroupingDeps {
  // `embeddingProvider` is omitted when undefined to satisfy
  // tsconfig `exactOptionalPropertyTypes: true` (the type is
  // `SceneEmbeddingProvider` not `SceneEmbeddingProvider | undefined`).
  return {
    db,
    sceneGroupsRepo: new SceneGroupsRepository(db),
    sceneGroupItemsRepo: new SceneGroupItemsRepository(db),
    logger: createLogger({ nodeEnv: "test", level: "fatal" }),
    ...(embedding !== undefined ? { embeddingProvider: embedding } : {}),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-scene-grouping-"));
  const dbHandle = openDatabase(path.join(tmpRoot, "scene.db"));
  try {
    runMigrations(dbHandle.db);
    const db = dbHandle.db;

    // -----------------------------------------------------------------------
    // CASE 1: empty trip → no-error, no rows, skippedReason='no_candidates'
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "Empty Trip");
      const deps = makeDeps(db);
      const res = runSceneGroupingForTrip({ tripId, selectionRound: 1 }, deps);
      record(
        "empty trip: no error, sceneGroupCount=0, sceneItemCount=0",
        res.sceneGroupCount === 0 && res.sceneItemCount === 0,
        `groups=${res.sceneGroupCount} items=${res.sceneItemCount}`,
      );
      record(
        "empty trip: skippedReason='no_candidates'",
        res.skippedReason === "no_candidates",
        `skippedReason=${String(res.skippedReason)}`,
      );
      record(
        "empty trip: algorithm_version='code-time-1.0'",
        res.algorithmVersion === SCENE_GROUPING_ALGORITHM_VERSION_CODE_TIME,
        `algorithmVersion=${res.algorithmVersion}`,
      );
      // No DB rows written.
      const sgCount = (db.prepare(`SELECT COUNT(*) n FROM scene_groups WHERE trip_id=?`).get(tripId) as { n: number }).n;
      const sgiCount = (db
        .prepare(
          `SELECT COUNT(*) n FROM scene_group_items WHERE scene_group_id IN (SELECT id FROM scene_groups WHERE trip_id=?)`,
        )
        .get(tripId) as { n: number }).n;
      record("empty trip: no scene_groups row written", sgCount === 0, `count=${sgCount}`);
      record("empty trip: no scene_group_items row written", sgiCount === 0, `count=${sgiCount}`);
    }

    // -----------------------------------------------------------------------
    // CASE 2: singleton media → exactly one group of size 1
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "Singleton");
      const mediaId = seedMedia(db, tripId, {
        exifCapturedAt: "2026-04-01T10:00:00.000Z",
        qualityScore: 0.82,
      });
      const deps = makeDeps(db);
      const res = runSceneGroupingForTrip({ tripId, selectionRound: 1 }, deps);
      record(
        "singleton: 1 group / 1 item",
        res.sceneGroupCount === 1 && res.sceneItemCount === 1,
        `groups=${res.sceneGroupCount} items=${res.sceneItemCount}`,
      );
      const groups = new SceneGroupsRepository(db).listByTripRound(tripId, 1);
      record(
        "singleton: scene_groups row has correct trip/round/group_index/member_count",
        groups.length === 1 &&
          groups[0]!.tripId === tripId &&
          groups[0]!.selectionRound === 1 &&
          groups[0]!.groupIndex === 0 &&
          groups[0]!.memberCount === 1,
        `${JSON.stringify(groups[0])}`,
      );
      record(
        "singleton: representative_media_id = the only media",
        groups[0]!.representativeMediaId === mediaId,
        `rep=${String(groups[0]!.representativeMediaId)} expected=${mediaId}`,
      );
      record(
        "singleton: captured_at_start = captured_at_end = EXIF DateTimeOriginal",
        groups[0]!.capturedAtStart === "2026-04-01T10:00:00.000Z" &&
          groups[0]!.capturedAtEnd === "2026-04-01T10:00:00.000Z",
        `start=${groups[0]!.capturedAtStart} end=${groups[0]!.capturedAtEnd}`,
      );
      const items = new SceneGroupItemsRepository(db).listByGroup(groups[0]!.id);
      record(
        "singleton: scene_group_items has rank_in_group=0 + group_score=quality_score",
        items.length === 1 && items[0]!.rankInGroup === 0 && items[0]!.groupScore === 0.82,
        `${JSON.stringify(items[0])}`,
      );
      record(
        "singleton: scene_group_items.reason mentions 'code-time-gap'",
        items[0]!.reason !== null && items[0]!.reason.includes("code-time-gap"),
        `reason=${String(items[0]!.reason)}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 3: multi-media → time-gap split into 2 groups; representative
    //          picked by quality_score; ranks within each group.
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "Split");
      // Burst 1 (10:00 ± 5 min): A (q=0.5), B (q=0.9), C (q=0.7)
      const A = seedMedia(db, tripId, { exifCapturedAt: "2026-04-02T10:00:00.000Z", qualityScore: 0.5 });
      const B = seedMedia(db, tripId, { exifCapturedAt: "2026-04-02T10:02:00.000Z", qualityScore: 0.9 });
      const C = seedMedia(db, tripId, { exifCapturedAt: "2026-04-02T10:05:00.000Z", qualityScore: 0.7 });
      // Burst 2 (12:00, 2-hour gap): D (no quality), E (q=0.6)
      const D = seedMedia(db, tripId, { exifCapturedAt: "2026-04-02T12:00:00.000Z" });
      const E = seedMedia(db, tripId, { exifCapturedAt: "2026-04-02T12:00:30.000Z", qualityScore: 0.6 });

      const deps = makeDeps(db);
      const res = runSceneGroupingForTrip({ tripId, selectionRound: 1 }, deps);
      record(
        "split: 2 groups / 5 items",
        res.sceneGroupCount === 2 && res.sceneItemCount === 5,
        `groups=${res.sceneGroupCount} items=${res.sceneItemCount}`,
      );

      const groupsRepo = new SceneGroupsRepository(db);
      const itemsRepo = new SceneGroupItemsRepository(db);
      const groups = groupsRepo.listByTripRound(tripId, 1);
      // group_index 0 = burst 1 (earliest)
      const g0Items = itemsRepo.listByGroup(groups[0]!.id);
      const g1Items = itemsRepo.listByGroup(groups[1]!.id);
      record(
        "split: group 0 has 3 members (A,B,C) and representative is B (highest quality_score)",
        g0Items.length === 3 &&
          groups[0]!.representativeMediaId === B &&
          g0Items[0]!.mediaId === B &&
          g0Items[0]!.rankInGroup === 0,
        `count=${g0Items.length} rep=${String(groups[0]!.representativeMediaId)} rank0Media=${String(g0Items[0]?.mediaId)}`,
      );
      record(
        "split: group 0 ranks = [B (q=0.9), C (q=0.7), A (q=0.5)] by quality DESC",
        g0Items.map((it) => it.mediaId).join(",") === [B, C, A].join(","),
        `order=${g0Items.map((it) => it.mediaId).join(",")} expected=${[B, C, A].join(",")}`,
      );
      record(
        "split: group 0 captured_at_start=10:00, captured_at_end=10:05",
        groups[0]!.capturedAtStart === "2026-04-02T10:00:00.000Z" &&
          groups[0]!.capturedAtEnd === "2026-04-02T10:05:00.000Z",
        `start=${groups[0]!.capturedAtStart} end=${groups[0]!.capturedAtEnd}`,
      );
      record(
        "split: group 1 has 2 members (D no-q, E q=0.6); representative=E (NULL ranks last)",
        g1Items.length === 2 &&
          groups[1]!.representativeMediaId === E &&
          g1Items[0]!.mediaId === E &&
          g1Items[1]!.mediaId === D &&
          g1Items[1]!.groupScore === null,
        `members=${g1Items.map((it) => it.mediaId).join(",")} rep=${String(groups[1]!.representativeMediaId)} gscore[1]=${String(g1Items[1]?.groupScore)}`,
      );
      record(
        "split: group_index assigned in chronological order (0=burst1, 1=burst2)",
        groups[0]!.groupIndex === 0 && groups[1]!.groupIndex === 1,
        `idx=[${groups[0]!.groupIndex},${groups[1]!.groupIndex}]`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 4: idempotency — second run produces identical content
    //          without duplicate UNIQUE violations + row counts unchanged.
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "Idempotent");
      const m1 = seedMedia(db, tripId, { exifCapturedAt: "2026-04-03T08:00:00.000Z", qualityScore: 0.5 });
      const m2 = seedMedia(db, tripId, { exifCapturedAt: "2026-04-03T08:01:00.000Z", qualityScore: 0.6 });
      const m3 = seedMedia(db, tripId, { exifCapturedAt: "2026-04-03T20:00:00.000Z", qualityScore: 0.7 });

      const deps = makeDeps(db);
      const first = runSceneGroupingForTrip({ tripId, selectionRound: 1 }, deps);

      // Capture the IDs from the first run so we can prove they changed
      // (idempotency is *content*, not identity — fresh UUIDs each call).
      const sgIdsFirst = new SceneGroupsRepository(db)
        .listByTripRound(tripId, 1)
        .map((g) => g.id)
        .sort();
      const sgiCountFirst = (db
        .prepare(`SELECT COUNT(*) n FROM scene_group_items WHERE selection_round=?`)
        .get(1) as { n: number }).n;

      // Re-run.
      const second = runSceneGroupingForTrip({ tripId, selectionRound: 1 }, deps);
      record(
        "idempotency: second run returns identical counts",
        first.sceneGroupCount === second.sceneGroupCount &&
          first.sceneItemCount === second.sceneItemCount,
        `first=${first.sceneGroupCount}/${first.sceneItemCount} second=${second.sceneGroupCount}/${second.sceneItemCount}`,
      );
      const sgIdsSecond = new SceneGroupsRepository(db)
        .listByTripRound(tripId, 1)
        .map((g) => g.id)
        .sort();
      record(
        "idempotency: second run rebuilt rows (IDs changed, count preserved)",
        sgIdsFirst.length === sgIdsSecond.length &&
          sgIdsFirst.every((id, i) => id !== sgIdsSecond[i]),
        `firstIds=${sgIdsFirst.join(",")} secondIds=${sgIdsSecond.join(",")}`,
      );
      const sgiCountAfter = (db
        .prepare(`SELECT COUNT(*) n FROM scene_group_items WHERE selection_round=?`)
        .get(1) as { n: number }).n;
      record(
        "idempotency: scene_group_items row count NOT doubled (CASCADE DELETE worked)",
        sgiCountFirst === sgiCountAfter,
        `before=${sgiCountFirst} after=${sgiCountAfter}`,
      );
      // Member assignment shape unchanged: m1+m2 together, m3 alone.
      const groups = new SceneGroupsRepository(db).listByTripRound(tripId, 1);
      record(
        "idempotency: same trip → same logical group layout (2 groups, sizes 2 + 1)",
        groups.length === 2 && groups[0]!.memberCount === 2 && groups[1]!.memberCount === 1,
        `layout=[${groups.map((g) => g.memberCount).join(",")}]`,
      );
      // Quick smoke that all 3 media are referenced somewhere.
      const itemsRepo = new SceneGroupItemsRepository(db);
      const allMedias = new Set<string>();
      for (const g of groups) {
        for (const it of itemsRepo.listByGroup(g.id)) {
          allMedias.add(it.mediaId);
        }
      }
      record(
        "idempotency: every media re-appears post-rerun",
        allMedias.has(m1) && allMedias.has(m2) && allMedias.has(m3),
        `set=${[...allMedias].join(",")}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 5: transaction rollback — simulate failure mid-write by
    //          pre-seeding a conflicting scene_group_items row whose
    //          UNIQUE(scene_group_id, rank_in_group) will collide
    //          with the worker's insert. The outer transaction must
    //          undo everything; pre-existing data on a SECOND
    //          (tripId, round) must remain.
    // -----------------------------------------------------------------------
    {
      const tripA = seedTrip(db, "TxA");
      const tripB = seedTrip(db, "TxB");
      seedMedia(db, tripA, { exifCapturedAt: "2026-04-04T10:00:00.000Z", qualityScore: 0.9 });
      seedMedia(db, tripA, { exifCapturedAt: "2026-04-04T10:01:00.000Z", qualityScore: 0.5 });
      // Seed tripB to prove cross-trip rows survive a tripA rollback.
      seedMedia(db, tripB, { exifCapturedAt: "2026-04-04T11:00:00.000Z", qualityScore: 0.7 });

      // First, produce a real, valid run on tripB so it has rows.
      const deps = makeDeps(db);
      runSceneGroupingForTrip({ tripId: tripB, selectionRound: 1 }, deps);
      const tripBCountBefore = (db
        .prepare(`SELECT COUNT(*) n FROM scene_groups WHERE trip_id=?`)
        .get(tripB) as { n: number }).n;

      // Wrap tripA's run with a poisoned repository that throws on the
      // second scene_groups insert; the outer transaction must
      // unwind the FIRST insert too.
      const realGroupsRepo = new SceneGroupsRepository(db);
      const realItemsRepo = new SceneGroupItemsRepository(db);
      let insertCalls = 0;
      const poisonedGroupsRepo = {
        insert(data: Parameters<typeof realGroupsRepo.insert>[0]) {
          insertCalls += 1;
          if (insertCalls >= 2) {
            throw new Error("simulated mid-write failure");
          }
          return realGroupsRepo.insert(data);
        },
      } as unknown as SceneGroupsRepository;
      const poisonedDeps: SceneGroupingDeps = {
        db,
        sceneGroupsRepo: poisonedGroupsRepo,
        sceneGroupItemsRepo: realItemsRepo,
        logger: createLogger({ nodeEnv: "test", level: "fatal" }),
      };

      // Force tripA into 2 groups: time gap > 15 min.
      seedMedia(db, tripA, { exifCapturedAt: "2026-04-04T13:00:00.000Z", qualityScore: 0.8 });

      expectThrow(
        "rollback: poisoned worker throws on 2nd scene_groups insert",
        () => runSceneGroupingForTrip({ tripId: tripA, selectionRound: 1 }, poisonedDeps),
        /simulated mid-write failure/,
      );

      const tripACountAfter = (db
        .prepare(`SELECT COUNT(*) n FROM scene_groups WHERE trip_id=?`)
        .get(tripA) as { n: number }).n;
      record(
        "rollback: tripA has NO scene_groups rows (first insert rolled back)",
        tripACountAfter === 0,
        `tripA_groups=${tripACountAfter}`,
      );
      const tripASGICount = (db
        .prepare(
          `SELECT COUNT(*) n FROM scene_group_items WHERE scene_group_id IN (SELECT id FROM scene_groups WHERE trip_id=?)`,
        )
        .get(tripA) as { n: number }).n;
      record(
        "rollback: tripA has NO scene_group_items rows",
        tripASGICount === 0,
        `tripA_items=${tripASGICount}`,
      );
      const tripBCountAfter = (db
        .prepare(`SELECT COUNT(*) n FROM scene_groups WHERE trip_id=?`)
        .get(tripB) as { n: number }).n;
      record(
        "rollback: tripB rows survived tripA's failed run (cross-trip isolation)",
        tripBCountAfter === tripBCountBefore && tripBCountAfter > 0,
        `tripB before=${tripBCountBefore} after=${tripBCountAfter}`,
      );

      // After the failure the user retries with healthy deps → success.
      const retry = runSceneGroupingForTrip({ tripId: tripA, selectionRound: 1 }, deps);
      record(
        "rollback: clean retry succeeds and writes (2 groups for tripA)",
        retry.sceneGroupCount === 2 && retry.sceneItemCount === 3,
        `groups=${retry.sceneGroupCount} items=${retry.sceneItemCount}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 6: filters — soft-deleted, failed-status, non-image are all
    //          excluded from candidates.
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "Filters");
      seedMedia(db, tripId, { exifCapturedAt: "2026-04-05T09:00:00.000Z", qualityScore: 0.9 });
      seedMedia(db, tripId, { exifCapturedAt: "2026-04-05T09:01:00.000Z", softDeleted: true });
      seedMedia(db, tripId, { exifCapturedAt: "2026-04-05T09:02:00.000Z", status: "failed" });
      seedMedia(db, tripId, { exifCapturedAt: "2026-04-05T09:03:00.000Z", type: "video" });

      const deps = makeDeps(db);
      const res = runSceneGroupingForTrip({ tripId, selectionRound: 1 }, deps);
      record(
        "filters: only 1 candidate accepted (image, not deleted, not failed)",
        res.sceneGroupCount === 1 && res.sceneItemCount === 1,
        `groups=${res.sceneGroupCount} items=${res.sceneItemCount}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 7: dryRun — plan returned, NO DB writes.
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "DryRun");
      seedMedia(db, tripId, { exifCapturedAt: "2026-04-06T09:00:00.000Z", qualityScore: 0.5 });
      seedMedia(db, tripId, { exifCapturedAt: "2026-04-06T09:00:30.000Z", qualityScore: 0.8 });

      const deps = makeDeps(db);
      const res = runSceneGroupingForTrip({ tripId, selectionRound: 1, dryRun: true }, deps);
      record(
        "dryRun: plan returned with 1 group / 2 items",
        res.dryRun === true && res.sceneGroupCount === 1 && res.sceneItemCount === 2,
        `dryRun=${res.dryRun} groups=${res.sceneGroupCount} items=${res.sceneItemCount}`,
      );
      const writtenCount = (db
        .prepare(`SELECT COUNT(*) n FROM scene_groups WHERE trip_id=?`)
        .get(tripId) as { n: number }).n;
      record("dryRun: NO scene_groups row written", writtenCount === 0, `count=${writtenCount}`);
    }

    // -----------------------------------------------------------------------
    // CASE 8: round invariant — round=0 rejected; negative rejected;
    //          non-integer rejected.
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "Invariants");
      seedMedia(db, tripId, { qualityScore: 0.5 });
      const deps = makeDeps(db);
      expectThrow(
        "invariant: round=0 rejected",
        () => runSceneGroupingForTrip({ tripId, selectionRound: 0 }, deps),
        /selectionRound must be an integer >= 1/,
      );
      expectThrow(
        "invariant: round=-1 rejected",
        () => runSceneGroupingForTrip({ tripId, selectionRound: -1 }, deps),
        /selectionRound must be an integer >= 1/,
      );
      expectThrow(
        "invariant: round=0.5 rejected",
        () => runSceneGroupingForTrip({ tripId, selectionRound: 0.5 }, deps),
        /selectionRound must be an integer >= 1/,
      );
      expectThrow(
        "invariant: empty tripId rejected",
        () => runSceneGroupingForTrip({ tripId: "", selectionRound: 1 }, deps),
        /tripId must be non-empty/,
      );
      expectThrow(
        "invariant: settings.timeGapSeconds=0 rejected",
        () =>
          runSceneGroupingForTrip(
            { tripId, selectionRound: 1 },
            { ...deps, settings: { timeGapSeconds: 0 } },
          ),
        /timeGapSeconds must be > 0/,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 9: AI embedding stub — provider declared available; service
    //          flags it in algorithm_version BUT never calls
    //          computeEmbeddings.
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "AIstub");
      seedMedia(db, tripId, { exifCapturedAt: "2026-04-07T09:00:00.000Z", qualityScore: 0.5 });
      let computeCalled = false;
      const stub: SceneEmbeddingProvider = {
        isAvailable: () => true,
        computeEmbeddings: async () => {
          computeCalled = true;
          return new Map();
        },
      };
      const deps = makeDeps(db, stub);
      const res = runSceneGroupingForTrip({ tripId, selectionRound: 1 }, deps);
      record(
        "AI stub: algorithm_version includes '+scene_embedding-pending' suffix",
        res.algorithmVersion === `${SCENE_GROUPING_ALGORITHM_VERSION_CODE_TIME}+scene_embedding-pending`,
        `algorithmVersion=${res.algorithmVersion}`,
      );
      record(
        "AI stub: baseline NEVER invoked computeEmbeddings",
        computeCalled === false,
        `computeCalled=${computeCalled}`,
      );
      // And the row in scene_groups reflects the new algorithm_version.
      const groups = new SceneGroupsRepository(db).listByTripRound(tripId, 1);
      record(
        "AI stub: scene_groups.algorithm_version persisted with suffix",
        groups.length === 1 &&
          groups[0]!.algorithmVersion ===
            `${SCENE_GROUPING_ALGORITHM_VERSION_CODE_TIME}+scene_embedding-pending`,
        `persisted=${groups[0]?.algorithmVersion}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 10: EXIF fallback — when media_versions(metadata) missing or
    //          malformed, captured_at falls back to media_items.created_at.
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "Fallback");
      // No EXIF → created_at fallback. Set created_at far apart to
      // verify the fallback ISO string actually drives the time-gap split.
      const a = seedMedia(db, tripId, { createdAt: "2026-04-08T08:00:00.000Z", qualityScore: 0.5 });
      // 30 minutes later → > 15 min gap → split into a new group.
      const b = seedMedia(db, tripId, { createdAt: "2026-04-08T08:30:00.000Z", qualityScore: 0.6 });
      // Malformed EXIF: not valid JSON → fallback to created_at.
      const c = randomUUID();
      const cCreated = "2026-04-08T08:31:00.000Z";
      dbHandle.db
        .prepare(
          `INSERT INTO media_items (id, trip_id, type, original_path, mime_type, extension, file_size, status, user_decision, created_at, updated_at)
           VALUES (?, ?, 'image', ?, 'image/jpeg', 'jpg', 4096, 'processed', 'undecided', ?, ?)`,
        )
        .run(c, tripId, `trips/${tripId}/originals/${c}.jpg`, cCreated, cCreated);
      dbHandle.db
        .prepare(
          `INSERT INTO media_versions (id, media_id, version_type, file_path, mime_type, params, status)
           VALUES (?, ?, 'metadata', ?, 'application/json', 'NOT JSON {{{', 'ready')`,
        )
        .run(randomUUID(), c, `trips/${tripId}/originals/${c}.jpg`);

      const deps = makeDeps(db);
      const res = runSceneGroupingForTrip({ tripId, selectionRound: 1 }, deps);
      record(
        "fallback: 2 groups (a alone; b+c together via created_at)",
        res.sceneGroupCount === 2 && res.sceneItemCount === 3,
        `groups=${res.sceneGroupCount} items=${res.sceneItemCount}`,
      );
      const groups = new SceneGroupsRepository(db).listByTripRound(tripId, 1);
      record(
        "fallback: group 0 captured_at_start=08:00 (a's created_at)",
        groups[0]!.capturedAtStart === "2026-04-08T08:00:00.000Z",
        `start=${groups[0]!.capturedAtStart}`,
      );
      const items = new SceneGroupItemsRepository(db).listByGroup(groups[0]!.id);
      record(
        "fallback: rank-0 reason mentions 'created_at' source",
        items[0]!.reason !== null && items[0]!.reason.includes("created_at"),
        `reason=${String(items[0]!.reason)}`,
      );
      // Sanity — a is in the first group, b and c in the second.
      const g1Items = new SceneGroupItemsRepository(db).listByGroup(groups[1]!.id);
      record(
        "fallback: group 1 contains b + c (malformed EXIF media)",
        g1Items.length === 2 &&
          g1Items.map((it) => it.mediaId).sort().join(",") === [b, c].sort().join(","),
        `members=${g1Items.map((it) => it.mediaId).sort().join(",")}`,
      );
      record(
        "fallback: a is alone in group 0",
        items.length === 1 && items[0]!.mediaId === a,
        `g0Items=${items.map((it) => it.mediaId).join(",")}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 11: SCENE_GROUPING_JOB_TYPE constant — sanity check that the
    //          orchestrator-facing public constant has the right value.
    // -----------------------------------------------------------------------
    {
      record(
        "constant: SCENE_GROUPING_JOB_TYPE === 'scene_grouping'",
        SCENE_GROUPING_JOB_TYPE === "scene_grouping",
        `value=${SCENE_GROUPING_JOB_TYPE}`,
      );
      record(
        "constant: DEFAULT_SCENE_GROUPING_SETTINGS.timeGapSeconds = 900",
        DEFAULT_SCENE_GROUPING_SETTINGS.timeGapSeconds === 900,
        `timeGapSeconds=${DEFAULT_SCENE_GROUPING_SETTINGS.timeGapSeconds}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 12: clear-on-rerun for a trip whose media were all
    //          soft-deleted — previous round's rows should be cleared
    //          to "no_candidates".
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "ClearOnSoftDelete");
      const m = seedMedia(db, tripId, { exifCapturedAt: "2026-04-09T09:00:00.000Z", qualityScore: 0.5 });
      const deps = makeDeps(db);
      const first = runSceneGroupingForTrip({ tripId, selectionRound: 1 }, deps);
      record("clear-on-rerun: first run wrote 1 group", first.sceneGroupCount === 1, `n=${first.sceneGroupCount}`);

      // Now soft-delete the media and re-run.
      db.prepare(`UPDATE media_items SET deleted_at=? WHERE id=?`).run(new Date().toISOString(), m);
      const second = runSceneGroupingForTrip({ tripId, selectionRound: 1 }, deps);
      record(
        "clear-on-rerun: 2nd run skips with no_candidates",
        second.skippedReason === "no_candidates" && second.sceneGroupCount === 0,
        `reason=${String(second.skippedReason)} n=${second.sceneGroupCount}`,
      );
      const remaining = (db
        .prepare(`SELECT COUNT(*) n FROM scene_groups WHERE trip_id=?`)
        .get(tripId) as { n: number }).n;
      record(
        "clear-on-rerun: prior scene_groups rows wiped (clean slate)",
        remaining === 0,
        `remaining=${remaining}`,
      );
    }
  } finally {
    closeDatabase(dbHandle);
    await rm(tmpRoot, { recursive: true, force: true });
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n[smoke] summary: ${passed}/${results.length} passed`);
  if (failed > 0) {
    console.log(`[smoke] failures: ${results.filter((r) => !r.ok).map((r) => r.name).join(", ")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[smoke] uncaught error: ${describeError(err)}`);
  process.exit(1);
});
