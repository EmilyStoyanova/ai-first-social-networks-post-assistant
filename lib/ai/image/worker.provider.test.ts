import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { WorkerImageProvider } from "./worker.provider";

type Json = Record<string, unknown>;

const PROMPT = "a coffee cup on a wooden desk";
const NEGATIVE = "deformed anatomy, bad hands, watermark";

const WORKER_OK = { imageUrl: "https://cdn.example/x.png", width: 1200, height: 624 };

const realFetch = globalThis.fetch;

/** Replaces global fetch and records the JSON body of every request. */
function captureFetch(response: Json): Json[] {
  const bodies: Json[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Json);
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return bodies;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

function newProvider(): WorkerImageProvider {
  return new WorkerImageProvider("http://worker.test", "key");
}

describe("WorkerImageProvider — request body", () => {
  it("forwards the dimensions it was given", async () => {
    const bodies = captureFetch(WORKER_OK);

    await newProvider().generate(PROMPT, { width: 1200, height: 624 });

    assert.equal(bodies.length, 1);
    assert.equal(bodies[0]?.width, 1200);
    assert.equal(bodies[0]?.height, 624);
  });

  it("sends the full shape when prompt, negative prompt and dimensions are all present", async () => {
    const bodies = captureFetch(WORKER_OK);

    await newProvider().generate(PROMPT, {
      width: 1080,
      height: 1920,
      negativePrompt: NEGATIVE,
    });

    assert.deepEqual(bodies[0], {
      prompt: PROMPT,
      negativePrompt: NEGATIVE,
      width: 1080,
      height: 1920,
    });
  });

  it("omits every optional field when none was supplied", async () => {
    const bodies = captureFetch(WORKER_OK);

    await newProvider().generate(PROMPT);

    // An older worker build must keep seeing exactly the request it expects.
    assert.deepEqual(bodies[0], { prompt: PROMPT });
  });

  it("omits the dimensions individually when only one is known", async () => {
    const bodies = captureFetch(WORKER_OK);

    await newProvider().generate(PROMPT, { width: 1024 });

    assert.deepEqual(bodies[0], { prompt: PROMPT, width: 1024 });
  });

  it("keeps the negative prompt working on its own", async () => {
    const bodies = captureFetch(WORKER_OK);

    await newProvider().generate(PROMPT, { negativePrompt: NEGATIVE });

    assert.deepEqual(bodies[0], { prompt: PROMPT, negativePrompt: NEGATIVE });
  });

  it("passes the prompt through untouched", async () => {
    const bodies = captureFetch(WORKER_OK);

    await newProvider().generate(PROMPT, {
      width: 1200,
      height: 632,
      negativePrompt: NEGATIVE,
    });

    // Dimensions are numbers on the body, never appended to the prompt text.
    assert.equal(bodies[0]?.prompt, PROMPT);
  });

  it("does not recompute dimensions — it reports back what the worker returned", async () => {
    captureFetch({ imageUrl: "https://cdn.example/x.png", width: 1200, height: 632 });

    const image = await newProvider().generate(PROMPT, { width: 1200, height: 624 });

    assert.equal(image.width, 1200);
    assert.equal(image.height, 632);
  });
});
