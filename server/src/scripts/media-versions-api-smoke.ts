// Manual smoke test for the version switching API (P8.T4).
//
// Usage: npm run smoke:media-versions-api
//
// Exercises `MediaService.listVersions` + `MediaService.selectVersion`
// at the service layer (real SQLite, real prepared statements, no
// HTTP) — same shape as `media-enhance-trigger-smoke.ts` and
// `trip-media-recycle-bin-smoke.ts`. A small HTTP block at the end
// confirms the routes are mounted on `/api/media/:id/versions` and
// `/api/media/:id/select-version` and forward correctly to the
// service.
//
// Coverage:
//   * GET versions: original always present; original.isActive=true
//     by default (migration 010 sets active_version_type='original');
//     enhanced.isActive=false until selected.
//   * GET versions: enhanced row appears when media_versions has a
//     row of type='enhanced' (P8.T3 worker output).
//   * GET versions: operational types (thumbnail / preview /
//     metadata / video_*) are FILTERED OUT — only user-selectable
//     types reach the response.
//   * GET versions on unknown-type media: synthesized original entry
//     still present, filePath='' (no original_path on disk), no
//     enhanced.
//   * POST select-version → 'enhanced' on a media that owns it:
//     active_version_type flips, previousVersionType returned,
//     alreadyActive=false.
//   * POST select-version again with the same versionType:
//     alreadyActive=true; no DB write (updated_at preserved).
//   * POST select-version → 'enhanced' on a media without an
//     enhanced row → BadRequestError (clear message).
//   * POST select-version → 'original' on type='unknown' media
//     (no original_path) → BadRequestError.
//   * Malformed body / unknown body keys → BadRequestError via
//     zod .strict().
//   * Missing media → NotFoundError on both endpoints.
//   * Soft-deleted media → NotFoundError on both endpoints
//     (matches P7 recycle-bin contract).
//   * select-version does NOT touch original_path / preview_path /
//     thumbnail_path / status / user_decision / media_versions rows.
//   * select-version does NOT delete or modify files on disk.
//   * HTTP layer: GET /versions returns 200 + correct shape;
//     POST /select-version returns 200 + correct shape; bad body
//     gives 400.

