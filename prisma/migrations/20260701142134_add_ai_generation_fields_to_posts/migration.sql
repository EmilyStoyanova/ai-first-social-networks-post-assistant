-- AlterTable
ALTER TABLE "posts" ADD COLUMN     "image_prompt" TEXT,
ADD COLUMN     "llm_model" TEXT,
ADD COLUMN     "llm_provider" TEXT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "prompt_snapshot" JSONB;
