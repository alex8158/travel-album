// /api/health route (P0.T8).
//
// Reads exclusively from the immutable Capabilities snapshot built once
// at startup — does NOT spawn ffmpeg / ffprobe per request.
//
// Public response shape (per docs/tasks.md P0.T8):
//   {
//     "status":   "ok",
//     "requestId": "...",
//     "capabilities": {
//        "ffmpegAvailable":          boolean,
//        "ffmpegVersion":            string | null,
//        "ffprobeAvailable":         boolean,
//        "ffprobeVersion":           string | null,
//        "permanentDeleteEnabled":   boolean,
//        "aiEnabled":                boolean
//     },
//     "storage": {
//        "available":    true,        // currently always true if the server is up
//        "resolvedRoot": string
//     }
//   }
//
// We intentionally project only a subset of `Capabilities` here:
//   - ffmpegPath / ffprobePath are kept internal so /api/health does not
//     leak the absolute install path of system binaries.
//   - ffmpegError / ffprobeError stay in startup logs; clients should
//     not rely on a specific error string.

import { Router } from "express";
import type { Capabilities } from "../runtime/capabilities.js";
import type { LocalStorageProvider } from "../storage/index.js";

export interface HealthRouterDeps {
  readonly capabilities: Capabilities;
  readonly storage: LocalStorageProvider;
}

export function makeHealthRouter(deps: HealthRouterDeps): Router {
  const router = Router();

  router.get("/", (req, res) => {
    res.json({
      status: "ok",
      requestId: req.requestId,
      capabilities: {
        ffmpegAvailable: deps.capabilities.ffmpegAvailable,
        ffmpegVersion: deps.capabilities.ffmpegVersion,
        ffprobeAvailable: deps.capabilities.ffprobeAvailable,
        ffprobeVersion: deps.capabilities.ffprobeVersion,
        permanentDeleteEnabled: deps.capabilities.permanentDeleteEnabled,
        aiEnabled: deps.capabilities.aiEnabled,
      },
      storage: {
        available: true,
        resolvedRoot: deps.storage.root,
      },
    });
  });

  return router;
}
