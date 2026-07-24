-- v2-9: atomic per-item translation claim (lease).
-- A claim transitions an eligible feed item to translation_status = 'translating'
-- and stamps a lease expiry. Only the run whose conditional UPDATE matches one row
-- owns the item; concurrent runs match zero rows and skip, so the same article is
-- never translated twice at once. A crashed worker's claim becomes reclaimable once
-- its lease expires.
ALTER TABLE "feed_items"
  ADD COLUMN "translation_lease_expires_at" TIMESTAMP(3);

-- Recovery scan: find in-flight claims ('translating') whose lease has expired.
CREATE INDEX "feed_items_translation_status_translation_lease_expires_at_idx"
  ON "feed_items" ("translation_status", "translation_lease_expires_at");
