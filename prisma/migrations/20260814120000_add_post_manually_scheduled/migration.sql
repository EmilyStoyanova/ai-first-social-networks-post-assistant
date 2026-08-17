-- =============================================================================
-- The publisher's discriminator, as a column of its own
--
-- "Did a PERSON name this post's publish time, or did the weekly filler
-- estimate one for it?" decides whether `scheduled_for` may be brought forward
-- (an estimate) or must be waited for and then parked if missed (a promise).
-- See lib/scheduling/publish-window.ts.
--
-- Until now that question was answered by `generation_batch_id IS NOT NULL`,
-- which worked only because manual BULK generation was the single way a person
-- could name a time. A single post can now be scheduled at generation and from
-- its own card, and neither of those is a batch — so the fact gets stored
-- directly rather than inferred from an association that no longer implies it.
--
-- The backfill is what makes the swap lossless: every existing bulk post keeps
-- being treated exactly as it was, and every cron/unscheduled post keeps the
-- FALSE default. No post changes behaviour at the moment this runs.
--
-- Written by hand rather than by `prisma migrate dev`: shadow-database replay
-- fails on 20260710000001_sync_db_push_changes, which is itself a hand-written
-- baseline registered with `migrate resolve --applied`. Same pattern here.
-- =============================================================================

-- AlterTable
ALTER TABLE "posts"
  ADD COLUMN "manually_scheduled" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: a batch post's time was always a person's choice.
UPDATE "posts"
  SET "manually_scheduled" = true
  WHERE "generation_batch_id" IS NOT NULL;
