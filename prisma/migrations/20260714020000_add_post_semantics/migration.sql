-- Phase 1.2: semantic-memory infrastructure.
-- pgvector extension + a 1:1 side table holding the embedding of each post's
-- coreMessage. Kept off the hot `posts` row on purpose (large, derived, optional,
-- regeneratable, independently failable).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "post_semantics" (
    "post_id"            TEXT NOT NULL,
    -- Nullable: a row can exist in status 'pending'/'failed' with no vector yet.
    "embedding"          vector(1536),
    "embedding_provider" TEXT,
    "embedding_model"    TEXT,
    "embedding_dims"     INTEGER,
    "core_message_hash"  TEXT,
    "status"             TEXT NOT NULL DEFAULT 'pending',
    "attempts"           INTEGER NOT NULL DEFAULT 0,
    "last_error"         TEXT,
    -- Denormalized, immutable routing keys copied from posts.
    "company_id"         TEXT NOT NULL,
    "channel"            "SocialChannel" NOT NULL,
    "post_created_at"    TIMESTAMP(3) NOT NULL,
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_semantics_pkey" PRIMARY KEY ("post_id")
);

-- One embedding row per post; deletes cascade with the post.
ALTER TABLE "post_semantics"
    ADD CONSTRAINT "post_semantics_post_id_fkey"
    FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Serves the future "latest N posts for this company+channel" gate query as a
-- single index range scan. No ANN (HNSW/ivfflat) index yet — the gate window is
-- tiny, so an ANN index would be premature; add one when scale demands it.
CREATE INDEX "post_semantics_company_channel_created_idx"
    ON "post_semantics" ("company_id", "channel", "post_created_at" DESC);

CREATE INDEX "post_semantics_status_idx" ON "post_semantics" ("status");
