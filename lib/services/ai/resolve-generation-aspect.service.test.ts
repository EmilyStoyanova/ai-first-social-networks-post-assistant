import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveGenerationAspect } from "./resolve-generation-aspect.service";
import { buildPrimaryFingerprint } from "@/lib/ai/aspect-extractor";
import { buildSnapshotAspectFields } from "@/lib/ai/aspect-pool-store";
import { aspectId, type ContentAspect } from "@/lib/ai/content-aspect";
import type { FeedItemContext, ILlmProvider, LlmRequest, LlmResponse } from "@/lib/ai/types";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CLOSURE: FeedItemContext = {
  id: "closure",
  title: "University closes campus after funding cut",
  content: "Students were told the campus will shut at the end of term.",
  url: "https://news.example.com/university-closure",
  publishedAt: null,
};

const WEATHER: FeedItemContext = {
  id: "weather",
  title: "Storm warning issued for the coast",
  content: "Forecasters expect high winds through the weekend.",
  url: "https://news.example.com/storm-warning",
  publishedAt: null,
};

function makeAspect(focus: string): ContentAspect {
  return { id: aspectId(focus), title: "T", focus, visualConcept: "a scene" };
}

/** Records every extraction call so a cold miss is distinguishable from a hit. */
function makeProvider(response: string) {
  const prompts: string[] = [];
  const provider: ILlmProvider = {
    async generate(req: LlmRequest): Promise<LlmResponse> {
      prompts.push(req.userPrompt);
      return { text: response };
    },
  };
  return { provider, prompts };
}

const WEATHER_ASPECT = makeAspect("high winds close coastal roads for the weekend");
const CLOSURE_ASPECTS = JSON.stringify([
  {
    title: "Funding gap",
    focus: "the campus closure follows a funding gap of several million",
    visualConcept: "an empty lecture hall with chairs stacked against the wall",
  },
]);

