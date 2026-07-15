import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SocialChannel } from "@prisma/client";
import type { EmbedPostInput, EmbedPostOutcome } from "@/lib/services/ai/embed-post.service";
import { backfillEmbeddings } from "./backfill-embeddings.service";

function candidate(id: string) {
  return {
    id,
    company_id: "co-1",
    channel: "linkedin" as SocialChannel,
    core_message: `claim ${id}`,
    topic: null,
    aspect_focus: null,
    created_at: new Date("2026-07-14T00:00:00Z"),
  };
}

describe("backfillEmbeddings (Phase 1.2)", () => {
  it("returns no_provider and does nothing when no provider is available", async () => {
    const calls: EmbedPostInput[] = [];
    const summary = await backfillEmbeddings(
      {},
      {
        providerAvailable: () => false,
        findCandidates: async () => [candidate("a")],
        embed: async (input) => {
          calls.push(input);
          return { status: "embedded" };
        },
      }
    );

    assert.equal(summary.reason, "no_provider");
    assert.deepEqual(summary, {
      scanned: 0,
      embedded: 0,
      skipped: 0,
      failed: 0,
      reason: "no_provider",
    });
    assert.equal(calls.length, 0, "must not embed when no provider");
  });

  it("embeds every candidate and tallies outcomes", async () => {
    const outcomes: Record<string, EmbedPostOutcome> = {
      a: { status: "embedded" },
      b: { status: "failed", error: "boom" },
      c: { status: "skipped", reason: "unchanged" },
    };
    const seen: string[] = [];

    const summary = await backfillEmbeddings(
      { limit: 10 },
      {
        providerAvailable: () => true,
        findCandidates: async () => [candidate("a"), candidate("b"), candidate("c")],
        embed: async (input) => {
          seen.push(input.postId);
          return outcomes[input.postId];
        },
      }
    );

    assert.deepEqual(seen, ["a", "b", "c"]);
    assert.deepEqual(summary, { scanned: 3, embedded: 1, skipped: 1, failed: 1 });
  });

  it("passes the candidate topic and aspect focus through to embed", async () => {
    const calls: EmbedPostInput[] = [];
    await backfillEmbeddings(
      {},
      {
        providerAvailable: () => true,
        findCandidates: async () => [
          {
            ...candidate("a"),
            topic: "A topic",
            aspect_focus: "an aspect focus",
          },
        ],
        embed: async (input) => {
          calls.push(input);
          return { status: "embedded" };
        },
      }
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].topic, "A topic");
    assert.equal(calls[0].aspectFocus, "an aspect focus");
  });

  it("passes companyId and limit through to the candidate query", async () => {
    let capturedCompany: string | undefined = "unset";
    let capturedLimit = -1;

    await backfillEmbeddings(
      { companyId: "co-42", limit: 7 },
      {
        providerAvailable: () => true,
        findCandidates: async (companyId, limit) => {
          capturedCompany = companyId;
          capturedLimit = limit;
          return [];
        },
        embed: async () => ({ status: "embedded" }),
      }
    );

    assert.equal(capturedCompany, "co-42");
    assert.equal(capturedLimit, 7);
  });
});
