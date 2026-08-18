-- =============================================================================
-- Primary topic and main subject on feed_items
--
-- Two columns that make a verdict checkable, added because HIGH and MEDIUM were
-- not reliably distinguishable. The validator used to accept a tier as long as
-- ANY cited topic belonged to it, so an article mainly about a medium topic that
-- mentioned a top-priority one in passing was promoted to HIGH. Naming the single
-- dominant topic forces the choice that test was silently getting wrong.
--
--   classification_primary_topic — the ONE configured topic the verdict rests on,
--     in its stored spelling. NULL for OUT_OF_SCOPE. Its tier now decides the
--     verdict: top→HIGH, medium→MEDIUM, avoided→BLACKLIST.
--
--   classification_main_subject  — what the classifier judged the article to be
--     about, in its own words. A fact about the article, not an argument for the
--     verdict (classification_reason is that). Asked for first and separately,
--     because naming the subject before reaching for a topic is what stops the
--     reach; kept as the operator's diagnostic.
--
-- See lib/ai/feed-item-classification.ts.
--
-- Both NULLABLE, and nothing is backfilled. Every row classified before this
-- migration keeps its verdict and simply shows no diagnostic — a backfill would
-- have to invent a primary topic, which is precisely the failure mode above. Such
-- a row is re-judged only when it is reopened by the existing paths (a topic or
-- brand-copy change, or "Reclassify this source"); this migration reopens nothing.
--
-- Written by hand rather than by `prisma migrate dev`: shadow-database replay
-- fails on 20260710000001_sync_db_push_changes, which is itself a hand-written
-- baseline registered with `migrate resolve --applied`. Same pattern here.
-- =============================================================================

-- AlterTable
ALTER TABLE "feed_items"
  ADD COLUMN "classification_main_subject" TEXT,
  ADD COLUMN "classification_primary_topic" TEXT;