/** A snapshot recording that WEATHER's pool exists and its aspect was used. */
function weatherSnapshot(): Record<string, unknown> {
  return buildSnapshotAspectFields(
    buildPrimaryFingerprint(WEATHER)!,
    [WEATHER_ASPECT],
    WEATHER_ASPECT,
    1
  ) as unknown as Record<string, unknown>;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("resolveGenerationAspect — the aspect belongs to the primary article", () => {
  it("never serves one article's pool to a different article", () => {
    // The bug, reproduced at the seam it lived in. The fingerprint used to hash
    // the whole feed window, so a post about CLOSURE loaded the pool stored for
    // a post about WEATHER and was handed WEATHER's aspect — as a mandatory
    // "build the post around this" constraint — while linking to CLOSURE.
    const { provider } = makeProvider(CLOSURE_ASPECTS);

    return resolveGenerationAspect({
      primary: CLOSURE,
      snapshots: [weatherSnapshot()],
      provider,
    }).then((resolved) => {
      assert.notEqual(
        resolved.aspect?.id,
        WEATHER_ASPECT.id,
        "an aspect mined from another article must never be selected"
      );
      assert.ok(
        resolved.aspect?.focus.includes("funding gap"),
        "the aspect must come from the primary article"
      );
    });
  });

  it("treats a different primary as a cold miss and mines fresh", async () => {
    const { provider, prompts } = makeProvider(CLOSURE_ASPECTS);
    await resolveGenerationAspect({
      primary: CLOSURE,
      snapshots: [weatherSnapshot()],
      provider,
    });

    assert.equal(prompts.length, 1, "a pool for another article is not a cache hit");
    assert.ok(prompts[0].includes(CLOSURE.title!), "extraction mines the primary");
    assert.ok(!prompts[0].includes(WEATHER.title!), "extraction never sees the other article");
  });

  it("reuses the pool stored for the SAME primary", async () => {
    // Evergreen primaries are reused across posts; that is where the cache and
    // the LRU rotation earn their keep, and it must still work.
    const unused = makeAspect("a second distinct angle on the very same article");
    const snapshot = buildSnapshotAspectFields(
      buildPrimaryFingerprint(WEATHER)!,
      [WEATHER_ASPECT, unused],
      WEATHER_ASPECT,
      1
    ) as unknown as Record<string, unknown>;

    const { provider, prompts } = makeProvider("[]");
    const resolved = await resolveGenerationAspect({
      primary: WEATHER,
      snapshots: [snapshot],
      provider,
    });

    assert.equal(prompts.length, 0, "a warm pool must not trigger extraction");
    assert.equal(resolved.aspect?.id, unused.id, "the unused aspect is served next");
    assert.equal(resolved.fingerprint, buildPrimaryFingerprint(WEATHER));
  });

  it("returns nothing for a mission post", async () => {
    const { provider, prompts } = makeProvider(CLOSURE_ASPECTS);
    const resolved = await resolveGenerationAspect({ primary: null, snapshots: [], provider });

    assert.equal(resolved.aspect, undefined);
    assert.equal(resolved.fingerprint, null);
    assert.equal(prompts.length, 0, "no primary, nothing to mine");
  });

  it("stands down when the source already says what the post must contain", async () => {
    // The production failure this guards. A product page told to "list every
    // event with its type and price" was mined for an aspect anyway, and the
    // mined focus — one webinar — reached the prompt as "you MUST build this
    // post around this focus", so four of the five events were never written.
    const listing: FeedItemContext = {
      id: "events",
      title: "Business events",
      content: JSON.stringify({
        instructions: "List every event this week with its type and whether it is free.",
        pageText: "Energy Update — webinar, 11.08.2026, free\nHR Meetup — meetup, 16.08.2026",
      }),
      url: "https://events.example.com/?week=current",
      publishedAt: null,
      sourceType: "product_page",
    };
    const { provider, prompts } = makeProvider(CLOSURE_ASPECTS);

    const resolved = await resolveGenerationAspect({ primary: listing, snapshots: [], provider });

    assert.equal(resolved.aspect, undefined, "no focus may be imposed on top of the instruction");
    assert.equal(resolved.fingerprint, null, "nothing is recorded, so no pool is reused later");
    assert.equal(prompts.length, 0, "and the extraction LLM call is not made at all");
  });

  it("still mines a product page that carries no instruction", async () => {
    // Standing down is scoped to an explicit instruction — an ordinary product
    // page keeps the aspect rotation it has always had.
    const page: FeedItemContext = {
      id: "pro-plan",
      title: "Pro Plan",
      content: JSON.stringify({ title: "Pro Plan", description: "Everything, plus SSO." }),
      url: "https://shop.example.com/pro",
      publishedAt: null,
      sourceType: "product_page",
    };
    const { provider, prompts } = makeProvider(CLOSURE_ASPECTS);

    const resolved = await resolveGenerationAspect({ primary: page, snapshots: [], provider });

    assert.equal(prompts.length, 1);
    assert.ok(resolved.aspect);
  });

  it("proceeds without an aspect when extraction fails", async () => {
    // Fail-open: a broken extraction must never block generation.
    const provider: ILlmProvider = {
      async generate(): Promise<LlmResponse> {
        throw new Error("provider exploded");
      },
    };
    const resolved = await resolveGenerationAspect({ primary: CLOSURE, snapshots: [], provider });
    assert.equal(resolved.aspect, undefined);
    assert.deepEqual(resolved.pool, []);
  });

  it("a malformed aspect object never zeroes out the pool — the survivors still reach selection", async () => {
    // The real production trace this guards: one object shaped like
    // {"(title": "...", "focus": "...", "visualConcept": "..."} sat alongside
    // otherwise-valid objects, and the pool that reached generation was empty.
    const mixedReply = JSON.stringify([
      {
        "(title": "Cost-Effective Escapes",
        focus: "budget travel still finds quality lodging off-season",
        visualConcept: "a scene",
      },
      {
        title: "Funding gap",
        focus: "the campus closure follows a funding gap of several million",
        visualConcept: "an empty lecture hall with chairs stacked against the wall",
      },
    ]);
    const { provider } = makeProvider(mixedReply);

    const resolved = await resolveGenerationAspect({ primary: CLOSURE, snapshots: [], provider });

    assert.ok(resolved.pool.length > 0, "the well-formed object must survive into the pool");
    assert.ok(resolved.aspect, "a real aspect must be selected from the surviving pool");
    assert.ok(resolved.aspect?.focus.includes("funding gap"));
  });
});

describe("resolveGenerationAspect — an extracted product page", () => {
  const EXTRACTED_LISTING: FeedItemContext = {
    id: "events",
    title: "Business events",
    content: JSON.stringify({
      instructions: "List every event next week with its type and price.",
      pageText: "raw page",
    }),
    url: "https://events.example.com/?week=current",
    publishedAt: null,
    sourceType: "product_page",
    extractionStatus: "completed",
    extractedContent: [
      "Total events: 3",
      "1. Energy Update — Webinar — Free",
      "2. HR Masterclass — Masterclass — 50 BGN",
      "3. Growth Conference — Conference — 120 BGN",
    ].join("\n"),
  };

  it("cannot narrow an extracted list of three events down to one focus", async () => {
    // Aspect mining answers "which single facet of this source should the post be
    // about", which is the opposite of what an all-items extraction is for. It
    // has to stand down even now that the facts arrive pre-extracted.
    const { provider, prompts } = makeProvider(CLOSURE_ASPECTS);

    const resolved = await resolveGenerationAspect({
      primary: EXTRACTED_LISTING,
      snapshots: [],
      provider,
    });

    assert.equal(resolved.aspect, undefined);
    assert.equal(prompts.length, 0, "and it costs no model call");
  });

  it("stands down for a not-found extraction too", async () => {
    const { provider } = makeProvider(CLOSURE_ASPECTS);

    const resolved = await resolveGenerationAspect({
      primary: { ...EXTRACTED_LISTING, extractionStatus: "not_found", extractedContent: null },
      snapshots: [],
      provider,
    });

    assert.equal(resolved.aspect, undefined);
  });
});
