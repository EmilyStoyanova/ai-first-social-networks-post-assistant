import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SocialChannel } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { generatePostFromContext } from "./generate-draft-post.service";
import type { GenerateDraftPostDb, GenerateDraftPostDeps } from "./generate-draft-post.service";
import type { GenerationContext } from "@/lib/ai/types";
import type { SemanticGate } from "@/lib/ai/generate-with-retry";
import { GenerationTracer } from "@/lib/generation-trace/tracer";
import type {
  GenerationTraceStore,
  PersistableRun,
  PersistableStep,
} from "@/lib/generation-trace/store";
import { REDACTED } from "@/lib/generation-trace/redact";

/**
 * What a post's trace has to contain, proved against the real pipeline.
 *
 * These tests run `generatePostFromContext` itself — not a re-implementation of
 * it — with a capturing store in place of the database, because every claim
 * being made here is about a pipeline that is 800 lines long and reached by four
 * different callers. A test that assembled its own steps would prove only that
 * the assembler works.
 */

const ACCEPT_GATE: SemanticGate = async () => ({
  decision: "accept",
  topSimilarity: null,
  matchedPostId: null,
  matchedCoreMessage: null,
  skipped: false,
});

function makeContext(overrides: Partial<GenerationContext> = {}): GenerationContext {
  return {
    company: { name: "Acme", website: null, automationMode: "manual", defaultLang: "en" },
    brand: {
      companyDescription: "We make bathroom fittings.",
      toneOfVoice: "Warm and practical",
      targetAudience: "Renovators",
      forbiddenWords: ["cheap"],
      competitors: ["Rival Ltd"],
      primaryColor: "#123456",
      secondaryColor: null,
    },
    channel: {
      channel: "linkedin",
      postingLanguage: "en",
      imageRequired: false,
      automationModeOverride: null,
      maxTextLength: null,
      includeSourceLink: false,
      autoGenerateImage: false,
    },
    feedItems: [],
    hasArticleSources: false,
    ...overrides,
  };
}

interface Harness {
  deps: GenerateDraftPostDeps;
  tracer: GenerationTracer;
  saved: () => PersistableRun[];
  run: () => PersistableRun;
  steps: (type: string) => PersistableStep[];
}

