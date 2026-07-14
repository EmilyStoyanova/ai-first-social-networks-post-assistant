-- Phase 1.3: switch the post embedding dimension from 1536 → 1024.
-- The local TEXT_WORKER now serves bge-m3 (1024-dim) via POST /embed. Any vectors
-- written under the old 1536 layout are incompatible, so clear them and mark the
-- rows 'pending' for the backfill to re-embed. Embeddings are derived and
-- regeneratable, so no data is lost that cannot be reproduced.
UPDATE "post_semantics"
SET "embedding" = NULL,
    "embedding_dims" = NULL,
    "status" = 'pending',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "embedding" IS NOT NULL;

-- With every value now NULL, the type change casts trivially.
ALTER TABLE "post_semantics"
    ALTER COLUMN "embedding" TYPE vector(1024);
