-- Refactor: LlmConfig now stores ONLY runtime state (active/default) per provider.
-- Credentials, worker URLs, and model names move to environment variables / code.
-- Migration path: the isActive/isDefault runtime state is preserved; stored API
-- keys, base URLs, and model names are intentionally discarded (they are supplied
-- by deployment secrets from now on). User preferences (FK) survive the dedupe via
-- ON DELETE SET NULL.

-- 1. Collapse to a single row per provider. Keep the "best" row using a strict
--    total order: default first, then active, then newest, then id as a tiebreak,
--    so exactly one row per provider survives.
DELETE FROM "llm_configs" a
USING "llm_configs" b
WHERE a."provider" = b."provider"
  AND a."id" <> b."id"
  AND (b."is_default", b."is_active", b."created_at", b."id")
    > (a."is_default", a."is_active", a."created_at", a."id");

-- 2. Drop credential/model columns — these now come from env only.
ALTER TABLE "llm_configs" DROP CONSTRAINT "llm_configs_created_by_fkey";
ALTER TABLE "llm_configs" DROP COLUMN "created_by";
ALTER TABLE "llm_configs" DROP COLUMN "api_key_enc";
ALTER TABLE "llm_configs" DROP COLUMN "base_url";
ALTER TABLE "llm_configs" DROP COLUMN "model_name";

-- 3. Enforce one runtime-state row per provider.
CREATE UNIQUE INDEX "llm_configs_provider_key" ON "llm_configs"("provider");
