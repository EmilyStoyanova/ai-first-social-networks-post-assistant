-- =============================================================================
-- Baseline migration: consolidates all schema changes applied via `db push`
-- after the last tracked migration (20260707085552_add_email_verification).
-- This file was created manually with `migrate resolve --applied` to register
-- changes that are already present in the database.
-- =============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- ChannelConfig: add Buffer profile fields + is_active
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE "channel_configs"
  ADD COLUMN "buffer_profile_id"   TEXT,
  ADD COLUMN "buffer_profile_name" TEXT,
  ADD COLUMN "is_active"           BOOLEAN NOT NULL DEFAULT true;

-- Change enabled default from true to false (channels disabled until Buffer syncs)
ALTER TABLE "channel_configs" ALTER COLUMN "enabled" SET DEFAULT false;

-- Replace old unique (company_id, channel) with (company_id, buffer_profile_id)
DROP INDEX IF EXISTS "channel_configs_company_id_channel_key";

CREATE UNIQUE INDEX "channel_configs_company_id_buffer_profile_id_key"
  ON "channel_configs"("company_id", "buffer_profile_id");

CREATE INDEX "channel_configs_company_id_is_active_idx"
  ON "channel_configs"("company_id", "is_active");

-- ────────────────────────────────────────────────────────────────────────────
-- BufferConnection: add token expiry, sync timestamp, and audit timestamps
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE "buffer_connections"
  ADD COLUMN "token_expires_at"     TIMESTAMP(3),
  ADD COLUMN "last_profile_sync_at" TIMESTAMP(3),
  ADD COLUMN "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updated_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- ────────────────────────────────────────────────────────────────────────────
-- Post: add direct link to the published social media post
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE "posts"
  ADD COLUMN "published_post_url" TEXT;

-- ────────────────────────────────────────────────────────────────────────────
-- FeedItem: allow per-article enable/disable (enabled = true by default)
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE "feed_items"
  ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true;
