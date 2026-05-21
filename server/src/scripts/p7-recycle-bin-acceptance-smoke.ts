// P7.T5 acceptance smoke — soft-delete + restore + recycle-bin cross-cut.
//
// Usage: npm run smoke:p7-recycle-bin-acceptance
//
// This script is the P7 stage-acceptance artifact. It consolidates the
// four cross-table FK paths called out by `docs/tasks.md` (P7.T5):
//
//   1. 删除推荐图后该重复组 `recommended_media_id` 被正确重置
//   2. 删除一张组内图片不会触发 `FOREIGN KEY constraint failed`
//   3. 删除后再恢复，状态字段、关联记录、`duplicate_groups` 评估都正确恢复
//   4. 跨表外键路径遍历检查
//        (media_analysis / duplicate_group_items / media_versions /
//         processing_jobs / trips.cover_media_id /
//         duplicate_groups.recommended_media_id)
//
// And the four user-facing recycle-bin paths:
//
//   A. Default gallery / `listMediaForTrip` does NOT return deleted media.
//   B. Recycle-bin (`?onlyDeleted=true`) returns ONLY deleted media.
//   C. Restore clears `deleted_at`, flips `status`, removes from
//      recycle-bin, re-adds to gallery.
//   D. Restore does NOT delete originals, does NOT trigger permanent
//      delete, does NOT mutate processing / recommendation /
//      auto-cover / video flows.
//
// Why a separate smoke when P7.T1 / T2 / T3 / T4 already have their
// own? Each of those smokes verifies a single axis. P7.T5's job is
// to assert the COMBINED invariant across ALL referencing tables in
// one place — soft-delete is "marker only", restore is the inverse,
// and neither path should propagate destructive side effects to any
// cross-table row. Bundling the assertions here makes the contract
// easy to re-verify when a future migration adds a new referencing
// table.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
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
  type MediaSoftDeleteDeps,
} from "../media/index.js";
import { LocalStorageProvider, type StorageProvider } from "../storage/index.js";
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
//
// `seedFullyAttachedMedia` writes a media_items row PLUS one row in
// every table that references media_items(id), so we can prove every
// FK path stays intact across delete + restore in a single test case:
//
//   * media_versions             (ON DELETE CASCADE — survives soft delete)
//   * media_analysis             (ON DELETE CASCADE — survives soft delete)
//   * processing_jobs            (ON DELETE CASCADE — survives soft delete)
//   * duplicate_group_items      (ON DELETE CASCADE — survives soft delete)
//   * video_segments             (ON DELETE CASCADE — survives soft delete)
//                                 added by P9.T1 (migration 011); closes R-78
//
// Plus optionally a `duplicate_groups.recommended_media_id` pointing
// at the seeded media so we can verify it gets reset on soft-delete
// (and stays NULL after restore — recompute lives on the selector
// chain, not on the restore primitive itself).
// ---------------------------------------------------------------------------

interface SeededAttachments {
  readonly mediaId: string;
  readonly originalPath: string;
  readonly groupId: string;
  readonly itemId: string;
  readonly analysisId: string;
  readonly versionId: string;
  readonly jobId: string;
  /**
   * P9.T1 (migration 011). One row in `video_segments` so the
   * cross-table FK walk also asserts soft-delete + restore preserves
   * video child rows. Always seeded — the table doesn't care about
   * `media.type`, and the CHECK constraints only require positive
   * timing values, which the seed provides.
   */
  readonly segmentId: string;
}

