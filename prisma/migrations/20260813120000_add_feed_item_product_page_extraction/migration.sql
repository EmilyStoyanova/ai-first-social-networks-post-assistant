-- Product-page extraction (see lib/ai/product-page-extraction.ts).
--
-- The extracted result lives beside the raw scrape rather than replacing it:
-- `content` keeps the scraped page, exactly as translation keeps the original
-- article in `title`/`content` and writes only to its own columns.
--
-- Every column is nullable (or defaulted) so existing feed items — every item of
-- every other source type — stay valid and untouched.
ALTER TABLE "feed_items"
  ADD COLUMN "extracted_content" TEXT,
  ADD COLUMN "extraction_status" TEXT,
  ADD COLUMN "extraction_hash" TEXT,
  ADD COLUMN "extraction_error" TEXT,
  ADD COLUMN "extracted_at" TIMESTAMP(3),
  ADD COLUMN "extraction_attempt_count" INTEGER NOT NULL DEFAULT 0;

-- Drives the extraction drain: pending items, oldest first.
CREATE INDEX "feed_items_extraction_status_created_at_idx"
  ON "feed_items" ("extraction_status", "created_at");
