-- AlterTable
-- Phase 1.1: dedicated column for the post's central claim/takeaway. Nullable so
-- existing rows predating this column remain valid (no backfill). Value is also
-- mirrored in prompt_snapshot.coreMessage for audit/debugging.
ALTER TABLE "posts" ADD COLUMN "core_message" TEXT;
