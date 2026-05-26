// Manual smoke test for the audio processor toolkit (P11.T2).
//
// Usage: npm run smoke:audio-processor
//
// Two layers of coverage:
//
//   A) Pure filter builders (NO ffmpeg required):
//      * buildAtrimFilter — valid combinations + rejection of empty / negative input
//      * buildAfadeFilter — in-only / out-only / both / disabled / clamp to ≥ 0
//      * buildLoudnormFilter — produces the expected `loudnorm=I=…:TP=…:LRA=…` form
//      * joinAfChain — null when all empty, joined otherwise
//      * findDefaultAudioCandidates — missing dir → [], empty → [], mixed → audio only
//      * prepareBackgroundMusic — input validation rejects ≤ 0 / non-finite duration
//        BEFORE spawning ffmpeg (the critical infinite-loop guard)
//
//   B) End-to-end ffmpeg runners (SKIP if ffmpeg / ffprobe missing):
//      * stripAudio — input video with audio → output video with no audio track
//      * prepareBackgroundMusic — 2s sine → 4s target (loop) and → 1s target (trim)
//      * replaceVideoAudio — video + new audio → output has new audio track
//      * replaceVideoAudio (musicPath=null) → identical to stripAudio
//
// Mirrors the conventions of the other video smokes: ffmpeg
// availability check, on-the-fly lavfi-generated fixtures, structured
// pass/fail reporting, exit code 1 on any FAIL.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEFAULT_AUDIO_PROCESSOR_SETTINGS,
  buildAfadeFilter,
  buildAtrimFilter,
  buildLoudnormFilter,
  findDefaultAudioCandidates,
  joinAfChain,
  prepareBackgroundMusic,
  replaceVideoAudio,
  stripAudio,
  trimAudio,
  type AudioProcessorSettings,
} from "../jobs/audioProcessor.js";

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
// ffmpeg availability + helpers
// ---------------------------------------------------------------------------

async function isAvailable(cmd: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn(cmd, ["-version"], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

/** Generate a 2-second 320×240 testsrc video WITH a 1kHz sine audio track. */
async function makeVideoWithAudio(outputPath: string, durationSec = 2): Promise<void> {
  const args = [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `testsrc=duration=${durationSec}:size=320x240:rate=25`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=1000:sample_rate=48000:duration=${durationSec}`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "ultrafast",
    "-c:a",
    "aac",
    "-ac",
    "2",
    "-shortest",
    "-movflags",
    "+faststart",
    outputPath,
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (b: Buffer) => stderr.push(b));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`ffmpeg gen video exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`),
        );
    });
  });
}

/** Generate a `durationSec` sine-tone audio file. Extension drives the muxer. */
async function makeSineAudio(outputPath: string, durationSec: number, freq = 880): Promise<void> {
  const args = [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${freq}:sample_rate=48000:duration=${durationSec}`,
    "-c:a",
    "aac",
    outputPath,
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (b: Buffer) => stderr.push(b));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`ffmpeg gen audio exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`),
        );
    });
  });
}

/** Tiny ffprobe wrapper used by the smoke for after-the-fact checks. */
interface ProbeInfo {
  readonly hasAudio: boolean;
  readonly hasVideo: boolean;
  readonly durationSec: number | null;
  readonly audioCodec: string | null;
}

