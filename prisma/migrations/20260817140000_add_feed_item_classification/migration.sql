-- =============================================================================
-- Topic classification on feed_items
--
-- Every RSS article gets a verdict — HIGH | MEDIUM | REJECTED — against the topic
-- priorities the company configured on brand_guidelines
-- (20260817130000_add_brand_topic_priorities). See lib/ai/feed-item-classification.ts.
--
-- The columns mirror the translation and extraction blocks above them, for the
-- same reasons: `title`/`content` stay the untouched article text and the derived
-- result lives beside them, with its own status, its own input hash, its own
-- attempt counter and its own lease.
--
-- Every column is NULLABLE and every existing row therefore reads as "no verdict".
-- That is the backwards-compatibility contract and it is deliberate: NULL
-- classification means "no signal", NOT "rejected". A company that never opens the
-- new Brand Settings section must keep seeing exactly the articles it saw before,
-- so nothing here is backfilled to a verdict and no article is filtered by this
-- migration alone.
--
-- Written by hand rather than by `prisma migrate dev`: shadow-database replay
-- fails on 20260710000001_sync_db_push_changes, which is itself a hand-written
-- baseline registered with `migrate resolve --applied`. Same pattern here.
-- =============================================================================

-- AlterTable
ALTER TABLE "feed_items"
  ADD COLUMN "classification" TEXT,
  ADD COLUMN "classification_rejection_reason" TEXT,
  ADD COLUMN "classification_matched_topics" TEXT[],
  ADD COLUMN "classification_reason" TEXT,
  ADD COLUMN "classification_status" TEXT,
  ADD COLUMN "classification_hash" TEXT,
  ADD COLUMN "classification_error" TEXT,
  ADD COLUMN "classified_at" TIMESTAMP(3),
  ADD COLUMN "classification_provider" TEXT,
  ADD COLUMN "classification_model" TEXT,
  ADD COLUMN "classification_attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "classification_lease_expires_at" TIMESTAMP(3);

-- Existing rows have matched nothing, as an empty list rather than an absence.
UPDATE "feed_items"
  SET "classification_matched_topics" = ARRAY[]::TEXT[]
  WHERE "classification_matched_topics" IS NULL;

-- CreateIndex: the drain — eligible items, oldest first.
CREATE INDEX "feed_items_classification_status_created_at_idx"
  ON "feed_items"("classification_status", "created_at");

-- CreateIndex: recovery — in-flight claims whose lease has expired.
CREATE INDEX "feed_items_classification_status_classification_lease_expi_idx"
  ON "feed_items"("classification_status", "classification_lease_expires_at");
