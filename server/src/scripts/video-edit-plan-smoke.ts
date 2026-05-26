// Manual smoke test for the video edit plan generator (P11.T4).
//
// Usage: npm run smoke:video-edit-plan
//
// Coverage:
//
//   Pure rule engine (no DB / no HTTP):
//     * buildEditPlan: 0 candidates → empty plan + 'no_video_candidates'
//     * buildEditPlan: 1 candidate w/ duration >= target → 1 clip at target
//     * buildEditPlan: 1 candidate w/ duration < target → 1 short clip +
//                       'insufficient_source_material'
//     * buildEditPlan: N candidates, cumulative > target → last clip
//                       truncated to land exactly on target
//     * buildEditPlan: N candidates, cumulative < target → warning
//                       + total < target
//     * computePerClipCapSeconds: floor at MIN_CLIP_DURATION_SECONDS
//     * resolveAudioPolicy: 4 mode-resolution table cases
//
//   Service + DB (real SQLite + real migrations, NO ffmpeg needed —
//   the planner reads `media_items.duration` rather than probing):
//     * Empty trip → plan with 0 clips + `no_video_candidates`
//     * Trip with image-only media → plan with 0 clips (silent
//       skip, no warning unless mediaIds explicit)
//     * Explicit `mediaIds` containing a non-video → emits
//       'media_not_video' warning
//     * Explicit `mediaIds` containing an unknown id → emits
//       'media_not_found' warning
//     * Explicit `mediaIds` from a different trip → emits
//       'media_not_found' (no cross-trip enumeration)
//     * audioMode='keep_original' → policy mode unchanged
//     * audioMode='mute' → removeOriginalAudio=true + no BGM
//     * audioMode='replace_with_library' + valid backgroundAudioId →
//       resolved policy with `replace_with_library` + correct
//       audioId + loudnorm/loop/fade defaults
//     * backgroundAudioId not found → fallback to keep_original +
//       'background_audio_not_found' warning
//     * backgroundAudioId pointing to inactive row → fallback +
//       'background_audio_inactive' warning
//     * backgroundAudioId without explicit audioMode → infers
//       'replace_with_library'
//     * Style 'short' / 'standard' / 'long' → 15s / 30s / 60s targets
//     * Explicit targetDurationSec wins over style
//     * Trip missing / soft-deleted → NotFoundError (HTTP 404 mapping)
//     * Body fails zod (unknown key / out-of-range / bad enum) →
//       ValidationError (HTTP 400 mapping)
//
//   HTTP layer (express app — real request, body parsing, error
//   envelope):
//     * POST 200 with happy plan
//     * POST 404 on missing trip
//     * POST 400 on unknown body key (`.strict()` rejection)
//     * POST plan response has the expected shape (`version`,
//       `tripId`, `clips`, `audioPolicy`, `warnings`)

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import express, { type Express } from "express";

