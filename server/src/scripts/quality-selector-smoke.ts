// Manual smoke test for QualitySelectorService (P6.T5 second half).
//
// Usage: npm run smoke:quality-selector
//
// Coverage:
//   * Pure helpers:
//       - `rankMembers` orders by quality_score DESC, with null
//         sorted last; ties (within epsilon) fall through to
//         sharpness / exposure / color / resolution / file_size /
//         created_at / mediaId tie-breaks.
//       - `buildPerItemReasons` emits one `keep` for the winner and
//         `remove` for the rest with informative reason strings.
//   * `selectForGroup` end-to-end on a real DB:
//       - 3-member group: highest quality_score wins, group's
//         recommended_media_id is updated, every item's
//         recommendation + reason are written, and user_decision is
//         NOT touched.
//       - 2-member group where one has analysis and the other does
//         not: the analysed member wins.
//       - all-missing-analysis group: still picks one by tie-breakers
//         (created_at ASC), winner reason explains the fallback.
//       - 1-member group: trivial pick.
//   * `user_confirmed = 1` group: selectForGroup returns
//     `skipped-confirmed`, the group's `recommended_media_id` is left
//     untouched, items' `user_decision` AND `recommendation` are
//     untouched.
//   * Missing / empty groups → typed `skipped-empty` / `missing-group`
//     outcomes (no exception).
//   * Idempotency: re-running selectForGroup writes the same state.
//   * selectForTrip: aggregates per-group outcomes; confirmed group
//     is `skipped-confirmed`, others applied.
//   * Tie-break determinism: equal-quality_score group picks by
//     sharpness DESC; equal sharpness picks by exposure; etc.
//   * No P6.T5 first-half regression: existing per-dimension scores
//     + raw_result sub-trees survive untouched after recommendation
//     writeback.

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { DuplicateGroupsRepository } from "../dedup/index.js";
import { createLogger } from "../logger.js";
import { MediaAnalysisRepository, MediaRepository } from "../media/index.js";
import {
  QUALITY_SCORE_TIE_EPSILON,
  QualitySelectorService,
  buildPerItemReasons,
  rankMembers,
  type MemberRanking,
} from "../quality/index.js";
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

