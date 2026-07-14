import { createHash } from "node:crypto";
import { prisma } from "@/lib/db/client";
import { type SocialChannel } from "@prisma/client";
import { type IEmbeddingProvider } from "@/lib/ai/embedding/embedding-provider";
import {
  EMBEDDING_DIMENSIONS,
  getEmbeddingProviderOrNull,
} from "@/lib/ai/embedding/embedding-provider-factory";

/**
 * Best-effort semantic embedding of a post's coreMessage (Phase 1.2).
 *
 * Guarantees:
 *   • Never throws — embedding must never fail or delay post generation.
 *   • No long DB transaction — the vector is written in a single upsert AFTER the
 *     post already exists; failures leave a 'failed' row for the backfill to retry.
 *   • Skips work when the coreMessage hash already matches a 'ready' row.
 *
 * Only `coreMessage` is embedded (the normalized semantic claim), never the full
 * post content. No similarity/cosine/gating is computed here — this phase only
 * populates the store.
 */

export interface EmbedPostInput {
  postId: string;
  companyId: string;
  channel: SocialChannel;
  /** The post's central claim. Null (legacy posts) → nothing to embed. */
  coreMessage: string | null;
  postCreatedAt: Date;
}

export type EmbedPostOutcome =
  | { status: "embedded" }
  | { status: "skipped"; reason: "unchanged" | "no_core_message" | "no_provider" }
  | { status: "failed"; error: string };

// ─── Store seam ───────────────────────────────────────────────────────────────
// The embedding column is pgvector (Prisma `Unsupported`), so the vector must be
// written via raw SQL. This interface isolates that so unit tests can inject a
// fake without a database.

export interface SemanticsRow extends EmbedPostInput {
  coreMessage: string; // non-null here
  coreMessageHash: string;
  vector: number[];
  provider: string;
  model: string;
  dims: number;
}

export interface PostSemanticsStore {
  getExisting(postId: string): Promise<{ coreMessageHash: string | null; status: string } | null>;
  saveEmbedding(row: SemanticsRow): Promise<void>;
  recordFailure(input: EmbedPostInput, coreMessageHash: string, error: string): Promise<void>;
}

export function coreMessageHash(coreMessage: string): string {
  return createHash("sha256").update(coreMessage).digest("hex");
}

// ─── Default (Prisma) store ───────────────────────────────────────────────────

const prismaSemanticsStore: PostSemanticsStore = {
  async getExisting(postId) {
    const row = await prisma.postSemantics.findUnique({
      where: { postId },
      select: { coreMessageHash: true, status: true },
    });
    return row ? { coreMessageHash: row.coreMessageHash, status: row.status } : null;
  },

  async saveEmbedding(row) {
    // pgvector text input format: "[0.1,0.2,...]".
    const literal = `[${row.vector.join(",")}]`;
    await prisma.$executeRaw`
      INSERT INTO "post_semantics" (
        "post_id", "embedding", "embedding_provider", "embedding_model", "embedding_dims",
        "core_message_hash", "status", "attempts", "last_error",
        "company_id", "channel", "post_created_at", "created_at", "updated_at"
      ) VALUES (
        ${row.postId}, ${literal}::vector, ${row.provider}, ${row.model}, ${row.dims},
        ${row.coreMessageHash}, 'ready', 0, NULL,
        ${row.companyId}, ${row.channel}::"SocialChannel", ${row.postCreatedAt}, now(), now()
      )
      ON CONFLICT ("post_id") DO UPDATE SET
        "embedding"          = EXCLUDED."embedding",
        "embedding_provider" = EXCLUDED."embedding_provider",
        "embedding_model"    = EXCLUDED."embedding_model",
        "embedding_dims"     = EXCLUDED."embedding_dims",
        "core_message_hash"  = EXCLUDED."core_message_hash",
        "status"             = 'ready',
        "last_error"         = NULL,
        "post_created_at"    = EXCLUDED."post_created_at",
        "updated_at"         = now();
    `;
  },

  async recordFailure(input, hash, error) {
    const trimmed = error.slice(0, 500);
    await prisma.$executeRaw`
      INSERT INTO "post_semantics" (
        "post_id", "core_message_hash", "status", "attempts", "last_error",
        "company_id", "channel", "post_created_at", "created_at", "updated_at"
      ) VALUES (
        ${input.postId}, ${hash}, 'failed', 1, ${trimmed},
        ${input.companyId}, ${input.channel}::"SocialChannel", ${input.postCreatedAt}, now(), now()
      )
      ON CONFLICT ("post_id") DO UPDATE SET
        "status"            = 'failed',
        "attempts"          = "post_semantics"."attempts" + 1,
        "last_error"        = EXCLUDED."last_error",
        "core_message_hash" = EXCLUDED."core_message_hash",
        "updated_at"        = now();
    `;
  },
};

// ─── Service ──────────────────────────────────────────────────────────────────

export interface EmbedPostDeps {
  /** Injected provider; when omitted, resolved from the factory (or skipped). */
  provider?: IEmbeddingProvider;
  store?: PostSemanticsStore;
}

export async function embedPost(
  input: EmbedPostInput,
  deps: EmbedPostDeps = {}
): Promise<EmbedPostOutcome> {
  const core = input.coreMessage?.trim();
  if (!core) return { status: "skipped", reason: "no_core_message" };

  const store = deps.store ?? prismaSemanticsStore;
  const hash = coreMessageHash(core);

  // Skip when an up-to-date embedding already exists.
  try {
    const existing = await store.getExisting(input.postId);
    if (existing && existing.status === "ready" && existing.coreMessageHash === hash) {
      return { status: "skipped", reason: "unchanged" };
    }
  } catch {
    // A read failure must not stop us — fall through and attempt to (re)embed.
  }

  const provider = deps.provider ?? getEmbeddingProviderOrNull();
  if (!provider) return { status: "skipped", reason: "no_provider" };

  try {
    const result = await provider.embed([core]);
    const vector = result.vectors[0];
    if (!vector || result.dims !== EMBEDDING_DIMENSIONS || vector.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `embedding dimension mismatch: got ${vector?.length ?? "none"} (expected ${EMBEDDING_DIMENSIONS})`
      );
    }

    await store.saveEmbedding({
      ...input,
      coreMessage: core,
      coreMessageHash: hash,
      vector,
      provider: result.provider,
      model: result.model,
      dims: result.dims,
    });
    return { status: "embedded" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await store.recordFailure(input, hash, message);
    } catch {
      // Even recording the failure is best-effort; the backfill will retry.
    }
    return { status: "failed", error: message };
  }
}
