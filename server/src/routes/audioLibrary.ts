// Audio library routes (P11.T6).
//
// Mounted at `/api`, owns:
//
//   GET    /api/audio-library
//   POST   /api/audio-library/upload         (multipart/form-data)
//   POST   /api/audio-library/import-url
//   DELETE /api/audio-library/:id
//
// Conventions:
//   * `asyncHandler` so any thrown AppError reaches the unified
//     error envelope.
//   * Body / query validation in the Service layer via zod
//     `.strict()` (see `audioLibrarySchemas.ts`).
//   * Multipart upload reused from the P2.T4 `parseUpload` helper
//     to keep busboy plumbing in one place.

import { Router } from "express";
import { unlink } from "node:fs/promises";

import type { AudioLibraryService } from "../media/index.js";
import {
  listAudioLibraryQuerySchema,
  importAudioUrlBodySchema,
  uploadAudioMultipartFieldsSchema,
} from "../media/audioLibrarySchemas.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { parseUpload } from "../upload/uploadParser.js";
import { parseOrThrow } from "../util/zodParse.js";
import { BadRequestError } from "../errors/AppError.js";

export interface AudioLibraryRouterDeps {
  readonly audioLibraryService: AudioLibraryService;
  /** Wired from `config.audioLibrary.maxUploadBytes`. Used as
   * busboy's per-part fileSize cap so a malicious client can't
   * stream gigabytes through the upload pipeline before the
   * Service's sizeBytes check kicks in. */
  readonly maxUploadBytes: number;
}

export function makeAudioLibraryRouter(deps: AudioLibraryRouterDeps): Router {
  const router = Router();

  // GET /api/audio-library
  //
  // Query (all optional):
  //   sourceType?:       'system' | 'user' | 'url_import'
  //   includeInactive?:  boolean (default false)
  //
  // 200 → { items: AudioLibraryView[] }
  // 400 on unknown query key / bad enum (.strict() schema).
  router.get(
    "/audio-library",
    asyncHandler((req, res) => {
      const query = parseOrThrow(listAudioLibraryQuerySchema, req.query, "query");
      let items;
      if (query.sourceType !== undefined) {
        items = deps.audioLibraryService.listActiveBySourceType(query.sourceType);
      } else {
        items = deps.audioLibraryService.listAllActive();
      }
      res.status(200).json({ items });
    }),
  );

  // POST /api/audio-library/upload (multipart/form-data)
  //
  // Single audio file part (any field name). Optional fields:
  //   name?  display name override (form field)
  //   tags?  comma-separated tags (form field)
  //
  // 200 → AudioLibraryWriteResult
  // 400 on empty payload / wrong format / too large / unsupported
  //     MIME (Service throws AUDIO_EMPTY / AUDIO_UNSUPPORTED_FORMAT
  //     / AUDIO_TOO_LARGE; busboy enforces the cap up-front too).
  router.post(
    "/audio-library/upload",
    asyncHandler(async (req, res) => {
      const parsed = await parseUpload({
        headers: req.headers,
        body: req,
        maxFileSize: deps.maxUploadBytes,
      });
      try {
        if (parsed.files.length === 0) {
          throw new BadRequestError(
            "no file part found in multipart payload (expected exactly one audio file)",
          );
        }
        // V1: take the first file part. The schema docs note "single
        // file"; additional parts are ignored for forward-compat.
        const file = parsed.files[0]!;
        if (file.truncated) {
          throw new BadRequestError(
            `uploaded file exceeded the ${deps.maxUploadBytes}-byte limit and was truncated`,
            { limit: deps.maxUploadBytes },
          );
        }
        if (file.error !== undefined) {
          throw new BadRequestError(`upload staging failed: ${file.error.message}`, {
            code: file.error.code,
          });
        }

        // Optional form fields (busboy collects these as separate
        // entries but parseUpload only surfaces files). For V1 we
        // accept them via query params too, since the route is
        // single-purpose; if a future client wants form-field
        // overrides, parseUpload would need extending to capture
        // text fields. The simpler V1 path: read from query.
        const fields = parseOrThrow(uploadAudioMultipartFieldsSchema, req.query, "query");

        const result = await deps.audioLibraryService.uploadAudio({
          stagingPath: file.stagingPath,
          sizeBytes: file.size,
          originalFilename: file.originalFilename,
          declaredMimeType: file.declaredMimeType,
          ...(fields.name !== undefined ? { displayName: fields.name } : {}),
          ...(fields.tags !== undefined ? { tags: fields.tags } : {}),
        });
        res.status(200).json(result);
      } finally {
        await parsed.cleanup();
      }
    }),
  );

  // POST /api/audio-library/import-url
  //
  // Body: { url, name?, tags? }
  // 200 → AudioLibraryWriteResult
  // 400 on bad URL / forbidden IP / unsupported format / too large
  // 400 on download network error / timeout / non-200 (Service maps
  //     these to AUDIO_IMPORT_DOWNLOAD_FAILED).
  router.post(
    "/audio-library/import-url",
    asyncHandler(async (req, res) => {
      const body = parseOrThrow(importAudioUrlBodySchema, req.body ?? {}, "request body");
      const input: { url: string; name?: string; tags?: string } = { url: body.url };
      if (body.name !== undefined) input.name = body.name;
      if (body.tags !== undefined) input.tags = body.tags;
      const result = await deps.audioLibraryService.importFromUrl(input);
      res.status(200).json(result);
    }),
  );

  // DELETE /api/audio-library/:id
  //
  // 200 → { id, deleted, removedFilePath }
  // 400 on unknown id
  // 403 on system row (AUDIO_SYSTEM_NOT_DELETABLE)
  // 409 on in-use row (AUDIO_IN_USE — referenced by pending/
  //     running render job)
  router.delete(
    "/audio-library/:id",
    asyncHandler(async (req, res) => {
      const id = req.params.id ?? "";
      if (id.length === 0) {
        throw new BadRequestError("id path param required");
      }
      const result = await deps.audioLibraryService.deleteAudio(id);
      res.status(200).json(result);
    }),
  );

  return router;
}

// Suppress unused import — `unlink` is referenced in the docs but
// not the code body (parseUpload owns staging cleanup via its own
// `parsed.cleanup()` call).
void unlink;