function syntheticMember(args: {
  mediaId?: string;
  qualityScore?: number | null;
  sharpness?: number | null;
  exposure?: number | null;
  color?: number | null;
  resolution?: number | null;
  fileSize?: number | null;
  createdAt?: string | null;
}): MemberRanking {
  const id = args.mediaId ?? randomUUID();
  return {
    mediaId: id,
    item: {
      id: randomUUID(),
      groupId: randomUUID(),
      mediaId: id,
      similarityScore: null,
      qualityScore: args.qualityScore ?? null,
      recommendation: "undecided",
      reason: null,
      userDecision: "undecided",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    analysis: null,
    media: null,
    qualityScore: args.qualityScore ?? null,
    sharpness: args.sharpness ?? null,
    exposure: args.exposure ?? null,
    color: args.color ?? null,
    resolution: args.resolution ?? null,
    fileSize: args.fileSize ?? null,
    createdAt: args.createdAt ?? null,
  };
}

function seedTrip(db: SqliteDatabase, tripService: TripService, title: string): string {
  return tripService.createTrip({ title }).id;
}

function seedMedia(
  db: SqliteDatabase,
  tripId: string,
  args: {
    fileSize?: number;
    width?: number | null;
    height?: number | null;
    createdAt?: string;
  } = {},
): string {
  const mediaId = randomUUID();
  const now = args.createdAt ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO media_items
       (id, trip_id, type, original_path, mime_type, extension, file_size,
        width, height,
        status, user_decision, created_at, updated_at)
     VALUES (?, ?, 'image', ?, 'image/jpeg', 'jpg', ?,
             ?, ?,
             'uploaded', 'undecided', ?, ?)`,
  ).run(
    mediaId,
    tripId,
    `trips/${tripId}/originals/${mediaId}.jpg`,
    args.fileSize ?? 1024,
    args.width ?? null,
    args.height ?? null,
    now,
    now,
  );
  return mediaId;
}

function seedAnalysis(
  db: SqliteDatabase,
  mediaId: string,
  args: {
    qualityScore?: number | null;
    sharpness?: number | null;
    exposure?: number | null;
    color?: number | null;
  },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO media_analysis (
       id, media_id,
       sharpness_score, exposure_score, color_score,
       quality_score,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    mediaId,
    args.sharpness ?? null,
    args.exposure ?? null,
    args.color ?? null,
    args.qualityScore ?? null,
    now,
    now,
  );
}

function seedGroupWithItems(
  db: SqliteDatabase,
  groupsRepo: DuplicateGroupsRepository,
  args: {
    tripId: string;
    memberIds: string[];
    recommendedMediaId?: string | null;
    userConfirmed?: boolean;
    perItemUserDecision?: Map<string, "keep" | "remove" | "undecided">;
  },
): string {
  const groupId = randomUUID();
  const now = new Date().toISOString();
  groupsRepo.createGroupWithItems(
    {
      id: groupId,
      tripId: args.tripId,
      groupType: "exact",
      recommendedMediaId: args.recommendedMediaId ?? null,
      userConfirmed: args.userConfirmed === true,
      createdAt: now,
      updatedAt: now,
    },
    args.memberIds.map((mediaId) => ({
      id: randomUUID(),
      mediaId,
      recommendation: "undecided",
      reason: null,
      userDecision: args.perItemUserDecision?.get(mediaId) ?? "undecided",
      createdAt: now,
      updatedAt: now,
    })),
  );
  return groupId;
}

function readGroup(db: SqliteDatabase, groupId: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM duplicate_groups WHERE id = ?`).get(groupId) as
    | Record<string, unknown>
    | undefined;
}

function readItems(db: SqliteDatabase, groupId: string): Record<string, unknown>[] {
  return db
    .prepare(`SELECT * FROM duplicate_group_items WHERE group_id = ? ORDER BY media_id ASC`)
    .all(groupId) as Record<string, unknown>[];
}

