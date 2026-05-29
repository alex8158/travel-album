-- 026_extend_media_analysis_ai_blur.sql
--
-- Migration scope (P12.T3):
--
-- Add the AI second-pass blur signal to `media_analysis` (created in 008),
-- kept strictly separate from the Code (Laplacian) blur fields so the two
-- never overwrite each other (design.md §4.2 media_analysis row + §7.8 L3):
--
--   * ai_blur_class  TEXT, CHECK ∈ {sharp, maybe_blurry, blurry, unknown},
--                    DEFAULT 'unknown'. Written by the P12.T5 ai_blur_check
--                    worker. Independent of the existing Code blur columns
--                    (blur_score / is_blurry); the AI verdict and the Code
--                    verdict coexist.
--   * ai_blur_reason TEXT NULL. The human-readable justification the AI
--                    returns, so the frontend can answer "why was this
--                    flagged blurry" directly (CLAUDE.md §3.8 explainability).
--
-- Both columns are nullable in spirit — the CHECK admits NULL — but
-- ai_blur_class carries DEFAULT 'unknown' so existing P0–P11 rows and any
-- INSERT that omits it land on the explicit "not yet AI-checked" sentinel
-- rather than NULL.
--
-- Why ALTER ADD COLUMN (no rebuild): media_analysis has no child tables,
-- and a CHECK constraint on an added column is permitted. No FK side
-- effects. The existing MediaAnalysisRepository upserts
-- (ON CONFLICT(media_id)) are unaffected — they neither read nor write
-- these new columns.
--
-- Non-goals (schema-only): no worker / repository / route change. The
-- P12.T5 worker (and a future repository method) will populate these.

ALTER TABLE media_analysis
  ADD COLUMN ai_blur_class TEXT DEFAULT 'unknown'
  CHECK (ai_blur_class IS NULL OR ai_blur_class IN ('sharp', 'maybe_blurry', 'blurry', 'unknown'));

ALTER TABLE media_analysis
  ADD COLUMN ai_blur_reason TEXT;
