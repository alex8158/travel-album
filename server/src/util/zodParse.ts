// Shared zod -> ValidationError adapter (P1.T3).
//
// Lifts the private `parseOrThrow` helper that lived in
// trips/tripService.ts so route handlers can use the same translation
// without duplicating the issue-formatting logic.
//
// Use this any time you have an `unknown` payload (req.body, req.query,
// CLI argv, etc.) and want a typed value or a 422 ValidationError —
// the latter then renders as the project-standard error envelope via
// the global error middleware (P0.T6).

import type { z } from "zod";
import { ValidationError } from "../errors/AppError.js";

export function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown, label = "input"): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(`Validation failed: ${label}`, {
      issues: result.error.issues.map((i) => ({
        path: i.path.join(".") || "(root)",
        message: i.message,
        code: i.code,
      })),
    });
  }
  return result.data;
}
