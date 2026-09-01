-- 2026-09 relevance-retry fix (Part 3B relevance-UI/retry follow-up).
--
-- Two additive, nullable/defaulted columns on competitor_intelligence —
-- no backfill needed, no behavior change for existing rows on deploy:
--
--   relevance_attempt_count — bounded-retry counter for the relevance step,
--     mirroring the existing attempt_count column's role for extraction.
--     Prevents a permanently-failing row from hot-looping the relevance
--     drain's self-continuation forever.
--
--   relevance_evaluated_at — timestamp of the last GENUINE relevance verdict
--     (never set on a failed attempt or an exhausted-retries write), backing
--     the Content detail view's "Evaluated: <date>" field.

ALTER TABLE "competitor_intelligence"
  ADD COLUMN "relevance_attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "relevance_evaluated_at" TIMESTAMP(3);
