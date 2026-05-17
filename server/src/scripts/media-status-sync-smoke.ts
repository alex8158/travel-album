// Manual smoke test for media-status sync (P4.T5).
//
// Usage: npm run smoke:media-status-sync
//
// Drives JobRepository / JobQueue / JobService directly against a
// real SQLite DB to verify that every job-state transition keeps
// `media_items.status` in sync with the derived rule:
//
//   any {pending, retrying, running} job → 'processing'
//   else any failed                       → 'failed'
//   else any success                      → 'processed'
//   else only cancelled                   → 'failed'
//   no jobs                               → unchanged
//
// Test isolation: cases that call `claimNextPendingByJobTypes` use
// UNIQUE per-case `job_type` strings so the global claim's
// ORDER BY created_at ASC doesn't pull in another case's leftover
// pending row. CASE 14 needs MediaService.reprocess which is
// hardcoded to use 'image_thumbnail' / 'image_metadata', so it
// runs LAST and operates on a fresh media row.
//
// Coverage:
//   * Initial state — fresh media has no jobs → status stays 'uploaded'.
//   * Pending job alone — status still 'uploaded' (insert does NOT sync;
//     only running/active transitions do).
//   * Claim flips media → 'processing'.
//   * Single job success → media 'processed'.
//   * Single job failed without retry budget → media 'failed'.
//   * markRetrying (retry budget left) → media 'processing'.
//   * Two jobs: one success + one pending → media 'processing' (any active wins).
//   * Two jobs: one success + one failed → media 'failed' (failed wins over success).
//   * Two jobs: both success → media 'processed'.
//   * Cancel pending job → media 'failed' (cancelled-only fallback).
//   * Cancel running job → media 'failed'.
//   * Cancel one of two active jobs with the other still running → media 'processing'.
//   * Retry API (resetToRetrying) on failed → media 'processing'.
//   * Reprocess via MediaService on a 'processed' media → media 'processing'.
//   * Soft-deleted media is NOT touched by sync.
//   * archived media is NOT touched by sync.
//   * Sync no-op when target == current (changes=0).

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { JobRepository, JobService, type JobStatus } from "../jobs/index.js";
import { MediaRepository, MediaService, MediaVersionsRepository } from "../media/index.js";
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

function seedImageMedia(
  tripService: TripService,
  mediaRepo: MediaRepository,
  tripTitle: string,
): { tripId: string; mediaId: string } {
  const trip = tripService.createTrip({ title: tripTitle });
  const mediaId = randomUUID();
  const now = new Date().toISOString();
  mediaRepo.insert({
    id: mediaId,
    tripId: trip.id,
    type: "image",
    originalPath: `trips/${trip.id}/originals/${mediaId}.jpg`,
    fileSize: 1024,
    mimeType: "image/jpeg",
    extension: "jpg",
    createdAt: now,
    updatedAt: now,
  });
  return { tripId: trip.id, mediaId };
}

function insertJob(
  db: SqliteDatabase,
  mediaId: string,
  jobType: string,
  status: JobStatus = "pending",
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO processing_jobs (id, media_id, job_type, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, mediaId, jobType, status, now, now);
  return id;
}

function readMediaStatus(db: SqliteDatabase, mediaId: string): string | undefined {
  const row = db.prepare(`SELECT status FROM media_items WHERE id = ?`).get(mediaId) as
    | { status: string }
    | undefined;
  return row?.status;
}

/**
 * Direct-SQL helper: cancel every leftover pending/retrying row in the DB
 * (bypassing JobRepository so no sync fires). Used right before tests
 * that need MediaService.reprocess, which is hardcoded to operate on
 * `image_thumbnail` / `image_metadata` — the same types used by other
 * cases. Without this cleanup, an earlier case's pending row of those
 * types could be claimed by `claimNextPendingByJobTypes` during the
 * reprocess assertion path.
 */
