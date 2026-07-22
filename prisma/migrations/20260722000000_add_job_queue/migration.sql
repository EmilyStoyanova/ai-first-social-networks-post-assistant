-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('queued', 'active', 'completed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "WorkerStatus" AS ENUM ('starting', 'idle', 'busy', 'draining', 'stopped');

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'queued',
    "payload" JSONB NOT NULL,
    "dedupe_key" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "locked_by" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "last_error" TEXT,
    "result" JSONB,
    "company_id" TEXT,
    "created_by" TEXT,
    "cron_run_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "WorkerStatus" NOT NULL DEFAULT 'starting',
    "hostname" TEXT,
    "pid" INTEGER,
    "concurrency" INTEGER NOT NULL DEFAULT 1,
    "metadata" JSONB,
    "last_heartbeat_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stopped_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "jobs_status_run_at_priority_idx" ON "jobs"("status", "run_at", "priority");

-- CreateIndex
CREATE INDEX "jobs_company_id_idx" ON "jobs"("company_id");

-- CreateIndex
CREATE INDEX "jobs_cron_run_id_idx" ON "jobs"("cron_run_id");

-- CreateIndex
-- Partial index backing the atomic claim scan: only queued, ordered best-first.
-- Prisma cannot express partial indexes, so this lives in SQL only.
CREATE INDEX "jobs_claim_idx" ON "jobs"("priority" DESC, "run_at" ASC) WHERE "status" = 'queued';

-- CreateIndex
-- Duplicate-active-job guard: at most one non-terminal job per dedupe_key.
-- Terminal rows (completed/failed/cancelled) and NULL keys are exempt. Partial
-- unique index — Prisma cannot express it, so it lives in SQL only.
CREATE UNIQUE INDEX "jobs_dedupe_active_key" ON "jobs"("dedupe_key") WHERE "status" IN ('queued', 'active') AND "dedupe_key" IS NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "workers_name_key" ON "workers"("name");

-- CreateIndex
CREATE INDEX "workers_status_idx" ON "workers"("status");

-- CreateIndex
CREATE INDEX "workers_last_heartbeat_at_idx" ON "workers"("last_heartbeat_at");
