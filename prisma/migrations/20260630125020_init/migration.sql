-- CreateEnum
CREATE TYPE "Role" AS ENUM ('owner', 'editor');

-- CreateEnum
CREATE TYPE "AutomationMode" AS ENUM ('semi_automated', 'fully_automated');

-- CreateEnum
CREATE TYPE "SocialChannel" AS ENUM ('facebook', 'linkedin', 'instagram', 'tiktok');

-- CreateEnum
CREATE TYPE "HashtagStyle" AS ENUM ('inline', 'end_of_post', 'none');

-- CreateEnum
CREATE TYPE "ContentSourceType" AS ENUM ('rss', 'prompt', 'product_page', 'calendar_event');

-- CreateEnum
CREATE TYPE "MediaSource" AS ENUM ('user_upload', 'ai');

-- CreateEnum
CREATE TYPE "ScheduleStatus" AS ENUM ('generating', 'ready', 'completed');

-- CreateEnum
CREATE TYPE "PostStatus" AS ENUM ('draft', 'pending_approval', 'approved', 'rejected', 'sent_to_buffer', 'published', 'failed');

-- CreateEnum
CREATE TYPE "LlmProvider" AS ENUM ('claude', 'openai', 'grok');

-- CreateEnum
CREATE TYPE "CronStatus" AS ENUM ('running', 'completed', 'failed');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT,
    "is_global_admin" BOOLEAN NOT NULL DEFAULT false,
    "preferred_language" TEXT NOT NULL DEFAULT 'en',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "companies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "automation_mode" "AutomationMode" NOT NULL DEFAULT 'semi_automated',
    "default_language" TEXT NOT NULL DEFAULT 'en',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_members" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "invited_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brand_guidelines" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "logo_url" TEXT,
    "colors" JSONB,
    "fonts" JSONB,
    "tones" TEXT[],
    "forbidden_words" TEXT[],
    "target_audience" TEXT,
    "competitors" TEXT[],
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brand_guidelines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_configs" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "channel" "SocialChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "image_required" BOOLEAN,
    "max_text_length" INTEGER,
    "hashtag_style" "HashtagStyle" NOT NULL DEFAULT 'end_of_post',
    "posting_language" TEXT NOT NULL DEFAULT 'en',
    "posts_per_day" INTEGER NOT NULL DEFAULT 1,
    "posts_per_week" INTEGER NOT NULL DEFAULT 5,
    "posting_windows" JSONB,
    "automation_mode_override" "AutomationMode",
    "buffer_profile_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "buffer_connections" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "buffer_user_id" TEXT NOT NULL,
    "access_token_enc" TEXT NOT NULL,
    "refresh_token_enc" TEXT,
    "token_expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "buffer_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_configs" (
    "id" TEXT NOT NULL,
    "provider" "LlmProvider" NOT NULL,
    "model_name" TEXT NOT NULL,
    "api_key_enc" TEXT NOT NULL,
    "base_url" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "llm_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_sources" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "type" "ContentSourceType" NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_fetched_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feed_items" (
    "id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "title" TEXT,
    "content" TEXT,
    "url" TEXT NOT NULL,
    "published_at" TIMESTAMP(3),
    "used_in_post" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feed_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_assets" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "cloudinary_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "thumbnail_url" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "generated_by" "MediaSource" NOT NULL,
    "ai_prompt" TEXT,
    "uploaded_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weekly_schedules" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "week_start" DATE NOT NULL,
    "status" "ScheduleStatus" NOT NULL DEFAULT 'generating',
    "generated_at" TIMESTAMP(3),

    CONSTRAINT "weekly_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "posts" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "schedule_id" TEXT,
    "channel" "SocialChannel" NOT NULL,
    "content" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "hashtags" TEXT[],
    "media_asset_id" TEXT,
    "status" "PostStatus" NOT NULL DEFAULT 'draft',
    "buffer_update_id" TEXT,
    "scheduled_for" TIMESTAMP(3),
    "published_at" TIMESTAMP(3),
    "safety_flagged" BOOLEAN NOT NULL DEFAULT false,
    "safety_flag_reason" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "generated_by" TEXT,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "rejected_by" TEXT,
    "rejected_at" TIMESTAMP(3),
    "rejection_notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_versions" (
    "id" TEXT NOT NULL,
    "post_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "changed_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "company_id" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cron_runs" (
    "id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "status" "CronStatus" NOT NULL DEFAULT 'running',
    "actions_taken" JSONB,
    "error" TEXT,

    CONSTRAINT "cron_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "last_used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "companies_slug_key" ON "companies"("slug");

-- CreateIndex
CREATE INDEX "company_members_user_id_idx" ON "company_members"("user_id");

-- CreateIndex
CREATE INDEX "company_members_company_id_idx" ON "company_members"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "company_members_company_id_user_id_key" ON "company_members"("company_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "brand_guidelines_company_id_key" ON "brand_guidelines"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_configs_company_id_channel_key" ON "channel_configs"("company_id", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "buffer_connections_company_id_key" ON "buffer_connections"("company_id");

-- CreateIndex
CREATE INDEX "feed_items_source_id_idx" ON "feed_items"("source_id");

-- CreateIndex
CREATE UNIQUE INDEX "feed_items_source_id_url_key" ON "feed_items"("source_id", "url");

-- CreateIndex
CREATE INDEX "media_assets_company_id_idx" ON "media_assets"("company_id");

-- CreateIndex
CREATE INDEX "weekly_schedules_company_id_idx" ON "weekly_schedules"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "weekly_schedules_company_id_week_start_key" ON "weekly_schedules"("company_id", "week_start");

-- CreateIndex
CREATE INDEX "posts_company_id_status_idx" ON "posts"("company_id", "status");

-- CreateIndex
CREATE INDEX "posts_scheduled_for_idx" ON "posts"("scheduled_for");

-- CreateIndex
CREATE INDEX "posts_retry_count_status_idx" ON "posts"("retry_count", "status");

-- CreateIndex
CREATE UNIQUE INDEX "post_versions_post_id_version_key" ON "post_versions"("post_id", "version");

-- CreateIndex
CREATE INDEX "audit_logs_company_id_created_at_idx" ON "audit_logs"("company_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_members" ADD CONSTRAINT "company_members_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_members" ADD CONSTRAINT "company_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_guidelines" ADD CONSTRAINT "brand_guidelines_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_configs" ADD CONSTRAINT "channel_configs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "buffer_connections" ADD CONSTRAINT "buffer_connections_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "llm_configs" ADD CONSTRAINT "llm_configs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_sources" ADD CONSTRAINT "content_sources_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "content_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_schedules" ADD CONSTRAINT "weekly_schedules_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "weekly_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_media_asset_id_fkey" FOREIGN KEY ("media_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_generated_by_fkey" FOREIGN KEY ("generated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_rejected_by_fkey" FOREIGN KEY ("rejected_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_versions" ADD CONSTRAINT "post_versions_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_versions" ADD CONSTRAINT "post_versions_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
