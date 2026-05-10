// Manual smoke test for the File_Classifier (P2.T3).
//
// Usage:
//   npm run smoke:classify
//
// Synthesises minimal head-byte buffers for every supported magic
// pattern, then exercises the three-layer classifier over a matrix of
// happy-path, MIME-exemption, and conflict / spoof / edge cases.
// Prints PASS/FAIL per case and exits non-zero if any required case
// failed. Pure synthetic — no filesystem, no network.

import {
  classify,
  type ClassifyOptions,
  type ClassifyResult,
  type MediaType,
} from "../classify/index.js";

interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const results: CheckResult[] = [];

const ALLOWED_IMAGE_EXT: readonly string[] = ["jpg", "jpeg", "png", "webp", "heic"];
const ALLOWED_VIDEO_EXT: readonly string[] = ["mp4", "mov", "m4v", "avi", "mkv"];

const OPTIONS: ClassifyOptions = {
  imageExtensions: ALLOWED_IMAGE_EXT,
  videoExtensions: ALLOWED_VIDEO_EXT,
};

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`[smoke][${ok ? "PASS" : "FAIL"}] ${name}: ${detail}`);
}

function describe(result: ClassifyResult): string {
  return `type=${result.type} ext=${result.extension ?? "(none)"} mime=${result.mimeType ?? "(none)"} reason="${result.reason}"`;
}

function expectType(name: string, expected: MediaType, result: ClassifyResult): void {
  record(name, result.type === expected, describe(result));
}

// ---------------------------------------------------------------------------
// Synthesise minimal head-byte buffers for each supported magic.
// 16 bytes is enough for every pattern we recognise.
// ---------------------------------------------------------------------------

const HEAD_LEN = 16;

function bufFromBytes(bytes: number[]): Uint8Array {
  const out = new Uint8Array(HEAD_LEN);
  for (let i = 0; i < bytes.length && i < HEAD_LEN; i += 1) {
    out[i] = bytes[i] ?? 0;
  }
  return out;
}