import { randomUUID } from "node:crypto";
import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { NoopProvider } from "../ai/index.js";
import { closeDatabase, openDatabase, type SqliteDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { DuplicateGroupsRepository } from "../dedup/index.js";
import { JobRepository } from "../jobs/index.js";
import { createLogger } from "../logger.js";
import {
  MediaRepository,
  MediaService,
  MediaVersionsRepository,
  type MediaSoftDeleteDeps,
} from "../media/index.js";
import { makeErrorHandler, notFoundHandler } from "../middleware/errorHandler.js";
import { requestIdMiddleware } from "../middleware/requestId.js";
import { makeMediaRouter } from "../routes/media.js";
import { LocalStorageProvider } from "../storage/index.js";
import { TripRepository, TripService } from "../trips/index.js";
import { UploadService } from "../upload/index.js";

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

interface Seeded {
  readonly tripId: string;
  readonly mediaId: string;
  readonly originalPath: string;
}

function seedImage(
  db: SqliteDatabase,
  tripService: TripService,
  mediaRepo: MediaRepository,
  title = "Versions API Smoke Trip",
): Seeded {
  const trip = tripService.createTrip({ title });
  const mediaId = randomUUID();
  const originalPath = `trips/${trip.id}/originals/${mediaId}.jpg`;
  const now = new Date().toISOString();
  mediaRepo.insert({
    id: mediaId,
    tripId: trip.id,
    type: "image",
    originalPath,
    fileSize: 1024,
    mimeType: "image/jpeg",
    extension: "jpg",
    createdAt: now,
    updatedAt: now,
  });
  return { tripId: trip.id, mediaId, originalPath };
}

function seedUnknown(
  tripService: TripService,
  mediaRepo: MediaRepository,
): { tripId: string; mediaId: string } {
  const trip = tripService.createTrip({ title: "Versions API Smoke unknown" });
  const mediaId = randomUUID();
  const now = new Date().toISOString();
  mediaRepo.insert({
    id: mediaId,
    tripId: trip.id,
    type: "unknown",
    originalPath: null,
    fileSize: null,
    mimeType: null,
    extension: null,
    createdAt: now,
    updatedAt: now,
  });
  return { tripId: trip.id, mediaId };
}

function upsertVersion(
  versionsRepo: MediaVersionsRepository,
  mediaId: string,
  versionType: string,
  filePath: string,
  extras: { mimeType?: string; width?: number; height?: number; fileSize?: number } = {},
): void {
  versionsRepo.upsert({
    mediaId,
    versionType,
    filePath,
    mimeType: extras.mimeType ?? null,
    width: extras.width ?? null,
    height: extras.height ?? null,
    fileSize: extras.fileSize ?? null,
    now: new Date().toISOString(),
  });
}

function readMedia(db: SqliteDatabase, id: string): Record<string, unknown> | undefined {
  return db.prepare(`SELECT * FROM media_items WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
}

function countVersions(db: SqliteDatabase, mediaId: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM media_versions WHERE media_id = ?`).get(mediaId) as {
      n: number;
    }
  ).n;
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-media-versions-api-smoke-"));
  const dbPath = path.join(tmpRoot, "smoke.db");
  const storageRoot = path.join(tmpRoot, "storage");
  console.log(`[smoke] tmpRoot=${tmpRoot}`);

  const dbHandle = openDatabase(dbPath);
  let server: ReturnType<typeof createServer> | null = null;
  try {
    runMigrations(dbHandle.db);

    const logger = createLogger({ nodeEnv: "test" });
    const storage = LocalStorageProvider.create(storageRoot);
    const tripRepo = new TripRepository(dbHandle.db);
    const tripService = new TripService(tripRepo);
    const mediaRepo = new MediaRepository(dbHandle.db);
    const mediaVersionsRepo = new MediaVersionsRepository(dbHandle.db);
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
    // CASE 1: default active_version_type='original' on fresh media.
    // The migration's DEFAULT covers existing rows; this asserts that
    // a freshly-inserted row also lands at 'original' (no INSERT
    // surprise).
    // -----------------------------------------------------------------
    const seeded = seedImage(dbHandle.db, tripService, mediaRepo, "Case1 default");
    {
      const m = readMedia(dbHandle.db, seeded.mediaId);
      record(
        "default: media_items.active_version_type='original' on fresh row",
        m?.active_version_type === "original",
        `active_version_type=${String(m?.active_version_type)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 2: GET versions on media with NO media_versions rows yet.
    // Should return exactly the synthesized 'original' entry, with
    // isActive=true.
    // -----------------------------------------------------------------
    {
      const view = mediaService.listVersions(seeded.mediaId);
      record(
        "GET (no rows): mediaId + activeVersionType='original' at top level",
        view.mediaId === seeded.mediaId && view.activeVersionType === "original",
        JSON.stringify(view),
      );
      record(
        "GET (no rows): exactly 1 entry — synthesized original",
        view.versions.length === 1 &&
          view.versions[0]?.versionType === "original" &&
          view.versions[0]?.isActive === true &&
          view.versions[0]?.id === null,
        `count=${view.versions.length}`,
      );
      record(
        "GET (no rows): synthesized original.filePath = original_path",
        view.versions[0]?.filePath === seeded.originalPath,
        `filePath=${String(view.versions[0]?.filePath)}`,
      );
      record(
        "GET (no rows): synthesized original.mimeType/createdAt are populated from media_items",
        view.versions[0]?.mimeType === "image/jpeg" &&
          typeof view.versions[0]?.createdAt === "string",
        `mime=${String(view.versions[0]?.mimeType)} createdAt=${String(view.versions[0]?.createdAt)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 3: GET versions with operational rows seeded (thumbnail /
    // preview / metadata) — these MUST be filtered out.
    // -----------------------------------------------------------------
    {
      upsertVersion(
        mediaVersionsRepo,
        seeded.mediaId,
        "thumbnail",
        `trips/${seeded.tripId}/derived/${seeded.mediaId}/thumb.webp`,
        { mimeType: "image/webp", width: 320, height: 240, fileSize: 8000 },
      );
      upsertVersion(
        mediaVersionsRepo,
        seeded.mediaId,
        "preview",
        `trips/${seeded.tripId}/derived/${seeded.mediaId}/preview.webp`,
        { mimeType: "image/webp", width: 1600, height: 1200, fileSize: 80_000 },
      );
      upsertVersion(
        mediaVersionsRepo,
        seeded.mediaId,
        "metadata",
        `trips/${seeded.tripId}/derived/${seeded.mediaId}/metadata.json`,
        { mimeType: "application/json", fileSize: 200 },
      );
      const view = mediaService.listVersions(seeded.mediaId);
      record(
        "GET (with operational rows): operational types are filtered out",
        view.versions.length === 1 && view.versions[0]?.versionType === "original",
        `types=${view.versions.map((v) => v.versionType).join(",")}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 4: enhanced row appears when seeded.
    // -----------------------------------------------------------------
    {
      upsertVersion(
        mediaVersionsRepo,
        seeded.mediaId,
        "enhanced",
        `trips/${seeded.tripId}/derived/${seeded.mediaId}/enhanced.jpg`,
        { mimeType: "image/jpeg", width: 1920, height: 1440, fileSize: 60_000 },
      );
      const view = mediaService.listVersions(seeded.mediaId);
      record(
        "GET (enhanced exists): original + enhanced, both with isActive correctly set",
        view.versions.length === 2 &&
          view.versions.some((v) => v.versionType === "original" && v.isActive === true) &&
          view.versions.some((v) => v.versionType === "enhanced" && v.isActive === false),
        `versions=${view.versions
          .map((v) => `${v.versionType}=${v.isActive ? "active" : "inactive"}`)
          .join(",")}`,
      );
      record(
        "GET (enhanced exists): enhanced.id is a uuid (not null), filePath matches",
        typeof view.versions.find((v) => v.versionType === "enhanced")?.id === "string" &&
          view.versions.find((v) => v.versionType === "enhanced")?.filePath ===
            `trips/${seeded.tripId}/derived/${seeded.mediaId}/enhanced.jpg`,
        `enhancedId=${String(view.versions.find((v) => v.versionType === "enhanced")?.id)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 5: select-version → enhanced (happy path).
    // -----------------------------------------------------------------
    {
      const beforeMedia = readMedia(dbHandle.db, seeded.mediaId);
      const out = mediaService.selectVersion(seeded.mediaId, { versionType: "enhanced" });
      record(
        "select (happy): alreadyActive=false + previousVersionType='original' + activeVersionType='enhanced'",
        out.alreadyActive === false &&
          out.previousVersionType === "original" &&
          out.activeVersionType === "enhanced" &&
          out.mediaId === seeded.mediaId,
        JSON.stringify(out),
      );
      const afterMedia = readMedia(dbHandle.db, seeded.mediaId);
      record(
        "select (happy): media_items.active_version_type flipped to 'enhanced'",
        afterMedia?.active_version_type === "enhanced",
        `active_version_type=${String(afterMedia?.active_version_type)}`,
      );
      record(
        "select (happy): updated_at was bumped (write happened)",
        afterMedia?.updated_at !== beforeMedia?.updated_at,
        `before=${String(beforeMedia?.updated_at)} after=${String(afterMedia?.updated_at)}`,
      );
      // GET should now show enhanced as active.
      const view = mediaService.listVersions(seeded.mediaId);
      record(
        "select (happy): GET reflects the switch — enhanced.isActive=true",
        view.activeVersionType === "enhanced" &&
          view.versions.find((v) => v.versionType === "enhanced")?.isActive === true &&
          view.versions.find((v) => v.versionType === "original")?.isActive === false,
        `top=${view.activeVersionType}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 6: select-version idempotency — re-selecting the active
    // version is a no-op; alreadyActive=true; no updated_at bump.
    // -----------------------------------------------------------------
    {
      const before = readMedia(dbHandle.db, seeded.mediaId);
      const out = mediaService.selectVersion(seeded.mediaId, { versionType: "enhanced" });
      const after = readMedia(dbHandle.db, seeded.mediaId);
      record(
        "select (idempotent): alreadyActive=true; activeVersionType unchanged",
        out.alreadyActive === true &&
          out.activeVersionType === "enhanced" &&
          out.previousVersionType === "enhanced",
        JSON.stringify(out),
      );
      record(
        "select (idempotent): updated_at unchanged (no DB write)",
        after?.updated_at === before?.updated_at,
        `before=${String(before?.updated_at)} after=${String(after?.updated_at)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 7: select-version → 'original' (switch back).
    // -----------------------------------------------------------------
    {
      const out = mediaService.selectVersion(seeded.mediaId, { versionType: "original" });
      record(
        "select (back): alreadyActive=false + previousVersionType='enhanced' + activeVersionType='original'",
        out.alreadyActive === false &&
          out.previousVersionType === "enhanced" &&
          out.activeVersionType === "original",
        JSON.stringify(out),
      );
      const m = readMedia(dbHandle.db, seeded.mediaId);
      record(
        "select (back): media_items.active_version_type='original'",
        m?.active_version_type === "original",
        `active_version_type=${String(m?.active_version_type)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 8: select-version → 'enhanced' on a media WITHOUT an
    // enhanced row → BadRequestError.
    // -----------------------------------------------------------------
    {
      const empty = seedImage(dbHandle.db, tripService, mediaRepo, "Case8 no-enhanced");
      let threw: unknown;
      try {
        mediaService.selectVersion(empty.mediaId, { versionType: "enhanced" });
      } catch (err) {
        threw = err;
      }
      record(
        "select (no-enhanced): BadRequestError mentions 'no media_versions row of that type'",
        threw !== undefined && /no media_versions row of that type/.test(describeError(threw)),
        describeError(threw),
      );
      // No state change.
      const m = readMedia(dbHandle.db, empty.mediaId);
      record(
        "select (no-enhanced): media_items.active_version_type stays 'original'",
        m?.active_version_type === "original",
        `active_version_type=${String(m?.active_version_type)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 9: select-version → 'original' on type='unknown' media
    // (no original_path) → BadRequestError.
    // -----------------------------------------------------------------
    {
      const u = seedUnknown(tripService, mediaRepo);
      let threw: unknown;
      try {
        mediaService.selectVersion(u.mediaId, { versionType: "original" });
      } catch (err) {
        threw = err;
      }
      record(
        "select (unknown→original): BadRequestError mentions 'no original_path'",
        threw !== undefined && /no original_path/.test(describeError(threw)),
        describeError(threw),
      );
      // GET still works on unknown — synthesized original with empty filePath.
      const view = mediaService.listVersions(u.mediaId);
      record(
        "GET (unknown): synthesized original entry still present with filePath=''",
        view.versions.length === 1 &&
          view.versions[0]?.versionType === "original" &&
          view.versions[0]?.filePath === "" &&
          view.versions[0]?.isActive === true,
        `versions=${JSON.stringify(view.versions)}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 10: malformed select-version body → BadRequestError /
    // ValidationError via zod .strict().
    // -----------------------------------------------------------------
    {
      const m = seedImage(dbHandle.db, tripService, mediaRepo, "Case10 bad-body");
      // Missing versionType.
      let threwMissing: unknown;
      try {
        mediaService.selectVersion(m.mediaId, {});
      } catch (err) {
        threwMissing = err;
      }
      record(
        "select (no versionType): rejected with Validation error",
        threwMissing !== undefined && /Validation/.test(describeError(threwMissing)),
        describeError(threwMissing),
      );
      // Unknown versionType ('preview' is not user-selectable).
      let threwBadType: unknown;
      try {
        mediaService.selectVersion(m.mediaId, { versionType: "preview" });
      } catch (err) {
        threwBadType = err;
      }
      record(
        "select (versionType='preview'): rejected with Validation error",
        threwBadType !== undefined && /Validation/.test(describeError(threwBadType)),
        describeError(threwBadType),
      );
      // Unknown body key (strict).
      let threwExtra: unknown;
      try {
        mediaService.selectVersion(m.mediaId, { versionType: "original", extra: 1 });
      } catch (err) {
        threwExtra = err;
      }
      record(
        "select (extra body key): rejected with Validation error (.strict())",
        threwExtra !== undefined && /Validation/.test(describeError(threwExtra)),
        describeError(threwExtra),
      );
    }

    // -----------------------------------------------------------------
    // CASE 11: missing media → NotFoundError on both endpoints.
    // -----------------------------------------------------------------
    {
      const ghostId = randomUUID();
      let threwGet: unknown;
      try {
        mediaService.listVersions(ghostId);
      } catch (err) {
        threwGet = err;
      }
      record(
        "GET (missing): NotFoundError",
        threwGet !== undefined && /Media not found/.test(describeError(threwGet)),
        describeError(threwGet),
      );
      let threwSelect: unknown;
      try {
        mediaService.selectVersion(ghostId, { versionType: "original" });
      } catch (err) {
        threwSelect = err;
      }
      record(
        "select (missing): NotFoundError",
        threwSelect !== undefined && /Media not found/.test(describeError(threwSelect)),
        describeError(threwSelect),
      );
    }

    // -----------------------------------------------------------------
    // CASE 12: soft-deleted media → NotFoundError on both endpoints
    // (matches P7 recycle-bin contract).
    // -----------------------------------------------------------------
    {
      const sd = seedImage(dbHandle.db, tripService, mediaRepo, "Case12 soft-deleted");
      mediaService.softDeleteMedia(sd.mediaId);
      let threwGet: unknown;
      try {
        mediaService.listVersions(sd.mediaId);
      } catch (err) {
        threwGet = err;
      }
      record(
        "GET (soft-deleted): NotFoundError (recycle-bin contract)",
        threwGet !== undefined && /Media not found/.test(describeError(threwGet)),
        describeError(threwGet),
      );
      let threwSelect: unknown;
      try {
        mediaService.selectVersion(sd.mediaId, { versionType: "original" });
      } catch (err) {
        threwSelect = err;
      }
      record(
        "select (soft-deleted): NotFoundError (recycle-bin contract)",
        threwSelect !== undefined && /Media not found/.test(describeError(threwSelect)),
        describeError(threwSelect),
      );
    }

    // -----------------------------------------------------------------
    // CASE 13: select-version does NOT touch other media_items columns
    // or media_versions rows or files on disk.
    //
    // The "scope-guard" of P8.T4: switching versions is a single-
    // column update on media_items; everything else stays as-is.
    // -----------------------------------------------------------------
    {
      const m = seedImage(dbHandle.db, tripService, mediaRepo, "Case13 scope-guard");
      upsertVersion(
        mediaVersionsRepo,
        m.mediaId,
        "enhanced",
        `trips/${m.tripId}/derived/${m.mediaId}/enhanced.jpg`,
        { mimeType: "image/jpeg", width: 800, height: 600, fileSize: 12_345 },
      );
      // Write a real bytes-on-disk file for the original + enhanced
      // so we can prove the select-version action does NOT delete or
      // overwrite anything on disk.
      const enhancedAbs = path.join(
        storage.root,
        `trips/${m.tripId}/derived/${m.mediaId}/enhanced.jpg`,
      );
      await storage.putDerived({
        tripId: m.tripId,
        mediaId: m.mediaId,
        relPath: "enhanced.jpg",
        data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        overwrite: true,
      });
      const originalAbs = path.join(storage.root, m.originalPath);
      await storage.putOriginal({
        tripId: m.tripId,
        mediaId: m.mediaId + "-copy",
        extension: "jpg",
        data: Buffer.from([0xff, 0xd8, 0xff, 0xdb]),
      });
      // (the original we INSERT into media_items doesn't actually have
      // bytes on disk because we used the repository helper, not
      // putOriginal; this is fine — the version-switch endpoint
      // doesn't touch the file system at all.)
      void originalAbs;

      const beforeMedia = readMedia(dbHandle.db, m.mediaId);
      const beforeEnhancedExists = existsSync(enhancedAbs);
      const beforeCount = countVersions(dbHandle.db, m.mediaId);

      mediaService.selectVersion(m.mediaId, { versionType: "enhanced" });

      const afterMedia = readMedia(dbHandle.db, m.mediaId);
      const afterEnhancedExists = existsSync(enhancedAbs);
      const afterCount = countVersions(dbHandle.db, m.mediaId);

      record(
        "scope-guard: only active_version_type + updated_at changed",
        afterMedia?.active_version_type === "enhanced" &&
          afterMedia?.original_path === beforeMedia?.original_path &&
          afterMedia?.preview_path === beforeMedia?.preview_path &&
          afterMedia?.thumbnail_path === beforeMedia?.thumbnail_path &&
          afterMedia?.status === beforeMedia?.status &&
          afterMedia?.user_decision === beforeMedia?.user_decision &&
          afterMedia?.deleted_at === beforeMedia?.deleted_at,
        `active=${String(afterMedia?.active_version_type)}`,
      );
      record(
        "scope-guard: media_versions row count unchanged",
        beforeCount === afterCount,
        `before=${beforeCount} after=${afterCount}`,
      );
      record(
        "scope-guard: enhanced.jpg still on disk (no delete / overwrite)",
        beforeEnhancedExists && afterEnhancedExists,
        `before=${beforeEnhancedExists} after=${afterEnhancedExists}`,
      );
      // bytes-equal check — the file content is untouched.
      const enhancedBytes = readFileSync(enhancedAbs);
      record(
        "scope-guard: enhanced.jpg bytes intact (4 sentinel bytes)",
        enhancedBytes.length === 4 &&
          enhancedBytes[0] === 0xff &&
          enhancedBytes[1] === 0xd8 &&
          enhancedBytes[2] === 0xff &&
          enhancedBytes[3] === 0xe0,
        `len=${enhancedBytes.length}`,
      );
    }

    // -----------------------------------------------------------------
    // CASE 14: HTTP layer — confirm the routes are mounted at the
    // canonical paths and forward to the service correctly.
    //
    // We boot a minimal Express app with the media router (and a
    // stub UploadService that we never exercise).
    // -----------------------------------------------------------------
    {
      const uploadService = new UploadService({
        db: dbHandle.db,
        storage,
        tripService,
        mediaRepo,
        jobRepo,
        classifyOptions: {
          imageExtensions: ["jpg", "jpeg", "png", "webp", "heic"],
          videoExtensions: ["mp4", "mov", "m4v", "avi", "mkv"],
        },
        maxFileSize: 10 * 1024 * 1024,
        logger,
      });
      const app = express();
      app.use(express.json({ limit: "1mb" }));
      app.use(requestIdMiddleware);
      // P10.T3 added an `aiProvider` dep on the media router; pass a
      // NoopProvider so the existing P8.T4 smoke doesn't have to care
      // about the AI surface (it never hits /ai-refine anyway).
      app.use(
        "/api",
        makeMediaRouter({ uploadService, mediaService, aiProvider: new NoopProvider() }),
      );
      app.use(notFoundHandler);
      app.use(makeErrorHandler(logger));

      server = createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}`;

      const httpSeed = seedImage(dbHandle.db, tripService, mediaRepo, "Case14 HTTP layer");
      upsertVersion(
        mediaVersionsRepo,
        httpSeed.mediaId,
        "enhanced",
        `trips/${httpSeed.tripId}/derived/${httpSeed.mediaId}/enhanced.jpg`,
        { mimeType: "image/jpeg", width: 100, height: 100, fileSize: 500 },
      );

      // GET /api/media/:id/versions
      {
        const res = await fetch(
          `${base}/api/media/${encodeURIComponent(httpSeed.mediaId)}/versions`,
          { headers: { Accept: "application/json" } },
        );
        const body = (await res.json()) as {
          mediaId: string;
          activeVersionType: string;
          versions: Array<{ versionType: string; isActive: boolean }>;
        };
        record(
          "HTTP GET /versions → 200 + correct shape",
          res.status === 200 &&
            body.mediaId === httpSeed.mediaId &&
            body.activeVersionType === "original" &&
            body.versions.length === 2 &&
            body.versions.some((v) => v.versionType === "original" && v.isActive) &&
            body.versions.some((v) => v.versionType === "enhanced" && !v.isActive),
          `status=${res.status} body=${JSON.stringify(body)}`,
        );
      }

      // POST /api/media/:id/select-version
      {
        const res = await fetch(
          `${base}/api/media/${encodeURIComponent(httpSeed.mediaId)}/select-version`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ versionType: "enhanced" }),
          },
        );
        const body = (await res.json()) as {
          mediaId: string;
          activeVersionType: string;
          previousVersionType: string;
          alreadyActive: boolean;
        };
        record(
          "HTTP POST /select-version → 200 + correct shape",
          res.status === 200 &&
            body.mediaId === httpSeed.mediaId &&
            body.activeVersionType === "enhanced" &&
            body.previousVersionType === "original" &&
            body.alreadyActive === false,
          `status=${res.status} body=${JSON.stringify(body)}`,
        );
      }

      // POST with malformed body → 400 VALIDATION_FAILED
      {
        const res = await fetch(
          `${base}/api/media/${encodeURIComponent(httpSeed.mediaId)}/select-version`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ versionType: "bogus" }),
          },
        );
        const body = (await res.json()) as { error?: { code: string } };
        record(
          "HTTP POST /select-version with invalid versionType → 400 VALIDATION_FAILED",
          res.status === 400 && body.error?.code === "VALIDATION_FAILED",
          `status=${res.status} body=${JSON.stringify(body)}`,
        );
      }

      // GET on a missing id → 404
      {
        const ghost = randomUUID();
        const res = await fetch(`${base}/api/media/${ghost}/versions`, {
          headers: { Accept: "application/json" },
        });
        const body = (await res.json()) as { error?: { code: string } };
        record(
          "HTTP GET /versions on missing media → 404 NOT_FOUND",
          res.status === 404 && body.error?.code === "NOT_FOUND",
          `status=${res.status} body=${JSON.stringify(body)}`,
        );
      }
    }
  } finally {
    if (server !== null) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
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
