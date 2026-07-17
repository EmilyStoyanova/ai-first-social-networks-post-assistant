-- v2-8 — Content Mix (Generation Distribution)
--
-- Persists how a company's weekly posts are distributed across its content
-- sources and its own mission/brand content.
--
-- Every column is additive and nullable (or defaulted), so existing companies
-- keep working untouched: with no quota anywhere, `resolveContentMix` returns
-- null and the scheduler runs the pre-v2-8 pooling path unchanged.
--
-- NULL vs 0 is meaningful in both quota columns:
--   NULL = no quota configured (this source/company takes no part in a mix)
--   0    = configured to contribute zero posts

-- Weekly quota for posts written from company mission/brand knowledge (no RSS).
ALTER TABLE "companies"
  ADD COLUMN "company_content_posts_per_week" INTEGER;

-- Per-source weekly quota, plus the exhaustion policy. `fallback_policy` accepts
-- the full v2-8 vocabulary (skip | use_another_source | use_company_profile |
-- allow_reuse) so later phases need no migration; only 'skip' is implemented
-- today and the service layer rejects the rest.
ALTER TABLE "content_sources"
  ADD COLUMN "posts_per_week" INTEGER,
  ADD COLUMN "fallback_policy" TEXT NOT NULL DEFAULT 'skip';

-- Which quota a generated post was drawn against. NULL = company content.
-- Required because evergreen (prompt/calendar) posts and mission posts both
-- leave primary_feed_item_id NULL, so source attribution cannot be derived.
--
-- ON DELETE SET NULL: deleting a source must never delete posts already written
-- from it.
ALTER TABLE "posts"
  ADD COLUMN "content_source_id" TEXT;

ALTER TABLE "posts"
  ADD CONSTRAINT "posts_content_source_id_fkey"
  FOREIGN KEY ("content_source_id") REFERENCES "content_sources"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Backs the scheduler's per-run "what has this week generated, and from where"
-- count, which runs before every generation.
CREATE INDEX "posts_schedule_id_channel_content_source_id_idx"
  ON "posts"("schedule_id", "channel", "content_source_id");
