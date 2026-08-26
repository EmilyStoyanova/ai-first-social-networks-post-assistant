ALTER TABLE "feed_items"
ADD COLUMN IF NOT EXISTS "classification_chunk_progress" JSONB;