function makeHarness(
  options: {
    tracerInit?: Partial<Parameters<typeof GenerationTracer.start>[0]>;
    semanticGate?: SemanticGate;
    depsOverride?: Partial<GenerateDraftPostDeps>;
    postId?: string;
  } = {}
): Harness {
  const runs: PersistableRun[] = [];
  const store: GenerationTraceStore = {
    saveRun: async (run) => {
      runs.push(run);
    },
  };

  const tracer = GenerationTracer.start({
    kind: "post_generation",
    trigger: "manual",
    companyId: "company-1",
    channel: "linkedin",
    store,
    newId: () => "run-under-test",
    ...options.tracerInit,
  });

  const db: GenerateDraftPostDb = {
    post: {
      findMany: async () => [],
      create: async (args) => ({
        id: options.postId ?? "post-1",
        companyId: args.data.companyId,
        channel: args.data.channel as SocialChannel,
        status: "draft",
        content: args.data.content,
        hashtags: [],
        imagePrompt: null,
        notes: null,
        llmProvider: null,
        llmModel: null,
        createdAt: new Date("2026-03-01T10:00:00.000Z"),
      }),
    },
    feedItem: { updateMany: async () => ({ count: 1 }) },
  };

  const deps: GenerateDraftPostDeps = {
    db,
    tracer,
    auditLog: async () => {},
    embed: async () => ({ status: "embedded" }),
    recordCalibration: async () => {},
    autoImage: async (input) =>
      input.enabled
        ? { status: "generated", media: { id: "a", url: "https://cdn/x.png", width: 1, height: 1 } }
        : { status: "skipped", reason: "disabled" },
    autoSourceImage: async () => ({ status: "skipped", reason: "no_source_image" }),
    semanticGate: options.semanticGate ?? ACCEPT_GATE,
    loadDefaultLlmConfig: async () => ({ id: "default-cfg", provider: "grok" }),
    // The trace's extra reads are DB calls; stubbed so these tests touch none.
    loadFeedItemArtifacts: async () => null,
    loadCandidateFacts: async () => [],
    ...options.depsOverride,
  };

  return {
    deps,
    tracer,
    saved: () => runs,
    run: () => {
      assert.equal(runs.length, 1, "exactly one run should have been flushed");
      return runs[0];
    },
    steps: (type: string) => runs[0].steps.filter((s) => s.type === type),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("generation trace — linkage and the exact prompt snapshot", () => {
  let prevMockMode: string | undefined;
  before(() => {
    prevMockMode = process.env.AI_MOCK_MODE;
    process.env.AI_MOCK_MODE = "true";
  });
  after(() => {
    if (prevMockMode === undefined) delete process.env.AI_MOCK_MODE;
    else process.env.AI_MOCK_MODE = prevMockMode;
  });

  it("links the run to the post that was written", async () => {
    const h = makeHarness({ postId: "post-42" });
    const result = await generatePostFromContext(makeContext(), "company-1", {}, h.deps);

    assert.equal(result.success, true);
    const run = h.run();
    assert.equal(run.postId, "post-42");
    assert.equal(run.companyId, "company-1");
    assert.equal(run.channel, "linkedin");
    assert.equal(run.status, "completed");
    assert.ok(run.durationMs !== null);
  });

  it("stores the EXACT prompts that were sent, not a summary of them", async () => {
    const h = makeHarness();
    await generatePostFromContext(makeContext(), "company-1", {}, h.deps);

    const prompts = h.steps("prompt");
    assert.equal(prompts.length, 1, "one accepted attempt means one prompt step");

    const input = prompts[0].input as { systemPrompt: string; userPrompt: string };
    // Not a placeholder and not a hash — the real assembled prompt, which is
    // what makes the trace usable for reproducing a generation.
    assert.ok(input.systemPrompt.length > 50);
    assert.ok(input.userPrompt.length > 50);
    // The brand copy that was in force reached the prompt, and the trace has it.
    assert.ok(
      input.systemPrompt.includes("Warm and practical") ||
        input.userPrompt.includes("Warm and practical"),
      "the tone of voice in force should appear in the captured prompt"
    );
  });

  it("records the request, context, LLM call, raw response and persistence in order", async () => {
    const h = makeHarness();
    await generatePostFromContext(makeContext(), "company-1", {}, h.deps);

    const types = h.run().steps.map((s) => s.type);
    const orderOf = (type: string) => types.indexOf(type);

    assert.ok(orderOf("request") === 0, "the request is always first");
    assert.ok(orderOf("context") < orderOf("prompt"));
    assert.ok(orderOf("prompt") < orderOf("llm_call"));
    assert.ok(orderOf("llm_call") < orderOf("raw_response"));
    assert.ok(orderOf("raw_response") < orderOf("parsed_result"));
    assert.ok(orderOf("parsed_result") < orderOf("persistence"));
  });

  it("keeps the raw model reply verbatim, before parsing", async () => {
    const h = makeHarness();
    await generatePostFromContext(makeContext(), "company-1", {}, h.deps);

    const raw = h.steps("raw_response")[0].output as { text: string };
    // The mock provider answers with JSON; the trace holds it un-parsed, which
    // is the only way a parse bug is diagnosable after the fact.
    assert.ok(raw.text.trim().startsWith("{"));
    const parsed = JSON.parse(raw.text) as { coreMessage: string };
    assert.ok(parsed.coreMessage.length > 0);
  });

  it("snapshots the brand guidelines and channel settings as they stood", async () => {
    const h = makeHarness();
    await generatePostFromContext(makeContext(), "company-1", {}, h.deps);

    const context = h.steps("context")[0].output as {
      brandGuidelines: { toneOfVoice: string; forbiddenWords: string[] };
      channelSettings: { channel: string; includeSourceLink: boolean };
    };
    assert.equal(context.brandGuidelines.toneOfVoice, "Warm and practical");
    assert.deepEqual(context.brandGuidelines.forbiddenWords, ["cheap"]);
    assert.equal(context.channelSettings.channel, "linkedin");
  });
});

describe("generation trace — an old trace is not rewritten by new settings", () => {
  let prevMockMode: string | undefined;
  before(() => {
    prevMockMode = process.env.AI_MOCK_MODE;
    process.env.AI_MOCK_MODE = "true";
  });
  after(() => {
    if (prevMockMode === undefined) delete process.env.AI_MOCK_MODE;
    else process.env.AI_MOCK_MODE = prevMockMode;
  });

  it("keeps March's guidelines after April's edit", async () => {
    // The run that happened first, under the original brand copy.
    const march = makeHarness({ postId: "post-march" });
    await generatePostFromContext(makeContext(), "company-1", {}, march.deps);

    // The company then rewrites its brand setup, and generates again.
    const edited = makeContext({
      brand: {
        companyDescription: "We make premium bathroom fittings.",
        toneOfVoice: "Bold and irreverent",
        targetAudience: "Architects",
        forbiddenWords: ["budget"],
        competitors: [],
        primaryColor: null,
        secondaryColor: null,
      },
    });
    const april = makeHarness({ postId: "post-april" });
    await generatePostFromContext(edited, "company-1", {}, april.deps);

    const marchBrand = (
      march.steps("context")[0].output as { brandGuidelines: { toneOfVoice: string } }
    ).brandGuidelines;
    const aprilBrand = (
      april.steps("context")[0].output as { brandGuidelines: { toneOfVoice: string } }
    ).brandGuidelines;

    // The whole reason the trace is a snapshot rather than a set of relations:
    // the older run still describes the world it actually ran in.
    assert.equal(marchBrand.toneOfVoice, "Warm and practical");
    assert.equal(aprilBrand.toneOfVoice, "Bold and irreverent");

    // …and so does its prompt.
    const marchPrompt = march.steps("prompt")[0].input as {
      systemPrompt: string;
      userPrompt: string;
    };
    assert.ok(
      !`${marchPrompt.systemPrompt}${marchPrompt.userPrompt}`.includes("Bold and irreverent"),
      "the older prompt must not have acquired the newer tone of voice"
    );
  });
});

describe("generation trace — attempts, validation and retries", () => {
  let prevMockMode: string | undefined;
  before(() => {
    prevMockMode = process.env.AI_MOCK_MODE;
    process.env.AI_MOCK_MODE = "true";
  });
  after(() => {
    if (prevMockMode === undefined) delete process.env.AI_MOCK_MODE;
    else process.env.AI_MOCK_MODE = prevMockMode;
  });

  it("records EVERY attempt, including the ones that were thrown away", async () => {
    // A gate that rejects the first two candidates and accepts the third — the
    // shape of a real semantic-duplicate retry.
    let calls = 0;
    const gate: SemanticGate = async () => {
      calls += 1;
      return calls < 3
        ? {
            decision: "regenerate",
            topSimilarity: 0.94,
            matchedPostId: "post-old",
            matchedCoreMessage: "An earlier post said this already.",
            skipped: false,
          }
        : {
            decision: "accept",
            topSimilarity: 0.2,
            matchedPostId: null,
            matchedCoreMessage: null,
            skipped: false,
          };
    };

    const h = makeHarness({ semanticGate: gate });
    const result = await generatePostFromContext(makeContext(), "company-1", {}, h.deps);
    assert.equal(result.success, true);

    const prompts = h.steps("prompt");
    assert.equal(prompts.length, 3, "all three attempts' prompts must be on the record");
    assert.deepEqual(
      prompts.map((p) => p.attempt),
      [1, 2, 3]
    );

    // A retry's prompt is the base prompt PLUS a correction — the thing a
    // "final prompt only" record could never show.
    const first = (prompts[0].input as { userPrompt: string }).userPrompt;
    const second = (prompts[1].input as { userPrompt: string }).userPrompt;
    assert.notEqual(first, second);
    assert.ok(second.length > first.length, "the retry prompt should carry a correction");

    // The rejected attempts are named as rejections, with a reason.
    const retries = h.steps("retry");
    assert.equal(retries.length, 2);
    assert.deepEqual(
      retries.map((r) => (r.output as { rejectionReason: string }).rejectionReason),
      ["semantic_duplicate", "semantic_duplicate"]
    );
    assert.equal((retries[0].output as { willRetry: boolean }).willRetry, true);

    assert.equal(h.run().attempts, 3);
  });

  it("records each quality gate's score, threshold comparison and verdict", async () => {
    const gate: SemanticGate = async () => ({
      decision: "gray_zone",
      topSimilarity: 0.78,
      matchedPostId: "post-neighbour",
      matchedCoreMessage: "A nearby claim.",
      skipped: false,
    });
    const h = makeHarness({ semanticGate: gate });
    await generatePostFromContext(makeContext(), "company-1", {}, h.deps);

    const validations = h.steps("validation");
    const semantic = validations.find((v) => v.label?.includes("Semantic"));
    assert.ok(semantic, "the semantic gate must have its own validation step");
    const out = semantic.output as {
      decision: string;
      topSimilarity: number;
      matchedPostId: string;
      passed: boolean;
    };
    assert.equal(out.decision, "gray_zone");
    assert.equal(out.topSimilarity, 0.78);
    assert.equal(out.matchedPostId, "post-neighbour");
    assert.equal(out.passed, true);

    // The Jaccard gate and the safety check are separately recorded.
    assert.ok(validations.some((v) => v.label?.includes("Jaccard")));
    assert.ok(validations.some((v) => v.label?.includes("safety")));
  });

  it("a fail-open semantic gate is recorded as SKIPPED, never as a pass", async () => {
    const gate: SemanticGate = async () => ({
      decision: "accept",
      topSimilarity: null,
      matchedPostId: null,
      matchedCoreMessage: null,
      skipped: true,
    });
    const h = makeHarness({ semanticGate: gate });
    await generatePostFromContext(makeContext(), "company-1", {}, h.deps);

    const semantic = h.steps("validation").find((v) => v.label?.includes("Semantic"));
    assert.equal(semantic?.status, "skipped");
  });

  it("records a run that produced NO post, with the reason it aborted", async () => {
    // A gate that never accepts: every attempt is a semantic duplicate, so
    // generation refuses to persist and returns CANNOT_GENERATE_UNIQUE_POST.
    const gate: SemanticGate = async () => ({
      decision: "regenerate",
      topSimilarity: 0.99,
      matchedPostId: "post-old",
      matchedCoreMessage: "Said already.",
      skipped: false,
    });
    const h = makeHarness({ semanticGate: gate });
    const result = await generatePostFromContext(makeContext(), "company-1", {}, h.deps);

    assert.equal(result.success, false);
    const run = h.run();
    assert.equal(run.status, "failed");
    assert.equal(run.errorCode, "CANNOT_GENERATE_UNIQUE_POST");
    assert.equal(run.postId, null, "no post exists, so the run links to none");
    // Every attempt survives, which is exactly why this run is worth keeping.
    assert.equal(h.steps("prompt").length, 3);
    assert.ok(h.steps("validation").some((v) => v.label?.includes("Uniqueness abort")));
  });
});

describe("generation trace — only the steps that occurred", () => {
  let prevMockMode: string | undefined;
  before(() => {
    prevMockMode = process.env.AI_MOCK_MODE;
    process.env.AI_MOCK_MODE = "true";
  });
  after(() => {
    if (prevMockMode === undefined) delete process.env.AI_MOCK_MODE;
    else process.env.AI_MOCK_MODE = prevMockMode;
  });

  it("a mission post has no source, translation or classification step at all", async () => {
    const h = makeHarness();
    await generatePostFromContext(makeContext(), "company-1", {}, h.deps);

    // Not "skipped" — absent. A post written from brand knowledge never went
    // near an RSS pipeline, and a skipped translation row would imply it did.
    assert.equal(h.steps("source").length, 0);
    assert.equal(h.steps("translation").length, 0);
    assert.equal(h.steps("classification").length, 0);
    assert.equal(h.steps("extraction").length, 0);
  });

  it("an article-backed post records its source and links the article's artifacts", async () => {
    const h = makeHarness({
      depsOverride: {
        loadFeedItemArtifacts: async () => ({
          translation: {
            status: "completed",
            language: "bg",
            provider: "GROQ",
            model: "llama",
            translatedAt: new Date("2026-02-28T09:00:00.000Z"),
            error: null,
            titleChars: 40,
            contentChars: 900,
          },
          classification: {
            status: "completed",
            classification: "HIGH",
            rejectionReason: null,
            matchedTopics: ["смесители"],
            primaryTopic: "смесители",
            mainSubject: "A new mixer range",
            reason: "The article is about bathroom mixers.",
            provider: "GROQ",
            model: "llama",
            classifiedAt: new Date("2026-02-28T09:05:00.000Z"),
            error: null,
          },
          extraction: null,
          runIds: {
            translation: "run-translation-1",
            classification: "run-classify-1",
            extraction: null,
          },
        }),
      },
    });

    const context = makeContext({
      hasArticleSources: true,
      feedItems: [
        {
          id: "item-1",
          title: "Нова серия смесители",
          content: "Пълният текст на статията.",
          url: "https://example.com/a",
          publishedAt: new Date("2026-02-27T00:00:00.000Z"),
          sourceType: "rss",
          sourceName: "Design Weekly",
          usedTranslation: true,
        },
      ],
    });

    await generatePostFromContext(context, "company-1", {}, h.deps);

    const source = h.steps("source")[0];
    assert.ok(source, "an article-backed post must record its source");
    assert.equal((source.output as { feedItemId: string }).feedItemId, "item-1");
    // The text the prompt was actually built from is stored, not a pointer at a
    // row that a re-translation could rewrite.
    assert.equal((source.output as { content: string }).content, "Пълният текст на статията.");

    // Translation and classification are REFERENCES plus the decisive verdict.
    const translation = h.steps("translation")[0];
    assert.equal(translation.linkedRunId, "run-translation-1");
    assert.equal((translation.output as { usedByThisPost: boolean }).usedByThisPost, true);

    const classification = h.steps("classification")[0];
    assert.equal(classification.linkedRunId, "run-classify-1");
    assert.equal((classification.output as { classification: string }).classification, "HIGH");
    assert.deepEqual((classification.output as { matchedTopics: string[] }).matchedTopics, [
      "смесители",
    ]);

    // Extraction never happened for an RSS article, so there is no step for it.
    assert.equal(h.steps("extraction").length, 0);
  });

  // ── The translated text is stored in full ──────────────────────────────────
  // It used to be cut to a 600-character preview with a trailing "…", which made
  // the step useless for the one question it exists to answer: is the
  // translation any good? There is no second copy of the stored translation
  // anywhere in the trace to fall back on — the linked translation run holds the
  // provider's raw reply, not this text.

  /** Comfortably past the old 600-char preview limit. */
  const LONG_TRANSLATION = Array.from(
    { length: 40 },
    (_, i) => `Изречение номер ${i + 1} от преведената статия за нови смесители.`
  ).join(" ");

  function translatedHarness() {
    return makeHarness({
      depsOverride: {
        loadFeedItemArtifacts: async () => ({
          translation: {
            status: "completed",
            language: "bg",
            provider: "GROQ",
            model: "llama",
            translatedAt: new Date("2026-02-28T09:00:00.000Z"),
            error: null,
            titleChars: 40,
            contentChars: LONG_TRANSLATION.length,
          },
          classification: null,
          extraction: null,
          runIds: { translation: "run-translation-1", classification: null, extraction: null },
        }),
      },
    });
  }

  function translatedContext(usedTranslation: boolean) {
    return makeContext({
      hasArticleSources: true,
      feedItems: [
        {
          id: "item-1",
          title: "Нова серия смесители",
          content: LONG_TRANSLATION,
          url: "https://example.com/a",
          publishedAt: new Date("2026-02-27T00:00:00.000Z"),
          sourceType: "rss",
          sourceName: "Design Weekly",
          usedTranslation,
        },
      ],
    });
  }

  it("stores the translated text in full, with no truncation and no trailing ellipsis", async () => {
    const h = translatedHarness();
    await generatePostFromContext(translatedContext(true), "company-1", {}, h.deps);

    const output = h.steps("translation")[0].output as { translatedContent: string };

    // Guards the fixture itself: a short article would pass trivially.
    assert.ok(
      LONG_TRANSLATION.length > 600,
      `fixture must exceed the old 600-char limit, was ${LONG_TRANSLATION.length}`
    );
    assert.equal(output.translatedContent, LONG_TRANSLATION, "the whole translation is stored");
    assert.equal(output.translatedContent.length, LONG_TRANSLATION.length);
    assert.ok(!output.translatedContent.endsWith("…"), "must not be an elided preview");
  });

  it("names the field translatedContent — the admin trace labels it 'Translated Content'", async () => {
    // The UI derives its label mechanically from the key (see humanizeKey in
    // components/admin/generation-trace-value.tsx), so the key IS the label.
    const h = translatedHarness();
    await generatePostFromContext(translatedContext(true), "company-1", {}, h.deps);

    const output = h.steps("translation")[0].output as Record<string, unknown>;
    assert.ok("translatedContent" in output);
    assert.ok(!("translatedExcerpt" in output), "the excerpt field is gone, not merely renamed");
  });

  it("leaves translatedContent null when the post was built from the original text", async () => {
    const h = translatedHarness();
    await generatePostFromContext(translatedContext(false), "company-1", {}, h.deps);

    const output = h.steps("translation")[0].output as {
      translatedContent: string | null;
      usedByThisPost: boolean;
    };
    assert.equal(output.usedByThisPost, false);
    assert.equal(output.translatedContent, null);
  });

  it("an image suppressed by the channel setting is recorded as skipped, with the reason", async () => {
    const h = makeHarness();
    await generatePostFromContext(makeContext(), "company-1", {}, h.deps);

    const image = h.steps("image")[0];
    assert.equal(image.status, "skipped");
    assert.ok(image.label?.includes("disabled"));
  });

  it("records the image prompt, negative prompt, provider and dimensions when one is drawn", async () => {
    const h = makeHarness({
      depsOverride: {
        // The real pipeline reports through `recordImage`; this stands in for it
        // so the mapping into a step is what is under test.
        autoImage: async (input) => {
          input.recordImage?.({
            basePrompt: "A bright bathroom",
            prompt: "A bright bathroom, landscape 16:9 format, professional",
            negativePrompt: "deformed hands, watermark",
            provider: "ideogram",
            model: "V_2",
            style: "photographic",
            width: 1200,
            height: 624,
            startedAt: new Date("2026-03-01T10:00:00.000Z"),
            completedAt: new Date("2026-03-01T10:00:04.000Z"),
            durationMs: 4000,
            result: {
              url: "https://cdn/x.png",
              width: 1200,
              height: 624,
              providerAssetId: "prov-1",
              mediaAssetId: "asset-1",
            },
          });
          return {
            status: "generated",
            media: { id: "asset-1", url: "https://cdn/x.png", width: 1200, height: 624 },
          };
        },
      },
    });

    const context = makeContext({
      channel: { ...makeContext().channel, autoGenerateImage: true },
    });
    await generatePostFromContext(context, "company-1", {}, h.deps);

    const image = h.steps("image")[0];
    assert.equal(image.status, "success");
    const input = image.input as { prompt: string; negativePrompt: string };
    assert.ok(input.prompt.includes("landscape 16:9"));
    assert.equal(input.negativePrompt, "deformed hands, watermark");
    const metadata = image.metadata as { provider: string; model: string; width: number };
    assert.equal(metadata.provider, "ideogram");
    assert.equal(metadata.model, "V_2");
    assert.equal(metadata.width, 1200);
    assert.equal(image.durationMs, 4000);
  });
});

describe("generation trace — multi-channel", () => {
  let prevMockMode: string | undefined;
  before(() => {
    prevMockMode = process.env.AI_MOCK_MODE;
    process.env.AI_MOCK_MODE = "true";
  });
  after(() => {
    if (prevMockMode === undefined) delete process.env.AI_MOCK_MODE;
    else process.env.AI_MOCK_MODE = prevMockMode;
  });

  it("each channel gets its own run, its own post, and the shared content group", async () => {
    const contentGroupId = "group-1";
    const results: PersistableRun[] = [];

    for (const channel of ["linkedin", "facebook"] as const) {
      const h = makeHarness({
        postId: `post-${channel}`,
        tracerInit: { channel, contentGroupId },
      });
      const context = makeContext({ channel: { ...makeContext().channel, channel } });
      await generatePostFromContext(
        context,
        "company-1",
        {
          contentGroupId,
          // The sibling is told which claim to adapt, exactly as the
          // orchestrator tells it.
          ...(channel === "facebook"
            ? {
                sharedTopic: {
                  coreMessage: "One story.",
                  topic: "mixers",
                  establishedBy: "linkedin",
                },
              }
            : {}),
        },
        h.deps
      );
      results.push(h.run());
    }

    assert.deepEqual(
      results.map((r) => [r.channel, r.postId, r.contentGroupId]),
      [
        ["linkedin", "post-linkedin", contentGroupId],
        ["facebook", "post-facebook", contentGroupId],
      ]
    );

    // The sibling's context step records the topic it was ordered to adapt,
    // which is what distinguishes it from an independent generation.
    const siblingContext = results[1].steps.find((s) => s.type === "context");
    assert.equal(
      (siblingContext?.output as { sharedTopic: { coreMessage: string } | null }).sharedTopic
        ?.coreMessage,
      "One story."
    );
    // And the anchor's does not.
    const anchorContext = results[0].steps.find((s) => s.type === "context");
    assert.equal((anchorContext?.output as { sharedTopic: unknown }).sharedTopic, null);
  });
});

describe("generation trace — reliability and redaction in the real pipeline", () => {
  let prevMockMode: string | undefined;
  before(() => {
    prevMockMode = process.env.AI_MOCK_MODE;
    process.env.AI_MOCK_MODE = "true";
  });
  after(() => {
    if (prevMockMode === undefined) delete process.env.AI_MOCK_MODE;
    else process.env.AI_MOCK_MODE = prevMockMode;
  });

  it("a trace write that fails does NOT fail the generation", async () => {
    const originalError = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };

    try {
      const tracer = GenerationTracer.start({
        kind: "post_generation",
        trigger: "manual",
        companyId: "company-1",
        store: {
          saveRun: async () => {
            throw new Error("the database said no");
          },
        },
        newId: () => "run-doomed",
      });
      const h = makeHarness();
      const result = await generatePostFromContext(
        makeContext(),
        "company-1",
        {},
        { ...h.deps, tracer }
      );

      assert.equal(result.success, true, "the post must still have been generated");
      assert.ok(
        logged.join(" ").includes("[generation-trace] FAILED to persist run run-doomed"),
        "and the trace failure must be diagnosable from the log"
      );
    } finally {
      console.error = originalError;
    }
  });

  it("redacts a credential that reached the captured options", async () => {
    const h = makeHarness({
      tracerInit: {
        options: { llmConfigId: "cfg-1", apiKey: "abcdef0123456789" },
      },
    });
    await generatePostFromContext(makeContext(), "company-1", {}, h.deps);

    const options = h.run().options as Record<string, unknown>;
    assert.equal(options.apiKey, REDACTED);
    assert.equal(options.llmConfigId, "cfg-1", "an ordinary id must survive");
  });
});

describe("generation trace — the trigger is derived when nobody names it", () => {
  it("a schedule id means cron; a batch id means bulk; a group id means multi-channel", async () => {
    // Exercised through the derivation the pipeline uses, so the mapping is
    // asserted once rather than at four call sites.
    const { deriveTrigger } = await import("@/lib/generation-trace/post-generation-steps");

    assert.equal(deriveTrigger({ scheduleId: "s1", generationBatchId: "b1" }), "cron");
    assert.equal(deriveTrigger({ generationBatchId: "b1", contentGroupId: "g1" }), "bulk");
    assert.equal(
      deriveTrigger({ contentGroupId: "g1", generatedById: "u1" }),
      "manual_multi_channel"
    );
    assert.equal(deriveTrigger({ generatedById: "u1" }), "manual");
    assert.equal(deriveTrigger({}), "system");
  });
});

// Keeps the Prisma import meaningful for the JSON typing above.
export type _TraceJson = Prisma.JsonValue;
