-- =============================================================================
-- Post origin snapshot
--
-- Freezes what a post was written from, at generation time, on the post row
-- itself. The existing relations cannot answer this durably: deleting a content
-- source cascades to its feed items, which nulls posts.primary_feed_item_id and
-- SetNulls posts.content_source_id, and renaming a source retroactively
-- relabels every post ever drawn from it.
--
-- Written by hand rather than by `prisma migrate dev`: shadow-database replay
-- fails on 20260710000001_sync_db_push_changes, which is itself a hand-written
-- baseline registered with `migrate resolve --applied`. Same pattern here.
-- =============================================================================

-- CreateEnum
CREATE TYPE "PostOriginType" AS ENUM ('brand_setup', 'content_source');

-- AlterTable
ALTER TABLE "posts" ADD COLUMN     "origin_type" "PostOriginType",
ADD COLUMN     "origin_source_name" TEXT,
ADD COLUMN     "origin_source_title" TEXT,
ADD COLUMN     "origin_source_url" TEXT;

-- Backfill: freeze the CURRENT origin of every pre-existing post that still has
-- a live article behind it, so a later rename or delete cannot rewrite its
-- history either.
--
-- Posts with no live article are deliberately LEFT NULL rather than stamped
-- 'brand_setup'. A mission post and a post whose source was already deleted are
-- indistinguishable from this side of the migration, and asserting the wrong one
-- would freeze a lie. NULL keeps them on the fallback path, where they display
-- exactly as they do today.
UPDATE "posts" p
SET "origin_type"         = 'content_source',
    "origin_source_name"  = cs."name",
    "origin_source_title" = fi."title",
    "origin_source_url"   = fi."url"
FROM "feed_items" fi
JOIN "content_sources" cs ON cs."id" = fi."source_id"
WHERE p."primary_feed_item_id" = fi."id"
  AND p."origin_type" IS NULL;
