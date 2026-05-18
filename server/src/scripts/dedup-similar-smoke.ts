// Manual smoke test for DedupEngine.similar (P5.T4).
//
// Usage: npm run smoke:dedup-similar
//
// Seeds media + `perceptual_hash` strings directly (no real
// image_hash worker needed) so the algorithm under test is the
// Hamming-distance clustering + idempotency / protection rules, not
// sharp / DCT correctness (those are covered by smoke:image-hash).
//
// Each seeded `perceptual_hash` is built from a base 16-hex pHash
// padded with a fixed dHash half so the engine slice logic
// (`pHashHex(16) + dHashHex(16)`) sees a realistic 32-char string.
// `flipBits` flips a chosen set of bit positions in the pHash half
// so the test fixtures have known Hamming distances.
//
// Coverage (against the prompt list):
//   * 2 images within threshold → 1 similar group.
//   * 3 directly similar (all pairs ≤ T) → 1 group.
//   * 3 transitively similar (A~B and B~C, but A~C > T) → still 1
//     group via DSU connected component.
//   * Pair beyond threshold → no group.
//   * NULL perceptual_hash → skipped at repo level.
//   * Invalid hex (too short / wrong chars) → counted in
//     `mediaSkippedInvalid`, no crash.
//   * Soft-deleted → skipped.
//   * Video media → skipped.
//   * Cross-trip isolation: same pHash in two trips → two groups.
//   * Idempotency: second run → 0 created + cohortsSkipped surfaces
//     the prior cohort.
//   * user_confirmed similar group → preserved untouched.
//   * Existing exact group → engine never overlaps; partial overlap
//     skips whole cohort.
//   * Multiple distinct similar cohorts → multiple groups in one run.
//   * Field assertions: group_type='similar', confidence + similarity
//     scores derived from max pair distance, item reason mentions
//     "pHash hamming distance".
//   * Pure `hexHammingDistance` helper sanity (identical / single
//     bit flip / N-bit flip / non-hex / short string).

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import {
  DEFAULT_SIMILAR_HAMMING_THRESHOLD,
  DedupEngine,
  DuplicateGroupsRepository,
  HEX16_MAX_BITS,
  hexHammingDistance,
} from "../dedup/index.js";
import { createLogger } from "../logger.js";
import { MediaRepository } from "../media/index.js";
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

const D_HASH_TAIL = "0000000000000000"; // fixed dHash half, irrelevant to similar
const BASE_P = "abcdef0123456789"; // 16-hex base pHash

/**
 * Flip a list of bit positions in a 16-hex string. Bit 0 is the
 * least-significant bit of the LAST hex char (right-most), matching
 * the convention used by `parseInt(h, 16)` on each char.
 *
 * We need precise control because the engine treats two pHashes
 * with Hamming distance d as similar iff d ≤ threshold; the smoke
 * verifies threshold ± 1 boundaries.
 */
function flipPHashBits(base: string, bitsToFlip: readonly number[]): string {
  if (base.length !== 16) throw new Error(`base must be 16 hex chars, got ${base.length}`);
  const nibbles: number[] = [];
  for (let i = 0; i < 16; i += 1) nibbles.push(parseInt(base[i] as string, 16));
  for (const bit of bitsToFlip) {
    if (bit < 0 || bit >= 64) throw new Error(`bit ${bit} out of [0,64)`);
    // bit 0 → nibble 15 (last), shift 0
    // bit 4 → nibble 14, shift 0
    // bit 7 → nibble 14, shift 3
    const nibbleIdx = 15 - Math.floor(bit / 4);
    const shiftInNibble = bit % 4;
    nibbles[nibbleIdx] = (nibbles[nibbleIdx] as number) ^ (1 << shiftInNibble);
  }
  return nibbles.map((n) => n.toString(16)).join("");
}

function fullHash(pHash16: string): string {
  return pHash16 + D_HASH_TAIL;
}

function nowIso(): string {
  return new Date().toISOString();
}

function seedTrip(tripService: TripService, title: string): string {
  return tripService.createTrip({ title }).id;
}

