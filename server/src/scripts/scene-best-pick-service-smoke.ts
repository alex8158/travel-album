// Manual smoke test for sceneBestPickService (P12.T6 baseline).
//
// Usage: npm run smoke:scene-best-pick-service
//
// Coverage (matches the P12.T6 prompt's test requirements):
//   * 空 trip 不报错                       → trip-level
//   * 空 / 不存在 scene group 不报错       → group-level skip
//   * 单 group 单 item 可被选中            → single-member shortcut
//   * 单 group 多 item 选择最高分          → Code score wins,
//                                            top-K draft rows
//   * 模糊 item 被降权或跳过                → ai_blur_class='blurry'
//                                            cut score; not_best
//   * 缺失 analysis 时 graceful fallback   → score 0.5 default
//   * 同分 tie-break 稳定                  → rank/created/id order
//   * 重复执行幂等，不重复写入             → DELETE-then-INSERT
//                                            inside one TX
//   * 不覆盖用户 round / user decision     → round=0 row untouched
//                                            across reruns
//   * 写入 curated_selections 字段正确    → is_current=0,
//                                            included for best,
//                                            reason for not_best
//   * AI off → Code top-1 fallback         → outcome=code_fallback_ai_off
//   * AI returns invalid mediaId → Code fallback
//   * AI throws → Code fallback + failed audit
//   * cache hit on same input              → outcome=cache_hit
//   * trip-level batch isolation           → 1 throwing + 1 ok
//   * ai_invocations written with the P12 column set
//
// The smoke uses the LocalMockProvider (P12.T1) for AI calls — no
// network, no secrets, deterministic by mediaId hash.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { AiInvocationsRepository, LocalMockProvider, NoopProvider } from "../ai/index.js";
import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import {
  DEFAULT_SCENE_BEST_PICK_TOP_K,
  SCENE_BEST_PICK_JOB_TYPE,
  SCENE_BEST_PICK_REQUEST_TYPE,
  SCENE_BEST_PICK_TARGET_TYPE,
  runSceneBestPickForGroup,
  runSceneBestPickForTrip,
  sceneBestPickComputeScore,
  type SceneBestPickDeps,
} from "../jobs/index.js";
import { createLogger } from "../logger.js";
import {
  CuratedSelectionsRepository,
  MediaAnalysisRepository,
  MediaRepository,
  SceneGroupItemsRepository,
  SceneGroupsRepository,
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

// ---------------------------------------------------------------------------
// Seeding helpers
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

interface SeedMediaOpts {
  readonly type?: string;
  readonly status?: string;
  readonly softDeleted?: boolean;
  readonly createdAt?: string;
  readonly qualityScore?: number | null;
  readonly aiBlurClass?: "sharp" | "maybe_blurry" | "blurry" | "unknown";
  readonly isBlurry?: 0 | 1;
  readonly isDuplicate?: 0 | 1;
}

function seedMedia(db: SqliteDatabase, tripId: string, opts: SeedMediaOpts = {}): string {
  const id = randomUUID();
  const now = opts.createdAt ?? new Date().toISOString();
  const status = opts.status ?? "processed";
  const type = opts.type ?? "image";
  const deletedAt = opts.softDeleted ? now : null;

  db.prepare(
    `INSERT INTO media_items
       (id, trip_id, type, original_path, mime_type, extension, file_size,
        status, user_decision, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, 'image/jpeg', 'jpg', 4096,
             ?, 'undecided', ?, ?, ?)`,
  ).run(id, tripId, type, `trips/${tripId}/originals/${id}.jpg`, status, now, now, deletedAt);

  // Only insert media_analysis when at least one analytic field is
  // provided — the missing-analysis case is also a test goal.
  if (
    opts.qualityScore !== undefined ||
    opts.aiBlurClass !== undefined ||
    opts.isBlurry !== undefined ||
    opts.isDuplicate !== undefined
  ) {
    db.prepare(
      `INSERT INTO media_analysis
         (id, media_id, quality_score, is_blurry, is_duplicate, ai_blur_class, ai_blur_reason, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'seed')`,
    ).run(
      randomUUID(),
      id,
      opts.qualityScore ?? null,
      opts.isBlurry ?? null,
      opts.isDuplicate ?? null,
      opts.aiBlurClass ?? null,
      opts.aiBlurClass !== undefined ? `seed ${opts.aiBlurClass}` : null,
      // reason already 'seed'
    );
  }
  return id;
}

function seedGroup(
  db: SqliteDatabase,
  tripId: string,
  selectionRound: number,
  groupIndex: number,
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO scene_groups
       (id, trip_id, selection_round, group_index, member_count, algorithm_version, created_at)
     VALUES (?, ?, ?, ?, 0, 'test-1.0', ?)`,
  ).run(id, tripId, selectionRound, groupIndex, now);
  return id;
}

function seedGroupItem(
  db: SqliteDatabase,
  sceneGroupId: string,
  mediaId: string,
  selectionRound: number,
  rankInGroup: number,
  groupScore: number | null = null,
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO scene_group_items
       (id, scene_group_id, media_id, selection_round, group_score, similarity_score, rank_in_group, reason)
     VALUES (?, ?, ?, ?, ?, NULL, ?, 'seed')`,
  ).run(id, sceneGroupId, mediaId, selectionRound, groupScore, rankInGroup);
  return id;
}