async function seedFullyAttachedMedia(args: {
  readonly db: SqliteDatabase;
  readonly storage: StorageProvider;
  readonly tripId: string;
  readonly isRecommendedForGroup: boolean;
  readonly userDecision?: "keep" | "remove" | "undecided";
  readonly type?: "image" | "video";
}): Promise<SeededAttachments> {
  const { db, storage, tripId, isRecommendedForGroup } = args;
  const userDecision = args.userDecision ?? "keep";
  const type = args.type ?? "image";
  const now = new Date().toISOString();

  // 1) media_items row, with the original bytes actually written to
  //    disk via the storage provider so the file-presence assertion
  //    below is real-disk (not a path-only smoke).
  const mediaId = randomUUID();
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
  const stored = await storage.putOriginal({
    tripId,
    mediaId,
    extension: type === "image" ? "jpg" : "mp4",
    data: bytes,
  });
  db.prepare(
    `INSERT INTO media_items
       (id, trip_id, type, original_path, thumbnail_path,
        mime_type, extension, file_size,
        status, user_decision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?,
             ?, ?, ?,
             'processed', 'undecided', ?, ?)`,
  ).run(
    mediaId,
    tripId,
    type,
    stored.logicalPath,
    `trips/${tripId}/derived/${mediaId}/thumb.webp`,
    type === "image" ? "image/jpeg" : "video/mp4",
    type === "image" ? "jpg" : "mp4",
    bytes.length,
    now,
    now,
  );

  // 2) media_versions row — FK ON DELETE CASCADE. We use a unique
  //    version_type so we can lookup precisely after the operation.
  const versionId = randomUUID();
  db.prepare(
    `INSERT INTO media_versions
       (id, media_id, version_type, file_path, mime_type,
        width, height, file_size, model_name, params, status,
        created_at, updated_at)
     VALUES (?, ?, 'metadata', ?, 'application/json',
             NULL, NULL, NULL, NULL, '{"exif":"stub"}', 'ready',
             ?, ?)`,
  ).run(versionId, mediaId, `trips/${tripId}/derived/${mediaId}/metadata.json`, now, now);

  // 3) media_analysis row — FK ON DELETE CASCADE.
  const analysisId = randomUUID();
  db.prepare(
    `INSERT INTO media_analysis
       (id, media_id, quality_score, sharpness_score, exposure_score,
        color_score, is_blurry, reason, created_at, updated_at)
     VALUES (?, ?, 0.82, 0.9, 0.7, 0.6, 0, 'seeded for P7.T5', ?, ?)`,
  ).run(analysisId, mediaId, now, now);

  // 4) processing_jobs row — FK ON DELETE CASCADE. Status='success'
  //    keeps the worker queue idle (we want to assert the row's
  //    presence, not exercise the executor).
  const jobId = randomUUID();
  db.prepare(
    `INSERT INTO processing_jobs
       (id, media_id, job_type, status, payload, created_at, updated_at)
     VALUES (?, ?, 'image_metadata', 'success', NULL, ?, ?)`,
  ).run(jobId, mediaId, now, now);

  // 5) duplicate_groups + duplicate_group_items. The group's
  //    `recommended_media_id` points at this media iff caller asked
  //    for it (so we can isolate "delete recommended → recommended
  //    cleared" vs. "delete non-recommended member → recommended
  //    untouched").
  const groupId = randomUUID();
  db.prepare(
    `INSERT INTO duplicate_groups
       (id, trip_id, group_type, recommended_media_id,
        confidence, similarity_score, user_confirmed,
        created_at, updated_at)
     VALUES (?, ?, 'exact', ?,
             1.0, 1.0, 0,
             ?, ?)`,
  ).run(groupId, tripId, isRecommendedForGroup ? mediaId : null, now, now);

  const itemId = randomUUID();
  db.prepare(
    `INSERT INTO duplicate_group_items
       (id, group_id, media_id, similarity_score, quality_score,
        recommendation, reason, user_decision, created_at, updated_at)
     VALUES (?, ?, ?, 1.0, 0.82,
             ?, 'seeded for P7.T5', ?, ?, ?)`,
  ).run(
    itemId,
    groupId,
    mediaId,
    isRecommendedForGroup ? "keep" : "remove",
    userDecision,
    now,
    now,
  );

  // 6) video_segments row — FK ON DELETE CASCADE (migration 011,
  //    P9.T1). The table is independent of media.type at the schema
  //    level (FK only requires media_items(id) to exist), so we
  //    seed regardless. We carry deterministic fixture values for
  //    every column the smoke later inspects: a 10-second slice
  //    starting at t=0, neutral waste_type, user_decision='keep'.
  //    These values are part of the soft-delete preservation
  //    contract: restore must NOT clobber them (CLAUDE.md §3.9 user-
  //    decision precedence applies to video segments too).
  const segmentId = randomUUID();
  db.prepare(
    `INSERT INTO video_segments
       (id, media_id, start_time, end_time, duration,
        thumbnail_path, preview_path,
        blur_score, stability_score, quality_score,
        waste_type, is_recommended, user_decision, reason,
        created_at, updated_at)
     VALUES (?, ?, 0, 10, 10,
             ?, ?,
             0.85, 0.7, 0.78,
             'none', 1, 'keep', 'seeded for P9.T1 FK walk',
             ?, ?)`,
  ).run(
    segmentId,
    mediaId,
    `trips/${tripId}/derived/${mediaId}/segments/seg-0/thumb.webp`,
    `trips/${tripId}/derived/${mediaId}/segments/seg-0/preview.mp4`,
    now,
    now,
  );

  return {
    mediaId,
    originalPath: stored.logicalPath,
    groupId,
    itemId,
    analysisId,
    versionId,
    jobId,
    segmentId,
  };
}

