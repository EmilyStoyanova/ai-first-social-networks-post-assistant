-- =============================================================================
-- Manual bulk generation — batch id
--
-- One id shared by every post produced by a single "generate N posts between
-- these dates" request, so a bulk run's output can be found together after the
-- fact (the HTTP summary is transient; the association must not be).
--
-- Deliberately a single nullable column, not a `bulk_generations` table: a batch
-- carries no state and no lifecycle. Every post is committed independently, is a
-- normal draft, and is reviewed on its own — the only durable fact is which
-- posts came from the same click.
--
-- Additive and nullable, so every existing post (single manual generation and
-- all cron/scheduled posts) keeps reading as "not part of a batch".
--
-- Written by hand rather than by `prisma migrate dev`: shadow-database replay
-- fails on 20260710000001_sync_db_push_changes, which is itself a hand-written
-- baseline registered with `migrate resolve --applied`. Same pattern here.
-- =============================================================================

-- AlterTable
ALTER TABLE "posts" ADD COLUMN "generation_batch_id" TEXT;

-- Backs "show me everything that bulk run produced", which is always asked
-- within one company.
CREATE INDEX "posts_company_id_generation_batch_id_idx"
  ON "posts"("company_id", "generation_batch_id");
