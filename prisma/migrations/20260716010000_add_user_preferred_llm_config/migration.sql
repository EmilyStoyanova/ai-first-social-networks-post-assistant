-- AlterTable
-- Per-user preferred LLM config. Nullable = "use system default". The FK is
-- ON DELETE SET NULL so deleting a config never orphans the preference — the user
-- transparently falls back to the admin default at generation time.
ALTER TABLE "users" ADD COLUMN "preferred_llm_config_id" TEXT;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_preferred_llm_config_id_fkey" FOREIGN KEY ("preferred_llm_config_id") REFERENCES "llm_configs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