// Helpers for the cross-table preservation assertions.

function rowExists(db: SqliteDatabase, table: string, id: string): boolean {
  const row = db.prepare(`SELECT 1 AS one FROM ${table} WHERE id = ?`).get(id) as
    | { one: number }
    | undefined;
  return row !== undefined && row.one === 1;
}

function readMediaAnalysis(
  db: SqliteDatabase,
  mediaId: string,
): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM media_analysis WHERE media_id = ?`).get(mediaId) as
    | Record<string, unknown>
    | undefined;
}

function readMediaVersion(
  db: SqliteDatabase,
  mediaId: string,
  versionType: string,
): Record<string, unknown> | undefined {
  return db
    .prepare(`SELECT * FROM media_versions WHERE media_id = ? AND version_type = ?`)
    .get(mediaId, versionType) as Record<string, unknown> | undefined;
}

function readJob(db: SqliteDatabase, id: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM processing_jobs WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
}

function readItem(db: SqliteDatabase, id: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM duplicate_group_items WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
}

function readGroup(db: SqliteDatabase, id: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM duplicate_groups WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
}

function readMediaRaw(db: SqliteDatabase, id: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM media_items WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-p7-acceptance-smoke-"));
  const dbPath = path.join(tmpRoot, "smoke.db");
  const storageRoot = path.join(tmpRoot, "storage");
  console.log(`[smoke] tmpRoot=${tmpRoot}`);

  const dbHandle = openDatabase(dbPath);
  try {
    runMigrations(dbHandle.db);

    const logger = createLogger({ nodeEnv: "test" });
    const storage = LocalStorageProvider.create(storageRoot);
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
    // PATH A (default gallery hides deleted) — sanity guard so a
    // regression in `listByTripActiveStmt` would fail this smoke even
    // without exercising recycle-bin paths.
    // -----------------------------------------------------------------
    const tripA = tripService.createTrip({ title: "PathA gallery hides deleted" });
    const aSeed = await seedFullyAttachedMedia({
      db: dbHandle.db,
      storage,
      tripId: tripA.id,
      isRecommendedForGroup: false,
    });
    mediaService.softDeleteMedia(aSeed.mediaId);
    {
      const list = mediaService.listMediaForTrip(tripA.id);
      record(
        "PathA: default listMediaForTrip excludes soft-deleted media",
        list.every((m) => m.id !== aSeed.mediaId),
        `count=${list.length} excluded=${list.every((m) => m.id !== aSeed.mediaId)}`,
      );
      let threw: unknown;
      try {
        mediaService.getMediaById(aSeed.mediaId);
      } catch (err) {
        threw = err;
      }
      record(
        "PathA: getMediaById on soft-deleted → 404 NotFoundError",
        threw !== undefined && /Media not found/.test(describeError(threw)),
        describeError(threw),
      );
    }

    // -----------------------------------------------------------------
    // PATH B (recycle bin returns only deleted) — exercise the
    // onlyDeleted query route used by `TripRecycleBinPage`.
    // -----------------------------------------------------------------
    {
      const bin = mediaService.listMediaForTrip(tripA.id, { onlyDeleted: true });
      record(
        "PathB: onlyDeleted list contains exactly the soft-deleted media",
        bin.length === 1 && bin[0]?.id === aSeed.mediaId,
        `count=${bin.length} ids=${bin.map((m) => m.id).join(",")}`,
      );
      record(
        "PathB: onlyDeleted row carries non-null deletedAt + status='deleted'",
        bin[0]?.deletedAt !== null && bin[0]?.status === "deleted",
        `deletedAt=${String(bin[0]?.deletedAt)} status=${String(bin[0]?.status)}`,
      );
    }

    // -----------------------------------------------------------------
    // PATH C (restore state transition + view migration) — restore
    // should clear `deleted_at`, flip `status`, drop from recycle bin,
    // re-include in gallery.
    // -----------------------------------------------------------------
    {
      const outcome = mediaService.restoreMedia(aSeed.mediaId);
      record(
        "PathC: restoreMedia returns restored=true + alreadyRestored=false",
        outcome.restored === true && outcome.alreadyRestored === false,
        JSON.stringify(outcome),
      );
      const row = readMediaRaw(dbHandle.db, aSeed.mediaId);
      record(
        "PathC: deleted_at cleared + status reset to 'processed'",
        row?.deleted_at === null && row?.status === "processed",
        `deleted_at=${String(row?.deleted_at)} status=${String(row?.status)}`,
      );
      const bin = mediaService.listMediaForTrip(tripA.id, { onlyDeleted: true });
      record(
        "PathC: recycle bin no longer lists the restored media",
        !bin.some((m) => m.id === aSeed.mediaId),
        `count=${bin.length}`,
      );
      const gallery = mediaService.listMediaForTrip(tripA.id);
      record(
        "PathC: default gallery re-includes the restored media",
        gallery.some((m) => m.id === aSeed.mediaId),
        `count=${gallery.length}`,
      );
    }

    // -----------------------------------------------------------------
    // PATH D + tasks.md path 1: deleting the recommended media of a
    // group clears `duplicate_groups.recommended_media_id` — without
    // a FOREIGN KEY error.
    // -----------------------------------------------------------------
    const tripB = tripService.createTrip({ title: "PathD recommend cleanup" });
    const bSeed = await seedFullyAttachedMedia({
      db: dbHandle.db,
      storage,
      tripId: tripB.id,
      isRecommendedForGroup: true,
      userDecision: "keep",
    });
    {
      const groupBefore = readGroup(dbHandle.db, bSeed.groupId);
      record(
        "tasks.md path 1 (pre): group.recommended_media_id points at the media",
        groupBefore?.recommended_media_id === bSeed.mediaId,
        `recommended=${String(groupBefore?.recommended_media_id)}`,
      );
      let threw: unknown;
      let outcomeOk = false;
      try {
        const o = mediaService.softDeleteMedia(bSeed.mediaId);
        outcomeOk = o.deleted === true;
      } catch (err) {
        threw = err;
      }
      record(
        "tasks.md path 2 (FK): softDeleteMedia on a media that's the recommendation of a group does NOT throw FOREIGN KEY",
        threw === undefined && outcomeOk,
        threw === undefined ? "no error" : describeError(threw),
      );
      const groupAfter = readGroup(dbHandle.db, bSeed.groupId);
      record(
        "tasks.md path 1 (post): group.recommended_media_id reset to NULL",
        groupAfter?.recommended_media_id === null,
        `recommended=${String(groupAfter?.recommended_media_id)}`,
      );
    }

    // -----------------------------------------------------------------
    // PATH D + tasks.md path 4: cross-table FK walk — every
    // attachment row STILL EXISTS after soft-delete (the CASCADE on
    // FK does NOT fire because soft-delete is "set deleted_at" not
    // a real DELETE).
    // -----------------------------------------------------------------
    {
      record(
        "FK walk (soft-delete): media_analysis row preserved",
        rowExists(dbHandle.db, "media_analysis", bSeed.analysisId),
        `analysisId=${bSeed.analysisId}`,
      );
      record(
        "FK walk (soft-delete): media_versions row preserved",
        rowExists(dbHandle.db, "media_versions", bSeed.versionId),
        `versionId=${bSeed.versionId}`,
      );
      record(
        "FK walk (soft-delete): processing_jobs row preserved",
        rowExists(dbHandle.db, "processing_jobs", bSeed.jobId),
        `jobId=${bSeed.jobId}`,
      );
      record(
        "FK walk (soft-delete): duplicate_group_items row preserved",
        rowExists(dbHandle.db, "duplicate_group_items", bSeed.itemId),
        `itemId=${bSeed.itemId}`,
      );
      // user_decision must NOT be overwritten by soft-delete — the row
      // stays exactly as the user left it so P7.T2 restore is lossless.
      const item = readItem(dbHandle.db, bSeed.itemId);
      record(
        "FK walk (soft-delete): duplicate_group_items.user_decision preserved verbatim ('keep')",
        item?.user_decision === "keep",
        `user_decision=${String(item?.user_decision)}`,
      );
      // P9.T1: video_segments row survives soft-delete (CASCADE
      // does not fire because soft-delete is marker-only). Closes
      // R-78.
      record(
        "FK walk (soft-delete): video_segments row preserved (P9.T1, closes R-78)",
        rowExists(dbHandle.db, "video_segments", bSeed.segmentId),
        `segmentId=${bSeed.segmentId}`,
      );
    }

    // -----------------------------------------------------------------
    // PATH D + tasks.md path 3 + tasks.md path 4: restore the media,
    // then walk the SAME cross-table rows — every attachment row is
    // still there with the original content. `media_items.deleted_at`
    // is cleared.
    // -----------------------------------------------------------------
    {
      const restored = mediaService.restoreMedia(bSeed.mediaId);
      record(
        "tasks.md path 3: restoreMedia returns restored=true (no error mid-cycle)",
        restored.restored === true,
        JSON.stringify(restored),
      );
      const row = readMediaRaw(dbHandle.db, bSeed.mediaId);
      record(
        "tasks.md path 3: media row deleted_at cleared after restore",
        row?.deleted_at === null && row?.status === "processed",
        `deleted_at=${String(row?.deleted_at)} status=${String(row?.status)}`,
      );
      record(
        "FK walk (restore): media_analysis row STILL preserved (round-trip)",
        rowExists(dbHandle.db, "media_analysis", bSeed.analysisId),
        `analysisId=${bSeed.analysisId}`,
      );
      record(
        "FK walk (restore): media_versions row STILL preserved (round-trip)",
        rowExists(dbHandle.db, "media_versions", bSeed.versionId),
        `versionId=${bSeed.versionId}`,
      );
      record(
        "FK walk (restore): processing_jobs row STILL preserved (round-trip)",
        rowExists(dbHandle.db, "processing_jobs", bSeed.jobId),
        `jobId=${bSeed.jobId}`,
      );
      record(
        "FK walk (restore): duplicate_group_items row STILL preserved (round-trip)",
        rowExists(dbHandle.db, "duplicate_group_items", bSeed.itemId),
        `itemId=${bSeed.itemId}`,
      );
      const item = readItem(dbHandle.db, bSeed.itemId);
      record(
        "FK walk (restore): user_decision still 'keep' (CLAUDE.md §3.9 user-decision precedence)",
        item?.user_decision === "keep",
        `user_decision=${String(item?.user_decision)}`,
      );
      // P9.T1: video_segments row STILL preserved through the round
      // trip + content (user_decision, waste_type, scores) intact.
      // Closes R-78 — soft-delete + restore is FK-safe + content-safe
      // for video child rows just as for image child rows.
      record(
        "FK walk (restore): video_segments row STILL preserved (P9.T1, closes R-78)",
        rowExists(dbHandle.db, "video_segments", bSeed.segmentId),
        `segmentId=${bSeed.segmentId}`,
      );
      const segmentRow = dbHandle.db
        .prepare(
          `SELECT user_decision, waste_type, blur_score, stability_score, quality_score
             FROM video_segments WHERE id = ?`,
        )
        .get(bSeed.segmentId) as
        | {
            user_decision: string;
            waste_type: string;
            blur_score: number;
            stability_score: number;
            quality_score: number;
          }
        | undefined;
      record(
        "FK walk (restore): video_segments fixture content preserved (user_decision='keep', waste_type='none', scores intact)",
        segmentRow?.user_decision === "keep" &&
          segmentRow?.waste_type === "none" &&
          segmentRow?.blur_score === 0.85 &&
          segmentRow?.stability_score === 0.7 &&
          segmentRow?.quality_score === 0.78,
        `row=${JSON.stringify(segmentRow)}`,
      );
      // group.recommended_media_id stays NULL after restore — restore
      // is intentionally NOT idempotent w.r.t. the prior selection;
      // recompute lives on the enqueued quality_selector_run, not
      // here. That keeps the primitive simple and surfaces the gap
      // through `qualitySelectorEnqueued` instead.
      const groupAfter = readGroup(dbHandle.db, bSeed.groupId);
      record(
        "tasks.md path 3: group.recommended_media_id stays NULL until selector job runs (not auto-restored)",
        groupAfter?.recommended_media_id === null,
        `recommended=${String(groupAfter?.recommended_media_id)} (selector enqueued: ${restored.qualitySelectorEnqueued})`,
      );
    }

    // -----------------------------------------------------------------
    // PATH D — originals on disk are NEVER removed (delete and
    // restore are both "marker" operations; the only writer that
    // touches disk in V1 is the upload pipeline).
    // -----------------------------------------------------------------
    {
      const tripC = tripService.createTrip({ title: "PathD disk preservation" });
      const cSeed = await seedFullyAttachedMedia({
        db: dbHandle.db,
        storage,
        tripId: tripC.id,
        isRecommendedForGroup: false,
      });
      const fullPath = path.join(storageRoot, cSeed.originalPath);
      record(
        "disk: original file exists pre-delete",
        existsSync(fullPath),
        `path=${cSeed.originalPath}`,
      );
      mediaService.softDeleteMedia(cSeed.mediaId);
      record(
        "disk: original file still exists post-soft-delete (no hard delete)",
        existsSync(fullPath),
        `path=${cSeed.originalPath}`,
      );
      mediaService.restoreMedia(cSeed.mediaId);
      record(
        "disk: original file still exists post-restore (restore is marker-only)",
        existsSync(fullPath),
        `path=${cSeed.originalPath}`,
      );
      // The DB row also still exists — soft delete never removed it.
      const row = readMediaRaw(dbHandle.db, cSeed.mediaId);
      record(
        "disk: media_items row never hard-deleted across cycle",
        row !== undefined && row.id === cSeed.mediaId,
        `present=${row !== undefined}`,
      );
    }

    // -----------------------------------------------------------------
    // PATH D — video flow is NOT touched. We seed a `type='video'`
    // media row + companion rows, then delete + restore. Every
    // assertion below works the same way as for images: the soft-
    // delete primitive is type-agnostic, so adding video workers in
    // P9 will not change the recycle-bin contract.
    // -----------------------------------------------------------------
    {
      const tripD = tripService.createTrip({ title: "PathD video media" });
      const dSeed = await seedFullyAttachedMedia({
        db: dbHandle.db,
        storage,
        tripId: tripD.id,
        isRecommendedForGroup: false,
        type: "video",
      });
      mediaService.softDeleteMedia(dSeed.mediaId);
      const rowAfterDelete = readMediaRaw(dbHandle.db, dSeed.mediaId);
      record(
        "video: soft-delete of type='video' row sets deleted_at (no FK throw)",
        typeof rowAfterDelete?.deleted_at === "string" && rowAfterDelete.type === "video",
        `deleted_at=${String(rowAfterDelete?.deleted_at)} type=${String(rowAfterDelete?.type)}`,
      );
      record(
        "video: companion media_versions row preserved through soft-delete",
        rowExists(dbHandle.db, "media_versions", dSeed.versionId),
        `versionId=${dSeed.versionId}`,
      );
      mediaService.restoreMedia(dSeed.mediaId);
      const rowAfterRestore = readMediaRaw(dbHandle.db, dSeed.mediaId);
      record(
        "video: restore re-activates type='video' row identically to image",
        rowAfterRestore?.deleted_at === null && rowAfterRestore?.type === "video",
        `deleted_at=${String(rowAfterRestore?.deleted_at)} type=${String(rowAfterRestore?.type)}`,
      );
    }

    // -----------------------------------------------------------------
    // PATH D — auto-cover field semantics. When a media is the
    // user-pinned cover of a trip, soft-delete must release the pin
    // (`cover_set_by_user = 0`) AND clear `cover_media_id`. Restore
    // does NOT auto-restore the pin — instead it enqueues a
    // selector job; the cover will be repicked by the auto handler.
    // We only assert the primitive's contract here; the chain is
    // covered by smoke:media-restore CASE 9.
    // -----------------------------------------------------------------
    {
      const tripE = tripService.createTrip({ title: "PathD cover semantics" });
      const eSeed = await seedFullyAttachedMedia({
        db: dbHandle.db,
        storage,
        tripId: tripE.id,
        isRecommendedForGroup: false,
      });
      // Pin the cover (user-set), simulating the "manual cover" flow.
      tripRepo.markCoverSetByUser(tripE.id, eSeed.mediaId, new Date().toISOString());
      const before = dbHandle.db
        .prepare(`SELECT cover_media_id, cover_set_by_user FROM trips WHERE id = ?`)
        .get(tripE.id) as { cover_media_id: string | null; cover_set_by_user: number };
      record(
        "cover (pre): pin established (cover_set_by_user=1)",
        before.cover_media_id === eSeed.mediaId && before.cover_set_by_user === 1,
        JSON.stringify(before),
      );
      mediaService.softDeleteMedia(eSeed.mediaId);
      const afterDelete = dbHandle.db
        .prepare(`SELECT cover_media_id, cover_set_by_user FROM trips WHERE id = ?`)
        .get(tripE.id) as { cover_media_id: string | null; cover_set_by_user: number };
      record(
        "cover (post-delete): cover_media_id cleared + pin released (=0)",
        afterDelete.cover_media_id === null && afterDelete.cover_set_by_user === 0,
        JSON.stringify(afterDelete),
      );
      const restored = mediaService.restoreMedia(eSeed.mediaId);
      const afterRestore = dbHandle.db
        .prepare(`SELECT cover_media_id, cover_set_by_user FROM trips WHERE id = ?`)
        .get(tripE.id) as { cover_media_id: string | null; cover_set_by_user: number };
      record(
        "cover (post-restore): restore primitive does NOT auto-restore the pin (chain runs via selector handler, not here)",
        afterRestore.cover_set_by_user === 0,
        `${JSON.stringify(afterRestore)} selector=${restored.qualitySelectorEnqueued}`,
      );
      // The auto-pick will replace this later when the queue is
      // drained; the smoke:media-restore CASE 9 verifies that chain.
    }

    // -----------------------------------------------------------------
    // PATH D — recommendation field semantics. Restore must NOT
    // overwrite an existing user-confirmed group: a group with
    // `user_confirmed = 1` and explicit `user_decision` per item
    // stays as the user left it; the enqueued selector skips it
    // (CLAUDE.md §3.9). Here we only assert the restore primitive
    // doesn't touch `user_confirmed` or `user_decision`.
    // -----------------------------------------------------------------
    {
      const tripF = tripService.createTrip({ title: "PathD confirm preservation" });
      const fSeed = await seedFullyAttachedMedia({
        db: dbHandle.db,
        storage,
        tripId: tripF.id,
        isRecommendedForGroup: true,
        userDecision: "keep",
      });
      // Mark the group user_confirmed before any delete/restore.
      dbHandle.db
        .prepare(`UPDATE duplicate_groups SET user_confirmed = 1 WHERE id = ?`)
        .run(fSeed.groupId);
      mediaService.softDeleteMedia(fSeed.mediaId);
      mediaService.restoreMedia(fSeed.mediaId);
      const group = readGroup(dbHandle.db, fSeed.groupId);
      const item = readItem(dbHandle.db, fSeed.itemId);
      record(
        "recommend: user_confirmed=1 NOT cleared by delete+restore cycle",
        group?.user_confirmed === 1,
        `user_confirmed=${String(group?.user_confirmed)}`,
      );
      record(
        "recommend: item.user_decision NOT overwritten by restore (still 'keep')",
        item?.user_decision === "keep",
        `user_decision=${String(item?.user_decision)}`,
      );
    }

    // -----------------------------------------------------------------
    // PATH D — processing pipeline preservation. The processing_jobs
    // row's `status` is not touched by delete/restore (V1: no auto-
    // cancellation; the worker is expected to handle deleted media
    // gracefully when picking up a job, but the row stays put).
    // -----------------------------------------------------------------
    {
      const tripG = tripService.createTrip({ title: "PathD jobs preservation" });
      const gSeed = await seedFullyAttachedMedia({
        db: dbHandle.db,
        storage,
        tripId: tripG.id,
        isRecommendedForGroup: false,
      });
      const jobBefore = readJob(dbHandle.db, gSeed.jobId);
      mediaService.softDeleteMedia(gSeed.mediaId);
      const jobAfterDelete = readJob(dbHandle.db, gSeed.jobId);
      record(
        "jobs: processing_jobs.status not mutated by soft-delete",
        jobBefore?.status === jobAfterDelete?.status,
        `before=${String(jobBefore?.status)} after=${String(jobAfterDelete?.status)}`,
      );
      mediaService.restoreMedia(gSeed.mediaId);
      const jobAfterRestore = readJob(dbHandle.db, gSeed.jobId);
      record(
        "jobs: processing_jobs.status not mutated by restore either",
        jobBefore?.status === jobAfterRestore?.status,
        `before=${String(jobBefore?.status)} after=${String(jobAfterRestore?.status)}`,
      );
    }

    // -----------------------------------------------------------------
    // PATH D — media_versions content untouched. We previously seeded
    // a `metadata` version with `params='{"exif":"stub"}'`. After the
    // round-trip the row must still carry that exact payload — the
    // restore path does NOT re-run any version writer.
    // -----------------------------------------------------------------
    {
      const tripH = tripService.createTrip({ title: "PathD versions preservation" });
      const hSeed = await seedFullyAttachedMedia({
        db: dbHandle.db,
        storage,
        tripId: tripH.id,
        isRecommendedForGroup: false,
      });
      mediaService.softDeleteMedia(hSeed.mediaId);
      mediaService.restoreMedia(hSeed.mediaId);
      const version = readMediaVersion(dbHandle.db, hSeed.mediaId, "metadata");
      record(
        "versions: media_versions.params payload preserved verbatim across delete+restore",
        version?.params === '{"exif":"stub"}',
        `params=${String(version?.params)}`,
      );
      // and a sanity check on file_path — restore must not rewrite it.
      record(
        "versions: media_versions.file_path preserved",
        typeof version?.file_path === "string" &&
          (version.file_path as string).includes("metadata.json"),
        `file_path=${String(version?.file_path)}`,
      );
    }

    // -----------------------------------------------------------------
    // PATH D — media_analysis content untouched. `quality_score`,
    // `is_blurry`, and `reason` must survive verbatim — restore does
    // NOT erase the prior verdict.
    // -----------------------------------------------------------------
    {
      const tripI = tripService.createTrip({ title: "PathD analysis preservation" });
      const iSeed = await seedFullyAttachedMedia({
        db: dbHandle.db,
        storage,
        tripId: tripI.id,
        isRecommendedForGroup: false,
      });
      mediaService.softDeleteMedia(iSeed.mediaId);
      mediaService.restoreMedia(iSeed.mediaId);
      const analysis = readMediaAnalysis(dbHandle.db, iSeed.mediaId);
      record(
        "analysis: media_analysis.quality_score preserved (0.82)",
        analysis?.quality_score === 0.82,
        `quality_score=${String(analysis?.quality_score)}`,
      );
      record(
        "analysis: media_analysis.is_blurry preserved (0)",
        analysis?.is_blurry === 0,
        `is_blurry=${String(analysis?.is_blurry)}`,
      );
      record(
        "analysis: media_analysis.reason preserved verbatim",
        analysis?.reason === "seeded for P7.T5",
        `reason=${String(analysis?.reason)}`,
      );
    }

    // -----------------------------------------------------------------
    // Final FK-walk wrap-up: an end-to-end delete → restore → delete →
    // restore round-trip on the SAME media must keep every reference
    // table consistent. This catches "state-leak" bugs where one of
    // the cleanups (e.g. user-pin release) accidentally fires only on
    // the first pass.
    // -----------------------------------------------------------------
    {
      const tripJ = tripService.createTrip({ title: "round-trip cycle" });
      const jSeed = await seedFullyAttachedMedia({
        db: dbHandle.db,
        storage,
        tripId: tripJ.id,
        isRecommendedForGroup: true,
        userDecision: "keep",
      });
      for (let cycle = 1; cycle <= 2; cycle += 1) {
        mediaService.softDeleteMedia(jSeed.mediaId);
        const afterDel = readMediaRaw(dbHandle.db, jSeed.mediaId);
        record(
          `round-trip[${cycle}]: post-delete media row still present (soft-delete only)`,
          afterDel !== undefined && afterDel.deleted_at !== null,
          `deleted_at=${String(afterDel?.deleted_at)}`,
        );
        record(
          `round-trip[${cycle}]: post-delete duplicate_group_items row preserved`,
          rowExists(dbHandle.db, "duplicate_group_items", jSeed.itemId),
          `itemId=${jSeed.itemId}`,
        );
        mediaService.restoreMedia(jSeed.mediaId);
        const afterRest = readMediaRaw(dbHandle.db, jSeed.mediaId);
        record(
          `round-trip[${cycle}]: post-restore deleted_at cleared`,
          afterRest?.deleted_at === null && afterRest?.status === "processed",
          `deleted_at=${String(afterRest?.deleted_at)}`,
        );
        // The attachments must STILL be intact at the end of the cycle.
        record(
          `round-trip[${cycle}]: media_analysis still attached`,
          rowExists(dbHandle.db, "media_analysis", jSeed.analysisId),
          `analysisId=${jSeed.analysisId}`,
        );
        record(
          `round-trip[${cycle}]: media_versions still attached`,
          rowExists(dbHandle.db, "media_versions", jSeed.versionId),
          `versionId=${jSeed.versionId}`,
        );
        record(
          `round-trip[${cycle}]: processing_jobs still attached`,
          rowExists(dbHandle.db, "processing_jobs", jSeed.jobId),
          `jobId=${jSeed.jobId}`,
        );
        // P9.T1 (closes R-78): video_segments row also survives the
        // full round-trip cycle.
        record(
          `round-trip[${cycle}]: video_segments still attached (P9.T1)`,
          rowExists(dbHandle.db, "video_segments", jSeed.segmentId),
          `segmentId=${jSeed.segmentId}`,
        );
      }
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
