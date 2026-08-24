ALTER TABLE "feed_items"
ADD COLUMN IF NOT EXISTS "translation_progress" JSONB;
