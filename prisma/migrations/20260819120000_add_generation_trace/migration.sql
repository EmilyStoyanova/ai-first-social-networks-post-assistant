-- =============================================================================
-- Generation trace: generation_runs + generation_steps
--
-- A persistent, per-Post record of every step an AI generation actually took,
-- from the trigger that asked for it to the row that was written.
--
-- The design rule these two tables exist to enforce is that a trace is a
-- SNAPSHOT, never a view. Nothing here points at live configuration: brand
-- guidelines, channel settings, topic priorities and the exact prompts are
-- COPIED IN as JSON at the moment they were used, so editing any of them
-- tomorrow cannot rewrite the history of a post generated today. The only
-- foreign keys are identity ones (which post, which company, which article) and
-- they exist to FIND a trace, never to reconstruct one.
--
-- Nothing is backfilled. Every post generated before this migration simply has
-- no run, and the admin UI says so — a reconstructed trace would be exactly the
-- lie the snapshot rule is here to prevent.
--
-- Written by hand rather than by `prisma migrate dev`: shadow-database replay
-- fails on 20260710000001_sync_db_push_changes, which is itself a hand-written
-- baseline registered with `migrate resolve --applied`. Same pattern here.
-- =============================================================================

-- CreateEnum
CREATE TYPE "GenerationRunKind" AS ENUM ('post_generation', 'translation', 'classification', 'extraction', 'image');

-- CreateEnum
CREATE TYPE "GenerationTrigger" AS ENUM ('manual', 'manual_multi_channel', 'bulk', 'cron', 'preview', 'system');

-- CreateEnum
CREATE TYPE "GenerationRunStatus" AS ENUM ('running', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "GenerationStepStatus" AS ENUM ('success', 'failed', 'skipped');

-- CreateTable
CREATE TABLE "generation_runs" (
    "id" TEXT NOT NULL,
    "company_id" TEXT,
    "post_id" TEXT,
    "feed_item_id" TEXT,
    "kind" "GenerationRunKind" NOT NULL,
    "trigger" "GenerationTrigger" NOT NULL,
    "status" "GenerationRunStatus" NOT NULL DEFAULT 'running',
    "channel" "SocialChannel",
    "language" TEXT,
    "user_id" TEXT,
    "content_group_id" TEXT,
    "generation_batch_id" TEXT,
    "schedule_id" TEXT,
    "job_id" TEXT,
    "llm_provider" TEXT,
    "llm_model" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "error_code" TEXT,
    "error_message" TEXT,
    "options" JSONB,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_steps" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "label" TEXT,
    "status" "GenerationStepStatus" NOT NULL,
    "attempt" INTEGER,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "input" JSONB,
    "output" JSONB,
    "metadata" JSONB,
    "error_message" TEXT,
    "linked_run_id" TEXT,

    CONSTRAINT "generation_steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "generation_runs_post_id_idx" ON "generation_runs"("post_id");

-- CreateIndex
CREATE INDEX "generation_runs_company_id_started_at_idx" ON "generation_runs"("company_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "generation_runs_feed_item_id_kind_started_at_idx" ON "generation_runs"("feed_item_id", "kind", "started_at" DESC);

-- CreateIndex
CREATE INDEX "generation_runs_content_group_id_idx" ON "generation_runs"("content_group_id");

-- CreateIndex
CREATE INDEX "generation_runs_generation_batch_id_idx" ON "generation_runs"("generation_batch_id");

-- CreateIndex
CREATE INDEX "generation_steps_run_id_sequence_idx" ON "generation_steps"("run_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "generation_steps_run_id_sequence_key" ON "generation_steps"("run_id", "sequence");

-- AddForeignKey
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_feed_item_id_fkey" FOREIGN KEY ("feed_item_id") REFERENCES "feed_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_steps" ADD CONSTRAINT "generation_steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "generation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
