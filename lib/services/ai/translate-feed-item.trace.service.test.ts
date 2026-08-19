import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { translateFeedItem } from "./translate-feed-item.service";
import type { TranslateFeedItemDb } from "./translate-feed-item.service";
import { GenerationTracer } from "@/lib/generation-trace/tracer";
import type { GenerationTraceStore, PersistableRun } from "@/lib/generation-trace/store";

/**
 * What a feed item's translation leaves behind.
 *
 * This is the artifact a post's trace REFERENCES rather than copies (see
 * lib/generation-trace/feed-item-artifacts.ts), so the prompts and the raw reply
 * have to be here — if they are not, following the link from a post gets nothing
 * and the copy that was avoided was avoided for nothing.
 */

function makeStore(): { store: GenerationTraceStore; saved: () => PersistableRun[] } {
  const runs: PersistableRun[] = [];
  return { store: { saveRun: async (run) => void runs.push(run) }, saved: () => runs };
}

function makeDb(): TranslateFeedItemDb {
  return {
    feedItem: {
      update: async () => ({}),
      // Grants the atomic claim so the translation proceeds.
      updateMany: async () => ({ count: 1 }),
    },
  };
}

const ITEM = {
  id: "item-1",
  companyId: "company-1",
  title: "A new mixer range",
  content: "The full English article body, long enough to be worth translating.",
  url: "https://example.com/a",
  translationStatus: "pending" as string | null,
  translationHash: null,
  translationAttemptCount: 0,
};

describe("translation trace", () => {
  it("stores the prompts, the raw reply and the final translated text", async () => {
    const { store, saved } = makeStore();
    const tracer = GenerationTracer.start({
      kind: "translation",
      trigger: "system",
      feedItemId: ITEM.id,
      store,
      newId: () => "run-translation",
    });

    const reply = JSON.stringify({
      title: "Нова серия смесители",
      content: "Пълният текст на статията на български.",
    });

    const outcome = await translateFeedItem({ ...ITEM }, "bg", {
      db: makeDb(),
      tracer,
      resolveProvider: async () => ({
        ok: true,
        provider: "GROQ",
        model: "llama-3.3-70b",
        instance: { generate: async () => ({ text: reply, raw: { eval_count: 120 } }) },
      }),
    });

    assert.equal(outcome.status, "translated");

    const run = saved()[0];
    assert.equal(run.kind, "translation");
    assert.equal(run.feedItemId, "item-1");
    assert.equal(run.companyId, "company-1");
    assert.equal(run.language, "bg");
    assert.equal(run.llmProvider, "GROQ");
    assert.equal(run.status, "completed");

    const byType = (type: string) => run.steps.filter((s) => s.type === type);

    // The original, so the input a translation was derived from stays readable.
    const source = byType("source")[0].output as { title: string; content: string };
    assert.equal(source.title, "A new mixer range");
    assert.ok(source.content.includes("full English article body"));

    // The exact prompts.
    const prompt = byType("prompt")[0].input as { systemPrompt: string; userPrompt: string };
    assert.ok(prompt.systemPrompt.length > 20);
    assert.ok(prompt.userPrompt.includes("full English article body"));

    // The reply before parsing.
    assert.equal((byType("raw_response")[0].output as { text: string }).text, reply);

    // And the final text, which is what generation later reads.
    const stored = byType("persistence")[0].output as {
      translatedTitle: string;
      translatedContent: string;
      targetLang: string;
    };
    assert.equal(stored.translatedTitle, "Нова серия смесители");
    assert.equal(stored.translatedContent, "Пълният текст на статията на български.");
    assert.equal(stored.targetLang, "bg");
  });

  it("records every try when the model's first reply is unusable", async () => {
    const { store, saved } = makeStore();
    const tracer = GenerationTracer.start({
      kind: "translation",
      trigger: "system",
      feedItemId: ITEM.id,
      store,
      newId: () => "run-translation-retry",
    });

    let call = 0;
    const good = JSON.stringify({
      title: "Нова серия смесители",
      content: "Пълният текст на статията на български.",
    });

    await translateFeedItem({ ...ITEM }, "bg", {
      db: makeDb(),
      tracer,
      resolveProvider: async () => ({
        ok: true,
        provider: "GROQ",
        model: "llama",
        instance: {
          generate: async () => {
            call += 1;
            // First reply is prose rather than the required object.
            return { text: call === 1 ? "Sure! Here is the translation." : good };
          },
        },
      }),
    });

    const run = saved()[0];
    const prompts = run.steps.filter((s) => s.type === "prompt");
    assert.equal(prompts.length, 2, "both tries' prompts must be on the record");
    // The second try is a CORRECTION, not a re-roll of the same request.
    assert.notEqual(
      (prompts[0].input as { userPrompt: string }).userPrompt,
      (prompts[1].input as { userPrompt: string }).userPrompt
    );

    const retries = run.steps.filter((s) => s.type === "retry");
    assert.equal(retries.length, 1);
    assert.equal(retries[0].status, "failed");
    assert.equal((retries[0].output as { willRetry: boolean }).willRetry, true);

    // Both raw replies survive — including the rejected one, which is the only
    // record of what the model actually said.
    const raw = run.steps.filter((s) => s.type === "raw_response");
    assert.equal(raw.length, 2);
    assert.equal((raw[0].output as { text: string }).text, "Sure! Here is the translation.");
  });

  it("writes NO run at all when nothing was asked of a model", async () => {
    // An unchanged item settles without a call. A run here would stand in front
    // of the real translation as the most recent one, and a post's trace links
    // to the most recent — so this is a correctness property, not tidiness.
    const { store, saved } = makeStore();
    const tracer = GenerationTracer.start({
      kind: "translation",
      trigger: "system",
      store,
      newId: () => "run-should-not-exist",
    });

    const outcome = await translateFeedItem(
      // Nothing to translate at all — settled as `skipped` without a claim, an
      // attempt, or a model call.
      { ...ITEM, title: null, content: null },
      "bg",
      {
        db: makeDb(),
        tracer,
        resolveProvider: async () => {
          throw new Error("the provider must never be reached here");
        },
      }
    );

    assert.equal(outcome.status, "skipped");
    assert.equal(saved().length, 0);
  });
});
