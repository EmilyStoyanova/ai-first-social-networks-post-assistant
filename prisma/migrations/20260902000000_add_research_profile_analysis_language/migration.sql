-- 2026-09-02 ownership-boundary fix: Competitive Analysis owns its own
-- analysis language, independent of Company.defaultLang (Content Creation's
-- own, unrelated anchor).
--
-- Additive and non-destructive: one nullable-free column with a default,
-- plus a one-time, ONE-WAY backfill of existing rows. Nothing is dropped,
-- nothing is renamed, and Company.defaultLang is untouched.
--
-- ── Why the backfill copies Company.defaultLang, just this once ───────────
-- `analysisHash` (on competitor_intelligence) already encodes the language an
-- existing completed row was analyzed under, which — until this migration —
-- was always the owning company's `default_language`. If new profile rows
-- defaulted to 'en' regardless of that history, every already-correct
-- Bulgarian row for a Bulgarian-default company would immediately recompute
-- to a MISMATCHED hash and get swept up by reopen-stale-analysis.service.ts
-- as stale — a mass, unwanted re-analysis caused by this migration alone,
-- not by anything the user changed. Copying the company's current
-- default_language in as the STARTING value keeps every existing row's
-- staleness verdict exactly as it was the moment before this migration ran.
-- From this point on, analysis_language is fully independent — a later Brand
-- default_language change never touches this column again, in either
-- direction.
--
-- Verified against real data (read-only inspection, 2026-09-02): both
-- persisted competitor_research_profiles rows today (companies "domestico"
-- and "edamame") belong to companies with default_language = 'bg', so this
-- backfill sets analysis_language = 'bg' for both — a no-op for every
-- already-stored analysis_hash.

ALTER TABLE "competitor_research_profiles"
  ADD COLUMN "analysis_language" TEXT NOT NULL DEFAULT 'en';

UPDATE "competitor_research_profiles" AS rp
SET "analysis_language" = c."default_language"
FROM "companies" AS c
WHERE c.id = rp.company_id
  AND c."default_language" IN ('en', 'bg');
