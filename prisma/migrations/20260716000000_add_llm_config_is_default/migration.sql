-- AlterTable
-- Multi-active LLM providers: `is_active` now only means "available for use" and
-- several configs may be active at once. A separate `is_default` flag marks the
-- single system default ("Auto"). Backfill the previously-active config (there was
-- at most one, since activation used to be exclusive) as the default so existing
-- installs keep their current "Auto" behaviour.
ALTER TABLE "llm_configs" ADD COLUMN "is_default" BOOLEAN NOT NULL DEFAULT false;

UPDATE "llm_configs" SET "is_default" = true WHERE "is_active" = true;