function seedMedia(
  db: SqliteDatabase,
  args: {
    tripId: string;
    perceptualHash: string | null;
    type?: "image" | "video";
    softDeleted?: boolean;
  },
): string {
  const mediaId = randomUUID();
  const now = nowIso();
  db.prepare(
    `INSERT INTO media_items
       (id, trip_id, type, original_path, mime_type, extension, file_size,
        perceptual_hash, status, user_decision, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?,
             ?, ?, 'undecided', ?, ?, ?)`,
  ).run(
    mediaId,
    args.tripId,
    args.type ?? "image",
    `trips/${args.tripId}/originals/${mediaId}.${args.type === "video" ? "mp4" : "jpg"}`,
    args.type === "video" ? "video/mp4" : "image/jpeg",
    args.type === "video" ? "mp4" : "jpg",
    1024,
    args.perceptualHash,
    args.softDeleted === true ? "deleted" : "uploaded",
    now,
    now,
    args.softDeleted === true ? now : null,
  );
  return mediaId;
}

function listGroupsOfTypeForTrip(
  db: SqliteDatabase,
  tripId: string,
  groupType: "exact" | "similar" | "candidate",
): Record<string, unknown>[] {
  return db
    .prepare(
      `SELECT * FROM duplicate_groups
       WHERE trip_id = ? AND group_type = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(tripId, groupType) as Record<string, unknown>[];
}

function listItemsForGroup(db: SqliteDatabase, groupId: string): Record<string, unknown>[] {
  return db
    .prepare(`SELECT * FROM duplicate_group_items WHERE group_id = ? ORDER BY id ASC`)
    .all(groupId) as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // -----------------------------------------------------------------
  // PART 0: pure hamming helper sanity (no DB needed for these)
  // -----------------------------------------------------------------
  {
    record(
      "hamming: identical hashes → 0",
      hexHammingDistance(BASE_P, BASE_P, 16) === 0,
      `result=${String(hexHammingDistance(BASE_P, BASE_P, 16))}`,
    );
    const flipped1 = flipPHashBits(BASE_P, [0]);
    record(
      "hamming: single bit flip → 1",
      hexHammingDistance(BASE_P, flipped1, 16) === 1,
      `result=${String(hexHammingDistance(BASE_P, flipped1, 16))}`,
    );
    const flipped7 = flipPHashBits(BASE_P, [0, 5, 10, 15, 20, 25, 30]);
    record(
      "hamming: 7 distinct bit flips → 7",
      hexHammingDistance(BASE_P, flipped7, 16) === 7,
      `result=${String(hexHammingDistance(BASE_P, flipped7, 16))}`,
    );
    record(
      "hamming: non-hex string → null",
      hexHammingDistance("zzzzzzzzzzzzzzzz", BASE_P, 16) === null,
      `result=${String(hexHammingDistance("zzzzzzzzzzzzzzzz", BASE_P, 16))}`,
    );
    record(
      "hamming: shorter than hexLen → null",
      hexHammingDistance("deadbeef", BASE_P, 16) === null,
      `result=${String(hexHammingDistance("deadbeef", BASE_P, 16))}`,
    );
    record("HEX16_MAX_BITS exposed as 64", HEX16_MAX_BITS === 64, `value=${HEX16_MAX_BITS}`);
    record(
      "DEFAULT_SIMILAR_HAMMING_THRESHOLD exposed as 8",
      DEFAULT_SIMILAR_HAMMING_THRESHOLD === 8,
      `value=${DEFAULT_SIMILAR_HAMMING_THRESHOLD}`,
    );
  }

  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-dedup-similar-smoke-"));
  const dbPath = path.join(tmpRoot, "smoke.db");
  console.log(`[smoke] dbPath=${dbPath}`);

  const dbHandle = openDatabase(dbPath);
  try {
    runMigrations(dbHandle.db);

    const logger = createLogger({ nodeEnv: "test" });
    const tripService = new TripService(new TripRepository(dbHandle.db));
    const mediaRepo = new MediaRepository(dbHandle.db);
    const duplicateGroupsRepo = new DuplicateGroupsRepository(dbHandle.db);
    const engine = new DedupEngine({ mediaRepo, duplicateGroupsRepo, logger });

    const T = 8; // explicit threshold to match defaults

    // -----------------------------------------------------------------
    // CASE 1: 2 images within threshold → 1 similar group
    // -----------------------------------------------------------------
    {
      const tripId = seedTrip(tripService, "Case1");
      const m1 = seedMedia(dbHandle.db, { tripId, perceptualHash: fullHash(BASE_P) });
      // distance 5 (5 bit flips) — well within default threshold 8
      const m2 = seedMedia(dbHandle.db, {
        tripId,
        perceptualHash: fullHash(flipPHashBits(BASE_P, [0, 1, 2, 3, 4])),
      });

      const r = engine.runSimilarForTrip(tripId, { hammingThreshold: T });
      record(
        "within threshold: 1 group created, 0 skipped, 0 invalid",
        r.groupsCreated === 1 &&
          r.cohortsSkipped.length === 0 &&
          r.mediaScanned === 2 &&
          r.mediaSkippedInvalid === 0,
        JSON.stringify(r),
      );

      const groups = listGroupsOfTypeForTrip(dbHandle.db, tripId, "similar");
      record(
        "within threshold: exactly 1 'similar' group in DB",
        groups.length === 1,
        `count=${groups.length}`,
      );
      const g = groups[0];
      record(
        "within threshold: group has group_type='similar', user_confirmed=0",
        g?.group_type === "similar" && g?.user_confirmed === 0,
        JSON.stringify(g),
      );
      // distance 5 → confidence = 1 - 5/64 = 0.921875
      record(
        "within threshold: confidence + similarity_score reflect max pair distance",
        typeof g?.confidence === "number" &&
          typeof g?.similarity_score === "number" &&
          Math.abs((g.confidence as number) - (1 - 5 / 64)) < 1e-9 &&
          Math.abs((g.similarity_score as number) - (1 - 5 / 64)) < 1e-9,
        `confidence=${String(g?.confidence)} similarity_score=${String(g?.similarity_score)}`,
      );
      record(
        "within threshold: recommended_media_id stays NULL (P6 fills later)",
        g?.recommended_media_id === null,
        `recommended=${String(g?.recommended_media_id)}`,
      );
      const items = listItemsForGroup(dbHandle.db, g?.id as string);
      const memberIds = new Set(items.map((i) => i.media_id as string));
      record(
        "within threshold: 2 items covering both source media",
        items.length === 2 && memberIds.has(m1) && memberIds.has(m2),
        `members=${JSON.stringify([...memberIds])}`,
      );
      record(
        "within threshold: item reason mentions 'pHash hamming distance'",
        items.every(
          (i) => typeof i.reason === "string" && /pHash hamming distance/.test(i.reason as string),
        ),
        JSON.stringify(items.map((i) => i.reason)),
      );
    }

    // -----------------------------------------------------------------
    // CASE 2: 3 directly similar — all pairs within threshold → 1 group
    // -----------------------------------------------------------------
    {
      const tripId = seedTrip(tripService, "Case2");
      seedMedia(dbHandle.db, { tripId, perceptualHash: fullHash(BASE_P) });
      seedMedia(dbHandle.db, {
        tripId,
        perceptualHash: fullHash(flipPHashBits(BASE_P, [0, 1])),
      }); // d=2
      seedMedia(dbHandle.db, {
        tripId,
        perceptualHash: fullHash(flipPHashBits(BASE_P, [2, 3])),
      }); // d=2 to base, d=4 to second

      const r = engine.runSimilarForTrip(tripId, { hammingThreshold: T });
      record(
        "3 directly similar: 1 cohort with 3 members",
        r.candidateCohorts === 1 && r.groupsCreated === 1,
        JSON.stringify(r),
      );
      const groups = listGroupsOfTypeForTrip(dbHandle.db, tripId, "similar");
      const items = listItemsForGroup(dbHandle.db, groups[0]?.id as string);
      record("3 directly similar: 3 items written", items.length === 3, `items=${items.length}`);
    }

    // -----------------------------------------------------------------
    // CASE 3: 3 transitively similar — A~B (d=3), B~C (d=3),
    // A~C (d=10) > T. DSU still merges all into one cohort.
    // -----------------------------------------------------------------
    {
      const tripId = seedTrip(tripService, "Case3");
      const phA = BASE_P;
      const phB = flipPHashBits(BASE_P, [0, 1, 2]); // d(A,B)=3
      const phC = flipPHashBits(BASE_P, [0, 1, 2, 10, 11, 12, 13, 14, 15, 16]);
      // d(A,C)=10 > T, d(B,C)=? — B differs from base at bits 0,1,2; C differs at
      // bits 0,1,2,10,11,12,13,14,15,16. XOR of B and C is exactly bits 10..16
      // (7 bits) → d(B,C)=7 ≤ T.
      seedMedia(dbHandle.db, { tripId, perceptualHash: fullHash(phA) });
      seedMedia(dbHandle.db, { tripId, perceptualHash: fullHash(phB) });
      seedMedia(dbHandle.db, { tripId, perceptualHash: fullHash(phC) });

      // Sanity-check our distances.
      const dAB = hexHammingDistance(phA, phB, 16);
      const dBC = hexHammingDistance(phB, phC, 16);
      const dAC = hexHammingDistance(phA, phC, 16);
      record(
        "transitive setup: d(A,B)=3, d(B,C)=7, d(A,C)=10 (A~C alone > T)",
        dAB === 3 && dBC === 7 && dAC === 10,
        `dAB=${dAB} dBC=${dBC} dAC=${dAC}`,
      );

      const r = engine.runSimilarForTrip(tripId, { hammingThreshold: T });
      record(
        "transitive similar: DSU merges A,B,C into 1 cohort",
        r.candidateCohorts === 1 && r.groupsCreated === 1,
        JSON.stringify(r),
      );
      const groups = listGroupsOfTypeForTrip(dbHandle.db, tripId, "similar");
      const items = listItemsForGroup(dbHandle.db, groups[0]?.id as string);
      record(
        "transitive similar: 3 items in the one group",
        items.length === 3,
        `items=${items.length}`,
      );
      // Group-level confidence reflects worst pair (A~C, distance 10).
      record(
        "transitive similar: group confidence reflects worst pair (d=10)",
        Math.abs((groups[0]?.confidence as number) - (1 - 10 / 64)) < 1e-9,
        `confidence=${String(groups[0]?.confidence)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 4: pair beyond threshold → no group
    // -----------------------------------------------------------------
    {
      const tripId = seedTrip(tripService, "Case4");
      seedMedia(dbHandle.db, { tripId, perceptualHash: fullHash(BASE_P) });
      // distance 9 (just over T=8) → no group
      seedMedia(dbHandle.db, {
        tripId,
        perceptualHash: fullHash(flipPHashBits(BASE_P, [0, 1, 2, 3, 4, 5, 6, 7, 8])),
      });
      const r = engine.runSimilarForTrip(tripId, { hammingThreshold: T });
      record(
        "beyond threshold: 0 cohorts, 0 groups",
        r.candidateCohorts === 0 && r.groupsCreated === 0 && r.mediaScanned === 2,
        JSON.stringify(r),
      );
    }

    // -----------------------------------------------------------------
    // CASE 5: NULL perceptual_hash excluded
    // -----------------------------------------------------------------
    {
      const tripId = seedTrip(tripService, "Case5");
      seedMedia(dbHandle.db, { tripId, perceptualHash: fullHash(BASE_P) });
      seedMedia(dbHandle.db, { tripId, perceptualHash: null });
      const r = engine.runSimilarForTrip(tripId, { hammingThreshold: T });
      record(
        "NULL perceptual_hash excluded: only 1 row considered, 0 groups",
        r.mediaScanned === 1 && r.groupsCreated === 0,
        JSON.stringify(r),
      );
    }

    // -----------------------------------------------------------------
    // CASE 6: invalid hex (too-short hash) excluded with counter
    // -----------------------------------------------------------------
    {
      const tripId = seedTrip(tripService, "Case6");
      seedMedia(dbHandle.db, { tripId, perceptualHash: fullHash(BASE_P) });
      seedMedia(dbHandle.db, { tripId, perceptualHash: "tooshort" });
      const r = engine.runSimilarForTrip(tripId, { hammingThreshold: T });
      record(
        "invalid hex excluded: mediaScanned=1 + mediaSkippedInvalid=1",
        r.mediaScanned === 1 && r.mediaSkippedInvalid === 1,
        JSON.stringify(r),
      );
    }

    // -----------------------------------------------------------------
    // CASE 7: soft-deleted media excluded
    // -----------------------------------------------------------------
    {
      const tripId = seedTrip(tripService, "Case7");
      seedMedia(dbHandle.db, { tripId, perceptualHash: fullHash(BASE_P) });
      seedMedia(dbHandle.db, {
        tripId,
        perceptualHash: fullHash(BASE_P),
        softDeleted: true,
      });
      const r = engine.runSimilarForTrip(tripId, { hammingThreshold: T });
      record(
        "soft-deleted excluded: mediaScanned=1, 0 groups (singleton)",
        r.mediaScanned === 1 && r.groupsCreated === 0,
        JSON.stringify(r),
      );
    }

    // -----------------------------------------------------------------
    // CASE 8: video media excluded
    // -----------------------------------------------------------------
    {
      const tripId = seedTrip(tripService, "Case8");
      seedMedia(dbHandle.db, { tripId, perceptualHash: fullHash(BASE_P) });
      seedMedia(dbHandle.db, {
        tripId,
        perceptualHash: fullHash(BASE_P),
        type: "video",
      });
      const r = engine.runSimilarForTrip(tripId, { hammingThreshold: T });
      record(
        "video excluded: mediaScanned=1, 0 groups (singleton)",
        r.mediaScanned === 1 && r.groupsCreated === 0,
        JSON.stringify(r),
      );
    }

    // -----------------------------------------------------------------
    // CASE 9: cross-trip isolation
    // -----------------------------------------------------------------
    {
      const tripA = seedTrip(tripService, "Case9-A");
      const tripB = seedTrip(tripService, "Case9-B");
      seedMedia(dbHandle.db, { tripId: tripA, perceptualHash: fullHash(BASE_P) });
      seedMedia(dbHandle.db, {
        tripId: tripA,
        perceptualHash: fullHash(flipPHashBits(BASE_P, [0, 1])),
      });
      seedMedia(dbHandle.db, { tripId: tripB, perceptualHash: fullHash(BASE_P) });
      seedMedia(dbHandle.db, {
        tripId: tripB,
        perceptualHash: fullHash(flipPHashBits(BASE_P, [0, 1])),
      });
      const rA = engine.runSimilarForTrip(tripA, { hammingThreshold: T });
      const rB = engine.runSimilarForTrip(tripB, { hammingThreshold: T });
      record(
        "cross-trip: each trip gets its own similar group",
        rA.groupsCreated === 1 && rB.groupsCreated === 1,
        `A=${JSON.stringify(rA)} B=${JSON.stringify(rB)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 10: idempotency — re-run on identical state → 0 created
    // -----------------------------------------------------------------
    {
      const tripId = seedTrip(tripService, "Case10");
      seedMedia(dbHandle.db, { tripId, perceptualHash: fullHash(BASE_P) });
      seedMedia(dbHandle.db, {
        tripId,
        perceptualHash: fullHash(flipPHashBits(BASE_P, [0, 1, 2])),
      });
      const first = engine.runSimilarForTrip(tripId, { hammingThreshold: T });
      const second = engine.runSimilarForTrip(tripId, { hammingThreshold: T });
      record(
        "idempotency: first run creates 1, second creates 0 + cohortsSkipped[0].reason='already-grouped'",
        first.groupsCreated === 1 &&
          second.groupsCreated === 0 &&
          second.cohortsSkipped.length === 1 &&
          second.cohortsSkipped[0]?.reason === "already-grouped",
        `first=${JSON.stringify(first)} second=${JSON.stringify(second)}`,
      );
      record(
        "idempotency: still exactly 1 similar group in DB after re-run",
        listGroupsOfTypeForTrip(dbHandle.db, tripId, "similar").length === 1,
        `count=${listGroupsOfTypeForTrip(dbHandle.db, tripId, "similar").length}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 11: user_confirmed similar group is never duplicated /
    // overwritten.
    // -----------------------------------------------------------------
    {
      const tripId = seedTrip(tripService, "Case11");
      const m1 = seedMedia(dbHandle.db, { tripId, perceptualHash: fullHash(BASE_P) });
      const m2 = seedMedia(dbHandle.db, {
        tripId,
        perceptualHash: fullHash(flipPHashBits(BASE_P, [0, 1])),
      });
      // Seed an existing similar group already marked user_confirmed=1
      // directly via the repository.
      const groupId = randomUUID();
      const now = nowIso();
      duplicateGroupsRepo.createGroupWithItems(
        {
          id: groupId,
          tripId,
          groupType: "similar",
          recommendedMediaId: m1,
          confidence: 0.95,
          similarityScore: 0.95,
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
            similarityScore: 0.95,
            recommendation: "remove",
            reason: "user removed",
            userDecision: "remove",
            createdAt: now,
            updatedAt: now,
          },
        ],
      );

      const r = engine.runSimilarForTrip(tripId, { hammingThreshold: T });
      record(
        "user_confirmed: engine skips overlapping cohort",
        r.groupsCreated === 0 &&
          r.cohortsSkipped.length === 1 &&
          r.cohortsSkipped[0]?.reason === "already-grouped",
        JSON.stringify(r),
      );
      const groups = listGroupsOfTypeForTrip(dbHandle.db, tripId, "similar");
      record(
        "user_confirmed: original group still exists with user_confirmed=1",
        groups.length === 1 && groups[0]?.id === groupId && groups[0]?.user_confirmed === 1,
        JSON.stringify(groups[0]),
      );
      const items = listItemsForGroup(dbHandle.db, groupId);
      const decisions = items.map((i) => i.user_decision as string).sort();
      record(
        "user_confirmed: original user_decision values untouched (keep + remove)",
        decisions.length === 2 && decisions[0] === "keep" && decisions[1] === "remove",
        JSON.stringify(decisions),
      );
    }

    // -----------------------------------------------------------------
    // CASE 12: existing exact group protects the engine from
    // overlap. Members already in an exact group must not appear in
    // a new similar group.
    // -----------------------------------------------------------------
    {
      const tripId = seedTrip(tripService, "Case12");
      const m1 = seedMedia(dbHandle.db, { tripId, perceptualHash: fullHash(BASE_P) });
      const m2 = seedMedia(dbHandle.db, {
        tripId,
        perceptualHash: fullHash(flipPHashBits(BASE_P, [0, 1])),
      });
      // Pre-seed an exact group covering m1+m2 (e.g. they're byte-
      // identical despite the engine getting a different pHash for
      // them — contrived but valid: file_hash equality is independent
      // of perceptual_hash).
      const exactGroupId = randomUUID();
      const now = nowIso();
      duplicateGroupsRepo.createGroupWithItems(
        {
          id: exactGroupId,
          tripId,
          groupType: "exact",
          confidence: 1.0,
          similarityScore: 1.0,
          userConfirmed: false,
          createdAt: now,
          updatedAt: now,
        },
        [
          {
            id: randomUUID(),
            mediaId: m1,
            similarityScore: 1.0,
            recommendation: "undecided",
            reason: "exact byte-level match (file_hash)",
            userDecision: "undecided",
            createdAt: now,
            updatedAt: now,
          },
          {
            id: randomUUID(),
            mediaId: m2,
            similarityScore: 1.0,
            recommendation: "undecided",
            reason: "exact byte-level match (file_hash)",
            userDecision: "undecided",
            createdAt: now,
            updatedAt: now,
          },
        ],
      );

      const r = engine.runSimilarForTrip(tripId, { hammingThreshold: T });
      record(
        "exact-overlap: cohort skipped (cannot break exact)",
        r.groupsCreated === 0 && r.cohortsSkipped.length === 1,
        JSON.stringify(r),
      );
      // Exact group still intact
      record(
        "exact-overlap: exact group still present, no similar group created",
        listGroupsOfTypeForTrip(dbHandle.db, tripId, "exact").length === 1 &&
          listGroupsOfTypeForTrip(dbHandle.db, tripId, "similar").length === 0,
        `exact=${listGroupsOfTypeForTrip(dbHandle.db, tripId, "exact").length} similar=${listGroupsOfTypeForTrip(dbHandle.db, tripId, "similar").length}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 13: partial overlap — one member of a candidate cohort is
    // already in some group → whole cohort skipped.
    // -----------------------------------------------------------------
    {
      const tripId = seedTrip(tripService, "Case13");
      const m1 = seedMedia(dbHandle.db, { tripId, perceptualHash: fullHash(BASE_P) });
      const m2 = seedMedia(dbHandle.db, {
        tripId,
        perceptualHash: fullHash(flipPHashBits(BASE_P, [0, 1])),
      });
      const m3 = seedMedia(dbHandle.db, {
        tripId,
        perceptualHash: fullHash(flipPHashBits(BASE_P, [0, 1, 2])),
      });
      // Pre-seed a similar group containing only m1 + m2 (m3 not yet
      // present at the prior run's time). Now m3 joins and shares
      // pHash territory with both — DSU would unify {m1, m2, m3} but
      // m1/m2 are already grouped → skip whole cohort.
      const oldGroupId = randomUUID();
      const now = nowIso();
      duplicateGroupsRepo.createGroupWithItems(
        {
          id: oldGroupId,
          tripId,
          groupType: "similar",
          confidence: 0.95,
          similarityScore: 0.95,
          userConfirmed: false,
          createdAt: now,
          updatedAt: now,
        },
        [
          {
            id: randomUUID(),
            mediaId: m1,
            similarityScore: 1.0,
            recommendation: "undecided",
            reason: "previous run",
            userDecision: "undecided",
            createdAt: now,
            updatedAt: now,
          },
          {
            id: randomUUID(),
            mediaId: m2,
            similarityScore: 0.95,
            recommendation: "undecided",
            reason: "previous run",
            userDecision: "undecided",
            createdAt: now,
            updatedAt: now,
          },
        ],
      );

      const r = engine.runSimilarForTrip(tripId, { hammingThreshold: T });
      record(
        "partial-overlap: cohort {m1,m2,m3} skipped",
        r.candidateCohorts === 1 && r.groupsCreated === 0 && r.cohortsSkipped.length === 1,
        JSON.stringify(r),
      );
      record(
        "partial-overlap: still exactly 1 similar group (the old one)",
        listGroupsOfTypeForTrip(dbHandle.db, tripId, "similar").length === 1,
        `count=${listGroupsOfTypeForTrip(dbHandle.db, tripId, "similar").length}`,
      );
      // m3 was not silently added anywhere.
      const m3Groups = duplicateGroupsRepo.listGroupsByMediaId(m3);
      record(
        "partial-overlap: m3 is in no group (engine did not silently add it)",
        m3Groups.length === 0,
        `m3 groups=${m3Groups.length}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 14: multiple distinct similar cohorts → multiple groups
    // -----------------------------------------------------------------
    {
      const tripId = seedTrip(tripService, "Case14");
      // Cluster A: two near-base pHashes
      seedMedia(dbHandle.db, { tripId, perceptualHash: fullHash(BASE_P) });
      seedMedia(dbHandle.db, {
        tripId,
        perceptualHash: fullHash(flipPHashBits(BASE_P, [0, 1])),
      });
      // Cluster B: two near a FAR pHash so they don't merge with A.
      // Use a different base whose distance to BASE_P is large.
      const farBase = "fedcba9876543210";
      // Sanity: pick distance to ensure two clusters stay disjoint.
      // d(BASE_P, farBase) is ~32 bits (heuristic); well above T.
      seedMedia(dbHandle.db, { tripId, perceptualHash: fullHash(farBase) });
      seedMedia(dbHandle.db, {
        tripId,
        perceptualHash: fullHash(flipPHashBits(farBase, [0, 1, 2])),
      });
      const r = engine.runSimilarForTrip(tripId, { hammingThreshold: T });
      record(
        "two cohorts: 2 candidate cohorts + 2 groups created",
        r.candidateCohorts === 2 && r.groupsCreated === 2,
        JSON.stringify(r),
      );
    }

    // -----------------------------------------------------------------
    // CASE 15: empty trip → all zeroes, no throw
    // -----------------------------------------------------------------
    {
      const tripId = seedTrip(tripService, "Case15-empty");
      const r = engine.runSimilarForTrip(tripId, { hammingThreshold: T });
      record(
        "empty trip: all counters zero",
        r.mediaScanned === 0 &&
          r.mediaSkippedInvalid === 0 &&
          r.candidateCohorts === 0 &&
          r.groupsCreated === 0 &&
          r.cohortsSkipped.length === 0,
        JSON.stringify(r),
      );
    }

    // -----------------------------------------------------------------
    // CASE 16: hammingThreshold default applied when option omitted
    // -----------------------------------------------------------------
    {
      const tripId = seedTrip(tripService, "Case16-default");
      seedMedia(dbHandle.db, { tripId, perceptualHash: fullHash(BASE_P) });
      seedMedia(dbHandle.db, {
        tripId,
        perceptualHash: fullHash(flipPHashBits(BASE_P, [0, 1, 2])),
      });
      const r = engine.runSimilarForTrip(tripId);
      record(
        "default threshold: result.hammingThreshold matches DEFAULT_SIMILAR_HAMMING_THRESHOLD",
        r.hammingThreshold === DEFAULT_SIMILAR_HAMMING_THRESHOLD,
        `threshold=${r.hammingThreshold}`,
      );
      record(
        "default threshold: a within-default cohort still creates a group",
        r.groupsCreated === 1,
        JSON.stringify(r),
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