function cancelAllStillRunnable(db: SqliteDatabase): void {
  db.prepare(
    `UPDATE processing_jobs SET status = 'cancelled' WHERE status IN ('pending', 'retrying', 'running')`,
  ).run();
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-media-status-sync-smoke-"));
  const dbPath = path.join(tmpRoot, "smoke.db");
  console.log(`[smoke] dbPath=${dbPath}`);

  const dbHandle = openDatabase(dbPath);
  try {
    runMigrations(dbHandle.db);

    const tripService = new TripService(new TripRepository(dbHandle.db));
    const mediaRepo = new MediaRepository(dbHandle.db);
    const mediaVersionsRepo = new MediaVersionsRepository(dbHandle.db);
    const jobRepo = new JobRepository(dbHandle.db);
    const jobService = new JobService(jobRepo);
    const mediaService = new MediaService(mediaRepo, tripService, mediaVersionsRepo, jobRepo);

    // -----------------------------------------------------------------
    // CASE 1: fresh media, no jobs → status stays 'uploaded'
    // -----------------------------------------------------------------
    {
      const m = seedImageMedia(tripService, mediaRepo, "case1-no-jobs");
      record(
        "fresh media without jobs: status stays 'uploaded'",
        readMediaStatus(dbHandle.db, m.mediaId) === "uploaded",
        `status=${String(readMediaStatus(dbHandle.db, m.mediaId))}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 2: pending job only — status stays 'uploaded' (insert
    // doesn't sync; claim is what flips media to processing)
    // -----------------------------------------------------------------
    {
      const m = seedImageMedia(tripService, mediaRepo, "case2-only-pending");
      insertJob(dbHandle.db, m.mediaId, "case2_thumb", "pending");
      record(
        "media with only pending job: status stays 'uploaded' (insert is not a sync trigger)",
        readMediaStatus(dbHandle.db, m.mediaId) === "uploaded",
        `status=${String(readMediaStatus(dbHandle.db, m.mediaId))}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 3 + 4: claim flips → 'processing'; success → 'processed'
    // -----------------------------------------------------------------
    {
      const m = seedImageMedia(tripService, mediaRepo, "case3-claim");
      const jobId = insertJob(dbHandle.db, m.mediaId, "case3_thumb", "pending");
      const claimed = jobRepo.claimNextPendingByJobTypes(["case3_thumb"]);
      record(
        "claim returned the expected job",
        claimed?.id === jobId && claimed.status === "running",
        `id=${claimed?.id} status=${claimed?.status}`,
      );
      record(
        "after claim: media → 'processing'",
        readMediaStatus(dbHandle.db, m.mediaId) === "processing",
        `status=${String(readMediaStatus(dbHandle.db, m.mediaId))}`,
      );
      const changes = jobRepo.markSuccess(jobId);
      record(
        "markSuccess: media → 'processed'",
        changes === 1 && readMediaStatus(dbHandle.db, m.mediaId) === "processed",
        `changes=${changes} status=${String(readMediaStatus(dbHandle.db, m.mediaId))}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 5: markFailed → media 'failed'
    // -----------------------------------------------------------------
    {
      const m = seedImageMedia(tripService, mediaRepo, "case5-fail");
      const jobId = insertJob(dbHandle.db, m.mediaId, "case5_thumb", "pending");
      jobRepo.claimNextPendingByJobTypes(["case5_thumb"]);
      const changes = jobRepo.markFailed(jobId, "boom");
      record(
        "markFailed: media → 'failed'",
        changes === 1 && readMediaStatus(dbHandle.db, m.mediaId) === "failed",
        `changes=${changes} status=${String(readMediaStatus(dbHandle.db, m.mediaId))}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 6: markRetrying (retry budget left) → media 'processing'
    // -----------------------------------------------------------------
    {
      const m = seedImageMedia(tripService, mediaRepo, "case6-retry");
      const jobId = insertJob(dbHandle.db, m.mediaId, "case6_thumb", "pending");
      jobRepo.claimNextPendingByJobTypes(["case6_thumb"]);
      const before = readMediaStatus(dbHandle.db, m.mediaId);
      const changes = jobRepo.markRetrying(
        jobId,
        "transient",
        new Date(Date.now() + 60_000).toISOString(),
        1,
      );
      record(
        "markRetrying: media stays/becomes 'processing' (retrying counts as active)",
        changes === 1 &&
          before === "processing" &&
          readMediaStatus(dbHandle.db, m.mediaId) === "processing",
        `changes=${changes} before=${String(before)} after=${String(readMediaStatus(dbHandle.db, m.mediaId))}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 7: success + pending sibling → media 'processing'
    // -----------------------------------------------------------------
    {
      const m = seedImageMedia(tripService, mediaRepo, "case7-mixed-active");
      const thumbId = insertJob(dbHandle.db, m.mediaId, "case7_thumb", "pending");
      insertJob(dbHandle.db, m.mediaId, "case7_meta", "pending");
      jobRepo.claimNextPendingByJobTypes(["case7_thumb"]);
      jobRepo.markSuccess(thumbId);
      // case7_meta still pending → active>0 → 'processing'
      record(
        "success + still-pending sibling: media → 'processing'",
        readMediaStatus(dbHandle.db, m.mediaId) === "processing",
        `status=${String(readMediaStatus(dbHandle.db, m.mediaId))}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 8: success + failed sibling → media 'failed'
    // -----------------------------------------------------------------
    {
      const m = seedImageMedia(tripService, mediaRepo, "case8-mixed-fail");
      const thumbId = insertJob(dbHandle.db, m.mediaId, "case8_thumb", "pending");
      const metaId = insertJob(dbHandle.db, m.mediaId, "case8_meta", "pending");
      jobRepo.claimNextPendingByJobTypes(["case8_thumb"]);
      jobRepo.markSuccess(thumbId);
      jobRepo.claimNextPendingByJobTypes(["case8_meta"]);
      jobRepo.markFailed(metaId, "metadata blew up");
      record(
        "success + failed sibling: media → 'failed'",
        readMediaStatus(dbHandle.db, m.mediaId) === "failed",
        `status=${String(readMediaStatus(dbHandle.db, m.mediaId))}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 9: two successes → media 'processed'
    // -----------------------------------------------------------------
    {
      const m = seedImageMedia(tripService, mediaRepo, "case9-both-success");
      const thumbId = insertJob(dbHandle.db, m.mediaId, "case9_thumb", "pending");
      const metaId = insertJob(dbHandle.db, m.mediaId, "case9_meta", "pending");
      jobRepo.claimNextPendingByJobTypes(["case9_thumb"]);
      jobRepo.markSuccess(thumbId);
      jobRepo.claimNextPendingByJobTypes(["case9_meta"]);
      jobRepo.markSuccess(metaId);
      record(
        "both jobs success: media → 'processed'",
        readMediaStatus(dbHandle.db, m.mediaId) === "processed",
        `status=${String(readMediaStatus(dbHandle.db, m.mediaId))}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 10: cancel only pending job → media 'failed'
    // -----------------------------------------------------------------
    {
      const m = seedImageMedia(tripService, mediaRepo, "case10-cancel-only");
      const jobId = insertJob(dbHandle.db, m.mediaId, "case10_thumb", "pending");
      const before = readMediaStatus(dbHandle.db, m.mediaId);
      jobService.cancelJob(jobId);
      record(
        "cancel only pending job: media → 'failed' (cancelled-only fallback)",
        before === "uploaded" && readMediaStatus(dbHandle.db, m.mediaId) === "failed",
        `before=${String(before)} after=${String(readMediaStatus(dbHandle.db, m.mediaId))}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 11: cancel running job → media 'failed'
    // -----------------------------------------------------------------
    {
      const m = seedImageMedia(tripService, mediaRepo, "case11-cancel-running");
      const jobId = insertJob(dbHandle.db, m.mediaId, "case11_thumb", "pending");
      jobRepo.claimNextPendingByJobTypes(["case11_thumb"]);
      jobService.cancelJob(jobId);
      record(
        "cancel running job: media flips out of 'processing' → 'failed'",
        readMediaStatus(dbHandle.db, m.mediaId) === "failed",
        `status=${String(readMediaStatus(dbHandle.db, m.mediaId))}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 12: cancel one of two active jobs — media stays 'processing'
    // -----------------------------------------------------------------
    {
      const m = seedImageMedia(tripService, mediaRepo, "case12-cancel-one-of-two");
      const thumbId = insertJob(dbHandle.db, m.mediaId, "case12_thumb", "pending");
      insertJob(dbHandle.db, m.mediaId, "case12_meta", "pending");
      jobRepo.claimNextPendingByJobTypes(["case12_thumb"]);
      jobRepo.claimNextPendingByJobTypes(["case12_meta"]);
      jobService.cancelJob(thumbId);
      record(
        "cancel one of two running jobs: media stays 'processing'",
        readMediaStatus(dbHandle.db, m.mediaId) === "processing",
        `status=${String(readMediaStatus(dbHandle.db, m.mediaId))}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 13: Retry API on failed job → media → 'processing'
    // -----------------------------------------------------------------
    {
      const m = seedImageMedia(tripService, mediaRepo, "case13-retry-api");
      const jobId = insertJob(dbHandle.db, m.mediaId, "case13_thumb", "pending");
      jobRepo.claimNextPendingByJobTypes(["case13_thumb"]);
      jobRepo.markFailed(jobId, "boom");
      const failedSnapshot = readMediaStatus(dbHandle.db, m.mediaId);
      jobService.retryJob(jobId);
      record(
        "Retry API on failed job: media 'failed' → 'processing'",
        failedSnapshot === "failed" && readMediaStatus(dbHandle.db, m.mediaId) === "processing",
        `failedSnapshot=${String(failedSnapshot)} after=${String(readMediaStatus(dbHandle.db, m.mediaId))}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 14: Reprocess via MediaService (resetToRetrying path).
    //
    // MediaService.reprocess is hardcoded to image_thumbnail /
    // image_metadata, the same types other code paths can use. We
    // first cancel any leftover pending/retrying/running rows so the
    // claim ORDER BY created_at ASC doesn't pull in unrelated rows
    // from earlier cases. The new case's media gets a fresh pair of
    // these jobs and is the only active source.
    // -----------------------------------------------------------------
    {
      cancelAllStillRunnable(dbHandle.db);
      const m = seedImageMedia(tripService, mediaRepo, "case14-reprocess");
      const thumbId = insertJob(dbHandle.db, m.mediaId, "image_thumbnail", "pending");
      const metaId = insertJob(dbHandle.db, m.mediaId, "image_metadata", "pending");
      jobRepo.claimNextPendingByJobTypes(["image_thumbnail"]);
      jobRepo.markSuccess(thumbId);
      jobRepo.claimNextPendingByJobTypes(["image_metadata"]);
      jobRepo.markSuccess(metaId);
      const processedSnapshot = readMediaStatus(dbHandle.db, m.mediaId);
      mediaService.reprocess(m.mediaId);
      record(
        "Reprocess via MediaService: media 'processed' → 'processing'",
        processedSnapshot === "processed" &&
          readMediaStatus(dbHandle.db, m.mediaId) === "processing",
        `processedSnapshot=${String(processedSnapshot)} after=${String(readMediaStatus(dbHandle.db, m.mediaId))}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 15: soft-deleted media is not touched by sync
    // -----------------------------------------------------------------
    {
      const m = seedImageMedia(tripService, mediaRepo, "case15-soft-deleted");
      const jobId = insertJob(dbHandle.db, m.mediaId, "case15_thumb", "pending");
      dbHandle.db
        .prepare(`UPDATE media_items SET deleted_at = ?, status = 'deleted' WHERE id = ?`)
        .run(new Date().toISOString(), m.mediaId);
      jobRepo.claimNextPendingByJobTypes(["case15_thumb"]);
      record(
        "soft-deleted media: status stays 'deleted' through job sync",
        readMediaStatus(dbHandle.db, m.mediaId) === "deleted",
        `status=${String(readMediaStatus(dbHandle.db, m.mediaId))}`,
      );
      jobRepo.markSuccess(jobId);
    }

    // -----------------------------------------------------------------
    // CASE 16: archived media is not touched by sync
    // -----------------------------------------------------------------
    {
      const m = seedImageMedia(tripService, mediaRepo, "case16-archived");
      const jobId = insertJob(dbHandle.db, m.mediaId, "case16_thumb", "pending");
      dbHandle.db.prepare(`UPDATE media_items SET status = 'archived' WHERE id = ?`).run(m.mediaId);
      jobRepo.claimNextPendingByJobTypes(["case16_thumb"]);
      record(
        "archived media: status stays 'archived' through job sync",
        readMediaStatus(dbHandle.db, m.mediaId) === "archived",
        `status=${String(readMediaStatus(dbHandle.db, m.mediaId))}`,
      );
      jobRepo.markSuccess(jobId);
    }

    // -----------------------------------------------------------------
    // CASE 17: sync no-op when SQL changes=0 — media.updated_at stays.
    // We trigger this by calling markSuccess on a row that's already
    // in 'success' state. The mark*Stmt WHERE-guards refuse the UPDATE,
    // changes=0, and the sync branch is skipped, so media.updated_at
    // is not bumped.
    // -----------------------------------------------------------------
    {
      const m = seedImageMedia(tripService, mediaRepo, "case17-noop");
      const thumbId = insertJob(dbHandle.db, m.mediaId, "case17_thumb", "pending");
      jobRepo.claimNextPendingByJobTypes(["case17_thumb"]);
      jobRepo.markSuccess(thumbId);
      // Media is now 'processed'. Capture updated_at.
      const beforeUpdatedAt = (
        dbHandle.db.prepare(`SELECT updated_at FROM media_items WHERE id = ?`).get(m.mediaId) as
          | { updated_at: string }
          | undefined
      )?.updated_at;
      // Try to markSuccess again — row is already success, guard refuses, changes=0.
      const ghostChanges = jobRepo.markSuccess(thumbId);
      const afterUpdatedAt = (
        dbHandle.db.prepare(`SELECT updated_at FROM media_items WHERE id = ?`).get(m.mediaId) as
          | { updated_at: string }
          | undefined
      )?.updated_at;
      record(
        "sync no-op when SQL changes=0: media.updated_at unchanged",
        ghostChanges === 0 && afterUpdatedAt === beforeUpdatedAt,
        `ghostChanges=${ghostChanges} before=${String(beforeUpdatedAt)} after=${String(afterUpdatedAt)}`,
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
