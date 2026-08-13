import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  enqueueTopicGeneration,
  type EnqueueTopicGenerationDeps,
  type TopicGenerationRequest,
} from "./enqueue-topic-generation.service";
import { TOPIC_GENERATION_JOB_TYPE, TOPIC_GENERATION_MAX_ATTEMPTS } from "@/lib/queue/job-types";

const SLUG = "acme";
const USER_ID = "user-1";
const COMPANY_ID = "company-1";
const GROUP_ID = "group-1";

interface RecordedEnqueue {
  type: string;
  payload: Record<string, unknown>;
  dedupeKey: string | undefined;
  priority: number | undefined;
  maxAttempts: number | undefined;
  companyId: string | null | undefined;
  createdBy: string | null | undefined;
}

function makeDeps(options: { access?: { companyId: string } | null; enqueued?: boolean } = {}): {
  deps: EnqueueTopicGenerationDeps;
  enqueues: () => RecordedEnqueue[];
} {
  const enqueues: RecordedEnqueue[] = [];
  const deps: EnqueueTopicGenerationDeps = {
    resolveAccess: async () =>
      options.access === undefined ? { companyId: COMPANY_ID } : options.access,
    newContentGroupId: () => GROUP_ID,
    enqueue: async (input) => {
      enqueues.push({
        type: input.type,
        payload: input.payload as unknown as Record<string, unknown>,
        dedupeKey: input.dedupeKey,
        priority: input.priority,
        maxAttempts: input.maxAttempts,
        companyId: input.companyId,
        createdBy: input.createdBy,
      });
      return options.enqueued === false
        ? { enqueued: false, deduplicated: true, jobId: null }
        : { enqueued: true, deduplicated: false, jobId: "job-1" };
    },
  };
  return { deps, enqueues: () => enqueues };
}

function request(overrides: Partial<TopicGenerationRequest> = {}): TopicGenerationRequest {
  return { channels: ["linkedin", "facebook"], ...overrides };
}

describe("enqueueTopicGeneration — access", () => {
  it("refuses before anything is minted or queued", async () => {
    const { deps, enqueues } = makeDeps({ access: null });

    const result = await enqueueTopicGeneration(SLUG, USER_ID, false, request(), deps);

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, "NOT_FOUND");
    // A caller who may not generate for this company must not be able to put a
    // job in its queue, not even one that would fail later.
    assert.equal(enqueues().length, 0);
  });

  it("scopes the job to the company access was granted for", async () => {
    const { deps, enqueues } = makeDeps();

    await enqueueTopicGeneration(SLUG, USER_ID, false, request(), deps);

    // Written with the row: this is what the status endpoint scopes its read by,
    // so a job that existed without it would momentarily be readable by anyone.
    assert.equal(enqueues()[0].companyId, COMPANY_ID);
    assert.equal(enqueues()[0].createdBy, USER_ID);
  });
});

describe("enqueueTopicGeneration — the plan", () => {
  it("mints the content group up front and hands it back with the job", async () => {
    const { deps, enqueues } = makeDeps();

    const result = await enqueueTopicGeneration(SLUG, USER_ID, false, request(), deps);

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.jobId, "job-1");
    assert.equal(result.data.contentGroupId, GROUP_ID);
    // The worker cannot mint it: attempt 2 would mint a different one and the
    // channels it added would form a second group beside the first.
    assert.equal(enqueues()[0].payload.contentGroupId, GROUP_ID);
  });

  it("echoes the channels, so the client has a denominator before polling", async () => {
    const { deps } = makeDeps();

    const result = await enqueueTopicGeneration(
      SLUG,
      USER_ID,
      false,
      request({ channels: ["linkedin", "facebook", "instagram"] }),
      deps
    );

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.deepEqual(result.data.channels, ["linkedin", "facebook", "instagram"]);
  });

  it("queues at the right type, attempts and priority", async () => {
    const { deps, enqueues } = makeDeps();

    await enqueueTopicGeneration(SLUG, USER_ID, false, request(), deps);

    const queued = enqueues()[0];
    assert.equal(queued.type, TOPIC_GENERATION_JOB_TYPE);
    assert.equal(queued.maxAttempts, TOPIC_GENERATION_MAX_ATTEMPTS);
    // Above a bulk run (10): a person is watching a spinner for this one, and it
    // is minutes of work rather than tens of minutes.
    assert.equal(queued.priority, 20);
  });

  it("carries no dedupe key, so two colleagues are never refused", async () => {
    const { deps, enqueues } = makeDeps();

    await enqueueTopicGeneration(SLUG, USER_ID, false, request(), deps);

    // Deliberate: one topic makes a single claim, already guarded by the atomic
    // feed-item reservation and the (article, channel) unique index. A lock here
    // would newly refuse something the synchronous route always allowed.
    assert.equal(enqueues()[0].dedupeKey, undefined);
  });

  it("passes the generation options through unchanged", async () => {
    const { deps, enqueues } = makeDeps();

    await enqueueTopicGeneration(
      SLUG,
      USER_ID,
      false,
      request({
        contentLanguage: "bg",
        includeSourceLink: false,
        generateImage: true,
        llmConfigId: "llm-1",
        contentSource: "source-9",
      }),
      deps
    );

    const p = enqueues()[0].payload;
    assert.equal(p.contentLanguage, "bg");
    assert.equal(p.includeSourceLink, false);
    assert.equal(p.generateImage, true);
    assert.equal(p.llmConfigId, "llm-1");
    assert.equal(p.contentSource, "source-9");
  });

  it("never puts admin rights in the payload", async () => {
    const { deps, enqueues } = makeDeps();

    await enqueueTopicGeneration(SLUG, USER_ID, true, request(), deps);

    // A job can sit in the queue across the moment someone's rights are revoked;
    // the handler re-reads them at execution time.
    assert.ok(!("isGlobalAdmin" in enqueues()[0].payload));
  });
});

describe("enqueueTopicGeneration — refusing a request that cannot run", () => {
  it("refuses a single channel: that path is answered inline", async () => {
    const { deps, enqueues } = makeDeps();

    const result = await enqueueTopicGeneration(
      SLUG,
      USER_ID,
      false,
      request({ channels: ["linkedin"] }),
      deps
    );

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, "INVALID_PAYLOAD");
    assert.equal(enqueues().length, 0);
  });

  it("refuses a repeated channel", async () => {
    const { deps } = makeDeps();

    const result = await enqueueTopicGeneration(
      SLUG,
      USER_ID,
      false,
      request({ channels: ["linkedin", "linkedin"] }),
      deps
    );

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, "INVALID_PAYLOAD");
  });

  it("does not answer success when the queue returned no id", async () => {
    // Unreachable without a dedupe key, but a 202 naming a null job would leave
    // the client polling for a run that does not exist.
    const { deps } = makeDeps({ enqueued: false });

    const result = await enqueueTopicGeneration(SLUG, USER_ID, false, request(), deps);

    assert.equal(result.success, false);
  });
});
