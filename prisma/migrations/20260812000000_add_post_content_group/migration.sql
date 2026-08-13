-- =============================================================================
-- Multi-channel generation — content groups, and one post per (article, channel)
--
-- Two related changes, both additive in effect:
--
-- 1. `content_group_id` — the content TOPIC a post is one channel's version of.
--    One id shared by the Facebook / Instagram / LinkedIn posts written from the
--    same topic in the same request. Nullable, so every existing post (and every
--    cron post from now on) simply reads as ungrouped and renders exactly as it
--    always has. No backfill: an old post has no siblings, and inventing a group
--    of one would be a lie the UI would then have to special-case anyway.
--
--    Deliberately NOT reusing `generation_batch_id`, which answers a different
--    question (which "generate N posts" click produced this) and is load-bearing
--    at publish time (non-NULL means a person named the time — see
--    lib/scheduling/publish-window.ts).
--
-- 2. The one-post-per-article guarantee moves from `primary_feed_item_id` alone
--    to `(primary_feed_item_id, channel)`. One article is ONE topic; a topic may
--    be written once per channel. Two posts on the SAME channel from the same
--    article stay impossible, which is the half of the rule that was ever about
--    avoiding repetition. `used_in_post` on feed_items is unchanged and still
--    means "this article has been consumed as a topic", claimed once per topic.
--
--    Safe on existing data by construction: the old index allowed at most one
--    row per article, so every existing row already satisfies the stricter-keyed
--    composite. Postgres treats NULLs as distinct in a unique index, so the many
--    mission/evergreen posts with NULL primary_feed_item_id are unconstrained
--    under both the old index and the new one.
--
-- Written by hand rather than by `prisma migrate dev`: shadow-database replay
-- fails on 20260710000001_sync_db_push_changes, which is itself a hand-written
-- baseline registered with `migrate resolve --applied`. Same pattern here.
-- =============================================================================

-- AlterTable
ALTER TABLE "posts" ADD COLUMN "content_group_id" TEXT;

-- Backs "which channel versions belong together", always asked within one
-- company. NULL for every ungrouped post.
CREATE INDEX "posts_company_id_content_group_id_idx"
  ON "posts"("company_id", "content_group_id");

-- Replace the single-column guarantee with the per-channel one. Dropped first so
-- the composite is never briefly redundant with a strictly stronger constraint.
DROP INDEX "posts_primary_feed_item_id_key";

CREATE UNIQUE INDEX "posts_primary_feed_item_id_channel_key"
  ON "posts"("primary_feed_item_id", "channel");
