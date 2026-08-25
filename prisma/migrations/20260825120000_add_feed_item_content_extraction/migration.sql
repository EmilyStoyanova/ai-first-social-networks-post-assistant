-- Provenance for the ARTICLE BODY stored in feed_items.content.
--
-- Every column is nullable with no default on purpose: existing rows must read
-- as "unknown", never as "incomplete". The generation gate admits NULL, so the
-- archive stays usable and only newly ingested summary-only items are held back.
ALTER TABLE "feed_items" ADD COLUMN "content_extraction" TEXT;
ALTER TABLE "feed_items" ADD COLUMN "content_chars" INTEGER;
ALTER TABLE "feed_items" ADD COLUMN "content_complete" BOOLEAN;
ALTER TABLE "feed_items" ADD COLUMN "content_extraction_error" TEXT;
ALTER TABLE "feed_items" ADD COLUMN "content_extracted_at" TIMESTAMP(3);

-- Deliberately no index. The candidate window always filters company + enabled +
-- used_in_post first, which narrows a company's feed to a set small enough that
-- this column is a filter over already-fetched rows. A partial index would also
-- not be expressible in schema.prisma (Prisma has no partial-index syntax), so
-- adding one here would show up as permanent drift on every `migrate dev`.