function readAnalysisRow(db: SqliteDatabase, mediaId: string): Record<string, unknown> | undefined {
  // Direct row read returns snake_case columns; that's what this
  // helper exposes (no need to round-trip through the camelCase
  // repository projection).
  return db.prepare(`SELECT * FROM media_analysis WHERE media_id = ?`).get(mediaId) as
    | Record<string, unknown>
    | undefined;
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-quality-selector-smoke-"));
  const dbPath = path.join(tmpRoot, "smoke.db");
  console.log(`[smoke] tmpRoot=${tmpRoot}`);

  const dbHandle = openDatabase(dbPath);
  try {
    runMigrations(dbHandle.db);

    const logger = createLogger({ nodeEnv: "test" });
    const tripService = new TripService(new TripRepository(dbHandle.db));
    const mediaRepo = new MediaRepository(dbHandle.db);
    const mediaAnalysisRepo = new MediaAnalysisRepository(dbHandle.db);
    const duplicateGroupsRepo = new DuplicateGroupsRepository(dbHandle.db);
    const service = new QualitySelectorService({
      duplicateGroupsRepo,
      mediaAnalysisRepo,
      mediaRepo,
      logger,
    });

    // -----------------------------------------------------------------
    // CASE A: rankMembers — quality_score DESC, null last
    // -----------------------------------------------------------------
    {
      const a = syntheticMember({ mediaId: "a", qualityScore: 0.3 });
      const b = syntheticMember({ mediaId: "b", qualityScore: 0.9 });
      const c = syntheticMember({ mediaId: "c", qualityScore: null });
      const d = syntheticMember({ mediaId: "d", qualityScore: 0.6 });
      const order = rankMembers([a, b, c, d]).map((m) => m.mediaId);
      record(
        "rankMembers: quality_score DESC + null last",
        JSON.stringify(order) === '["b","d","a","c"]',
        JSON.stringify(order),
      );
    }

    // -----------------------------------------------------------------
    // CASE B: tie-break by sharpness when quality is within epsilon.
    // -----------------------------------------------------------------
    {
      const a = syntheticMember({ mediaId: "a", qualityScore: 0.875, sharpness: 0.5 });
      const b = syntheticMember({ mediaId: "b", qualityScore: 0.879, sharpness: 0.9 });
      // 0.879 - 0.875 = 0.004 < 0.01 → tied on quality; b wins on sharpness.
      const order = rankMembers([a, b]).map((m) => m.mediaId);
      record(
        "rankMembers: near-tied quality → sharpness tie-break",
        JSON.stringify(order) === '["b","a"]',
        JSON.stringify(order),
      );
    }

    // -----------------------------------------------------------------
    // CASE C: tie-break by exposure, then color, then resolution.
    // -----------------------------------------------------------------
    {
      const a = syntheticMember({
        mediaId: "a",
        qualityScore: 0.7,
        sharpness: 0.5,
        exposure: 0.3,
      });
      const b = syntheticMember({
        mediaId: "b",
        qualityScore: 0.7,
        sharpness: 0.5,
        exposure: 0.9,
      });
      record(
        "rankMembers: tied quality + sharpness → exposure tie-break",
        rankMembers([a, b])[0]?.mediaId === "b",
        "",
      );

      const c = syntheticMember({
        mediaId: "c",
        qualityScore: 0.7,
        sharpness: 0.5,
        exposure: 0.5,
        color: 0.3,
      });
      const d = syntheticMember({
        mediaId: "d",
        qualityScore: 0.7,
        sharpness: 0.5,
        exposure: 0.5,
        color: 0.9,
      });
      record(
        "rankMembers: tied quality + sharp + exposure → color tie-break",
        rankMembers([c, d])[0]?.mediaId === "d",
        "",
      );

      const e = syntheticMember({
        mediaId: "e",
        qualityScore: 0.7,
        sharpness: 0.5,
        exposure: 0.5,
        color: 0.5,
        resolution: 1_000_000,
      });
      const f = syntheticMember({
        mediaId: "f",
        qualityScore: 0.7,
        sharpness: 0.5,
        exposure: 0.5,
        color: 0.5,
        resolution: 5_000_000,
      });
      record(
        "rankMembers: tied across dimension scores → resolution tie-break",
        rankMembers([e, f])[0]?.mediaId === "f",
        "",
      );
    }

    // -----------------------------------------------------------------
    // CASE D: created_at ASC + stable mediaId tie-break
    // -----------------------------------------------------------------
    {
      const a = syntheticMember({
        mediaId: "a-id",
        qualityScore: null,
        createdAt: "2026-05-19T10:00:00.000Z",
      });
      const b = syntheticMember({
        mediaId: "b-id",
        qualityScore: null,
        createdAt: "2026-05-19T08:00:00.000Z",
      });
      record(
        "rankMembers: both quality=null → earlier created_at wins",
        rankMembers([a, b])[0]?.mediaId === "b-id",
        JSON.stringify(rankMembers([a, b]).map((m) => m.mediaId)),
      );

      const c = syntheticMember({
        mediaId: "z-id",
        qualityScore: null,
        createdAt: "2026-05-19T08:00:00.000Z",
      });
      const d = syntheticMember({
        mediaId: "a-id",
        qualityScore: null,
        createdAt: "2026-05-19T08:00:00.000Z",
      });
      record(
        "rankMembers: total tie → mediaId ASC final tie-break",
        rankMembers([c, d])[0]?.mediaId === "a-id",
        "",
      );
    }

    // -----------------------------------------------------------------
    // CASE E: buildPerItemReasons output shape
    // -----------------------------------------------------------------
    {
      const winner = syntheticMember({ mediaId: "win", qualityScore: 0.9 });
      const loser = syntheticMember({ mediaId: "loser", qualityScore: 0.6 });
      const out = buildPerItemReasons([winner, loser], winner);
      record(
        "buildPerItemReasons: emits one entry per member",
        out.size === 2 &&
          out.get("win")?.recommendation === "keep" &&
          out.get("loser")?.recommendation === "remove",
        JSON.stringify({
          win: out.get("win"),
          loser: out.get("loser"),
        }),
      );
      record(
        "buildPerItemReasons: winner reason cites quality_score + member count",
        out.get("win")?.reason.startsWith("recommended — quality_score=") === true &&
          (out.get("win")?.reason.includes("best of 2 member(s)") ?? false),
        out.get("win")?.reason ?? "",
      );
      record(
        "buildPerItemReasons: loser reason cites both quality scores",
        out.get("loser")?.reason === "quality_score 0.6 < winner 0.9",
        out.get("loser")?.reason ?? "",
      );
    }

    // -----------------------------------------------------------------
    // CASE 1: selectForGroup — 3 members, all have quality_score
    // -----------------------------------------------------------------
    const tripId = seedTrip(dbHandle.db, tripService, "Case1 main");
    const winnerId = seedMedia(dbHandle.db, tripId, { fileSize: 5_000 });
    seedAnalysis(dbHandle.db, winnerId, {
      qualityScore: 0.92,
      sharpness: 1,
      exposure: 0.9,
      color: 0.8,
    });
    const midId = seedMedia(dbHandle.db, tripId, { fileSize: 4_000 });
    seedAnalysis(dbHandle.db, midId, {
      qualityScore: 0.72,
      sharpness: 0.7,
      exposure: 0.8,
      color: 0.7,
    });
    const lowId = seedMedia(dbHandle.db, tripId, { fileSize: 3_000 });
    seedAnalysis(dbHandle.db, lowId, {
      qualityScore: 0.45,
      sharpness: 0.5,
      exposure: 0.5,
      color: 0.6,
    });
    const groupId = seedGroupWithItems(dbHandle.db, duplicateGroupsRepo, {
      tripId,
      memberIds: [winnerId, midId, lowId],
    });
    const outcome1 = service.selectForGroup(groupId);
    record(
      "selectForGroup: status='applied'",
      outcome1.status === "applied",
      JSON.stringify(outcome1),
    );
    record(
      "selectForGroup: winnerMediaId is the highest-quality media",
      outcome1.status === "applied" && outcome1.winnerMediaId === winnerId,
      `winner=${outcome1.status === "applied" ? outcome1.winnerMediaId : "?"}`,
    );
    record(
      "selectForGroup: ranking sorted by quality_score DESC",
      outcome1.status === "applied" &&
        JSON.stringify(outcome1.ranking) === JSON.stringify([winnerId, midId, lowId]),
      JSON.stringify(outcome1.status === "applied" ? outcome1.ranking : []),
    );

    // Group header updated.
    const groupRow1 = readGroup(dbHandle.db, groupId);
    record(
      "selectForGroup: group.recommended_media_id = winner",
      groupRow1?.recommended_media_id === winnerId,
      `recommended=${String(groupRow1?.recommended_media_id)}`,
    );
    record(
      "selectForGroup: group.user_confirmed stays 0",
      groupRow1?.user_confirmed === 0,
      `user_confirmed=${String(groupRow1?.user_confirmed)}`,
    );

    // Per-item rows.
    const itemRows1 = readItems(dbHandle.db, groupId);
    const winnerRow1 = itemRows1.find((r) => r["media_id"] === winnerId);
    const midRow1 = itemRows1.find((r) => r["media_id"] === midId);
    const lowRow1 = itemRows1.find((r) => r["media_id"] === lowId);
    record(
      "selectForGroup: winner item recommendation='keep' + reason mentions best",
      winnerRow1?.recommendation === "keep" &&
        typeof winnerRow1?.reason === "string" &&
        (winnerRow1.reason as string).startsWith("recommended — quality_score="),
      `rec=${String(winnerRow1?.recommendation)} reason=${String(winnerRow1?.reason)}`,
    );
    record(
      "selectForGroup: loser items recommendation='remove' + reason cites quality gap",
      midRow1?.recommendation === "remove" &&
        lowRow1?.recommendation === "remove" &&
        (midRow1.reason as string).startsWith("quality_score") &&
        (lowRow1.reason as string).startsWith("quality_score"),
      JSON.stringify({ mid: midRow1?.reason, low: lowRow1?.reason }),
    );
    record(
      "selectForGroup: NO item has user_decision touched (still 'undecided')",
      winnerRow1?.user_decision === "undecided" &&
        midRow1?.user_decision === "undecided" &&
        lowRow1?.user_decision === "undecided",
      JSON.stringify({
        w: winnerRow1?.user_decision,
        m: midRow1?.user_decision,
        l: lowRow1?.user_decision,
      }),
    );

    // -----------------------------------------------------------------
    // CASE 2: idempotency — re-run selectForGroup writes the same state.
    // -----------------------------------------------------------------
    {
      const updatedBefore = groupRow1?.updated_at as string;
      const outcomeAgain = service.selectForGroup(groupId);
      record(
        "idempotent: re-run status='applied' + same winner",
        outcomeAgain.status === "applied" && outcomeAgain.winnerMediaId === winnerId,
        JSON.stringify(outcomeAgain),
      );
      const groupRow2 = readGroup(dbHandle.db, groupId);
      record(
        "idempotent: recommended_media_id unchanged",
        groupRow2?.recommended_media_id === winnerId,
        `recommended=${String(groupRow2?.recommended_media_id)}`,
      );
      record(
        "idempotent: row count for this group = 1",
        readItems(dbHandle.db, groupId).length === 3,
        `count=${readItems(dbHandle.db, groupId).length}`,
      );
      // updated_at should advance (or stay equal in same-millisecond case).
      const updatedAfter = groupRow2?.updated_at as string;
      record(
        "idempotent: updated_at monotonic",
        updatedAfter >= updatedBefore,
        `before=${updatedBefore} after=${updatedAfter}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 3: user_confirmed=1 group is SKIPPED (no overwrite).
    // -----------------------------------------------------------------
    {
      const tripId2 = seedTrip(dbHandle.db, tripService, "Case3 confirmed");
      const aId = seedMedia(dbHandle.db, tripId2);
      const bId = seedMedia(dbHandle.db, tripId2);
      seedAnalysis(dbHandle.db, aId, { qualityScore: 0.5 });
      seedAnalysis(dbHandle.db, bId, { qualityScore: 0.9 }); // would otherwise win
      // User chose aId (the lower-quality one) and confirmed it.
      const confirmedGroupId = seedGroupWithItems(dbHandle.db, duplicateGroupsRepo, {
        tripId: tripId2,
        memberIds: [aId, bId],
        recommendedMediaId: aId,
        userConfirmed: true,
        perItemUserDecision: new Map([
          [aId, "keep"],
          [bId, "remove"],
        ]),
      });
      const outcome = service.selectForGroup(confirmedGroupId);
      record(
        "user_confirmed: status='skipped-confirmed'",
        outcome.status === "skipped-confirmed",
        JSON.stringify(outcome),
      );
      const row = readGroup(dbHandle.db, confirmedGroupId);
      record(
        "user_confirmed: recommended_media_id NOT overwritten",
        row?.recommended_media_id === aId,
        `recommended=${String(row?.recommended_media_id)}`,
      );
      record(
        "user_confirmed: user_confirmed flag remains 1",
        row?.user_confirmed === 1,
        `user_confirmed=${String(row?.user_confirmed)}`,
      );
      const items = readItems(dbHandle.db, confirmedGroupId);
      const itemA = items.find((r) => r["media_id"] === aId);
      const itemB = items.find((r) => r["media_id"] === bId);
      record(
        "user_confirmed: items.user_decision preserved (a='keep', b='remove')",
        itemA?.user_decision === "keep" && itemB?.user_decision === "remove",
        JSON.stringify({ a: itemA?.user_decision, b: itemB?.user_decision }),
      );
      record(
        "user_confirmed: items.recommendation NOT touched (stays 'undecided')",
        itemA?.recommendation === "undecided" && itemB?.recommendation === "undecided",
        JSON.stringify({ a: itemA?.recommendation, b: itemB?.recommendation }),
      );
    }

    // -----------------------------------------------------------------
    // CASE 4: missing analysis on some members — analysed members
    // outrank unanalysed ones; reason mentions missing analysis.
    // -----------------------------------------------------------------
    {
      const tripId3 = seedTrip(dbHandle.db, tripService, "Case4 partial analysis");
      const analysedId = seedMedia(dbHandle.db, tripId3);
      const noAnalysisId = seedMedia(dbHandle.db, tripId3);
      seedAnalysis(dbHandle.db, analysedId, { qualityScore: 0.5 });
      // noAnalysisId intentionally without media_analysis row.
      const gId = seedGroupWithItems(dbHandle.db, duplicateGroupsRepo, {
        tripId: tripId3,
        memberIds: [noAnalysisId, analysedId],
      });
      const outcome = service.selectForGroup(gId);
      record(
        "partial-analysis: analysed media wins over no-analysis media",
        outcome.status === "applied" && outcome.winnerMediaId === analysedId,
        JSON.stringify(outcome),
      );
      const items = readItems(dbHandle.db, gId);
      const noAItem = items.find((r) => r["media_id"] === noAnalysisId);
      record(
        "partial-analysis: no-analysis loser reason cites missing quality_score",
        typeof noAItem?.reason === "string" &&
          /no quality_score yet/i.test(noAItem.reason as string),
        `reason=${String(noAItem?.reason)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 5: all members missing analysis — still applies, picks by
    // tie-breakers (created_at ASC).
    // -----------------------------------------------------------------
    {
      const tripId4 = seedTrip(dbHandle.db, tripService, "Case5 all missing");
      // Two media, distinct created_at so the tie-break is deterministic.
      const earlyId = seedMedia(dbHandle.db, tripId4, { createdAt: "2026-05-18T01:00:00.000Z" });
      const lateId = seedMedia(dbHandle.db, tripId4, { createdAt: "2026-05-18T05:00:00.000Z" });
      const gId = seedGroupWithItems(dbHandle.db, duplicateGroupsRepo, {
        tripId: tripId4,
        memberIds: [earlyId, lateId],
      });
      const outcome = service.selectForGroup(gId);
      record(
        "all-missing: status='applied' + earlier created_at wins",
        outcome.status === "applied" && outcome.winnerMediaId === earlyId,
        JSON.stringify(outcome),
      );
      const items = readItems(dbHandle.db, gId);
      const winnerItem = items.find((r) => r["media_id"] === earlyId);
      const loserItem = items.find((r) => r["media_id"] === lateId);
      record(
        "all-missing: winner reason cites no quality_score + tie-breakers",
        typeof winnerItem?.reason === "string" &&
          /no quality_score yet/i.test(winnerItem.reason as string) &&
          /tie-breakers/i.test(winnerItem.reason as string),
        `reason=${String(winnerItem?.reason)}`,
      );
      record(
        "all-missing: loser reason explains tied-missing-quality + tie-breakers",
        typeof loserItem?.reason === "string" &&
          /tied on missing quality_score/i.test(loserItem.reason as string),
        `reason=${String(loserItem?.reason)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 6: 1-member group — trivial.
    // -----------------------------------------------------------------
    {
      const tripId5 = seedTrip(dbHandle.db, tripService, "Case6 single");
      const onlyId = seedMedia(dbHandle.db, tripId5);
      seedAnalysis(dbHandle.db, onlyId, { qualityScore: 0.5 });
      const gId = seedGroupWithItems(dbHandle.db, duplicateGroupsRepo, {
        tripId: tripId5,
        memberIds: [onlyId],
      });
      const outcome = service.selectForGroup(gId);
      record(
        "single-member: status='applied' + winnerMediaId = only member",
        outcome.status === "applied" && outcome.winnerMediaId === onlyId,
        JSON.stringify(outcome),
      );
      const items = readItems(dbHandle.db, gId);
      record(
        "single-member: that item gets recommendation='keep'",
        items[0]?.recommendation === "keep" &&
          (items[0]?.reason as string).includes("best of 1 member(s)"),
        `rec=${String(items[0]?.recommendation)} reason=${String(items[0]?.reason)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 7: missing group / non-existent groupId → typed outcome.
    // -----------------------------------------------------------------
    {
      const outcome = service.selectForGroup(randomUUID());
      record(
        "missing group: status='missing-group' (no throw)",
        outcome.status === "missing-group",
        JSON.stringify(outcome),
      );
    }

    // -----------------------------------------------------------------
    // CASE 8: selectForTrip aggregates per-group outcomes.
    // -----------------------------------------------------------------
    {
      const tripId6 = seedTrip(dbHandle.db, tripService, "Case8 multiple groups");
      const a1 = seedMedia(dbHandle.db, tripId6);
      const a2 = seedMedia(dbHandle.db, tripId6);
      seedAnalysis(dbHandle.db, a1, { qualityScore: 0.6 });
      seedAnalysis(dbHandle.db, a2, { qualityScore: 0.9 });
      const groupA = seedGroupWithItems(dbHandle.db, duplicateGroupsRepo, {
        tripId: tripId6,
        memberIds: [a1, a2],
      });
      const b1 = seedMedia(dbHandle.db, tripId6);
      const b2 = seedMedia(dbHandle.db, tripId6);
      seedAnalysis(dbHandle.db, b1, { qualityScore: 0.4 });
      seedAnalysis(dbHandle.db, b2, { qualityScore: 0.8 });
      const groupB = seedGroupWithItems(dbHandle.db, duplicateGroupsRepo, {
        tripId: tripId6,
        memberIds: [b1, b2],
        recommendedMediaId: b1,
        userConfirmed: true,
      });
      const outcomes = service.selectForTrip(tripId6);
      const byId = new Map(outcomes.map((o) => [o.groupId, o]));
      const oa = byId.get(groupA);
      const ob = byId.get(groupB);
      record(
        "selectForTrip: returns one outcome per group",
        outcomes.length === 2,
        `count=${outcomes.length}`,
      );
      record(
        "selectForTrip: applied for the non-confirmed group; winner = highest quality",
        oa?.status === "applied" && (oa.status === "applied" ? oa.winnerMediaId === a2 : false),
        JSON.stringify(oa),
      );
      record(
        "selectForTrip: confirmed group is 'skipped-confirmed' and untouched",
        ob?.status === "skipped-confirmed",
        JSON.stringify(ob),
      );
      const rowB = readGroup(dbHandle.db, groupB);
      record(
        "selectForTrip: confirmed group's recommended_media_id stayed b1",
        rowB?.recommended_media_id === b1,
        `recommended=${String(rowB?.recommended_media_id)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 9: P6.T5 first-half regression — media_analysis scores
    // survive the recommendation writeback.
    // -----------------------------------------------------------------
    {
      const a = readAnalysisRow(dbHandle.db, winnerId);
      record(
        "first-half intact: winner's quality_score / sharpness untouched by selector",
        a?.quality_score === 0.92 && a?.sharpness_score === 1,
        JSON.stringify({ q: a?.quality_score, s: a?.sharpness_score }),
      );
    }

    // -----------------------------------------------------------------
    // CASE 10: epsilon constant is sane (smoke-level sanity).
    // -----------------------------------------------------------------
    {
      record(
        "QUALITY_SCORE_TIE_EPSILON in (0, 0.1] reasonable band",
        QUALITY_SCORE_TIE_EPSILON > 0 && QUALITY_SCORE_TIE_EPSILON <= 0.1,
        `value=${QUALITY_SCORE_TIE_EPSILON}`,
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