const HEAD_JPEG = bufFromBytes([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const HEAD_PNG = bufFromBytes([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0,
]);
// "RIFF" + 4 dummy bytes + "WEBP"
const HEAD_WEBP = bufFromBytes([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0, 0, 0, 0,
]);
// "RIFF" + 4 dummy bytes + "AVI "
const HEAD_AVI = bufFromBytes([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20, 0, 0, 0, 0,
]);
// EBML header for MKV
const HEAD_MKV = bufFromBytes([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

function ftypHead(brand: string): Uint8Array {
  // 4 bytes size (ignored) + "ftyp" + 4-byte brand + 4 trailing zero bytes.
  const buf = new Uint8Array(HEAD_LEN);
  buf[0] = 0x00;
  buf[1] = 0x00;
  buf[2] = 0x00;
  buf[3] = 0x20;
  // "ftyp" at 4..8
  buf[4] = 0x66;
  buf[5] = 0x74;
  buf[6] = 0x79;
  buf[7] = 0x70;
  // brand at 8..12
  for (let i = 0; i < 4; i += 1) {
    buf[8 + i] = brand.charCodeAt(i) ?? 0x20;
  }
  return buf;
}

const HEAD_HEIC = ftypHead("heic");
const HEAD_HEIC_MIF1 = ftypHead("mif1");
const HEAD_MP4_ISOM = ftypHead("isom");
const HEAD_MP4_MP42 = ftypHead("mp42");
const HEAD_MOV = ftypHead("qt  ");
const HEAD_M4V = ftypHead("M4V ");
const HEAD_FTYP_UNKNOWN = ftypHead("xxxx");

const HEAD_TEXT = new TextEncoder().encode("hello world, this is plain text\n");
const HEAD_PDF = bufFromBytes([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0, 0, 0, 0, 0, 0, 0, 0,
]);
const HEAD_EMPTY = new Uint8Array(0);
// Note: a 3-byte head [0xFF 0xD8 0xFF] would actually fully match
// JPEG's prefix. To test "head too short for any pattern" we use 2
// bytes — shorter than every pattern in magicNumbers.ts.
const HEAD_TINY = new Uint8Array([0xff, 0xd8]); // 2 bytes only

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

function main(): void {
  // ---- Positive: image happy paths ----
  expectType(
    "[1] jpg + image/jpeg + JPEG magic",
    "image",
    classify(
      { filename: "photo.jpg", declaredMimeType: "image/jpeg", headBytes: HEAD_JPEG },
      OPTIONS,
    ),
  );
  expectType(
    "[2] jpeg + image/jpeg + JPEG magic",
    "image",
    classify(
      { filename: "photo.jpeg", declaredMimeType: "image/jpeg", headBytes: HEAD_JPEG },
      OPTIONS,
    ),
  );
  expectType(
    "[3] png + image/png + PNG magic",
    "image",
    classify(
      { filename: "diagram.png", declaredMimeType: "image/png", headBytes: HEAD_PNG },
      OPTIONS,
    ),
  );
  expectType(
    "[4] webp + image/webp + WEBP magic",
    "image",
    classify(
      { filename: "shot.webp", declaredMimeType: "image/webp", headBytes: HEAD_WEBP },
      OPTIONS,
    ),
  );
  expectType(
    "[5] heic + image/heic + HEIC ftyp brand",
    "image",
    classify(
      { filename: "img.heic", declaredMimeType: "image/heic", headBytes: HEAD_HEIC },
      OPTIONS,
    ),
  );
  expectType(
    "[5b] heic + image/heif + mif1 brand",
    "image",
    classify(
      { filename: "img.heic", declaredMimeType: "image/heif", headBytes: HEAD_HEIC_MIF1 },
      OPTIONS,
    ),
  );

  // ---- Positive: video happy paths ----
  expectType(
    "[6] mp4 + video/mp4 + isom brand",
    "video",
    classify(
      { filename: "clip.mp4", declaredMimeType: "video/mp4", headBytes: HEAD_MP4_ISOM },
      OPTIONS,
    ),
  );
  expectType(
    "[6b] mp4 + video/mp4 + mp42 brand",
    "video",
    classify(
      { filename: "clip.mp4", declaredMimeType: "video/mp4", headBytes: HEAD_MP4_MP42 },
      OPTIONS,
    ),
  );
  expectType(
    "[7] mov + video/quicktime + qt brand",
    "video",
    classify(
      { filename: "clip.mov", declaredMimeType: "video/quicktime", headBytes: HEAD_MOV },
      OPTIONS,
    ),
  );
  expectType(
    "[8] m4v + video/x-m4v + M4V brand",
    "video",
    classify(
      { filename: "clip.m4v", declaredMimeType: "video/x-m4v", headBytes: HEAD_M4V },
      OPTIONS,
    ),
  );
  expectType(
    "[9] avi + video/x-msvideo + AVI magic",
    "video",
    classify(
      { filename: "old.avi", declaredMimeType: "video/x-msvideo", headBytes: HEAD_AVI },
      OPTIONS,
    ),
  );
  expectType(
    "[10] mkv + video/x-matroska + EBML magic",
    "video",
    classify(
      { filename: "movie.mkv", declaredMimeType: "video/x-matroska", headBytes: HEAD_MKV },
      OPTIONS,
    ),
  );

  // ---- MIME exemption ----
  expectType(
    "[11] jpg + JPEG magic + MIME missing → image",
    "image",
    classify({ filename: "photo.jpg", headBytes: HEAD_JPEG }, OPTIONS),
  );
  expectType(
    "[12] jpg + JPEG magic + MIME application/octet-stream → image",
    "image",
    classify(
      { filename: "photo.jpg", declaredMimeType: "application/octet-stream", headBytes: HEAD_JPEG },
      OPTIONS,
    ),
  );
  expectType(
    "[13] mp4 + MP4 magic + MIME missing → video",
    "video",
    classify({ filename: "clip.mp4", headBytes: HEAD_MP4_ISOM }, OPTIONS),
  );
  expectType(
    "[13b] jpg + JPEG magic + MIME with ;charset param normalised",
    "image",
    classify(
      { filename: "p.jpg", declaredMimeType: "image/jpeg; charset=binary", headBytes: HEAD_JPEG },
      OPTIONS,
    ),
  );

  // ---- Conflict / spoof rejections ----
  expectType(
    "[14] jpg + MIME video/mp4 + JPEG magic → unknown (MIME conflict)",
    "unknown",
    classify(
      { filename: "photo.jpg", declaredMimeType: "video/mp4", headBytes: HEAD_JPEG },
      OPTIONS,
    ),
  );
  expectType(
    "[15] jpg + MIME image/jpeg + ASCII text → unknown (spoofed)",
    "unknown",
    classify(
      { filename: "fake.jpg", declaredMimeType: "image/jpeg", headBytes: HEAD_TEXT },
      OPTIONS,
    ),
  );
  expectType(
    "[16] mp4 + MIME image/jpeg + MP4 magic → unknown (MIME conflict)",
    "unknown",
    classify(
      { filename: "clip.mp4", declaredMimeType: "image/jpeg", headBytes: HEAD_MP4_ISOM },
      OPTIONS,
    ),
  );
  expectType(
    "[17] jpg ext + PNG magic → unknown (ext doesn't match magic — possible spoof)",
    "unknown",
    classify(
      { filename: "fake.jpg", declaredMimeType: "image/jpeg", headBytes: HEAD_PNG },
      OPTIONS,
    ),
  );
  expectType(
    "[17b] mp4 ext + JPEG magic → unknown (image/video swap)",
    "unknown",
    classify({ filename: "trick.mp4", headBytes: HEAD_JPEG }, OPTIONS),
  );

  // ---- Edge cases ----
  expectType(
    "[18] empty filename → unknown",
    "unknown",
    classify({ filename: "", headBytes: HEAD_JPEG }, OPTIONS),
  );
  expectType(
    "[18b] whitespace-only filename → unknown",
    "unknown",
    classify({ filename: "   ", headBytes: HEAD_JPEG }, OPTIONS),
  );
  expectType(
    "[19] no extension + JPEG magic + image/jpeg → image",
    "image",
    classify({ filename: "myfile", declaredMimeType: "image/jpeg", headBytes: HEAD_JPEG }, OPTIONS),
  );
  expectType(
    "[20] multi-dot photo.tar.gz → unknown (last ext gz not in allowlist)",
    "unknown",
    classify({ filename: "photo.tar.gz", headBytes: HEAD_JPEG }, OPTIONS),
  );
  expectType(
    "[21] uppercase .JPG + JPEG magic → image (case-insensitive)",
    "image",
    classify(
      { filename: "PHOTO.JPG", declaredMimeType: "IMAGE/JPEG", headBytes: HEAD_JPEG },
      OPTIONS,
    ),
  );
  expectType(
    "[22] empty headBytes → unknown",
    "unknown",
    classify(
      { filename: "photo.jpg", declaredMimeType: "image/jpeg", headBytes: HEAD_EMPTY },
      OPTIONS,
    ),
  );
  expectType(
    "[23] tiny headBytes (3 bytes) + jpg ext → unknown (head too short)",
    "unknown",
    classify(
      { filename: "photo.jpg", declaredMimeType: "image/jpeg", headBytes: HEAD_TINY },
      OPTIONS,
    ),
  );
  expectType(
    "[24] full path '/photos/2026/photo.jpg' + JPEG magic → image (basename extracted)",
    "image",
    classify({ filename: "/photos/2026/photo.jpg", headBytes: HEAD_JPEG }, OPTIONS),
  );
  expectType(
    "[25] Windows backslash path + JPEG magic → image",
    "image",
    classify({ filename: "C:\\Users\\me\\photo.jpg", headBytes: HEAD_JPEG }, OPTIONS),
  );
  expectType(
    "[26] .txt + ASCII text + no MIME → unknown",
    "unknown",
    classify({ filename: "notes.txt", headBytes: HEAD_TEXT }, OPTIONS),
  );
  expectType(
    "[27] PDF magic + .pdf ext → unknown (no PDF support)",
    "unknown",
    classify(
      { filename: "doc.pdf", declaredMimeType: "application/pdf", headBytes: HEAD_PDF },
      OPTIONS,
    ),
  );
  expectType(
    "[28] ftyp box with unknown brand → unknown",
    "unknown",
    classify({ filename: "weird.mp4", headBytes: HEAD_FTYP_UNKNOWN }, OPTIONS),
  );
  expectType(
    "[29] hidden file '.bashrc' + JPEG magic → image (no extension; magic decides)",
    "image",
    classify({ filename: ".bashrc", headBytes: HEAD_JPEG }, OPTIONS),
  );
  expectType(
    "[30] trailing dot 'photo.' + JPEG magic + image/jpeg → image (no extension after last dot)",
    "image",
    classify({ filename: "photo.", declaredMimeType: "image/jpeg", headBytes: HEAD_JPEG }, OPTIONS),
  );

  // ---- Reason field is always non-empty ----
  const reasonProbe = classify(
    { filename: "photo.jpg", declaredMimeType: "image/jpeg", headBytes: HEAD_JPEG },
    OPTIONS,
  );
  record(
    "[R] reason field is always non-empty (positive case)",
    reasonProbe.reason.length > 0,
    `reason="${reasonProbe.reason}"`,
  );

  // ---- Result extension/mime is normalised lowercase ----
  const normProbe = classify(
    { filename: "PHOTO.JPG", declaredMimeType: "IMAGE/JPEG", headBytes: HEAD_JPEG },
    OPTIONS,
  );
  record(
    "[N] extension and mime normalised to lowercase",
    normProbe.extension === "jpg" && normProbe.mimeType === "image/jpeg",
    `ext=${normProbe.extension} mime=${normProbe.mimeType}`,
  );

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[smoke] summary: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

main();