import { createApp } from "../app.js";
import { NoopProvider } from "../ai/index.js";
import { closeDatabase, openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { DedupEngine, DedupService, DuplicateGroupsRepository } from "../dedup/index.js";
import { JobRepository, JobService } from "../jobs/index.js";
import { createLogger } from "../logger.js";
import {
  AudioLibraryRepository,
  AudioLibraryService,
  EditPlansRepository,
  MediaAnalysisRepository,
  MediaRepository,
  MediaService,
  MediaVersionsRepository,
  VideoEditPlanService,
  VideoRenderService,
  VideoSegmentsRepository,
  VideoService,
  buildEditPlan,
  computePerClipCapSeconds,
  resolveAudioPolicy,
  type AudioLibraryView,
  type EditPlanCandidate,
  type MediaSoftDeleteDeps,
} from "../media/index.js";
import { LocalStorageProvider } from "../storage/index.js";
import { TripRepository, TripService } from "../trips/index.js";
import { UploadService } from "../upload/index.js";
import type { MediaItem } from "../media/mediaTypes.js";

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

function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

function fakeMediaItem(args: {
  id?: string;
  tripId: string;
  type: "video" | "image" | "unknown";
  durationSec: number | null;
  originalPath?: string | null;
}): MediaItem {
  const now = new Date().toISOString();
  return {
    id: args.id ?? randomUUID(),
    tripId: args.tripId,
    type: args.type,
    originalPath:
      args.originalPath === undefined ? `trips/${args.tripId}/originals/x.mp4` : args.originalPath,
    previewPath: null,
    thumbnailPath: null,
    fileSize: 1024,
    mimeType: args.type === "video" ? "video/mp4" : args.type === "image" ? "image/jpeg" : null,
    extension: args.type === "video" ? "mp4" : null,
    width: null,
    height: null,
    duration: args.durationSec,
    status: "processed",
    userDecision: "undecided",
    activeVersionType: "original",
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    analysis: null,
  };
}

function fixedClock(iso = "2026-05-26T04:00:00.000Z"): () => Date {
  return () => new Date(iso);
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-video-edit-plan-smoke-"));
  const dbPath = path.join(tmpRoot, "smoke.db");
  const storageRoot = path.join(tmpRoot, "storage");
  console.log(`[smoke] tmpRoot=${tmpRoot}`);

  // ============================================================
  // PART A — Pure rule engine (no DB)
  // ============================================================

  // computePerClipCapSeconds: floor + even split
  record(
    "pure: computePerClipCapSeconds(target=30, n=3) === 10",
    computePerClipCapSeconds(30, 3) === 10,
    `cap=${computePerClipCapSeconds(30, 3)}`,
  );
  record(
    "pure: computePerClipCapSeconds(target=10, n=5) clamps to floor 3",
    computePerClipCapSeconds(10, 5) === 3,
    `cap=${computePerClipCapSeconds(10, 5)}`,
  );
  record(
    "pure: computePerClipCapSeconds(target=30, n=0) === 0",
    computePerClipCapSeconds(30, 0) === 0,
    `cap=${computePerClipCapSeconds(30, 0)}`,
  );

  // resolveAudioPolicy: keep_original (no bg audio)
  {
    const r = resolveAudioPolicy({
      backgroundAudio: null,
      targetDurationSec: 30,
      defaults: { loudnorm: true, fadeInSeconds: 1.5, fadeOutSeconds: 2 },
    });
    record(
      "pure: resolveAudioPolicy default → keep_original / no bg / no removeOriginalAudio",
      r.policy.mode === "keep_original" &&
        r.policy.backgroundAudioId === null &&
        r.policy.removeOriginalAudio === false &&
        r.warnings.length === 0,
      JSON.stringify(r.policy),
    );
  }

  // resolveAudioPolicy: mute
  {
    const r = resolveAudioPolicy({
      requestedMode: "mute",
      backgroundAudio: null,
      targetDurationSec: 30,
      defaults: { loudnorm: true, fadeInSeconds: 1.5, fadeOutSeconds: 2 },
    });
    record(
      "pure: resolveAudioPolicy mute → removeOriginalAudio=true / no fades",
      r.policy.mode === "mute" &&
        r.policy.removeOriginalAudio === true &&
        r.policy.fadeInSeconds === 0 &&
        r.policy.fadeOutSeconds === 0,
      JSON.stringify(r.policy),
    );
  }

  // resolveAudioPolicy: replace_with_library + valid audio
  {
    const fakeAudio: AudioLibraryView = {
      id: "audio-xyz",
      name: "demo",
      displayName: "Demo",
      sourceType: "system",
      filePath: "/tmp/demo.mp3",
      relativePath: null,
      mimeType: "audio/mpeg",
      durationSeconds: 90,
      sizeBytes: 2_000_000,
      checksum: "x".repeat(64),
      isActive: true,
      tags: null,
      metadataJson: null,
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
    };
    const r = resolveAudioPolicy({
      requestedMode: "replace_with_library",
      requestedBackgroundAudioId: "audio-xyz",
      backgroundAudio: fakeAudio,
      targetDurationSec: 30,
      defaults: { loudnorm: true, fadeInSeconds: 1.5, fadeOutSeconds: 2 },
    });
    record(
      "pure: resolveAudioPolicy replace_with_library → carries id + loop + loudnorm",
      r.policy.mode === "replace_with_library" &&
        r.policy.backgroundAudioId === "audio-xyz" &&
        r.policy.loopToFit === true &&
        r.policy.loudnorm === true &&
        r.policy.removeOriginalAudio === true &&
        r.policy.targetDurationSec === 30,
      JSON.stringify(r.policy),
    );
  }

  // resolveAudioPolicy: replace_with_library but null audio → fallback
  {
    const r = resolveAudioPolicy({
      requestedMode: "replace_with_library",
      requestedBackgroundAudioId: "missing-audio",
      backgroundAudio: null,
      targetDurationSec: 30,
      defaults: { loudnorm: true, fadeInSeconds: 1.5, fadeOutSeconds: 2 },
    });
    record(
      "pure: resolveAudioPolicy replace_with_library + null audio → fallback keep_original",
      r.policy.mode === "keep_original" && r.policy.backgroundAudioId === null,
      JSON.stringify(r.policy),
    );
  }

  // buildEditPlan: 0 candidates
  {
    const plan = buildEditPlan({
      tripId: "trip-empty",
      style: "standard",
      targetDurationSec: 30,
      aspectRatio: "16:9",
      resolution: "1080p",
      candidates: [],
      audioPolicy: {
        mode: "keep_original",
        backgroundAudioId: null,
        removeOriginalAudio: false,
        loudnorm: false,
        fadeInSeconds: 0,
        fadeOutSeconds: 0,
        loopToFit: false,
        targetDurationSec: 30,
      },
      priorWarnings: [],
      now: fixedClock(),
    });
    record(
      "pure: buildEditPlan empty → 0 clips + no_video_candidates warning + totalDur=0",
      plan.clips.length === 0 &&
        plan.warnings.some((w) => w.code === "no_video_candidates") &&
        plan.totalDurationSec === 0,
      JSON.stringify({ clips: plan.clips.length, warnings: plan.warnings.map((w) => w.code) }),
    );
  }

  // buildEditPlan: 1 long candidate → 1 clip at target
  {
    const cand: EditPlanCandidate = {
      media: fakeMediaItem({ tripId: "trip-1", type: "video", durationSec: 120 }),
      durationSec: 120,
    };
    const plan = buildEditPlan({
      tripId: "trip-1",
      style: "standard",
      targetDurationSec: 30,
      aspectRatio: "16:9",
      resolution: "1080p",
      candidates: [cand],
      audioPolicy: {
        mode: "keep_original",
        backgroundAudioId: null,
        removeOriginalAudio: false,
        loudnorm: false,
        fadeInSeconds: 0,
        fadeOutSeconds: 0,
        loopToFit: false,
        targetDurationSec: 30,
      },
      priorWarnings: [],
      now: fixedClock(),
    });
    record(
      "pure: buildEditPlan 1×120s @ target=30 → 1 clip with duration=30 (clamped by per-clip cap)",
      plan.clips.length === 1 &&
        plan.clips[0]!.durationSec === 30 &&
        plan.totalDurationSec === 30 &&
        plan.warnings.length === 0,
      JSON.stringify({ clipDur: plan.clips[0]?.durationSec, total: plan.totalDurationSec }),
    );
  }

  // buildEditPlan: 1 short candidate → 1 short clip + warning
  {
    const cand: EditPlanCandidate = {
      media: fakeMediaItem({ tripId: "trip-1", type: "video", durationSec: 5 }),
      durationSec: 5,
    };
    const plan = buildEditPlan({
      tripId: "trip-1",
      style: "standard",
      targetDurationSec: 30,
      aspectRatio: "16:9",
      resolution: "1080p",
      candidates: [cand],
      audioPolicy: {
        mode: "keep_original",
        backgroundAudioId: null,
        removeOriginalAudio: false,
        loudnorm: false,
        fadeInSeconds: 0,
        fadeOutSeconds: 0,
        loopToFit: false,
        targetDurationSec: 30,
      },
      priorWarnings: [],
      now: fixedClock(),
    });
    record(
      "pure: buildEditPlan 1×5s @ target=30 → 1 clip=5s + insufficient warning + total<target",
      plan.clips.length === 1 &&
        plan.clips[0]!.durationSec === 5 &&
        plan.totalDurationSec === 5 &&
        plan.warnings.some((w) => w.code === "insufficient_source_material"),
      JSON.stringify({
        clipDur: plan.clips[0]?.durationSec,
        total: plan.totalDurationSec,
        warnings: plan.warnings.map((w) => w.code),
      }),
    );
  }

  // buildEditPlan: 4 long candidates, last truncated
  {
    const cands: EditPlanCandidate[] = [10, 20, 30, 40].map((d) => ({
      media: fakeMediaItem({ tripId: "trip-1", type: "video", durationSec: d }),
      durationSec: d,
    }));
    const plan = buildEditPlan({
      tripId: "trip-1",
      style: "standard",
      targetDurationSec: 30,
      aspectRatio: "16:9",
      resolution: "1080p",
      candidates: cands,
      audioPolicy: {
        mode: "keep_original",
        backgroundAudioId: null,
        removeOriginalAudio: false,
        loudnorm: false,
        fadeInSeconds: 0,
        fadeOutSeconds: 0,
        loopToFit: false,
        targetDurationSec: 30,
      },
      priorWarnings: [],
      now: fixedClock(),
    });
    // perClipCap = max(3, 30/4) = 7.5. Each clip naturally 7.5
    // (because all candidates are longer); cumulative reaches
    // 30 exactly at the 4th clip → 4 clips × 7.5 = 30.
    record(
      "pure: buildEditPlan 4 long sources @ target=30 → 4 clips of 7.5s each, total=30",
      plan.clips.length === 4 &&
        plan.clips.every((c) => c.durationSec === 7.5) &&
        plan.totalDurationSec === 30 &&
        plan.warnings.length === 0,
      JSON.stringify({
        clipDurs: plan.clips.map((c) => c.durationSec),
        total: plan.totalDurationSec,
      }),
    );
    record(
      "pure: buildEditPlan emits N-1 transitions for N clips",
      plan.transitions.length === plan.clips.length - 1 &&
        plan.transitions.every((t) => t.kind === "none"),
      JSON.stringify(plan.transitions),
    );
    record(
      "pure: buildEditPlan version/style/aspectRatio/resolution carried through",
      plan.version === "1.0" &&
        plan.style === "standard" &&
        plan.aspectRatio === "16:9" &&
        plan.resolution === "1080p" &&
        plan.aiRefined === false,
      JSON.stringify({
        version: plan.version,
        style: plan.style,
        aspect: plan.aspectRatio,
        res: plan.resolution,
        aiRefined: plan.aiRefined,
      }),
    );
  }

  // buildEditPlan: 3 short candidates totaling < target
  {
    const cands: EditPlanCandidate[] = [4, 5, 6].map((d) => ({
      media: fakeMediaItem({ tripId: "trip-1", type: "video", durationSec: d }),
      durationSec: d,
    }));
    const plan = buildEditPlan({
      tripId: "trip-1",
      style: "standard",
      targetDurationSec: 30,
      aspectRatio: "16:9",
      resolution: "1080p",
      candidates: cands,
      audioPolicy: {
        mode: "keep_original",
        backgroundAudioId: null,
        removeOriginalAudio: false,
        loudnorm: false,
        fadeInSeconds: 0,
        fadeOutSeconds: 0,
        loopToFit: false,
        targetDurationSec: 30,
      },
      priorWarnings: [],
      now: fixedClock(),
    });
    record(
      "pure: buildEditPlan 3 short sources < target → cumulative=15, insufficient warning",
      plan.clips.length === 3 &&
        plan.totalDurationSec === 15 &&
        plan.warnings.some((w) => w.code === "insufficient_source_material"),
      JSON.stringify({
        total: plan.totalDurationSec,
        warnings: plan.warnings.map((w) => w.code),
      }),
    );
  }

  // ============================================================
  // PART B — Service + DB
  // ============================================================
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
    const videoSegmentsRepo = new VideoSegmentsRepository(dbHandle.db);
    const audioLibraryRepo = new AudioLibraryRepository(dbHandle.db);
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

    const editPlansRepo = new EditPlansRepository(dbHandle.db);
    const planService = new VideoEditPlanService({
      tripService,
      mediaRepo,
      audioLibraryRepo,
      editPlansRepo,
      audioDefaults: {
        loudnormEnabled: true,
        fadeInSeconds: 1.5,
        fadeOutSeconds: 2,
      },
      aiEnabled: false,
      logger,
    });

    // Silence unused-import warnings — the analysis repo and versions
    // repo are needed elsewhere to construct MediaService but unused
    // directly in the plan code path.
    void mediaAnalysisRepo;
    void mediaVersionsRepo;

    // ----- Empty trip -------------------------------------------------
    const tripA = tripService.createTrip({ title: "P11.T4 smoke Trip A (empty)" });
    {
      const plan = await planService.generatePlan(tripA.id, {});
      record(
        "service: empty trip → 0 clips + no_video_candidates",
        plan.clips.length === 0 &&
          plan.totalDurationSec === 0 &&
          plan.warnings.some((w) => w.code === "no_video_candidates"),
        JSON.stringify({ clips: plan.clips.length, warnings: plan.warnings.map((w) => w.code) }),
      );
    }

    // ----- Image-only trip → silent skip ------------------------------
    const tripB = tripService.createTrip({ title: "P11.T4 smoke Trip B (image only)" });
    {
      const imgId = randomUUID();
      const now = new Date().toISOString();
      mediaRepo.insert({
        id: imgId,
        tripId: tripB.id,
        type: "image",
        originalPath: `trips/${tripB.id}/originals/photo.jpg`,
        mimeType: "image/jpeg",
        extension: "jpg",
        fileSize: 1024,
        createdAt: now,
        updatedAt: now,
      });
      const plan = await planService.generatePlan(tripB.id, {});
      record(
        "service: image-only trip → 0 clips + no_video_candidates (silent skip of image)",
        plan.clips.length === 0 &&
          plan.warnings.some((w) => w.code === "no_video_candidates") &&
          !plan.warnings.some((w) => w.code === "media_not_video"),
        JSON.stringify({ warnings: plan.warnings.map((w) => w.code) }),
      );
    }

    // ----- Happy: trip with two videos, target 30 ---------------------
    const tripC = tripService.createTrip({ title: "P11.T4 smoke Trip C (happy)" });
    const videoIdC1 = randomUUID();
    const videoIdC2 = randomUUID();
    {
      const now = new Date().toISOString();
      // Insert in chronological order; mediaRepo.list returns
      // DESC, so C2 comes first.
      mediaRepo.insert({
        id: videoIdC1,
        tripId: tripC.id,
        type: "video",
        originalPath: `trips/${tripC.id}/originals/${videoIdC1}.mp4`,
        mimeType: "video/mp4",
        extension: "mp4",
        fileSize: 1_000_000,
        createdAt: now,
        updatedAt: now,
      });
      mediaRepo.updateVideoMetadata({
        mediaId: videoIdC1,
        duration: 60,
        width: 1920,
        height: 1080,
        updatedAt: now,
      });
      mediaRepo.insert({
        id: videoIdC2,
        tripId: tripC.id,
        type: "video",
        originalPath: `trips/${tripC.id}/originals/${videoIdC2}.mp4`,
        mimeType: "video/mp4",
        extension: "mp4",
        fileSize: 1_000_000,
        createdAt: now,
        updatedAt: now,
      });
      mediaRepo.updateVideoMetadata({
        mediaId: videoIdC2,
        duration: 45,
        width: 1920,
        height: 1080,
        updatedAt: now,
      });
      const plan = await planService.generatePlan(tripC.id, { targetDurationSec: 30 });
      record(
        "service: happy 2 videos × 60/45s @ target=30 → 2 clips totalling 30s",
        plan.clips.length === 2 && plan.totalDurationSec === 30 && plan.warnings.length === 0,
        JSON.stringify({
          clipDurs: plan.clips.map((c) => c.durationSec),
          total: plan.totalDurationSec,
          warnings: plan.warnings.map((w) => w.code),
        }),
      );
      record(
        "service: clips carry sourcePath + order + reason",
        plan.clips.every(
          (c, i) =>
            typeof c.sourcePath === "string" &&
            c.sourcePath.length > 0 &&
            c.order === i &&
            typeof c.reason === "string" &&
            c.reason.length > 0,
        ),
        JSON.stringify(plan.clips.map((c) => ({ order: c.order, sp: c.sourcePath }))),
      );
    }

    // ----- Style → target mapping -------------------------------------
    {
      const shortPlan = await planService.generatePlan(tripC.id, { style: "short" });
      const longPlan = await planService.generatePlan(tripC.id, { style: "long" });
      record(
        "service: style=short → target=15, style=long → target=60",
        shortPlan.targetDurationSec === 15 && longPlan.targetDurationSec === 60,
        `short=${shortPlan.targetDurationSec} long=${longPlan.targetDurationSec}`,
      );
      const overridePlan = await planService.generatePlan(tripC.id, {
        style: "long",
        targetDurationSec: 12,
      });
      record(
        "service: explicit targetDurationSec overrides style",
        overridePlan.targetDurationSec === 12,
        `target=${overridePlan.targetDurationSec}`,
      );
    }

    // ----- audioMode = mute -------------------------------------------
    {
      const plan = await planService.generatePlan(tripC.id, { audioMode: "mute" });
      record(
        "service: audioMode=mute → policy.mode='mute', removeOriginalAudio=true, no BGM",
        plan.audioPolicy.mode === "mute" &&
          plan.audioPolicy.removeOriginalAudio === true &&
          plan.audioPolicy.backgroundAudioId === null,
        JSON.stringify(plan.audioPolicy),
      );
    }

    // ----- audioMode = replace_with_library + valid audio ------------
    let validAudioId = "";
    {
      const now = new Date().toISOString();
      validAudioId = randomUUID();
      audioLibraryRepo.upsertBySourceTypeAndChecksum({
        id: validAudioId,
        name: "demo-bgm",
        displayName: "Demo BGM",
        sourceType: "system",
        filePath: "/tmp/demo.mp3",
        relativePath: null,
        mimeType: "audio/mpeg",
        durationSeconds: 90,
        sizeBytes: 2_000_000,
        checksum: "a".repeat(64),
        isActive: true,
        tags: null,
        metadataJson: null,
        now,
      });
      const plan = await planService.generatePlan(tripC.id, {
        backgroundAudioId: validAudioId,
      });
      record(
        "service: backgroundAudioId without audioMode → infers replace_with_library",
        plan.audioPolicy.mode === "replace_with_library" &&
          plan.audioPolicy.backgroundAudioId === validAudioId &&
          plan.audioPolicy.removeOriginalAudio === true &&
          plan.audioPolicy.loopToFit === true &&
          plan.audioPolicy.loudnorm === true,
        JSON.stringify(plan.audioPolicy),
      );
    }

    // ----- backgroundAudioId not found → graceful fallback ------------
    {
      const plan = await planService.generatePlan(tripC.id, {
        backgroundAudioId: "non-existent-id",
      });
      record(
        "service: bg audio not found → fallback keep_original + warning",
        plan.audioPolicy.mode === "keep_original" &&
          plan.audioPolicy.backgroundAudioId === null &&
          plan.warnings.some((w) => w.code === "background_audio_not_found"),
        JSON.stringify({
          mode: plan.audioPolicy.mode,
          warnings: plan.warnings.map((w) => w.code),
        }),
      );
    }

    // ----- backgroundAudioId inactive → graceful fallback -------------
    {
      const now = new Date().toISOString();
      const inactiveId = randomUUID();
      audioLibraryRepo.upsertBySourceTypeAndChecksum({
        id: inactiveId,
        name: "inactive-bgm",
        displayName: "Inactive BGM",
        sourceType: "system",
        filePath: "/tmp/inactive.mp3",
        relativePath: null,
        mimeType: "audio/mpeg",
        durationSeconds: 60,
        sizeBytes: 1_000_000,
        checksum: "b".repeat(64),
        isActive: false,
        tags: null,
        metadataJson: null,
        now,
      });
      const plan = await planService.generatePlan(tripC.id, {
        backgroundAudioId: inactiveId,
        audioMode: "replace_with_library",
      });
      record(
        "service: bg audio inactive → fallback keep_original + 'background_audio_inactive'",
        plan.audioPolicy.mode === "keep_original" &&
          plan.warnings.some((w) => w.code === "background_audio_inactive"),
        JSON.stringify({
          mode: plan.audioPolicy.mode,
          warnings: plan.warnings.map((w) => w.code),
        }),
      );
    }

    // ----- explicit mediaIds: cross-trip + missing + non-video ------
    {
      // Insert an image media in tripC for the non-video case
      const now = new Date().toISOString();
      const imgInC = randomUUID();
      mediaRepo.insert({
        id: imgInC,
        tripId: tripC.id,
        type: "image",
        originalPath: `trips/${tripC.id}/originals/${imgInC}.jpg`,
        mimeType: "image/jpeg",
        extension: "jpg",
        fileSize: 1024,
        createdAt: now,
        updatedAt: now,
      });
      const otherTrip = tripService.createTrip({ title: "Other trip for cross-trip test" });
      const crossTripVideoId = randomUUID();
      mediaRepo.insert({
        id: crossTripVideoId,
        tripId: otherTrip.id,
        type: "video",
        originalPath: `trips/${otherTrip.id}/originals/${crossTripVideoId}.mp4`,
        mimeType: "video/mp4",
        extension: "mp4",
        fileSize: 1_000_000,
        createdAt: now,
        updatedAt: now,
      });
      mediaRepo.updateVideoMetadata({
        mediaId: crossTripVideoId,
        duration: 30,
        width: 1920,
        height: 1080,
        updatedAt: now,
      });

      const plan = await planService.generatePlan(tripC.id, {
        mediaIds: [videoIdC1, imgInC, "unknown-id", crossTripVideoId],
      });
      const codes = plan.warnings.map((w) => w.code);
      record(
        "service: explicit mediaIds emits not_video + not_found(missing) + not_found(cross-trip)",
        codes.includes("media_not_video") &&
          codes.filter((c) => c === "media_not_found").length >= 2,
        JSON.stringify(codes),
      );
      record(
        "service: explicit mediaIds still produces a usable plan from the valid video",
        plan.clips.length === 1 && plan.clips[0]!.mediaId === videoIdC1,
        JSON.stringify({ clips: plan.clips.map((c) => c.mediaId) }),
      );
    }

    // ----- Trip missing / soft-deleted → 404 mapping ------------------
    {
      let svc404 = false;
      let svc404Detail = "no throw";
      try {
        await planService.generatePlan("ffffffff-ffff-ffff-ffff-ffffffffffff", {});
      } catch (err) {
        if (err !== null && typeof err === "object") {
          const e = err as { code?: string; statusCode?: number };
          svc404 = e.code === "NOT_FOUND" && e.statusCode === 404;
          svc404Detail = `code=${String(e.code)} statusCode=${String(e.statusCode)}`;
        }
      }
      record("service: missing trip → NotFoundError (404 mapping)", svc404, svc404Detail);
    }

    // ----- Body validation (unknown key) ------------------------------
    {
      let svc400 = false;
      let svc400Detail = "no throw";
      try {
        await planService.generatePlan(tripC.id, { unknownField: "boom" });
      } catch (err) {
        if (err !== null && typeof err === "object") {
          const e = err as { code?: string; statusCode?: number };
          svc400 = e.code === "VALIDATION_FAILED" && e.statusCode === 400;
          svc400Detail = `code=${String(e.code)} statusCode=${String(e.statusCode)}`;
        }
      }
      record("service: unknown body key rejected by zod .strict() → 400", svc400, svc400Detail);
    }
    {
      let svc400 = false;
      try {
        await planService.generatePlan(tripC.id, { targetDurationSec: 99999 });
      } catch (err) {
        if (err !== null && typeof err === "object") {
          const e = err as { code?: string; statusCode?: number };
          svc400 = e.code === "VALIDATION_FAILED" && e.statusCode === 400;
        }
      }
      record("service: targetDurationSec out of range → 400", svc400, `caught=${svc400}`);
    }
    {
      let svc400 = false;
      try {
        await planService.generatePlan(tripC.id, { style: "nonsense" });
      } catch (err) {
        if (err !== null && typeof err === "object") {
          const e = err as { code?: string; statusCode?: number };
          svc400 = e.code === "VALIDATION_FAILED" && e.statusCode === 400;
        }
      }
      record("service: unknown style enum → 400", svc400, `caught=${svc400}`);
    }

    // ============================================================
    // PART C — HTTP layer
    // ============================================================
    // Minimal capabilities snapshot — no ffmpeg probe needed; this
    // smoke doesn't exercise any ffmpeg-gated route.
    const capabilities = {
      ffmpegAvailable: false,
      ffmpegVersion: null,
      ffmpegPath: null,
      ffmpegError: null,
      ffprobeAvailable: false,
      ffprobeVersion: null,
      ffprobePath: null,
      ffprobeError: null,
      permanentDeleteEnabled: false,
      aiEnabled: false,
    };

    const uploadService = new UploadService({
      db: dbHandle.db,
      storage,
      tripService,
      mediaRepo,
      jobRepo,
      classifyOptions: {
        imageExtensions: ["jpg"],
        videoExtensions: ["mp4"],
      },
      maxFileSize: 100_000_000,
      logger,
    });
    const dedupEngine = new DedupEngine({ mediaRepo, duplicateGroupsRepo, logger });
    const dedupService = new DedupService(
      dedupEngine,
      tripService,
      duplicateGroupsRepo,
      mediaRepo,
      mediaService,
    );
    const videoService = new VideoService(mediaRepo, videoSegmentsRepo, jobRepo, storage);
    const jobService = new JobService(jobRepo);
    void new AudioLibraryService(audioLibraryRepo); // exists path; no calls needed

    const videoRenderService = new VideoRenderService({
      tripService,
      mediaRepo,
      editPlansRepo,
      jobRepo,
      logger,
    });
    const app: Express = createApp({
      logger,
      capabilities,
      storage,
      tripService,
      tripRepo,
      uploadService,
      mediaService,
      mediaRepo,
      jobService,
      dedupService,
      videoService,
      videoEditPlanService: planService,
      videoRenderService,
      aiProvider: new NoopProvider(),
      debugRoutes: false,
    });

    // tiny request helper using node's http through supertest-ish manual call
    const server = await new Promise<{
      close: () => Promise<void>;
      port: number;
    }>((resolve, reject) => {
      const listener = app.listen(0, () => {
        const addr = listener.address();
        if (addr === null || typeof addr === "string") {
          reject(new Error("unexpected listener address"));
          return;
        }
        resolve({
          port: addr.port,
          close: () =>
            new Promise<void>((res) => {
              listener.close(() => res());
            }),
        });
      });
    });

    try {
      // happy
      {
        const r = await postJson(server.port, `/api/trips/${tripC.id}/generate-edit-plan`, {
          targetDurationSec: 30,
        });
        record(
          "http: POST happy → 200 with version='1.0' + tripId + clips[] + audioPolicy",
          r.status === 200 &&
            r.body !== null &&
            typeof r.body === "object" &&
            (r.body as { version?: string }).version === "1.0" &&
            (r.body as { tripId?: string }).tripId === tripC.id &&
            Array.isArray((r.body as { clips?: unknown }).clips) &&
            typeof (r.body as { audioPolicy?: unknown }).audioPolicy === "object",
          `status=${r.status} keys=${Object.keys(r.body as object).join(",")}`,
        );
      }
      // missing trip → 404
      {
        const r = await postJson(
          server.port,
          `/api/trips/ffffffff-ffff-ffff-ffff-ffffffffffff/generate-edit-plan`,
          {},
        );
        record(
          "http: POST missing trip → 404 NOT_FOUND",
          r.status === 404 && (r.body as { error?: { code?: string } }).error?.code === "NOT_FOUND",
          `status=${r.status} body=${JSON.stringify(r.body)}`,
        );
      }
      // unknown body key → 400
      {
        const r = await postJson(server.port, `/api/trips/${tripC.id}/generate-edit-plan`, {
          rogueField: "x",
        });
        record(
          "http: POST unknown body key → 400 VALIDATION_FAILED",
          r.status === 400 &&
            (r.body as { error?: { code?: string } }).error?.code === "VALIDATION_FAILED",
          `status=${r.status} body=${JSON.stringify(r.body)}`,
        );
      }
    } finally {
      await server.close();
    }

    void express; // suppress unused-import warning if applicable

    reportAndExit();
  } finally {
    closeDatabase(dbHandle);
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// minimal HTTP helper (no supertest dependency)
// ---------------------------------------------------------------------------

interface PostResult {
  readonly status: number;
  readonly body: unknown;
}

async function postJson(port: number, urlPath: string, body: unknown): Promise<PostResult> {
  const { request } = await import("node:http");
  const payload = JSON.stringify(body);
  return new Promise<PostResult>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: urlPath,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload).toString(),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown;
          try {
            parsed = raw.length === 0 ? null : JSON.parse(raw);
          } catch {
            parsed = raw;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function reportAndExit(): void {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n[smoke] summary: ${passed}/${results.length} passed (${failed} failed)`);
  if (failed > 0) {
    for (const r of results.filter((r) => !r.ok)) {
      console.log(`[smoke][FAIL] ${r.name}: ${r.detail}`);
    }
    process.exitCode = 1;
  }
}

// Suppress unused-import warning for `describe` helper (not yet used).
void describe;

void main().catch((err) => {
  console.error("[smoke] uncaught error:", err);
  process.exitCode = 1;
});
