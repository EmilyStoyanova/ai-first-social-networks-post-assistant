-- =============================================================================
-- Post origin: source type
--
-- Completes the origin snapshot with the KIND of source a post came from, so
-- the badge can read "RSS · TechPowerUp" instead of a bare name. The type is
-- copied in alongside the name and frozen with it — reading it live would
-- reintroduce exactly the mutability the snapshot exists to prevent.
--
-- Hand-written for the same reason as 20260806000000: `prisma migrate dev`
-- cannot replay this repo's history against a shadow database.
-- =============================================================================

-- AlterTable
ALTER TABLE "posts" ADD COLUMN     "origin_source_type" "ContentSourceType";

-- Backfill: posts whose origin was already frozen as a content source, and whose
-- article is still live, can have their type recovered from the source row. This
-- includes everything 20260806000000 backfilled a moment ago.
--
-- Posts whose article is gone keep a NULL type. Their name and URL survive from
-- the earlier backfill, so the badge falls back to showing the name alone —
-- degraded, never wrong.
UPDATE "posts" p
SET "origin_source_type" = cs."type"
FROM "feed_items" fi
JOIN "content_sources" cs ON cs."id" = fi."source_id"
WHERE p."primary_feed_item_id" = fi."id"
  AND p."origin_type" = 'content_source'
  AND p."origin_source_type" IS NULL;
