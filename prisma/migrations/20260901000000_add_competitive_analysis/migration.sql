-- Competitive Analysis (Part 3A) — schema foundation.
-- Hand-written per the repo's established P3006 workaround (`prisma migrate
-- dev` cannot replay history in a shadow DB — see cerebrum.md bug-177):
--   $env:DATABASE_URL = <DIRECT_URL>; npx prisma migrate deploy; npx prisma generate
--
-- Revised before first application (never applied to Neon) to make the
-- foundation compatible with social network analysis, a confirmed core
-- product requirement — see schema.prisma's CompetitorSocialProfile /
-- CompetitorSocialItem comments for the full rationale. Edited in place
-- rather than adding a second migration, since this one was never deployed.

-- CreateEnum
-- Named `Social`, not `Link` — see CompetitorSocialProfile's comment.
CREATE TYPE "CompetitorSocialPlatform" AS ENUM ('facebook', 'instagram', 'linkedin', 'tiktok', 'youtube', 'x', 'other');

-- CreateEnum
CREATE TYPE "CompetitorCollectionMode" AS ENUM ('reference_only', 'automatic', 'manual_only');

-- CreateEnum
CREATE TYPE "CompetitorRelevance" AS ENUM ('pending', 'relevant', 'related', 'out_of_scope');

-- CreateEnum
CREATE TYPE "CompetitorContentType" AS ENUM ('blog_post', 'product_update', 'promotion', 'announcement', 'guide', 'video', 'social_post', 'ad', 'other');

-- CreateEnum
CREATE TYPE "CompetitorCommercialIntent" AS ENUM ('informational', 'soft_sell', 'hard_sell', 'promotional');

-- CreateEnum
CREATE TYPE "CompetitorCtaType" AS ENUM ('learn_more', 'sign_up', 'buy_now', 'contact_us', 'download', 'comment_engage', 'none', 'other');

-- CreateEnum
CREATE TYPE "CompetitorAngleCategory" AS ENUM ('problem_solution', 'comparison', 'how_to', 'case_study', 'announcement', 'thought_leadership', 'behind_the_scenes', 'promotion', 'other');

-- CreateEnum
CREATE TYPE "CompetitorHookType" AS ENUM ('question', 'problem', 'bold_claim', 'statistic', 'curiosity', 'story', 'direct_offer', 'announcement', 'none', 'other');

-- CreateEnum
CREATE TYPE "CompetitorStructurePattern" AS ENUM ('problem_solution', 'how_to', 'list', 'story', 'comparison', 'question_answer', 'announcement', 'offer', 'other');

-- AlterEnum
-- Not used by any row this migration writes, so it is safe inside the same
-- transaction as everything else here (the restriction on ALTER TYPE ... ADD
-- VALUE is about USING the new value in the same transaction it was added in).
ALTER TYPE "ContentSourceType" ADD VALUE 'competitor_rss';
ALTER TYPE "ContentSourceType" ADD VALUE 'competitor_website';

-- CreateTable
CREATE TABLE "competitor_research_profiles" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "research_topics" TEXT[],
    "markets" TEXT[],
    "analysis_period_days" INTEGER NOT NULL DEFAULT 90,
    "profile_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "competitor_research_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competitors" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT,
    "website" TEXT,
    "notes" TEXT,
    "archived_at" TIMESTAMP(3),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "competitors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- Renamed from `competitor_links`: not a permanent reference-only hyperlink —
-- see the model comment in schema.prisma. Collection columns default to
-- disabled/reference_only; Part 3A writes nothing to them.
CREATE TABLE "competitor_social_profiles" (
    "id" TEXT NOT NULL,
    "competitor_id" TEXT NOT NULL,
    "platform" "CompetitorSocialPlatform" NOT NULL,
    "url" TEXT NOT NULL,
    "label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "collection_enabled" BOOLEAN NOT NULL DEFAULT false,
    "collection_mode" "CompetitorCollectionMode" NOT NULL DEFAULT 'reference_only',
    "external_profile_id" TEXT,
    "last_collected_at" TIMESTAMP(3),
    "collection_status" TEXT,
    "collection_error" TEXT,

    CONSTRAINT "competitor_social_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competitor_manual_entries" (
    "id" TEXT NOT NULL,
    "competitor_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "post_type" TEXT NOT NULL,
    "url" TEXT,
    "content" TEXT NOT NULL,
    "captured_at" TIMESTAMP(3),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competitor_manual_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- Part 3C's sync destination. Schema foundation only — no creation/sync
-- service exists in Part 3A; see the model comment in schema.prisma.
CREATE TABLE "competitor_social_items" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "competitor_id" TEXT NOT NULL,
    "social_profile_id" TEXT NOT NULL,
    "platform" "CompetitorSocialPlatform" NOT NULL,
    "external_item_id" TEXT,
    "content" TEXT,
    "url" TEXT,
    "published_at" TIMESTAMP(3),
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "competitor_social_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competitor_intelligence" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "competitor_id" TEXT NOT NULL,
    "feed_item_id" TEXT,
    "manual_entry_id" TEXT,
    "social_item_id" TEXT,
    "topic" TEXT,
    "subtopic" TEXT,
    "summary" TEXT,
    "angle" TEXT,
    "target_audience" TEXT,
    "problem_addressed" TEXT,
    "key_message" TEXT,
    "tone" TEXT,
    "cta_text" TEXT,
    "content_type" "CompetitorContentType",
    "commercial_intent" "CompetitorCommercialIntent",
    "cta_type" "CompetitorCtaType",
    "angle_category" "CompetitorAngleCategory",
    "hook_type" "CompetitorHookType",
    "structure_pattern" "CompetitorStructurePattern",
    "products_services_mentioned" TEXT[],
    "original_language" TEXT,
    "relevance" "CompetitorRelevance" NOT NULL DEFAULT 'pending',
    "relevance_reason" TEXT,
    "matched_research_topics" TEXT[],
    "relevance_profile_version" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "analysis_hash" TEXT,
    "analysis_error" TEXT,
    "analyzed_at" TIMESTAMP(3),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "lease_expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "competitor_intelligence_pkey" PRIMARY KEY ("id")
);

-- AlterTable
-- Nullable, additive — every existing row gets NULL, meaning "not a competitor
-- source" (the only possible value until Part 3B writes to it).
ALTER TABLE "content_sources" ADD COLUMN "competitor_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "competitor_research_profiles_company_id_key" ON "competitor_research_profiles"("company_id");

-- CreateIndex
CREATE INDEX "competitors_company_id_idx" ON "competitors"("company_id");

-- CreateIndex
CREATE INDEX "competitor_social_profiles_competitor_id_idx" ON "competitor_social_profiles"("competitor_id");

-- CreateIndex
CREATE INDEX "competitor_manual_entries_competitor_id_idx" ON "competitor_manual_entries"("competitor_id");

-- CreateIndex
CREATE INDEX "competitor_manual_entries_company_id_idx" ON "competitor_manual_entries"("company_id");

-- CreateIndex
-- Dedup key: NULLs are distinct in a Postgres unique index, so this only
-- constrains rows where the platform's own item id is actually known.
CREATE UNIQUE INDEX "competitor_social_items_social_profile_id_external_item_id_key" ON "competitor_social_items"("social_profile_id", "external_item_id");

-- CreateIndex
CREATE INDEX "competitor_social_items_company_id_competitor_id_idx" ON "competitor_social_items"("company_id", "competitor_id");

-- CreateIndex
CREATE INDEX "competitor_social_items_social_profile_id_idx" ON "competitor_social_items"("social_profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "competitor_intelligence_feed_item_id_key" ON "competitor_intelligence"("feed_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "competitor_intelligence_manual_entry_id_key" ON "competitor_intelligence"("manual_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "competitor_intelligence_social_item_id_key" ON "competitor_intelligence"("social_item_id");

-- CreateIndex
CREATE INDEX "competitor_intelligence_company_id_competitor_id_idx" ON "competitor_intelligence"("company_id", "competitor_id");

-- CreateIndex
CREATE INDEX "competitor_intelligence_company_id_relevance_idx" ON "competitor_intelligence"("company_id", "relevance");

-- CreateIndex
CREATE INDEX "content_sources_competitor_id_idx" ON "content_sources"("competitor_id");

-- AddForeignKey
ALTER TABLE "competitor_research_profiles" ADD CONSTRAINT "competitor_research_profiles_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitors" ADD CONSTRAINT "competitors_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitor_social_profiles" ADD CONSTRAINT "competitor_social_profiles_competitor_id_fkey" FOREIGN KEY ("competitor_id") REFERENCES "competitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitor_manual_entries" ADD CONSTRAINT "competitor_manual_entries_competitor_id_fkey" FOREIGN KEY ("competitor_id") REFERENCES "competitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitor_manual_entries" ADD CONSTRAINT "competitor_manual_entries_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitor_social_items" ADD CONSTRAINT "competitor_social_items_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitor_social_items" ADD CONSTRAINT "competitor_social_items_competitor_id_fkey" FOREIGN KEY ("competitor_id") REFERENCES "competitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitor_social_items" ADD CONSTRAINT "competitor_social_items_social_profile_id_fkey" FOREIGN KEY ("social_profile_id") REFERENCES "competitor_social_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitor_intelligence" ADD CONSTRAINT "competitor_intelligence_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitor_intelligence" ADD CONSTRAINT "competitor_intelligence_competitor_id_fkey" FOREIGN KEY ("competitor_id") REFERENCES "competitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitor_intelligence" ADD CONSTRAINT "competitor_intelligence_feed_item_id_fkey" FOREIGN KEY ("feed_item_id") REFERENCES "feed_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitor_intelligence" ADD CONSTRAINT "competitor_intelligence_manual_entry_id_fkey" FOREIGN KEY ("manual_entry_id") REFERENCES "competitor_manual_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitor_intelligence" ADD CONSTRAINT "competitor_intelligence_social_item_id_fkey" FOREIGN KEY ("social_item_id") REFERENCES "competitor_social_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_sources" ADD CONSTRAINT "content_sources_competitor_id_fkey" FOREIGN KEY ("competitor_id") REFERENCES "competitors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateConstraint
-- Exactly ONE of feed_item_id / manual_entry_id / social_item_id must be set.
-- Prisma cannot express this, so it lives only here — see the
-- CompetitorIntelligence model comment in schema.prisma. `num_nonnulls` is
-- Postgres's own built-in for "how many of these are non-null" (9.5+); using
-- it instead of a hand-expanded 3-way XOR keeps the expression readable and
-- correct by construction as more origins are ever added.
ALTER TABLE "competitor_intelligence" ADD CONSTRAINT "competitor_intelligence_exactly_one_origin" CHECK (num_nonnulls("feed_item_id", "manual_entry_id", "social_item_id") = 1);
