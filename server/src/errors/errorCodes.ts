// Stable API error codes (P0.T6, design.md §10.2).
//
// Codes are stable strings — never rename without a deliberate migration
// because clients may switch on them. New codes can be added freely.
// HTTP status mapping is up to each AppError instance (see AppError.ts);
// the same code can appear with different statuses in rare cases.

export const ERROR_CODES = {
  // Generic
  INTERNAL_ERROR: "INTERNAL_ERROR",
  NOT_FOUND: "NOT_FOUND",
  BAD_REQUEST: "BAD_REQUEST",
  VALIDATION_FAILED: "VALIDATION_FAILED",

  // State machines
  INVALID_STATE_TRANSITION: "INVALID_STATE_TRANSITION",

  // Storage (P0.T7) — see server/src/storage/.
  STORAGE_INVALID_KEY: "STORAGE_INVALID_KEY",
  STORAGE_PATH_TRAVERSAL: "STORAGE_PATH_TRAVERSAL",
  STORAGE_ALREADY_EXISTS: "STORAGE_ALREADY_EXISTS",
  STORAGE_NOT_FOUND: "STORAGE_NOT_FOUND",
  STORAGE_IO_ERROR: "STORAGE_IO_ERROR",

  // Domain — reserved for later phases. Defined now so the surface is
  // visible in one place and clients can prepare to handle them.
  DUPLICATE_GROUP_RECOMMENDED: "DUPLICATE_GROUP_RECOMMENDED",
  FFMPEG_NOT_AVAILABLE: "FFMPEG_NOT_AVAILABLE",
  PERMANENT_DELETE_DISABLED: "PERMANENT_DELETE_DISABLED",
  AI_NOT_CONFIGURED: "AI_NOT_CONFIGURED",
  AI_QUOTA_EXCEEDED: "AI_QUOTA_EXCEEDED",
  EDIT_PLAN_NOT_FOUND: "EDIT_PLAN_NOT_FOUND",

  // Audio library (P11.T6) — see server/src/media/audioLibraryService.ts.
  AUDIO_UNSUPPORTED_FORMAT: "AUDIO_UNSUPPORTED_FORMAT",
  AUDIO_TOO_LARGE: "AUDIO_TOO_LARGE",
  AUDIO_EMPTY: "AUDIO_EMPTY",
  AUDIO_IMPORT_FORBIDDEN_URL: "AUDIO_IMPORT_FORBIDDEN_URL",
  AUDIO_IMPORT_DOWNLOAD_FAILED: "AUDIO_IMPORT_DOWNLOAD_FAILED",
  AUDIO_SYSTEM_NOT_DELETABLE: "AUDIO_SYSTEM_NOT_DELETABLE",
  AUDIO_IN_USE: "AUDIO_IN_USE",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
