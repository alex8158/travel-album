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

  // Domain — reserved for later phases. Defined now so the surface is
  // visible in one place and clients can prepare to handle them.
  DUPLICATE_GROUP_RECOMMENDED: "DUPLICATE_GROUP_RECOMMENDED",
  FFMPEG_NOT_AVAILABLE: "FFMPEG_NOT_AVAILABLE",
  PERMANENT_DELETE_DISABLED: "PERMANENT_DELETE_DISABLED",
  AI_NOT_CONFIGURED: "AI_NOT_CONFIGURED",
  AI_QUOTA_EXCEEDED: "AI_QUOTA_EXCEEDED",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
