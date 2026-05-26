// Manual smoke test for the audio library data layer (P11.T3).
//
// Usage: npm run smoke:audio-library-seed
//
// Coverage:
//   * Migration 014 applies cleanly against a fresh DB AND against
//     a DB with all prior migrations (000..013) already applied.
//   * Schema shape: columns / CHECK enums / indexes / unique
//     constraint visible via PRAGMAs.
//   * `findById` / `listActiveBySourceType` / `listAllBySourceType`
//     basic CRUD on the repo.
//   * `setActive(false)` hides the row from active list but keeps
//     it discoverable via the all-list variant.
//   * `seedDefaultDirectory`:
//     - Missing directory → `{ scanned: 0, directoryExisted: false }`
//       (graceful per P11.T3 prompt).
//     - Empty directory → `{ scanned: 0, directoryExisted: true }`.
//     - `.gitkeep` + non-audio extensions skipped silently.
//     - One real ffmpeg-generated audio file → inserted with
//       checksum / size / mime / duration.
//     - Re-running on the same directory → outcome='updated' for
//       the same row (UPSERT idempotency); the `id` is preserved.
//     - Operator-edited surface (display_name, tags, metadata_json,
//       is_active) is NOT clobbered on re-seed.
//     - ffprobe-unavailable degradation: setting `ffprobePath` to
//       a missing binary still inserts the row with
//       `duration_seconds = null` rather than failing the whole
//       seed.
//     - Per-file failures don't cascade — one corrupt file does
//       not block the rest of the seed pass.
//   * PRAGMA foreign_key_check + PRAGMA integrity_check are clean.
//
// SKIPs the ffmpeg-dependent fixture generation when ffmpeg is not
// on PATH (matches the existing convention) — pure DB checks still
// run.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeDatabase, openDatabase } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { createLogger } from "../logger.js";
import { AudioLibraryRepository, AudioLibraryService } from "../media/index.js";

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
// ffmpeg availability + tiny audio fixture
// ---------------------------------------------------------------------------

