-- v2-4: RSS Translation via LLM.
-- Original `title`/`content` are never modified; translated text lives in its own
-- columns and is only used by generation when translation_status = 'completed'.
ALTER TABLE "feed_items"
  ADD COLUMN "translated_title" TEXT,
  ADD COLUMN "translated_content" TEXT,
  ADD COLUMN "translation_language" TEXT,
  ADD COLUMN "translation_status" TEXT,
  ADD COLUMN "translation_hash" TEXT,
  ADD COLUMN "translation_error" TEXT,
  ADD COLUMN "translated_at" TIMESTAMP(3),
  ADD COLUMN "translation_provider" TEXT,
  ADD COLUMN "translation_model" TEXT,
  ADD COLUMN "translation_attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "translation_last_attempt_at" TIMESTAMP(3),
  ADD COLUMN "translation_next_retry_at" TIMESTAMP(3);

-- Eligibility scan for the bounded cron translation step.
CREATE INDEX "feed_items_translation_status_translation_next_retry_at_idx"
  ON "feed_items" ("translation_status", "translation_next_retry_at");
