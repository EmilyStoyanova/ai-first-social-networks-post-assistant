-- AlterTable
ALTER TABLE "posts" ADD COLUMN "primary_feed_item_id" TEXT;

-- CreateIndex
-- One feed item may back at most one post (one-post-per-article, V2). NULLs are
-- distinct in Postgres, so mission/brand posts with no source article are unaffected.
CREATE UNIQUE INDEX "posts_primary_feed_item_id_key" ON "posts"("primary_feed_item_id");

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_primary_feed_item_id_fkey" FOREIGN KEY ("primary_feed_item_id") REFERENCES "feed_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
