-- Automatic image generation (per channel).
-- Additive and opt-in: DEFAULT false means existing channels keep the
-- manual-only behaviour and no image credits are spent because of this
-- migration. NOT NULL is safe precisely because of that default.
ALTER TABLE "channel_configs"
  ADD COLUMN "auto_generate_image" BOOLEAN NOT NULL DEFAULT false;