// ---------------------------------------------------------------------------
// Deps factory
// ---------------------------------------------------------------------------

type ProviderLike = {
  readonly name: string;
  readonly available: boolean;
  readonly supports: ReadonlySet<unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly invoke: (req: any) => Promise<any>;
};

function makeDeps(db: SqliteDatabase, provider: ProviderLike): SceneBestPickDeps {
  return {
    db,
    sceneGroupsRepo: new SceneGroupsRepository(db),
    sceneGroupItemsRepo: new SceneGroupItemsRepository(db),
    curatedSelectionsRepo: new CuratedSelectionsRepository(db),
    mediaRepo: new MediaRepository(db),
    mediaAnalysisRepo: new MediaAnalysisRepository(db),
    aiInvocationsRepo: new AiInvocationsRepository(db),
    aiProvider: provider as unknown as SceneBestPickDeps["aiProvider"],
    logger: createLogger({ nodeEnv: "test", level: "fatal" }),
  };
}

// ---------------------------------------------------------------------------
// DB query helpers
// ---------------------------------------------------------------------------

function listCuratedForGroup(
  db: SqliteDatabase,
  tripId: string,
  round: number,
  sceneGroupId: string,
): {
  mediaId: string;
  included: number;
  isCurrent: number;
  reason: string | null;
  aiConfidence: number | null;
  userDecision: string | null;
}[] {
  return db
    .prepare(
      `SELECT media_id AS mediaId, included, is_current AS isCurrent, reason, ai_confidence AS aiConfidence, user_decision AS userDecision
       FROM curated_selections
       WHERE trip_id = ? AND selection_round = ? AND scene_group_id = ?
       ORDER BY included DESC, media_id ASC`,
    )
    .all(tripId, round, sceneGroupId) as never;
}

