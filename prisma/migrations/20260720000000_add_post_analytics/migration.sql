-- CreateEnum
CREATE TYPE "MetricSyncStatus" AS ENUM ('ok', 'no_data', 'forbidden', 'not_found', 'error');

-- AlterTable
ALTER TABLE "buffer_connections" ADD COLUMN     "analytics_key_added_at" TIMESTAMP(3),
ADD COLUMN     "analytics_key_enc" TEXT,
ADD COLUMN     "analytics_key_last4" TEXT,
ADD COLUMN     "analytics_key_last_valid_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "post_metrics" (
    "id" TEXT NOT NULL,
    "post_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "channel_service" TEXT,
    "reactions" INTEGER,
    "comments" INTEGER,
    "shares" INTEGER,
    "impressions" INTEGER,
    "clicks" INTEGER,
    "reach" INTEGER,
    "views" INTEGER,
    "saves" INTEGER,
    "follows" INTEGER,
    "engagement_rate" DOUBLE PRECISION,
    "engagement_rate_denominator" TEXT,
    "raw" JSONB,
    "metrics_updated_at" TIMESTAMP(3),
    "collected_at" TIMESTAMP(3) NOT NULL,
    "sync_status" "MetricSyncStatus" NOT NULL DEFAULT 'ok',
    "sync_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "post_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_metric_snapshots" (
    "id" TEXT NOT NULL,
    "post_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "channel_service" TEXT,
    "reactions" INTEGER,
    "comments" INTEGER,
    "shares" INTEGER,
    "impressions" INTEGER,
    "clicks" INTEGER,
    "reach" INTEGER,
    "views" INTEGER,
    "saves" INTEGER,
    "follows" INTEGER,
    "engagement_rate" DOUBLE PRECISION,
    "engagement_rate_denominator" TEXT,
    "snapshot_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_metric_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "post_metrics_post_id_key" ON "post_metrics"("post_id");

-- CreateIndex
CREATE INDEX "post_metrics_company_id_collected_at_idx" ON "post_metrics"("company_id", "collected_at");

-- CreateIndex
CREATE INDEX "post_metric_snapshots_post_id_snapshot_at_idx" ON "post_metric_snapshots"("post_id", "snapshot_at" DESC);

-- CreateIndex
CREATE INDEX "post_metric_snapshots_company_id_snapshot_at_idx" ON "post_metric_snapshots"("company_id", "snapshot_at");

-- CreateIndex
CREATE UNIQUE INDEX "post_metric_snapshots_post_id_snapshot_at_key" ON "post_metric_snapshots"("post_id", "snapshot_at");

-- AddForeignKey
ALTER TABLE "post_metrics" ADD CONSTRAINT "post_metrics_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_metric_snapshots" ADD CONSTRAINT "post_metric_snapshots_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

