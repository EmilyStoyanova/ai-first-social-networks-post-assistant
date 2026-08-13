import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateBulkRequest,
  validateBulkRequestShape,
  validateSourceMix,
  type BulkRequestShape,
} from "./validate-bulk-request.service";
import { MAX_BULK_POSTS } from "@/lib/scheduling/bulk-schedule";

/** A week before the period below, so "the start date is in the future" holds. */
const NOW = new Date("2026-08-10T09:00:00.000Z");
const START = "2026-08-17";
const END = "2026-08-30";

function makeRequest(overrides: Partial<BulkRequestShape> = {}): BulkRequestShape {
  return { numberOfPosts: 2, startDate: START, endDate: END, ...overrides };
}

// ─── The pure rules ───────────────────────────────────────────────────────────

describe("validateBulkRequestShape", () => {
  it("accepts an ordinary request", () => {
    assert.equal(validateBulkRequestShape(makeRequest(), NOW), null);
  });

  it("refuses a topic count outside the allowed range", () => {
    for (const numberOfPosts of [0, -1, MAX_BULK_POSTS + 1, 2.5, Number.NaN]) {
      const problem = validateBulkRequestShape(makeRequest({ numberOfPosts }), NOW);
      assert.equal(problem?.code, "INVALID_POST_COUNT", `for ${numberOfPosts}`);
    }
  });

  it("refuses a period that runs backwards or is unparseable", () => {
    assert.equal(
      validateBulkRequestShape(makeRequest({ startDate: END, endDate: START }), NOW)?.code,
      "INVALID_DATE_RANGE"
    );
    assert.equal(
      validateBulkRequestShape(makeRequest({ endDate: "not-a-date" }), NOW)?.code,
      "INVALID_DATE_RANGE"
    );
  });

  it("refuses a period longer than the cap", () => {
    assert.equal(
      validateBulkRequestShape(makeRequest({ endDate: "2028-08-30" }), NOW)?.code,
      "INVALID_DATE_RANGE"
    );
  });

  it("refuses a period that has already begun", () => {
    // Posts scheduled into the past are ones the publisher refuses to fire, so
    // this is cheaper to answer as a request error than as a batch of stranded
    // drafts.
    assert.equal(
      validateBulkRequestShape(makeRequest({ startDate: "2026-08-01" }), NOW)?.code,
      "START_DATE_IN_PAST"
    );
  });

  it("accepts a period starting today", () => {
    assert.equal(validateBulkRequestShape(makeRequest({ startDate: "2026-08-10" }), NOW), null);
  });

  it("refuses a schedule that does not add up to the topics requested", () => {
    const problem = validateBulkRequestShape(
      makeRequest({
        numberOfPosts: 3,
        customDistribution: [{ date: "2026-08-18", count: 1, times: ["10:00"] }],
      }),
      NOW
    );
    assert.equal(problem?.code, "INVALID_DISTRIBUTION");
    assert.ok(problem.message.length > 0);
  });

  it("refuses a schedule with a date outside the period", () => {
    assert.equal(
      validateBulkRequestShape(
        makeRequest({
          numberOfPosts: 1,
          customDistribution: [{ date: "2027-01-05", count: 1, times: ["10:00"] }],
        }),
        NOW
      )?.code,
      "INVALID_DISTRIBUTION"
    );
  });

  it("accepts a schedule that adds up and stays inside the period", () => {
    assert.equal(
      validateBulkRequestShape(
        makeRequest({
          numberOfPosts: 2,
          customDistribution: [
            { date: "2026-08-18", count: 1, times: ["10:00"] },
            { date: "2026-08-20", count: 1, times: ["14:30"] },
          ],
        }),
        NOW
      ),
      null
    );
  });

  it("reports the first problem when a request is wrong in several ways", () => {
    // Ordering is part of the contract: a caller may have built on being told
    // about the count first, so a second fault does not change the answer.
    const problem = validateBulkRequestShape(
      makeRequest({ numberOfPosts: 99, startDate: "2020-01-01", endDate: "2019-01-01" }),
      NOW
    );
    assert.equal(problem?.code, "INVALID_POST_COUNT");
  });

  it("never touches the source mix", () => {
    // The mix needs a database read, so it is deliberately not part of the pure
    // half — a caller using this alone must not silently skip that check.
    assert.equal(
      validateBulkRequestShape(makeRequest({ sourceMix: [{ sourceId: "nope", posts: 99 }] }), NOW),
      null
    );
  });
});

