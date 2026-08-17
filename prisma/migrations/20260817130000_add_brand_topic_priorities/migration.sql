-- =============================================================================
-- Topic priorities on brand_guidelines
--
-- Three ordered lists of subjects a company cares about, edited in Brand
-- Settings and read back as HIGH / MEDIUM / REJECTED (lib/ai/topic-priorities.ts)
-- by the RSS article classifier that comes next.
--
-- They live on brand_guidelines rather than in a table of their own because they
-- are brand configuration in exactly the sense forbidden_words and competitors
-- already are: a fixed, small, per-company set of strings with no lifecycle,
-- no ordering to persist and nothing to reference. A join table would add three
-- queries and a second settings system for data the existing 1:1 row holds.
--
-- Declared as plain TEXT[] to match forbidden_words / competitors: Prisma reads
-- a NULL list as [], so a company that never touches the new section behaves
-- exactly as it did. The backfill makes that explicit anyway, so "never
-- configured" is stored as an empty list rather than as an absence.
--
-- Written by hand rather than by `prisma migrate dev`: shadow-database replay
-- fails on 20260710000001_sync_db_push_changes, which is itself a hand-written
-- baseline registered with `migrate resolve --applied`. Same pattern here.
-- =============================================================================

-- AlterTable
ALTER TABLE "brand_guidelines"
  ADD COLUMN "top_priority_topics" TEXT[],
  ADD COLUMN "medium_priority_topics" TEXT[],
  ADD COLUMN "avoided_topics" TEXT[];

-- Backfill: an existing company has configured no topics, in every group.
UPDATE "brand_guidelines"
  SET "top_priority_topics" = ARRAY[]::TEXT[]
  WHERE "top_priority_topics" IS NULL;

UPDATE "brand_guidelines"
  SET "medium_priority_topics" = ARRAY[]::TEXT[]
  WHERE "medium_priority_topics" IS NULL;

UPDATE "brand_guidelines"
  SET "avoided_topics" = ARRAY[]::TEXT[]
  WHERE "avoided_topics" IS NULL;
