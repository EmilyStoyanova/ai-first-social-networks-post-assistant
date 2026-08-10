-- =============================================================================
-- Source article image
--
-- Lets a post swap its AI-generated image for the main image of the RSS article
-- it was written from, and swap back.
--
--   feed_items.source_image_url        the article's own image, resolved once at
--                                      ingestion so the page is never re-scraped
--   media_assets.source_url            where an IMPORTED asset came from — the
--                                      dedupe key, and how the UI knows the
--                                      attached image is the article's
--   posts.previous_media_asset_id      the image displaced by the last switch,
--                                      so going back costs nothing
--
-- Every column is nullable with no default and nothing is backfilled: existing
-- feed items simply do not offer the action, and existing posts keep exactly the
-- image they have. A backfill would mean re-fetching every historical article,
-- which this migration deliberately does not do — ingestion fills the value in
-- on each source's next run.
--
-- Hand-written for the same reason as 20260806000000: `prisma migrate dev`
-- cannot replay this repo's history against a shadow database.
-- =============================================================================

-- AlterTable
ALTER TABLE "feed_items" ADD COLUMN     "source_image_url" TEXT;

-- AlterTable
ALTER TABLE "media_assets" ADD COLUMN     "source_url" TEXT;

-- AlterTable
ALTER TABLE "posts" ADD COLUMN     "previous_media_asset_id" TEXT;

-- CreateIndex
CREATE INDEX "media_assets_company_id_source_url_idx" ON "media_assets"("company_id", "source_url");

-- AddForeignKey
-- No cascade, matching posts.media_asset_id: deleting an image must never delete
-- the post. delete-media.service nulls both pointers before removing the row.
ALTER TABLE "posts" ADD CONSTRAINT "posts_previous_media_asset_id_fkey" FOREIGN KEY ("previous_media_asset_id") REFERENCES "media_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
