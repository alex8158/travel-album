// Zod schemas for P11.T6 audio library API.
//
// Convention: `.strict()` everywhere — unknown body / query keys
// surface as a single ValidationError through the global error
// middleware (matches the rest of the project's API surface).

import { z } from "zod";

/** `GET /api/audio-library` query schema.
 *
 * Both filters optional; an empty query returns all active rows
 * (system + user + url_import) ordered by source_type then
 * display_name.
 *
 * `sourceType` accepts a single value OR a comma-separated list
 * (`?sourceType=system,user`). The simpler single-value form is
 * what V1 documents; the CSV variant is left for a future
 * filter-by-multi extension and is NOT exposed in the V1 schema.
 */
export const listAudioLibraryQuerySchema = z
  .object({
    sourceType: z.enum(["system", "user", "url_import"]).optional(),
    /** Default true → only active rows. When false, includes
     * disabled rows (admin / smoke variant). */
    includeInactive: z.coerce.boolean().default(false),
  })
  .strict();

export type ListAudioLibraryQuery = z.infer<typeof listAudioLibraryQuerySchema>;

/** `POST /api/audio-library/import-url` body schema.
 *
 * The actual URL safety (protocol allowlist, private-IP refusal,
 * size / timeout caps) happens in the Service layer — this schema
 * just enforces the shape so 400 errors are uniform with the
 * rest of the API.
 */
export const importAudioUrlBodySchema = z
  .object({
    url: z.string().min(1, "url must be a non-empty string").max(2048, "url must be ≤ 2048 chars"),
    /** Optional display name override. When omitted, derived from
     * URL pathname or Content-Disposition header. */
    name: z.string().min(1).max(256).optional(),
    /** Optional tags string (comma-separated). The same field
     * exists on user upload + system seed; mirrors the
     * audio_library.tags column shape. */
    tags: z.string().max(512).optional(),
  })
  .strict();

export type ImportAudioUrlInput = z.infer<typeof importAudioUrlBodySchema>;

/** `POST /api/audio-library/upload` (multipart) does NOT have a
 * JSON body — fields come from busboy. We expose the closed
 * upload-form field shape here for the smoke / service to
 * validate the parsed multipart map (the Service does the
 * parsing; this schema is the contract). */
export const uploadAudioMultipartFieldsSchema = z
  .object({
    /** Optional display name; default derived from filename. */
    name: z.string().min(1).max(256).optional(),
    tags: z.string().max(512).optional(),
  })
  .strict();

export type UploadAudioMultipartFields = z.infer<typeof uploadAudioMultipartFieldsSchema>;