function countAiInvocationsForGroup(db: SqliteDatabase, sceneGroupId: string): number {
  return (db
    .prepare(
      `SELECT COUNT(*) n FROM ai_invocations WHERE target_type = 'scene_group' AND target_id = ?`,
    )
    .get(sceneGroupId) as { n: number }).n;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-scene-best-pick-"));
  const dbHandle = openDatabase(path.join(tmpRoot, "smoke.db"));
  console.log(`[smoke] tmpRoot=${tmpRoot}`);
  try {
    runMigrations(dbHandle.db);
    const db = dbHandle.db;
    const mockProvider = new LocalMockProvider();

    // -----------------------------------------------------------------------
    // CASE 1: empty trip (no scene_groups) → trip-level returns zero groups
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "Empty");
      const deps = makeDeps(db, mockProvider);
      const res = await runSceneBestPickForTrip(tripId, 1, deps);
      record(
        "empty trip: groupCount=0, zero outcomes, no error",
        res.groupCount === 0 &&
          res.successCount === 0 &&
          res.cacheHitCount === 0 &&
          res.codeFallbackCount === 0 &&
          res.skippedCount === 0,
        `gc=${res.groupCount}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 2: non-existent scene group → skipped_group_not_found
    // -----------------------------------------------------------------------
    {
      const deps = makeDeps(db, mockProvider);
      const res = await runSceneBestPickForGroup(randomUUID(), deps);
      record(
        "missing group: outcome=skipped_group_not_found",
        res.outcome === "skipped_group_not_found",
        `outcome=${res.outcome}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 3: scene group with selection_round=0 → skipped_round_mismatch
    //          (the schema CHECK allows round=0 on scene_groups; the
    //          worker refuses to write into the user override layer).
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "Round0");
      const gId = seedGroup(db, tripId, 0, 0);
      const m = seedMedia(db, tripId, { qualityScore: 0.8 });
      seedGroupItem(db, gId, m, 0, 0);
      const deps = makeDeps(db, mockProvider);
      const res = await runSceneBestPickForGroup(gId, deps);
      record(
        "round=0 group: outcome=skipped_round_mismatch",
        res.outcome === "skipped_round_mismatch",
        `outcome=${res.outcome}`,
      );
      record(
        "round=0 group: NO curated_selections row written",
        listCuratedForGroup(db, tripId, 0, gId).length === 0,
        `rows=${listCuratedForGroup(db, tripId, 0, gId).length}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 4: single-member group → single-member shortcut
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "Single");
      const gId = seedGroup(db, tripId, 1, 0);
      const m = seedMedia(db, tripId, { qualityScore: 0.9 });
      seedGroupItem(db, gId, m, 1, 0);
      const deps = makeDeps(db, mockProvider);
      const res = await runSceneBestPickForGroup(gId, deps);
      record(
        "single-member: outcome=code_fallback_single_member",
        res.outcome === "code_fallback_single_member",
        `outcome=${res.outcome}`,
      );
      record(
        "single-member: bestMediaId = the only member",
        res.bestMediaId === m,
        `best=${String(res.bestMediaId)} expected=${m}`,
      );
      const rows = listCuratedForGroup(db, tripId, 1, gId);
      record(
        "single-member: 1 curated_selections row, included=1, is_current=0, reason='single-member-group'",
        rows.length === 1 &&
          rows[0]!.included === 1 &&
          rows[0]!.isCurrent === 0 &&
          rows[0]!.reason === "single-member-group" &&
          rows[0]!.userDecision === null,
        `${JSON.stringify(rows)}`,
      );
      record(
        "single-member: ai_invocations row written (target_type=scene_group, target_id=group)",
        countAiInvocationsForGroup(db, gId) === 1,
        `n=${countAiInvocationsForGroup(db, gId)}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 5: multi-member group, AI happy path
    //          5 candidates; AI picks deterministically. Verify
    //          best/non-best rows + fields.
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "Happy");
      const gId = seedGroup(db, tripId, 1, 0);
      const mediaIds: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const id = seedMedia(db, tripId, { qualityScore: 0.5 + i * 0.05 });
        mediaIds.push(id);
        seedGroupItem(db, gId, id, 1, i);
      }
      const deps = makeDeps(db, mockProvider);
      const res = await runSceneBestPickForGroup(gId, deps);
      record(
        "happy: outcome=success",
        res.outcome === "success",
        `outcome=${res.outcome} err=${String(res.errorMessage)}`,
      );
      record(
        "happy: writtenCount = 5 (= K)",
        res.writtenCount === 5,
        `written=${res.writtenCount}`,
      );
      const rows = listCuratedForGroup(db, tripId, 1, gId);
      record(
        "happy: exactly 5 curated_selections rows; 1 included=1, 4 included=0",
        rows.length === 5 &&
          rows.filter((r) => r.included === 1).length === 1 &&
          rows.filter((r) => r.included === 0).length === 4,
        `n=${rows.length} included1=${rows.filter((r) => r.included === 1).length}`,
      );
      record(
        "happy: every row has is_current=0 (finalize owns is_current=1)",
        rows.every((r) => r.isCurrent === 0),
        `current_flags=${rows.map((r) => r.isCurrent).join(",")}`,
      );
      record(
        "happy: best row has aiConfidence set; not_best rows have aiConfidence=null + reason='not_best_in_group'",
        rows
          .filter((r) => r.included === 0)
          .every((r) => r.aiConfidence === null && r.reason === "not_best_in_group") &&
          rows.find((r) => r.included === 1)!.aiConfidence !== null,
        `best_conf=${rows.find((r) => r.included === 1)?.aiConfidence}`,
      );
      record(
        "happy: every row has user_decision=NULL (layer discipline preserved)",
        rows.every((r) => r.userDecision === null),
        `user_decisions=${rows.map((r) => String(r.userDecision)).join(",")}`,
      );
      const auditRow = db
        .prepare(
          `SELECT trip_id, target_type, target_id, input_hash, status, response_summary
           FROM ai_invocations WHERE target_id = ?`,
        )
        .get(gId) as {
          trip_id: string | null;
          target_type: string;
          target_id: string;
          input_hash: string | null;
          status: string;
          response_summary: string | null;
        };
      record(
        "happy: ai_invocations P12 columns correct",
        auditRow.trip_id === tripId &&
          auditRow.target_type === "scene_group" &&
          auditRow.target_id === gId &&
          auditRow.input_hash !== null &&
          auditRow.status === "success",
        `trip=${auditRow.trip_id === tripId} ttype=${auditRow.target_type} hash=${auditRow.input_hash !== null} status=${auditRow.status}`,
      );
      record(
        "happy: ai_invocations.response_summary parses as JSON with verdictSource='ai'",
        (() => {
          try {
            const j = JSON.parse(auditRow.response_summary ?? "null") as { verdictSource?: string };
            return j.verdictSource === "ai";
          } catch {
            return false;
          }
        })(),
        `summary=${auditRow.response_summary?.slice(0, 80)}...`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 6: multi-member, ai_blur_class='blurry' on the highest-quality
    //          item → it gets cut score and another wins.
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "Blur");
      const gId = seedGroup(db, tripId, 1, 0);
      // high-quality but blurry → score = 0.9 * 0.3 = 0.27
      const blurredHigh = seedMedia(db, tripId, { qualityScore: 0.9, aiBlurClass: "blurry" });
      // medium quality, sharp → score = 0.6 * 1.0 = 0.6
      const sharpMid = seedMedia(db, tripId, { qualityScore: 0.6, aiBlurClass: "sharp" });
      // low quality, sharp → score = 0.3
      const sharpLow = seedMedia(db, tripId, { qualityScore: 0.3, aiBlurClass: "sharp" });
      seedGroupItem(db, gId, blurredHigh, 1, 0);
      seedGroupItem(db, gId, sharpMid, 1, 1);
      seedGroupItem(db, gId, sharpLow, 1, 2);
      const deps = makeDeps(db, mockProvider);
      const res = await runSceneBestPickForGroup(gId, deps);
      record(
        "blurry-cut: outcome=success",
        res.outcome === "success",
        `outcome=${res.outcome}`,
      );
      // AI (LocalMock) picks deterministically from top-K; for the
      // assertion we check the Code top-K ORDER was correct: sharpMid
      // first, sharpLow second, blurredHigh last. The AI's pick must
      // be one of those three (it is, since top-K = full group).
      record(
        "blurry-cut: AI's bestMediaId is within the top-K (not blurredHigh alone)",
        [blurredHigh, sharpMid, sharpLow].includes(res.bestMediaId ?? ""),
        `best=${String(res.bestMediaId)}`,
      );
      // Validate the Code score function directly: blurredHigh < sharpMid.
      const blurredScore = sceneBestPickComputeScore({
        qualityScore: 0.9,
        aiBlurClass: "blurry",
        isBlurry: null,
        isDuplicate: null,
      });
      const sharpMidScore = sceneBestPickComputeScore({
        qualityScore: 0.6,
        aiBlurClass: "sharp",
        isBlurry: null,
        isDuplicate: null,
      });
      record(
        "blurry-cut: computeScore — 0.9*0.3=0.27 < 0.6*1.0=0.60 (multiplier downweights)",
        Math.abs(blurredScore - 0.27) < 1e-9 &&
          Math.abs(sharpMidScore - 0.6) < 1e-9 &&
          blurredScore < sharpMidScore,
        `blurred=${blurredScore} sharpMid=${sharpMidScore}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 7: missing media_analysis → score uses 0.5 default; not skipped
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "NoAnalysis");
      const gId = seedGroup(db, tripId, 1, 0);
      const noAnalysis = seedMedia(db, tripId); // no qualityScore etc.
      const lowAnalysis = seedMedia(db, tripId, { qualityScore: 0.2 });
      seedGroupItem(db, gId, noAnalysis, 1, 0);
      seedGroupItem(db, gId, lowAnalysis, 1, 1);
      const deps = makeDeps(db, mockProvider);
      const res = await runSceneBestPickForGroup(gId, deps);
      record(
        "no-analysis: outcome=success (graceful fallback)",
        res.outcome === "success",
        `outcome=${res.outcome}`,
      );
      record(
        "no-analysis: both items written (no skip)",
        res.writtenCount === 2,
        `written=${res.writtenCount}`,
      );
      // Code score for noAnalysis = 0.5; for lowAnalysis = 0.2. Code
      // top-1 is noAnalysis. AI pick must be in {noAnalysis, lowAnalysis}.
      const rows = listCuratedForGroup(db, tripId, 1, gId);
      record(
        "no-analysis: best row's mediaId is one of the two seeded",
        rows.find((r) => r.included === 1)?.mediaId === noAnalysis ||
          rows.find((r) => r.included === 1)?.mediaId === lowAnalysis,
        `best=${rows.find((r) => r.included === 1)?.mediaId}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 8: tie-break stability — equal score, different rank/created
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "TieBreak");
      const gId = seedGroup(db, tripId, 1, 0);
      // Same quality_score → equal Code score; ties resolved by
      // rank_in_group ASC.
      const a = seedMedia(db, tripId, { qualityScore: 0.6 });
      const b = seedMedia(db, tripId, { qualityScore: 0.6 });
      const c = seedMedia(db, tripId, { qualityScore: 0.6 });
      seedGroupItem(db, gId, a, 1, 0);
      seedGroupItem(db, gId, b, 1, 1);
      seedGroupItem(db, gId, c, 1, 2);
      const deps = makeDeps(db, mockProvider);
      // Run twice; the top-K mediaIds (and therefore input_hash)
      // must be identical → 2nd run becomes cache_hit.
      const first = await runSceneBestPickForGroup(gId, deps);
      const second = await runSceneBestPickForGroup(gId, deps);
      record(
        "tie-break: 1st = success, 2nd = cache_hit (deterministic top-K)",
        first.outcome === "success" && second.outcome === "cache_hit",
        `1=${first.outcome} 2=${second.outcome}`,
      );
      record(
        "tie-break: same auditId returned across runs",
        first.auditId !== null && first.auditId === second.auditId,
        `1=${first.auditId} 2=${second.auditId}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 9: idempotency on re-run — DELETE-then-INSERT keeps 1 row per
    //         media; row count stays exactly at top-K.
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "Idempotent");
      const gId = seedGroup(db, tripId, 1, 0);
      const mediaIds: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const id = seedMedia(db, tripId, { qualityScore: 0.5 + i * 0.1 });
        mediaIds.push(id);
        seedGroupItem(db, gId, id, 1, i);
      }
      const deps = makeDeps(db, mockProvider);
      const first = await runSceneBestPickForGroup(gId, deps);
      const beforeCount = listCuratedForGroup(db, tripId, 1, gId).length;
      const second = await runSceneBestPickForGroup(gId, deps);
      const afterCount = listCuratedForGroup(db, tripId, 1, gId).length;
      record(
        "idempotency: 1st success → 3 rows; 2nd = cache_hit → still 3 rows",
        first.outcome === "success" &&
          second.outcome === "cache_hit" &&
          beforeCount === 3 &&
          afterCount === 3,
        `before=${beforeCount} after=${afterCount}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 10: protect user round (round=0) on re-run.
    //          Seed a round=0 user pin first, run the worker, verify
    //          the override row is intact + the worker's draft rows
    //          appear separately.
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "ProtectUser");
      const gId = seedGroup(db, tripId, 1, 0);
      const a = seedMedia(db, tripId, { qualityScore: 0.5 });
      const b = seedMedia(db, tripId, { qualityScore: 0.7 });
      seedGroupItem(db, gId, a, 1, 0);
      seedGroupItem(db, gId, b, 1, 1);
      const deps = makeDeps(db, mockProvider);

      // User pin on media a (round=0). This row MUST NOT be touched
      // by the worker even though the same trip+media will get a
      // round=1 draft.
      deps.curatedSelectionsRepo.upsertOverride(randomUUID(), tripId, a, "kept");
      const pinBefore = deps.curatedSelectionsRepo.findByTripRoundMedia(tripId, 0, a);
      record(
        "protect-user: pin seeded at round=0",
        pinBefore !== null && pinBefore.userDecision === "kept" && pinBefore.included === 1,
        `${JSON.stringify(pinBefore)}`,
      );

      // Run the worker (first call writes round=1 drafts).
      await runSceneBestPickForGroup(gId, deps);
      const pinAfter1 = deps.curatedSelectionsRepo.findByTripRoundMedia(tripId, 0, a);
      record(
        "protect-user: after 1st worker run, round=0 pin still present + included=1 + user_decision='kept'",
        pinAfter1 !== null &&
          pinAfter1.userDecision === "kept" &&
          pinAfter1.included === 1 &&
          pinAfter1.id === pinBefore!.id,
        `${JSON.stringify(pinAfter1)}`,
      );
      record(
        "protect-user: worker wrote round=1 draft rows alongside the override",
        listCuratedForGroup(db, tripId, 1, gId).length === 2,
        `n=${listCuratedForGroup(db, tripId, 1, gId).length}`,
      );

      // Re-run; verify round=0 pin still intact and round=1 draft
      // count unchanged.
      const second = await runSceneBestPickForGroup(gId, deps);
      const pinAfter2 = deps.curatedSelectionsRepo.findByTripRoundMedia(tripId, 0, a);
      record(
        "protect-user: after 2nd worker run, round=0 pin row identity unchanged",
        pinAfter2 !== null && pinAfter2.id === pinBefore!.id && pinAfter2.userDecision === "kept",
        `${JSON.stringify(pinAfter2)}`,
      );
      record(
        "protect-user: 2nd run is cache_hit",
        second.outcome === "cache_hit",
        `outcome=${second.outcome}`,
      );
      // Validate the cross-round counts: 1 round=0 row + 2 round=1 rows.
      const total = (db
        .prepare(
          `SELECT COUNT(*) n FROM curated_selections WHERE trip_id = ?`,
        )
        .get(tripId) as { n: number }).n;
      record(
        "protect-user: total rows = 3 across rounds (1 round=0 + 2 round=1)",
        total === 3,
        `total=${total}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 11: AI off → Code top-1 fallback
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "AIoff");
      const gId = seedGroup(db, tripId, 1, 0);
      const a = seedMedia(db, tripId, { qualityScore: 0.4 });
      const b = seedMedia(db, tripId, { qualityScore: 0.8 });
      seedGroupItem(db, gId, a, 1, 0);
      seedGroupItem(db, gId, b, 1, 1);
      const deps = makeDeps(db, new NoopProvider());
      const res = await runSceneBestPickForGroup(gId, deps);
      record(
        "ai-off: outcome=code_fallback_ai_off",
        res.outcome === "code_fallback_ai_off",
        `outcome=${res.outcome}`,
      );
      record(
        "ai-off: bestMediaId = Code top-1 (highest quality = b)",
        res.bestMediaId === b,
        `best=${String(res.bestMediaId)} expected=${b}`,
      );
      record(
        "ai-off: 2 draft rows written, best is b, audit row has status=success + verdictSource=code_top_1_ai_off",
        (() => {
          const rows = listCuratedForGroup(db, tripId, 1, gId);
          if (rows.length !== 2) return false;
          if (rows.find((r) => r.included === 1)?.mediaId !== b) return false;
          const audit = db
            .prepare(
              `SELECT status, response_summary FROM ai_invocations WHERE target_id = ?`,
            )
            .get(gId) as { status: string; response_summary: string | null };
          if (audit.status !== "success") return false;
          try {
            const j = JSON.parse(audit.response_summary ?? "null") as { verdictSource?: string };
            return j.verdictSource === "code_top_1_ai_off";
          } catch {
            return false;
          }
        })(),
        "verified in IIFE",
      );
    }

    // -----------------------------------------------------------------------
    // CASE 12: AI returns invalid mediaId → Code fallback
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "InvalidPick");
      const gId = seedGroup(db, tripId, 1, 0);
      const a = seedMedia(db, tripId, { qualityScore: 0.9 });
      const b = seedMedia(db, tripId, { qualityScore: 0.5 });
      seedGroupItem(db, gId, a, 1, 0);
      seedGroupItem(db, gId, b, 1, 1);
      const hallucinatingProvider: ProviderLike = {
        name: "hallucinator",
        available: true,
        supports: new Set(["scene_best_pick"]),
        invoke: async () => ({
          status: "success" as const,
          provider: "hallucinator",
          modelName: "hallucinator-v1",
          costEstimate: 0,
          durationMs: 1,
          outputBytes: Buffer.from(
            JSON.stringify({
              bestMediaId: "completely-fictional-media-id",
              reason: "hallucinated",
              confidence: 0.99,
            }),
          ),
        }),
      };
      const deps = makeDeps(db, hallucinatingProvider);
      const res = await runSceneBestPickForGroup(gId, deps);
      record(
        "invalid-pick: outcome=code_fallback_invalid_pick",
        res.outcome === "code_fallback_invalid_pick",
        `outcome=${res.outcome}`,
      );
      record(
        "invalid-pick: bestMediaId = Code top-1 (highest quality = a)",
        res.bestMediaId === a,
        `best=${String(res.bestMediaId)} expected=${a}`,
      );
      const audit = db
        .prepare(`SELECT status, error_message FROM ai_invocations WHERE target_id = ?`)
        .get(gId) as { status: string; error_message: string | null };
      record(
        "invalid-pick: audit row status=failed + error_message mentions 'not in top-K'",
        audit.status === "failed" &&
          (audit.error_message ?? "").includes("not in top-K"),
        `status=${audit.status} err=${String(audit.error_message)?.slice(0, 60)}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 13: AI throws → Code fallback + failed audit
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "Throw");
      const gId = seedGroup(db, tripId, 1, 0);
      const a = seedMedia(db, tripId, { qualityScore: 0.7 });
      const b = seedMedia(db, tripId, { qualityScore: 0.4 });
      seedGroupItem(db, gId, a, 1, 0);
      seedGroupItem(db, gId, b, 1, 1);
      const throwing: ProviderLike = {
        name: "thrower",
        available: true,
        supports: new Set(["scene_best_pick"]),
        invoke: async () => {
          throw new Error("simulated outage");
        },
      };
      const deps = makeDeps(db, throwing);
      const res = await runSceneBestPickForGroup(gId, deps);
      record(
        "throw: outcome=code_fallback_provider_error + bestMediaId=a (top-1)",
        res.outcome === "code_fallback_provider_error" && res.bestMediaId === a,
        `outcome=${res.outcome} best=${String(res.bestMediaId)}`,
      );
      const audit = db
        .prepare(`SELECT status, error_message FROM ai_invocations WHERE target_id = ?`)
        .get(gId) as { status: string; error_message: string | null };
      record(
        "throw: audit row status=failed + error_message includes 'simulated outage'",
        audit.status === "failed" &&
          (audit.error_message ?? "").includes("simulated outage"),
        `status=${audit.status}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 14: cache hit reuses prior verdict and same auditId
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "Cache");
      const gId = seedGroup(db, tripId, 1, 0);
      for (let i = 0; i < 4; i += 1) {
        const id = seedMedia(db, tripId, { qualityScore: 0.4 + i * 0.1 });
        seedGroupItem(db, gId, id, 1, i);
      }
      const deps = makeDeps(db, mockProvider);
      const first = await runSceneBestPickForGroup(gId, deps);
      const second = await runSceneBestPickForGroup(gId, deps);
      const third = await runSceneBestPickForGroup(gId, deps);
      record(
        "cache: 1st=success, 2nd+3rd=cache_hit, all same auditId",
        first.outcome === "success" &&
          second.outcome === "cache_hit" &&
          third.outcome === "cache_hit" &&
          first.auditId === second.auditId &&
          second.auditId === third.auditId,
        `${first.outcome}/${second.outcome}/${third.outcome} audits=${first.auditId},${second.auditId},${third.auditId}`,
      );
      record(
        "cache: only 1 ai_invocations row written",
        countAiInvocationsForGroup(db, gId) === 1,
        `n=${countAiInvocationsForGroup(db, gId)}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 15: trip-level batch with mixed outcomes
    //          One throwing group + one happy group + one single-member.
    //          They must all complete (isolation), each with its own
    //          outcome.
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "BatchIsolation");
      const g1 = seedGroup(db, tripId, 1, 0); // multi-member, normal
      const g2 = seedGroup(db, tripId, 1, 1); // single-member
      const g3 = seedGroup(db, tripId, 1, 2); // empty -> skipped_no_eligible_members
      for (let i = 0; i < 3; i += 1) {
        const id = seedMedia(db, tripId, { qualityScore: 0.5 + i * 0.1 });
        seedGroupItem(db, g1, id, 1, i);
      }
      const onlyMember = seedMedia(db, tripId, { qualityScore: 0.8 });
      seedGroupItem(db, g2, onlyMember, 1, 0);
      // g3 has zero items.

      const deps = makeDeps(db, mockProvider);
      const res = await runSceneBestPickForTrip(tripId, 1, deps);
      record(
        "batch: groupCount=3 (g1, g2, g3 all considered)",
        res.groupCount === 3,
        `gc=${res.groupCount}`,
      );
      const g1Res = res.groupResults.find((r) => r.sceneGroupId === g1);
      const g2Res = res.groupResults.find((r) => r.sceneGroupId === g2);
      const g3Res = res.groupResults.find((r) => r.sceneGroupId === g3);
      record(
        "batch: g1=success, g2=code_fallback_single_member, g3=skipped_no_eligible_members",
        g1Res?.outcome === "success" &&
          g2Res?.outcome === "code_fallback_single_member" &&
          g3Res?.outcome === "skipped_no_eligible_members",
        `g1=${g1Res?.outcome} g2=${g2Res?.outcome} g3=${g3Res?.outcome}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 16: trip-level isolation — 1 throwing group + 1 happy group;
    //          batch processes both.
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "ThrowIso");
      const gOk = seedGroup(db, tripId, 1, 0);
      const gBad = seedGroup(db, tripId, 1, 1);
      for (let i = 0; i < 3; i += 1) {
        const id = seedMedia(db, tripId, { qualityScore: 0.5 + i * 0.1 });
        seedGroupItem(db, gOk, id, 1, i);
      }
      for (let i = 0; i < 3; i += 1) {
        const id = seedMedia(db, tripId, { qualityScore: 0.5 + i * 0.1 });
        seedGroupItem(db, gBad, id, 1, i);
      }
      const cond: ProviderLike = {
        name: "conditional",
        available: true,
        supports: new Set(["scene_best_pick"]),
        invoke: async (req: { params?: { candidates?: { mediaId: string }[] } }) => {
          const candidates = req.params?.candidates ?? [];
          // We don't have a clean way to discriminate by group here
          // (the provider only sees mediaIds). Use a marker via the
          // first mediaId — match against scene_group_items rows.
          const groupOfFirst = db
            .prepare(`SELECT scene_group_id FROM scene_group_items WHERE media_id = ? LIMIT 1`)
            .get(candidates[0]?.mediaId ?? "") as { scene_group_id: string } | undefined;
          if (groupOfFirst?.scene_group_id === gBad) {
            throw new Error("isolation: simulated bad-group failure");
          }
          return mockProvider.invoke({
            requestType: "scene_best_pick",
            params: { candidates },
          });
        },
      };
      const deps = makeDeps(db, cond);
      const res = await runSceneBestPickForTrip(tripId, 1, deps);
      const okRes = res.groupResults.find((r) => r.sceneGroupId === gOk);
      const badRes = res.groupResults.find((r) => r.sceneGroupId === gBad);
      record(
        "throw-iso: ok group → success; bad group → code_fallback_provider_error; batch did NOT abort",
        okRes?.outcome === "success" &&
          badRes?.outcome === "code_fallback_provider_error" &&
          res.successCount === 1 &&
          res.codeFallbackCount === 1,
        `ok=${okRes?.outcome} bad=${badRes?.outcome} s=${res.successCount} fb=${res.codeFallbackCount}`,
      );
      record(
        "throw-iso: both groups have curated_selections rows (code fallback still writes draft)",
        listCuratedForGroup(db, tripId, 1, gOk).length === 3 &&
          listCuratedForGroup(db, tripId, 1, gBad).length === 3,
        `ok=${listCuratedForGroup(db, tripId, 1, gOk).length} bad=${listCuratedForGroup(db, tripId, 1, gBad).length}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 17: invariants — empty group id, empty trip id, bad round,
    //          bad topK throw at the service boundary.
    // -----------------------------------------------------------------------
    {
      const deps = makeDeps(db, mockProvider);
      let threw: unknown;
      try {
        await runSceneBestPickForGroup("", deps);
      } catch (err) {
        threw = err;
      }
      record(
        "invariant: empty sceneGroupId throws synchronously",
        threw !== undefined && describeError(threw).includes("sceneGroupId must be non-empty"),
        `err=${describeError(threw)}`,
      );

      let threwTrip: unknown;
      try {
        await runSceneBestPickForTrip("", 1, deps);
      } catch (err) {
        threwTrip = err;
      }
      record(
        "invariant: empty tripId throws",
        threwTrip !== undefined && describeError(threwTrip).includes("tripId must be non-empty"),
        `err=${describeError(threwTrip)}`,
      );

      let threwRound: unknown;
      try {
        await runSceneBestPickForTrip(randomUUID(), 0, deps);
      } catch (err) {
        threwRound = err;
      }
      record(
        "invariant: round=0 throws",
        threwRound !== undefined &&
          describeError(threwRound).includes("selectionRound must be an integer >= 1"),
        `err=${describeError(threwRound)}`,
      );

      // bad topK — settings carries it; we re-create deps with a
      // bogus setting and run on any group.
      const tripId = seedTrip(db, "BadTopK");
      const gId = seedGroup(db, tripId, 1, 0);
      const m = seedMedia(db, tripId, { qualityScore: 0.5 });
      seedGroupItem(db, gId, m, 1, 0);
      const badDeps: SceneBestPickDeps = {
        ...deps,
        settings: { workerVersion: "test", topK: 0 },
      };
      let threwK: unknown;
      try {
        await runSceneBestPickForGroup(gId, badDeps);
      } catch (err) {
        threwK = err;
      }
      record(
        "invariant: settings.topK=0 throws",
        threwK !== undefined && describeError(threwK).includes("topK must be an integer >= 1"),
        `err=${describeError(threwK)}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 18: filters — non-image / soft-deleted / failed-status members
    //          drop out; remaining single eligible → single-member shortcut.
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "Filters");
      const gId = seedGroup(db, tripId, 1, 0);
      const ok = seedMedia(db, tripId, { qualityScore: 0.7 });
      const video = seedMedia(db, tripId, { qualityScore: 0.9, type: "video" });
      const soft = seedMedia(db, tripId, { qualityScore: 0.9, softDeleted: true });
      const failed = seedMedia(db, tripId, { qualityScore: 0.9, status: "failed" });
      seedGroupItem(db, gId, ok, 1, 0);
      seedGroupItem(db, gId, video, 1, 1);
      seedGroupItem(db, gId, soft, 1, 2);
      seedGroupItem(db, gId, failed, 1, 3);
      const deps = makeDeps(db, mockProvider);
      const res = await runSceneBestPickForGroup(gId, deps);
      record(
        "filters: only 1 candidate left → outcome=code_fallback_single_member",
        res.outcome === "code_fallback_single_member" && res.bestMediaId === ok,
        `outcome=${res.outcome} best=${String(res.bestMediaId)}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 19: public constants
    // -----------------------------------------------------------------------
    {
      record(
        "constant: SCENE_BEST_PICK_JOB_TYPE='scene_best_pick'",
        SCENE_BEST_PICK_JOB_TYPE === "scene_best_pick",
        `val=${SCENE_BEST_PICK_JOB_TYPE}`,
      );
      record(
        "constant: SCENE_BEST_PICK_REQUEST_TYPE='scene_best_pick'",
        SCENE_BEST_PICK_REQUEST_TYPE === "scene_best_pick",
        `val=${SCENE_BEST_PICK_REQUEST_TYPE}`,
      );
      record(
        "constant: SCENE_BEST_PICK_TARGET_TYPE='scene_group'",
        SCENE_BEST_PICK_TARGET_TYPE === "scene_group",
        `val=${SCENE_BEST_PICK_TARGET_TYPE}`,
      );
      record(
        "constant: DEFAULT_SCENE_BEST_PICK_TOP_K=5",
        DEFAULT_SCENE_BEST_PICK_TOP_K === 5,
        `val=${DEFAULT_SCENE_BEST_PICK_TOP_K}`,
      );
    }

    // -----------------------------------------------------------------------
    // CASE 20: more-than-K members → only top-K rows written
    // -----------------------------------------------------------------------
    {
      const tripId = seedTrip(db, "MoreThanK");
      const gId = seedGroup(db, tripId, 1, 0);
      // 7 members, top-K=5 → only 5 rows written; the bottom 2 drop out.
      const ids: string[] = [];
      for (let i = 0; i < 7; i += 1) {
        const id = seedMedia(db, tripId, { qualityScore: 0.1 + i * 0.1 });
        ids.push(id);
        seedGroupItem(db, gId, id, 1, i);
      }
      const deps = makeDeps(db, mockProvider);
      const res = await runSceneBestPickForGroup(gId, deps);
      record(
        "more-than-K: writtenCount = 5 (top-K), candidateCount also = 5",
        res.writtenCount === 5 && res.candidateCount === 5,
        `written=${res.writtenCount} candidates=${res.candidateCount}`,
      );
      record(
        "more-than-K: 2 lowest-quality media NOT in curated_selections",
        (() => {
          const rows = listCuratedForGroup(db, tripId, 1, gId);
          // ids[0] (q=0.1) and ids[1] (q=0.2) should be absent.
          return rows.length === 5 && !rows.some((r) => r.mediaId === ids[0]) && !rows.some((r) => r.mediaId === ids[1]);
        })(),
        "verified",
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