async function probe(filePath: string): Promise<ProbeInfo> {
  const args = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath];
  const stdoutChunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.on("data", (b: Buffer) => stdoutChunks.push(b));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffprobe smoke helper exited ${code}`));
    });
  });
  const parsed = JSON.parse(Buffer.concat(stdoutChunks).toString("utf8")) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; codec_name?: string }[];
  };
  const streams = parsed.streams ?? [];
  const audio = streams.find((s) => s.codec_type === "audio");
  const video = streams.find((s) => s.codec_type === "video");
  const dur = parsed.format?.duration;
  return {
    hasAudio: audio !== undefined,
    hasVideo: video !== undefined,
    durationSec: typeof dur === "string" ? Number.parseFloat(dur) : null,
    audioCodec: typeof audio?.codec_name === "string" ? audio.codec_name : null,
  };
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // ------------------------------------------------------------------
  // PART A — pure filter builders + discovery (no ffmpeg required)
  // ------------------------------------------------------------------

  // buildAtrimFilter
  record(
    "pure: buildAtrimFilter duration only",
    buildAtrimFilter({ duration: 4 }) === "atrim=duration=4,asetpts=PTS-STARTPTS",
    buildAtrimFilter({ duration: 4 }),
  );
  record(
    "pure: buildAtrimFilter start + end",
    buildAtrimFilter({ startSec: 1, endSec: 3 }) === "atrim=start=1:end=3,asetpts=PTS-STARTPTS",
    buildAtrimFilter({ startSec: 1, endSec: 3 }),
  );
  record(
    "pure: buildAtrimFilter all three axes",
    buildAtrimFilter({ startSec: 0, endSec: 5, duration: 4 }) ===
      "atrim=start=0:end=5:duration=4,asetpts=PTS-STARTPTS",
    buildAtrimFilter({ startSec: 0, endSec: 5, duration: 4 }),
  );
  {
    let threw = false;
    try {
      buildAtrimFilter({});
    } catch {
      threw = true;
    }
    record("pure: buildAtrimFilter rejects empty input", threw, `threw=${threw}`);
  }
  {
    let threw = false;
    try {
      buildAtrimFilter({ duration: -1 });
    } catch {
      threw = true;
    }
    // negative duration is filtered to no parts → throws
    record("pure: buildAtrimFilter rejects negative duration", threw, `threw=${threw}`);
  }

  // buildAfadeFilter
  record(
    "pure: buildAfadeFilter in + out @ total=10s",
    buildAfadeFilter({ inSeconds: 1.5, outSeconds: 2, totalDurationSec: 10 }) ===
      "afade=t=in:st=0:d=1.5,afade=t=out:st=8:d=2",
    String(buildAfadeFilter({ inSeconds: 1.5, outSeconds: 2, totalDurationSec: 10 })),
  );
  record(
    "pure: buildAfadeFilter in only",
    buildAfadeFilter({ inSeconds: 1, outSeconds: 0, totalDurationSec: 5 }) ===
      "afade=t=in:st=0:d=1",
    String(buildAfadeFilter({ inSeconds: 1, outSeconds: 0, totalDurationSec: 5 })),
  );
  record(
    "pure: buildAfadeFilter both disabled → null",
    buildAfadeFilter({ inSeconds: 0, outSeconds: 0, totalDurationSec: 5 }) === null,
    String(buildAfadeFilter({ inSeconds: 0, outSeconds: 0, totalDurationSec: 5 })),
  );
  record(
    "pure: buildAfadeFilter clamps fade-out start to ≥ 0 (short clip + long fade)",
    buildAfadeFilter({ inSeconds: 0, outSeconds: 5, totalDurationSec: 2 }) ===
      "afade=t=out:st=0:d=5",
    String(buildAfadeFilter({ inSeconds: 0, outSeconds: 5, totalDurationSec: 2 })),
  );
  {
    let threw = false;
    try {
      buildAfadeFilter({ inSeconds: 1, outSeconds: 1, totalDurationSec: 0 });
    } catch {
      threw = true;
    }
    record("pure: buildAfadeFilter rejects totalDurationSec ≤ 0", threw, `threw=${threw}`);
  }

  // buildLoudnormFilter
  record(
    "pure: buildLoudnormFilter default form",
    buildLoudnormFilter({ I: -16, TP: -1.5, LRA: 11 }) === "loudnorm=I=-16:TP=-1.5:LRA=11",
    buildLoudnormFilter({ I: -16, TP: -1.5, LRA: 11 }),
  );
  {
    let threw = false;
    try {
      buildLoudnormFilter({ I: Number.NaN, TP: -1.5, LRA: 11 });
    } catch {
      threw = true;
    }
    record("pure: buildLoudnormFilter rejects NaN", threw, `threw=${threw}`);
  }

  // joinAfChain
  record(
    "pure: joinAfChain joins non-null entries",
    joinAfChain("loudnorm=I=-16:TP=-1.5:LRA=11", "afade=t=in:st=0:d=1") ===
      "loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=in:st=0:d=1",
    String(joinAfChain("loudnorm=I=-16:TP=-1.5:LRA=11", "afade=t=in:st=0:d=1")),
  );
  record(
    "pure: joinAfChain returns null when all null",
    joinAfChain(null, null) === null,
    String(joinAfChain(null, null)),
  );

  // findDefaultAudioCandidates
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "tas-audio-processor-smoke-"));
  console.log(`[smoke] tmpRoot=${tmpRoot}`);
  try {
    // missing dir
    const missing = await findDefaultAudioCandidates(path.join(tmpRoot, "does-not-exist"));
    record(
      "pure: findDefaultAudioCandidates(missing dir) → [] (graceful fallback)",
      missing.length === 0,
      `count=${missing.length}`,
    );

    // empty dir
    const emptyDir = path.join(tmpRoot, "empty-audio");
    mkdirSync(emptyDir, { recursive: true });
    const empty = await findDefaultAudioCandidates(emptyDir);
    record(
      "pure: findDefaultAudioCandidates(empty dir) → []",
      empty.length === 0,
      `count=${empty.length}`,
    );

    // dir with .gitkeep + non-audio + actual audio files
    const mixedDir = path.join(tmpRoot, "mixed-audio");
    mkdirSync(mixedDir, { recursive: true });
    writeFileSync(path.join(mixedDir, ".gitkeep"), "");
    writeFileSync(path.join(mixedDir, "README.txt"), "hi");
    writeFileSync(path.join(mixedDir, "b-song.mp3"), Buffer.alloc(4));
    writeFileSync(path.join(mixedDir, "a-song.wav"), Buffer.alloc(4));
    writeFileSync(path.join(mixedDir, "image.png"), Buffer.alloc(4));
    const mixed = await findDefaultAudioCandidates(mixedDir);
    record(
      "pure: findDefaultAudioCandidates filters non-audio + dotfiles + sorts alphabetically",
      mixed.length === 2 &&
        mixed[0]!.filename === "a-song.wav" &&
        mixed[1]!.filename === "b-song.mp3" &&
        mixed[0]!.extension === "wav" &&
        mixed[1]!.extension === "mp3",
      `files=${mixed.map((c) => c.filename).join(",")}`,
    );

    // ------------------------------------------------------------------
    // PART A.2 — prepareBackgroundMusic input validation (NO ffmpeg
    //            needed; the throw happens BEFORE spawn).
    // ------------------------------------------------------------------
    const PURE_SETTINGS: AudioProcessorSettings = {
      ...DEFAULT_AUDIO_PROCESSOR_SETTINGS,
      ffmpegPath: "ffmpeg-nonexistent-binary-do-not-spawn",
    };
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      let threw = false;
      let msg = "";
      try {
        await prepareBackgroundMusic(
          "/dev/null",
          path.join(tmpRoot, "should-not-exist.m4a"),
          bad,
          PURE_SETTINGS,
        );
      } catch (err) {
        threw = true;
        msg = describe(err);
      }
      record(
        `pure: prepareBackgroundMusic rejects targetDurationSec=${String(bad)} BEFORE spawn (infinite-loop guard)`,
        threw && /positive finite number/.test(msg) && /infinite-loop/.test(msg),
        `threw=${threw} msg=${msg.slice(0, 120)}`,
      );
      record(
        `pure: prepareBackgroundMusic(${String(bad)}) did not produce an output file`,
        !existsSync(path.join(tmpRoot, "should-not-exist.m4a")),
        "outputPath untouched",
      );
    }

    // ------------------------------------------------------------------
    // PART B — end-to-end ffmpeg runners
    // ------------------------------------------------------------------
    const ffmpegOk = (await isAvailable("ffmpeg")) && (await isAvailable("ffprobe"));
    if (!ffmpegOk) {
      console.log("[smoke] SKIP: ffmpeg / ffprobe not on PATH — Part B skipped.");
      reportAndExit();
      return;
    }

    const SETTINGS: AudioProcessorSettings = {
      ...DEFAULT_AUDIO_PROCESSOR_SETTINGS,
      timeoutMs: 60_000,
    };

    // ---- stripAudio --------------------------------------------------
    const srcWithAudio = path.join(tmpRoot, "src-with-audio.mp4");
    await makeVideoWithAudio(srcWithAudio, 2);
    const srcProbe = await probe(srcWithAudio);
    record(
      "ffmpeg: input fixture has video + audio",
      srcProbe.hasVideo && srcProbe.hasAudio,
      JSON.stringify(srcProbe),
    );

    const strippedOut = path.join(tmpRoot, "stripped.mp4");
    await stripAudio(srcWithAudio, strippedOut, SETTINGS);
    const strippedProbe = await probe(strippedOut);
    record(
      "ffmpeg: stripAudio produces a video-only output (no audio stream)",
      existsSync(strippedOut) && strippedProbe.hasVideo && !strippedProbe.hasAudio,
      JSON.stringify(strippedProbe),
    );

    // ---- trimAudio ---------------------------------------------------
    const sineLong = path.join(tmpRoot, "sine-3s.m4a");
    await makeSineAudio(sineLong, 3);
    const trimmedOut = path.join(tmpRoot, "trimmed-1s.m4a");
    await trimAudio(sineLong, trimmedOut, SETTINGS, { duration: 1 });
    const trimmedProbe = await probe(trimmedOut);
    record(
      "ffmpeg: trimAudio shortens 3s source to ~1s output (duration)",
      trimmedProbe.hasAudio &&
        trimmedProbe.durationSec !== null &&
        Math.abs(trimmedProbe.durationSec - 1) < 0.2,
      JSON.stringify(trimmedProbe),
    );

    // ---- prepareBackgroundMusic happy: 2s source → 4s target (loop) --
    const sineShort = path.join(tmpRoot, "sine-2s.m4a");
    await makeSineAudio(sineShort, 2);
    const bgmLooped = path.join(tmpRoot, "bgm-looped-4s.m4a");
    await prepareBackgroundMusic(sineShort, bgmLooped, 4, SETTINGS);
    const loopedProbe = await probe(bgmLooped);
    record(
      "ffmpeg: prepareBackgroundMusic loops a 2s source up to a 4s target",
      loopedProbe.hasAudio &&
        loopedProbe.durationSec !== null &&
        Math.abs(loopedProbe.durationSec - 4) < 0.3,
      JSON.stringify(loopedProbe),
    );

    // ---- prepareBackgroundMusic trim: 3s source → 1s target ----------
    const bgmTrimmed = path.join(tmpRoot, "bgm-trimmed-1s.m4a");
    await prepareBackgroundMusic(sineLong, bgmTrimmed, 1, SETTINGS);
    const trimmedBgmProbe = await probe(bgmTrimmed);
    record(
      "ffmpeg: prepareBackgroundMusic trims a 3s source down to a 1s target",
      trimmedBgmProbe.hasAudio &&
        trimmedBgmProbe.durationSec !== null &&
        Math.abs(trimmedBgmProbe.durationSec - 1) < 0.3,
      JSON.stringify(trimmedBgmProbe),
    );

    // ---- prepareBackgroundMusic with fades disabled + loudnorm off ---
    const bgmNoFx = path.join(tmpRoot, "bgm-no-fx-2s.m4a");
    await prepareBackgroundMusic(sineShort, bgmNoFx, 2, SETTINGS, {
      loudnormEnabled: false,
      fadeInSeconds: 0,
      fadeOutSeconds: 0,
    });
    const noFxProbe = await probe(bgmNoFx);
    record(
      "ffmpeg: prepareBackgroundMusic works with all filters disabled (no -af)",
      noFxProbe.hasAudio &&
        noFxProbe.durationSec !== null &&
        Math.abs(noFxProbe.durationSec - 2) < 0.3,
      JSON.stringify(noFxProbe),
    );

    // ---- replaceVideoAudio: video + bgm → output has new audio ------
    const replacedOut = path.join(tmpRoot, "replaced.mp4");
    await replaceVideoAudio(srcWithAudio, bgmLooped, replacedOut, SETTINGS);
    const replacedProbe = await probe(replacedOut);
    record(
      "ffmpeg: replaceVideoAudio produces a video with the new audio track",
      existsSync(replacedOut) &&
        replacedProbe.hasVideo &&
        replacedProbe.hasAudio &&
        replacedProbe.audioCodec === "aac",
      JSON.stringify(replacedProbe),
    );

    // ---- replaceVideoAudio(musicPath=null) ≡ stripAudio --------------
    const replacedMuteOut = path.join(tmpRoot, "replaced-mute.mp4");
    await replaceVideoAudio(srcWithAudio, null, replacedMuteOut, SETTINGS);
    const replacedMuteProbe = await probe(replacedMuteOut);
    record(
      "ffmpeg: replaceVideoAudio(musicPath=null) routes through stripAudio (no audio out)",
      replacedMuteProbe.hasVideo && !replacedMuteProbe.hasAudio,
      JSON.stringify(replacedMuteProbe),
    );

    // ---- failure mode: ffmpeg binary not on PATH ---------------------
    {
      let threw = false;
      let msg = "";
      try {
        await stripAudio(srcWithAudio, path.join(tmpRoot, "wont-be-created.mp4"), {
          ...SETTINGS,
          ffmpegPath: "ffmpeg-no-such-binary-12345",
        });
      } catch (err) {
        threw = true;
        msg = describe(err);
      }
      record(
        "ffmpeg: missing binary surfaces a clear spawn-failed error",
        threw && /ffmpeg spawn failed \(stripAudio\)/.test(msg),
        `threw=${threw} msg=${msg.slice(0, 160)}`,
      );
    }

    reportAndExit();
  } finally {
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
