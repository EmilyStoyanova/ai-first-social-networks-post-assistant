import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { WorkerImageProvider } from "./worker.provider";
import { IdeogramProvider } from "./ideogram.provider";
import { LeonardoProvider } from "./leonardo.provider";
import { FalProvider } from "./fal.provider";
import { OpenAIImageProvider } from "./openai.provider";

const NEGATIVE = "deformed anatomy, bad hands, watermark";

type Json = Record<string, unknown>;

const realFetch = globalThis.fetch;

/**
 * Replaces global fetch, records the JSON body of every request, and answers
 * with `response`. Returns the recorded bodies.
 */
function captureFetch(response: Json, status = 200): Json[] {
  const bodies: Json[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Json);
    return new Response(JSON.stringify(response), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return bodies;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ─── Providers that support a negative prompt ─────────────────────────────────

describe("negativePrompt — Worker/ComfyUI provider", () => {
  const workerOk = { imageUrl: "https://cdn.example/x.png", width: 1024, height: 1024 };

  it("sends { prompt, negativePrompt } to the worker", async () => {
    const bodies = captureFetch(workerOk);
    const provider = new WorkerImageProvider("http://worker.test", "key");

    await provider.generate("a coffee cup", {
      width: 1024,
      height: 1024,
      negativePrompt: NEGATIVE,
    });

    assert.equal(bodies.length, 1);
    assert.equal(bodies[0]?.prompt, "a coffee cup");
    assert.equal(bodies[0]?.negativePrompt, NEGATIVE);
  });

  it("omits the field entirely when there is nothing to exclude", async () => {
    const bodies = captureFetch(workerOk);
    const provider = new WorkerImageProvider("http://worker.test", "key");

    await provider.generate("a coffee cup", { width: 1024, height: 1024 });

    assert.ok(!("negativePrompt" in (bodies[0] ?? {})));
    assert.equal(bodies[0]?.prompt, "a coffee cup");
  });
});

describe("negativePrompt — Ideogram provider", () => {
  const ideogramOk = { data: [{ url: "https://cdn.example/x.png", resolution: "1024x1024" }] };

  it("sends negative_prompt for a model family that supports it", async () => {
    const bodies = captureFetch(ideogramOk);
    const provider = new IdeogramProvider("key", "V_2");

    await provider.generate("a coffee cup", { negativePrompt: NEGATIVE });

    const request = bodies[0]?.image_request as Json;
    assert.equal(request.negative_prompt, NEGATIVE);
  });

  it("drops it for a model that no longer accepts the field", async () => {
    const bodies = captureFetch(ideogramOk);
    const provider = new IdeogramProvider("key", "V_3");

    await provider.generate("a coffee cup", { negativePrompt: NEGATIVE });

    const request = bodies[0]?.image_request as Json;
    assert.equal(request.negative_prompt, undefined);
    // The exclusions must not be smuggled into the positive prompt instead.
    assert.equal(request.prompt, "a coffee cup");
  });
});

describe("negativePrompt — Leonardo provider", () => {
  // The start call is failed on purpose: the request body is already captured by
  // then, and it saves the test from Leonardo's 3s poll interval.
  it("sends negative_prompt on the generation request", async () => {
    const bodies = captureFetch({ error: "nope" }, 500);
    const provider = new LeonardoProvider("key", null);

    await assert.rejects(() => provider.generate("a coffee cup", { negativePrompt: NEGATIVE }));

    assert.equal(bodies[0]?.negative_prompt, NEGATIVE);
    assert.equal(bodies[0]?.prompt, "a coffee cup");
  });

  it("omits the field when there is nothing to exclude", async () => {
    const bodies = captureFetch({ error: "nope" }, 500);
    const provider = new LeonardoProvider("key", null);

    await assert.rejects(() => provider.generate("a coffee cup"));

    assert.ok(!("negative_prompt" in (bodies[0] ?? {})));
  });
});

// ─── Providers whose API has no negative prompt ───────────────────────────────

describe("negativePrompt — providers that must ignore it", () => {
  it("fal drops it without touching the positive prompt", async () => {
    const bodies = captureFetch({
      images: [{ url: "https://cdn.example/x.png", width: 1024, height: 1024 }],
    });
    const provider = new FalProvider("key", "fal-ai/flux/schnell");

    await provider.generate("a coffee cup", { negativePrompt: NEGATIVE });

    assert.equal(bodies[0]?.prompt, "a coffee cup");
    assert.ok(!JSON.stringify(bodies[0]).includes("deformed anatomy"));
  });

  it("OpenAI drops it without touching the positive prompt", async () => {
    const bodies = captureFetch({ data: [{ b64_json: "AAAA" }] });
    const provider = new OpenAIImageProvider("key", "gpt-image-1");

    await provider.generate("a coffee cup", { negativePrompt: NEGATIVE });

    assert.equal(bodies[0]?.prompt, "a coffee cup");
    assert.ok(!JSON.stringify(bodies[0]).includes("deformed anatomy"));
  });
});