// ─── The content mix ──────────────────────────────────────────────────────────

describe("validateSourceMix", () => {
  const enabled = new Set(["source-a", "source-b"]);

  it("accepts a mix that adds up and names real, enabled sources", () => {
    assert.equal(
      validateSourceMix(
        [
          { sourceId: "source-a", posts: 1 },
          { sourceId: null, posts: 1 },
        ],
        2,
        undefined,
        enabled
      ),
      null
    );
  });

  it("refuses a mix that does not add up to the topics requested", () => {
    // Load-bearing: the mix IS the batch, so a mix that does not add up would
    // silently generate a different number of topics than the button promised.
    assert.ok(validateSourceMix([{ sourceId: "source-a", posts: 3 }], 2, undefined, enabled));
  });

  it("refuses a source this company does not have or has switched off", () => {
    assert.ok(validateSourceMix([{ sourceId: "source-z", posts: 2 }], 2, undefined, enabled));
  });

  it("refuses the same source listed twice", () => {
    assert.ok(
      validateSourceMix(
        [
          { sourceId: "source-a", posts: 1 },
          { sourceId: "source-a", posts: 1 },
        ],
        2,
        undefined,
        enabled
      )
    );
  });

  it("refuses a quota that is not a whole post", () => {
    assert.ok(validateSourceMix([{ sourceId: "source-a", posts: 0 }], 0, undefined, enabled));
    assert.ok(validateSourceMix([{ sourceId: "source-a", posts: 1.5 }], 1.5, undefined, enabled));
  });

  it("refuses a mix that names nobody", () => {
    assert.ok(validateSourceMix([], 2, undefined, enabled));
  });

  it("refuses a mix and a single picked source together", () => {
    // Alternatives, not layers — letting both through would leave the answer to
    // whichever the generation loop happened to read.
    assert.ok(
      validateSourceMix(
        [{ sourceId: "source-a", posts: 2 }],
        2,
        { kind: "source", sourceId: "source-b" },
        enabled
      )
    );
  });

  it("accepts a mix alongside the pooled default, which is what the form sends", () => {
    assert.equal(
      validateSourceMix(
        [{ sourceId: "source-a", posts: 2 }],
        2,
        { kind: "company_rules" },
        enabled
      ),
      null
    );
  });
});

// ─── The whole check ──────────────────────────────────────────────────────────

describe("validateBulkRequest", () => {
  const loadEnabledSourceIds = async () => new Set(["source-a"]);

  it("accepts a valid request without reading the database", async () => {
    let reads = 0;
    const problem = await validateBulkRequest("acme", makeRequest(), NOW, {
      loadEnabledSourceIds: async () => {
        reads += 1;
        return new Set<string>();
      },
    });

    assert.equal(problem, null);
    // No mix was submitted, so the ordinary request stays a pure function call.
    assert.equal(reads, 0);
  });

  it("answers a shape problem before reading the database", async () => {
    let reads = 0;
    const problem = await validateBulkRequest(
      "acme",
      makeRequest({ numberOfPosts: 99, sourceMix: [{ sourceId: "source-a", posts: 99 }] }),
      NOW,
      {
        loadEnabledSourceIds: async () => {
          reads += 1;
          return new Set<string>();
        },
      }
    );

    assert.equal(problem?.code, "INVALID_POST_COUNT");
    assert.equal(reads, 0);
  });

  it("checks a submitted mix against the company's real sources", async () => {
    const problem = await validateBulkRequest(
      "acme",
      makeRequest({ sourceMix: [{ sourceId: "source-nope", posts: 2 }] }),
      NOW,
      { loadEnabledSourceIds }
    );

    assert.equal(problem?.code, "INVALID_SOURCE_MIX");
  });

  it("accepts a mix that names real sources and adds up", async () => {
    const problem = await validateBulkRequest(
      "acme",
      makeRequest({ sourceMix: [{ sourceId: "source-a", posts: 2 }] }),
      NOW,
      { loadEnabledSourceIds }
    );

    assert.equal(problem, null);
  });
});