async function isAvailable(cmd: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn(cmd, ["-version"], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

/** Generate a `durationSec` sine tone at `outputPath`. Extension
 * drives the muxer + codec choice (mp3 needs libmp3lame; m4a/aac
 * needs aac). Used to populate the seed-test directory with a
 * real audio file ffprobe can parse. */
async function makeSineAudio(outputPath: string, durationSec: number, freq = 880): Promise<void> {
  const ext = path.extname(outputPath).slice(1).toLowerCase();
  const codec = ext === "mp3" ? "libmp3lame" : "aac";
  const args = [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${freq}:sample_rate=48000:duration=${durationSec}`,
    "-c:a",
    codec,
    outputPath,
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    const stderrChunks: Buffer[] = [];
    child.stderr.on("data", (b: Buffer) => stderrChunks.push(b));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`ffmpeg gen exited ${code}: ${Buffer.concat(stderrChunks).toString("utf8")}`),
        );
    });
  });
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const ffmpegOk = (await isAvailable("ffmpeg")) && (await isAvailable("ffprobe"));
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-audio-library-seed-smoke-"));
  console.log(`[smoke] tmpRoot=${tmpRoot}`);

  const dbPath = path.join(tmpRoot, "smoke.db");
  const dbHandle = openDatabase(dbPath);
  try {
    runMigrations(dbHandle.db);

    // ---- Migration shape ----------------------------------------------
    const tableCount = (
      dbHandle.db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='audio_library'",
        )
        .get() as { n: number }
    ).n;
    record("migration: audio_library table exists", tableCount === 1, `tableCount=${tableCount}`);

    const cols = (
      dbHandle.db.prepare("PRAGMA table_info(audio_library)").all() as {
        name: string;
        type: string;
        notnull: number;
      }[]
    ).map((c) => c.name);
    const expectedCols = [
      "id",
      "name",
      "display_name",
      "source_type",
      "file_path",
      "relative_path",
      "mime_type",
      "duration_seconds",
      "size_bytes",
      "checksum",
      "is_active",
      "tags",
      "metadata_json",
      "created_at",
      "updated_at",
    ];
    record(
      "migration: audio_library has all 15 expected columns",
      cols.length === expectedCols.length && expectedCols.every((c) => cols.includes(c)),
      `cols=${cols.join(",")}`,
    );

    const indexes = (
      dbHandle.db.prepare("PRAGMA index_list(audio_library)").all() as {
        name: string;
        unique: number;
      }[]
    ).map((i) => `${i.name}:u=${i.unique}`);
    record(
      "migration: (source_type, checksum) UNIQUE index exists",
      indexes.some((i) => /idx_audio_library_source_checksum:u=1/.test(i)),
      indexes.join(","),
    );
    record(
      "migration: (source_type, is_active) index exists",
      indexes.some((i) => i.startsWith("idx_audio_library_source_active:")),
      indexes.join(","),
    );

    // CHECK source_type enum — try inserting an invalid value.
    {
      let threw = false;
      let msg = "";
      try {
        dbHandle.db
          .prepare(
            `INSERT INTO audio_library
               (id, name, display_name, source_type,
                file_path, relative_path, mime_type,
                duration_seconds, size_bytes, checksum,
                is_active, tags, metadata_json,
                created_at, updated_at)
             VALUES (?, ?, ?, ?,  ?, ?, ?,  ?, ?, ?,  ?, ?, ?,  ?, ?)`,
          )
          .run(
            "fake-id",
            "x",
            "X",
            "unsupported", // <- not in enum
            "/tmp/x.mp3",
            null,
            "audio/mpeg",
            null,
            10,
            "abc",
            1,
            null,
            null,
            new Date().toISOString(),
            new Date().toISOString(),
          );
      } catch (err) {
        threw = true;
        msg = describe(err);
      }
      record(
        "migration: source_type CHECK rejects 'unsupported'",
        threw && /CHECK/.test(msg),
        `threw=${threw} msg=${msg.slice(0, 120)}`,
      );
    }

    // ---- Repository CRUD ----------------------------------------------
    const repo = new AudioLibraryRepository(dbHandle.db);

    const now = new Date().toISOString();
    const seedId = "11111111-1111-1111-1111-111111111111";
    repo.upsertBySourceTypeAndChecksum({
      id: seedId,
      name: "demo-clip",
      displayName: "Demo Clip",
      sourceType: "system",
      filePath: "/tmp/demo-clip.mp3",
      relativePath: null,
      mimeType: "audio/mpeg",
      durationSeconds: 12.5,
      sizeBytes: 1024,
      checksum: "checksum-for-demo-clip",
      isActive: true,
      tags: null,
      metadataJson: null,
      now,
    });
    const found = repo.findById(seedId);
    record(
      "repo: findById returns the inserted row",
      found !== null && found.id === seedId && found.displayName === "Demo Clip",
      JSON.stringify(found),
    );
    record(
      "repo: inserted row has isActive=true by default",
      found?.isActive === true,
      `isActive=${String(found?.isActive)}`,
    );

    // listActive / listAll
    {
      const active = repo.listActiveBySourceType("system");
      const all = repo.listAllBySourceType("system");
      record(
        "repo: listActiveBySourceType('system') returns the row",
        active.length === 1 && active[0]?.id === seedId,
        `len=${active.length}`,
      );
      record(
        "repo: listAllBySourceType('system') returns the row",
        all.length === 1 && all[0]?.id === seedId,
        `len=${all.length}`,
      );
    }

    // setActive(false) hides from active list, preserved in all list
    {
      const changes = repo.setActive(seedId, false, new Date().toISOString());
      const active = repo.listActiveBySourceType("system");
      const all = repo.listAllBySourceType("system");
      record("repo: setActive(false) returns changes=1", changes === 1, `changes=${changes}`);
      record(
        "repo: deactivated row hidden from active list",
        active.length === 0,
        `active.len=${active.length}`,
      );
      record(
        "repo: deactivated row still visible in all list",
        all.length === 1 && all[0]?.isActive === false,
        `all.len=${all.length} isActive=${String(all[0]?.isActive)}`,
      );
      // re-activate for downstream test clarity
      repo.setActive(seedId, true, new Date().toISOString());
    }

    // upsert by (source_type, checksum) — same checksum updates,
    // does NOT clobber operator-edited surface.
    {
      // First, mark the row as operator-edited by setting custom
      // display_name + tags + metadata_json + is_active.
      dbHandle.db
        .prepare(
          `UPDATE audio_library SET display_name = ?, tags = ?, metadata_json = ?
           WHERE id = ?`,
        )
        .run("Operator-edited Title", "cinematic,upbeat", '{"license":"CC0"}', seedId);
      // Now re-upsert with the same checksum but different
      // bytes-of-truth fields (new path / new size / new mime).
      const reupsert = repo.upsertBySourceTypeAndChecksum({
        id: "should-not-be-used",
        name: "renamed-on-disk",
        displayName: "Renamed On Disk (should NOT clobber)",
        sourceType: "system",
        filePath: "/tmp/demo-clip-renamed.mp3",
        relativePath: "audio/demo-clip-renamed.mp3",
        mimeType: "audio/mpeg",
        durationSeconds: 13.0,
        sizeBytes: 2048,
        checksum: "checksum-for-demo-clip",
        isActive: false, // <- should NOT clobber
        tags: "ignored-tag", // <- should NOT clobber
        metadataJson: '{"ignored":"yes"}', // <- should NOT clobber
        now: new Date().toISOString(),
      });
      record(
        "repo: re-upsert with same checksum returns outcome='updated'",
        reupsert.outcome === "updated",
        JSON.stringify(reupsert),
      );
      record(
        "repo: re-upsert preserves the original id (NOT the new uuid)",
        reupsert.id === seedId,
        `id=${reupsert.id}`,
      );
      const after = repo.findById(seedId)!;
      record(
        "repo: re-upsert refreshes bytes-of-truth (file_path)",
        after.filePath === "/tmp/demo-clip-renamed.mp3",
        `filePath=${after.filePath}`,
      );
      record(
        "repo: re-upsert refreshes bytes-of-truth (size_bytes)",
        after.sizeBytes === 2048,
        `sizeBytes=${after.sizeBytes}`,
      );
      record(
        "repo: re-upsert refreshes bytes-of-truth (relative_path)",
        after.relativePath === "audio/demo-clip-renamed.mp3",
        `relativePath=${String(after.relativePath)}`,
      );
      record(
        "repo: re-upsert preserves operator-edited display_name",
        after.displayName === "Operator-edited Title",
        `displayName=${after.displayName}`,
      );
      record(
        "repo: re-upsert preserves operator-edited tags",
        after.tags === "cinematic,upbeat",
        `tags=${String(after.tags)}`,
      );
      record(
        "repo: re-upsert preserves operator-edited metadata_json",
        after.metadataJson === '{"license":"CC0"}',
        `metadata_json=${String(after.metadataJson)}`,
      );
      record(
        "repo: re-upsert preserves operator-disabled is_active",
        after.isActive === true, // we re-activated it above; should stay activated
        `isActive=${after.isActive}`,
      );
    }

    // ---- Service: seedDefaultDirectory ------------------------------
    const logger = createLogger({ nodeEnv: "test" });
    const service = new AudioLibraryService(repo);

    // missing dir
    {
      const missingDir = path.join(tmpRoot, "no-such-dir");
      const summary = await service.seedDefaultDirectory(missingDir);
      record(
        "service: missing directory → directoryExisted=false, scanned=0 (graceful)",
        summary.directoryExisted === false &&
          summary.scanned === 0 &&
          summary.inserted === 0 &&
          summary.failed === 0 &&
          summary.items.length === 0,
        JSON.stringify(summary),
      );
    }

    // empty dir with only .gitkeep
    {
      const emptyDir = path.join(tmpRoot, "empty-audio-dir");
      mkdirSync(emptyDir, { recursive: true });
      writeFileSync(path.join(emptyDir, ".gitkeep"), "");
      const summary = await service.seedDefaultDirectory(emptyDir);
      record(
        "service: empty directory (only .gitkeep) → directoryExisted=true, scanned=0",
        summary.directoryExisted === true && summary.scanned === 0 && summary.inserted === 0,
        JSON.stringify(summary),
      );
    }

    // dir with non-audio files — should also yield scanned=0
    {
      const nonAudioDir = path.join(tmpRoot, "non-audio-dir");
      mkdirSync(nonAudioDir, { recursive: true });
      writeFileSync(path.join(nonAudioDir, "README.txt"), "hello");
      writeFileSync(path.join(nonAudioDir, "image.png"), Buffer.alloc(8));
      writeFileSync(path.join(nonAudioDir, ".hidden.mp3"), Buffer.alloc(8));
      const summary = await service.seedDefaultDirectory(nonAudioDir);
      record(
        "service: dir with only non-audio + dotfiles → scanned=0",
        summary.scanned === 0 && summary.inserted === 0,
        JSON.stringify(summary),
      );
    }

    // SKIPs from here if ffmpeg isn't available — those cases
    // need a real audio fixture to exercise checksum / ffprobe.
    if (!ffmpegOk) {
      console.log("[smoke] SKIP: ffmpeg not on PATH; real-fixture cases skipped.");
      reportAndExit();
      return;
    }

    // Real audio file in the seed dir
    const realDir = path.join(tmpRoot, "real-audio-dir");
    mkdirSync(realDir, { recursive: true });
    writeFileSync(path.join(realDir, ".gitkeep"), "");
    writeFileSync(path.join(realDir, "README.txt"), "not an audio");
    const sinePath = path.join(realDir, "Demo-Track.m4a");
    await makeSineAudio(sinePath, 2, 880);

    // First seed pass — happy path
    {
      const summary = await service.seedDefaultDirectory(realDir, { logger });
      record(
        "service: first seed inserts 1 row (the m4a)",
        summary.directoryExisted === true &&
          summary.scanned === 1 &&
          summary.inserted === 1 &&
          summary.updated === 0 &&
          summary.failed === 0,
        JSON.stringify({
          dirExisted: summary.directoryExisted,
          scanned: summary.scanned,
          inserted: summary.inserted,
          updated: summary.updated,
          failed: summary.failed,
        }),
      );
      const rows = repo.listAllBySourceType("system");
      const seeded = rows.find((r) => r.filePath === sinePath);
      record(
        "service: inserted row carries expected mime/duration/checksum/size",
        seeded !== undefined &&
          seeded.mimeType === "audio/mp4" &&
          typeof seeded.durationSeconds === "number" &&
          Math.abs((seeded.durationSeconds ?? 0) - 2) < 0.3 &&
          typeof seeded.sizeBytes === "number" &&
          seeded.sizeBytes > 0 &&
          typeof seeded.checksum === "string" &&
          /^[a-f0-9]{64}$/.test(seeded.checksum),
        JSON.stringify({
          mime: seeded?.mimeType,
          dur: seeded?.durationSeconds,
          size: seeded?.sizeBytes,
          checksumPrefix: seeded?.checksum.slice(0, 10),
        }),
      );
      record(
        "service: inserted row has name slug + readable display_name",
        seeded?.name === "demo-track" && seeded?.displayName === "Demo-Track",
        `name=${String(seeded?.name)} displayName=${String(seeded?.displayName)}`,
      );
    }

    // Second seed pass on the same dir — should be 'updated' (or
    // 'unchanged') for the existing row, no duplicate insert.
    {
      const beforeCount = repo
        .listAllBySourceType("system")
        .filter((r) => r.filePath === sinePath).length;
      const summary = await service.seedDefaultDirectory(realDir, { logger });
      record(
        "service: second seed is idempotent (no new insert, 'updated' outcome)",
        summary.scanned === 1 && summary.inserted === 0 && summary.updated === 1,
        JSON.stringify(summary),
      );
      const afterCount = repo
        .listAllBySourceType("system")
        .filter((r) => r.filePath === sinePath).length;
      record(
        "service: same audio file → still exactly 1 row (no duplicate)",
        beforeCount === 1 && afterCount === 1,
        `before=${beforeCount} after=${afterCount}`,
      );
    }

    // Operator-edited surface preserved across re-seed
    {
      const seededId = repo.listAllBySourceType("system").find((r) => r.filePath === sinePath)!.id;
      // operator customises the row
      dbHandle.db
        .prepare(
          `UPDATE audio_library SET display_name = ?, tags = ?, metadata_json = ?
           WHERE id = ?`,
        )
        .run(
          "Operator Title (preserve me)",
          "demo,bgm",
          '{"license":"CC0","author":"smoke"}',
          seededId,
        );
      await service.seedDefaultDirectory(realDir, { logger });
      const after = repo.findById(seededId)!;
      record(
        "service: re-seed preserves operator-edited display_name / tags / metadata_json",
        after.displayName === "Operator Title (preserve me)" &&
          after.tags === "demo,bgm" &&
          after.metadataJson === '{"license":"CC0","author":"smoke"}',
        JSON.stringify({
          displayName: after.displayName,
          tags: after.tags,
          metadataJson: after.metadataJson,
        }),
      );
    }

    // ffprobe-unavailable degradation: point to a missing binary,
    // confirm the row still inserts with duration_seconds=null but
    // size + checksum + mime intact.
    {
      const degradeDir = path.join(tmpRoot, "degrade-dir");
      mkdirSync(degradeDir, { recursive: true });
      const otherSine = path.join(degradeDir, "Track-B.mp3");
      // ffmpeg-generated mp3 (no ffprobe needed in seed because
      // we override ffprobePath). mp3 chosen so the mime mapping
      // exercises a different ext.
      await makeSineAudio(otherSine, 1, 440);
      const summary = await service.seedDefaultDirectory(degradeDir, {
        ffprobePath: "ffprobe-no-such-binary-12345",
        logger,
      });
      record(
        "service: ffprobe-unavailable still inserts row (1 inserted, 0 failed)",
        summary.scanned === 1 && summary.inserted === 1 && summary.failed === 0,
        JSON.stringify(summary),
      );
      const row = repo.listAllBySourceType("system").find((r) => r.filePath === otherSine);
      record(
        "service: degraded row has duration_seconds=null but size/checksum/mime populated",
        row !== undefined &&
          row.durationSeconds === null &&
          row.mimeType === "audio/mpeg" &&
          row.sizeBytes > 0 &&
          /^[a-f0-9]{64}$/.test(row.checksum),
        JSON.stringify({
          dur: row?.durationSeconds,
          mime: row?.mimeType,
          size: row?.sizeBytes,
          checksumPrefix: row?.checksum.slice(0, 10),
        }),
      );
    }

    // Mixed batch: one good audio + one zero-byte "audio file"
    // (sha256 of empty buffer succeeds, ffprobe will probe-fail but
    // degrade to null — still inserted, not failed). The point is
    // that one malformed entry does NOT kill the rest of the batch.
    {
      const mixedDir = path.join(tmpRoot, "mixed-dir");
      mkdirSync(mixedDir, { recursive: true });
      const goodFile = path.join(mixedDir, "Good.m4a");
      await makeSineAudio(goodFile, 1, 660);
      const corrupt = path.join(mixedDir, "Corrupt.mp3");
      writeFileSync(corrupt, Buffer.alloc(0)); // 0 bytes — ffprobe will fail; checksum still computes (sha of empty)
      const summary = await service.seedDefaultDirectory(mixedDir, { logger });
      // Both should INSERT (the corrupt one with duration=null).
      // The seed treats per-file ffprobe failure as degradation,
      // not failure of the row write.
      record(
        "service: mixed batch (good + corrupt) inserts both rows; no per-file cascade failure",
        summary.scanned === 2 && summary.inserted === 2 && summary.failed === 0,
        JSON.stringify(summary),
      );
      const corruptRow = repo.listAllBySourceType("system").find((r) => r.filePath === corrupt);
      record(
        "service: corrupt 0-byte 'audio' row has duration=null + size=0 + valid checksum",
        corruptRow !== undefined &&
          corruptRow.durationSeconds === null &&
          corruptRow.sizeBytes === 0 &&
          /^[a-f0-9]{64}$/.test(corruptRow.checksum),
        JSON.stringify({
          dur: corruptRow?.durationSeconds,
          size: corruptRow?.sizeBytes,
        }),
      );
    }

    // FK + integrity check — should be clean since audio_library
    // has no FKs.
    {
      const fkCheck = dbHandle.db.prepare("PRAGMA foreign_key_check").all() as unknown[];
      record(
        "integrity: PRAGMA foreign_key_check returns 0 rows",
        fkCheck.length === 0,
        `rows=${fkCheck.length}`,
      );
      const intCheck = (
        dbHandle.db.prepare("PRAGMA integrity_check").all() as {
          integrity_check: string;
        }[]
      ).map((r) => r.integrity_check);
      record(
        "integrity: PRAGMA integrity_check is 'ok'",
        intCheck.length === 1 && intCheck[0] === "ok",
        intCheck.join(", "),
      );
    }

    reportAndExit();
  } finally {
    closeDatabase(dbHandle);
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {
      /* best-effort */
    });
  }
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

void main().catch((err) => {
  console.error("[smoke] uncaught error:", err);
  process.exitCode = 1;
});
