import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  candidateWhereFor,
  fetchGenerationCandidates,
  type SourceScope,
} from "./build-generation-context.service";

/**
 * The candidate window, exercised against ROWS.
 *
 * A test that asserts the SHAPE of a `where` proves nothing — a well-formed
 * clause that matches zero rows passes it happily (bug-1318). So this file
 * composes exactly what `loadContext` composes — `candidateWhereFor(companyId,
 * scope)` fed to `fetchGenerationCandidates` — and interprets the result against
 * a seeded corpus, asking the only question that matters: which articles come
 * back, and in what order.
 *
 * **Why testing the scopes covers every flow.** Every generation in the product
 * reaches one of two entry points, `buildGenerationContextForCompany` (cron) and
 * `buildGenerationContext` (everything user-facing), and both hand off to the
 * same `loadContext`. Nothing about the caller reaches the window; the only thing
 * that varies is the SourceScope:
 *
 *   • cron weekly generation    → pooled, or source (a content-mix quota)
 *   • bulk generation           → pooled, or source (the batch's mix)
 *   • manual form               → pooled, source, or content_source
 *   • multi-channel siblings    → feed_item
 *   • prompt preview            → pooled or source
 *
 * So a rule that holds for all five scopes holds for all four flows, and the
 * REJECTED tests below are written scope-by-scope for exactly that reason.
 */

interface Row {
  id: string;
  companyId: string;
  sourceId: string;
  classification: string | null;
  enabled: boolean;
  usedInPost: boolean;
  sourceEnabled: boolean;
  /** NULL for every ordinary company source; set only on a competitor's
   *  ContentSource row (competitor_rss/competitor_website). */
  sourceCompetitorId: string | null;
  /**
   * Whether `content` is the article or only the feed's summary.
   *
   * `null` is the third state and the important one: every row ingested before
   * the column existed, and every non-RSS source type, reads as unknown and must
   * stay eligible.
   */
  contentComplete: boolean | null;
  /** Higher is newer — stands in for `publishedAt desc, createdAt desc`. */
  publishedAt: number;
}

const CO = "co-1";

let seq = 0;
function row(id: string, classification: string | null, overrides: Partial<Row> = {}): Row {
  seq -= 1;
  return {
    id,
    companyId: CO,
    sourceId: "src-1",
    classification,
    enabled: true,
    usedInPost: false,
    sourceEnabled: true,
    sourceCompetitorId: null,
    contentComplete: true,
    // Seeded rows get strictly decreasing recency, so "declared first" reads as
    // "newest" and a tier's internal order is the array order.
    publishedAt: seq,
    ...overrides,
  };
}

/**
 * Interprets a `where` from `candidateWhereFor` against one row.
 *
 * The `default: throw` is deliberate: a new eligibility key added to the filter
 * without teaching this interpreter about it fails the suite loudly, rather than
 * being silently ignored and letting the tests keep passing about a filter they
 * no longer model.
 */
function matches(r: Row, where: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(where)) {
    switch (key) {
      case "companyId":
        if (r.companyId !== value) return false;
        break;
      case "enabled":
        if (r.enabled !== value) return false;
        break;
      case "usedInPost":
        if (r.usedInPost !== value) return false;
        break;
      case "id":
        if (r.id !== value) return false;
        break;
      case "sourceId":
        if (r.sourceId !== value) return false;
        break;
      case "source": {
        const clause = value as { enabled: boolean; competitorId?: string | null };
        if (r.sourceEnabled !== clause.enabled) return false;
        if ("competitorId" in clause && r.sourceCompetitorId !== clause.competitorId) return false;
        break;
      }
      case "classification":
        // Exact equality, including null — this is the tier predicate.
        if (r.classification !== value) return false;
        break;
      case "AND":
        // Every clause must hold. Used for the content-completeness gate, which
        // is nested here rather than left at the top level so it cannot collide
        // with an OR a caller composes on.
        if (!(value as Array<Record<string, unknown>>).every((clause) => matches(r, clause)))
          return false;
        break;
      case "OR":
        if (!(value as Array<Record<string, unknown>>).some((clause) => matches(r, clause)))
          return false;
        break;
      case "contentComplete":
        // Exact equality including null — `{ contentComplete: null }` is the
        // branch that admits the pre-existing archive.
        if (r.contentComplete !== value) return false;
        break;
      default:
        throw new Error(`Test interpreter does not model the filter key "${key}"`);
    }
  }
  return true;
}

/** A finder over a fixed corpus, honouring the filter, the order and the take. */
function finderOver(corpus: Row[]) {
  return async (where: Record<string, unknown>, take: number): Promise<Row[]> =>
    corpus
      .filter((r) => matches(r, where))
      .sort((a, b) => b.publishedAt - a.publishedAt)
      .slice(0, take);
}

async function windowFor(corpus: Row[], scope: SourceScope, take = 5): Promise<string[]> {
  const items = await fetchGenerationCandidates(
    candidateWhereFor(CO, scope),
    take,
    finderOver(corpus)
  );
  return items.map((i) => i.id);
}

const POOLED: SourceScope = { kind: "pooled" };

// ─── 1. HIGH is preferred over MEDIUM ─────────────────────────────────────────

describe("candidate window — HIGH before MEDIUM", () => {
  it("offers the HIGH article first even when a MEDIUM one is newer", async () => {
    // m1 is declared first, so it is the newer row. Recency alone would put it
    // in front; priority must not let it.
    const corpus = [row("m1", "MEDIUM"), row("h1", "HIGH")];

    assert.deepEqual(await windowFor(corpus, POOLED), ["h1", "m1"]);
  });

  it("offers a HIGH article older than a full window of newer MEDIUM ones", async () => {
    // THE reason the window is one query per tier rather than a sort over a
    // recency-limited page. Taking the newest five and sorting them afterwards
    // would never see h1 at all — it is the sixth-newest row.
    const corpus = [
      row("m1", "MEDIUM"),
      row("m2", "MEDIUM"),
      row("m3", "MEDIUM"),
      row("m4", "MEDIUM"),
      row("m5", "MEDIUM"),
      row("h1", "HIGH"),
    ];

    const window = await windowFor(corpus, POOLED);
    assert.equal(window[0], "h1");
  });

  it("exhausts HIGH before drawing on MEDIUM at all", async () => {
    const corpus = [
      row("m1", "MEDIUM"),
      row("h1", "HIGH"),
      row("m2", "MEDIUM"),
      row("h2", "HIGH"),
      row("h3", "HIGH"),
    ];

    assert.deepEqual(await windowFor(corpus, POOLED), ["h1", "h2", "h3", "m1", "m2"]);
  });

  it("keeps recency order within a tier", async () => {
    const corpus = [row("h1", "HIGH"), row("h2", "HIGH"), row("h3", "HIGH")];

    assert.deepEqual(await windowFor(corpus, POOLED), ["h1", "h2", "h3"]);
  });

  it("still applies every eligibility rule first — priority never grants it", async () => {
    // Three HIGH articles that MAY NOT be used, for three different reasons.
    // None of them may block or displace the eligible MEDIUM one.
    const corpus = [
      row("h-used", "HIGH", { usedInPost: true }),
      row("h-off", "HIGH", { enabled: false }),
      row("h-src-off", "HIGH", { sourceEnabled: false }),
      row("m1", "MEDIUM"),
    ];

    assert.deepEqual(await windowFor(corpus, POOLED), ["m1"]);
  });
});

// ─── 2. MEDIUM when no HIGH is available ──────────────────────────────────────

describe("candidate window — MEDIUM fallback", () => {
  it("uses MEDIUM when the company has no HIGH article at all", async () => {
    const corpus = [row("u1", null), row("m1", "MEDIUM"), row("m2", "MEDIUM")];

    const window = await windowFor(corpus, POOLED);
    assert.deepEqual(window.slice(0, 2), ["m1", "m2"]);
  });

  it("uses MEDIUM when every HIGH article is already consumed", async () => {
    const corpus = [
      row("h1", "HIGH", { usedInPost: true }),
      row("h2", "HIGH", { usedInPost: true }),
      row("m1", "MEDIUM"),
    ];

    assert.deepEqual(await windowFor(corpus, POOLED), ["m1"]);
  });
});

// ─── 3. Unclassified is a fallback only ───────────────────────────────────────

describe("candidate window — unclassified is last", () => {
  it("ranks a missing verdict behind MEDIUM", async () => {
    const corpus = [row("u1", null), row("m1", "MEDIUM"), row("h1", "HIGH")];

    assert.deepEqual(await windowFor(corpus, POOLED), ["h1", "m1", "u1"]);
  });

  it("never treats a missing verdict as a rejection", async () => {
    // null covers an unconfigured company, an article still queued, and one
    // whose classification failed. All three must stay usable — discarding
    // content because a model was briefly unavailable is the failure here.
    const corpus = [row("u1", null), row("u2", null)];

    assert.deepEqual(await windowFor(corpus, POOLED), ["u1", "u2"]);
  });

  it("leaves a company with no topics configured on pure recency", async () => {
    // The backwards-compatibility case: every row null, so every row is in one
    // tier and the order out is the order the query returned.
    const corpus = [row("a", null), row("b", null), row("c", null)];

    assert.deepEqual(await windowFor(corpus, POOLED), ["a", "b", "c"]);
  });

  it("does not draw on unclassified while MEDIUM articles remain", async () => {
    const corpus = [
      row("u1", null),
      row("u2", null),
      row("m1", "MEDIUM"),
      row("m2", "MEDIUM"),
      row("m3", "MEDIUM"),
    ];

    const window = await windowFor(corpus, POOLED, 3);
    assert.deepEqual(window, ["m1", "m2", "m3"]);
  });
});

// ─── 4. REJECTED is never selected, in any flow ───────────────────────────────

describe("candidate window — REJECTED is never offered", () => {
  // One case per SourceScope. See the header note: the scope is the only thing
  // that differs between cron, bulk, manual and preview generation, so covering
  // every scope covers every flow.
  const scopes: Array<{ name: string; scope: SourceScope; flows: string }> = [
    { name: "pooled", scope: { kind: "pooled" }, flows: "cron, bulk, manual, preview" },
    {
      name: "source",
      scope: { kind: "source", sourceId: "src-1" },
      flows: "cron mix, bulk, manual",
    },
    {
      name: "content_source",
      scope: { kind: "content_source", sourceId: "src-1" },
      flows: "manual non-RSS pick",
    },
    {
      name: "feed_item",
      scope: { kind: "feed_item", feedItemId: "r1" },
      flows: "sibling channels",
    },
  ];

  for (const { name, scope, flows } of scopes) {
    it(`withholds a REJECTED article from the ${name} window (${flows})`, async () => {
      const corpus = [row("r1", "REJECTED"), row("m1", "MEDIUM")];

      assert.equal((await windowFor(corpus, scope)).includes("r1"), false);
    });
  }

  it("returns an empty window rather than falling back to a REJECTED article", async () => {
    // The one that decides the feature: with nothing else available, generation
    // must skip, not settle for an article the company said no to.
    const corpus = [row("r1", "REJECTED"), row("r2", "REJECTED")];

    assert.deepEqual(await windowFor(corpus, POOLED), []);
  });

  it("withholds it even when a person named that exact article", async () => {
    // The removed carve-out, pinned as a test. A sibling-channel window names one
    // item outright and drops the one-post-per-article filter — but naming an
    // article narrows the window, it does not exempt it from the tiers.
    const corpus = [row("r1", "REJECTED", { usedInPost: true })];

    assert.deepEqual(await windowFor(corpus, { kind: "feed_item", feedItemId: "r1" }), []);
  });

  it("does not let a REJECTED article displace an eligible one", async () => {
    const corpus = [row("r1", "REJECTED"), row("r2", "REJECTED"), row("u1", null)];

    assert.deepEqual(await windowFor(corpus, POOLED), ["u1"]);
  });
});

// ─── The eligibility filter each scope composes ───────────────────────────────

describe("candidateWhereFor", () => {
  it("applies one-post-per-article to the pooled window", async () => {
    const where = candidateWhereFor(CO, POOLED);
    assert.equal(where.usedInPost, false);
    assert.equal(where.companyId, CO);
    assert.equal(where.enabled, true);
    assert.deepEqual(where.source, { enabled: true, competitorId: null });
  });

  it("narrows to one source without loosening anything", async () => {
    const where = candidateWhereFor(CO, { kind: "source", sourceId: "src-2" });
    assert.equal(where.sourceId, "src-2");
    assert.equal(where.usedInPost, false);
  });

  it("drops one-post-per-article for a direct content source", async () => {
    // A product page's extraction is not a one-shot article; keeping the filter
    // would make the source pickable exactly once and dry forever after.
    const where = candidateWhereFor(CO, { kind: "content_source", sourceId: "src-2" });
    assert.equal("usedInPost" in where, false);
    assert.equal(where.sourceId, "src-2");
  });

  it("drops one-post-per-article for a pinned sibling, and names the item", async () => {
    const where = candidateWhereFor(CO, { kind: "feed_item", feedItemId: "fi-9" });
    assert.equal("usedInPost" in where, false);
    assert.equal(where.id, "fi-9");
    // Still company- and source-scoped: naming an item is not a bypass.
    assert.equal(where.companyId, CO);
    assert.deepEqual(where.source, { enabled: true, competitorId: null });
  });

  it("keeps a disabled source out of every scope", async () => {
    const corpus = [row("h1", "HIGH", { sourceEnabled: false })];
    for (const scope of [
      POOLED,
      { kind: "source", sourceId: "src-1" } as SourceScope,
      { kind: "content_source", sourceId: "src-1" } as SourceScope,
      { kind: "feed_item", feedItemId: "h1" } as SourceScope,
    ]) {
      assert.deepEqual(await windowFor(corpus, scope), []);
    }
  });

  it("keeps a manually disabled article out, whatever its verdict", async () => {
    // A person who switched an article off has overruled the classifier.
    const corpus = [row("h1", "HIGH", { enabled: false })];
    assert.deepEqual(await windowFor(corpus, POOLED), []);
  });

  it("cannot leak another company's articles into a scoped window", async () => {
    const corpus = [row("h1", "HIGH", { companyId: "co-2" }), row("m1", "MEDIUM")];
    assert.deepEqual(await windowFor(corpus, POOLED), ["m1"]);
  });
});

// ─── Content completeness gate ────────────────────────────────────────────────

describe("candidate window — summary-only articles are not generatable", () => {
  it("withholds an article whose stored content is only the feed summary", async () => {
    // The Albania case: full-text extraction failed, the feed's one-sentence
    // <description> was stored instead, and a post was written from it about a
    // subject the article never covers.
    const corpus = [row("summary-only", null, { contentComplete: false }), row("full", null)];

    assert.deepEqual(await windowFor(corpus, POOLED), ["full"]);
  });

  it("withholds it regardless of how highly the classifier rated it", async () => {
    // Priority orders; it never grants eligibility. A HIGH verdict on an
    // article nobody actually read must not buy it a way back in.
    const corpus = [row("h-partial", "HIGH", { contentComplete: false }), row("m-full", "MEDIUM")];

    assert.deepEqual(await windowFor(corpus, POOLED), ["m-full"]);
  });

  it("keeps rows ingested before the column existed (NULL is not incomplete)", async () => {
    // The migration risk: NULL means unknown. Treating it as incomplete would
    // make the entire pre-existing archive ungeneratable on deploy.
    const corpus = [row("legacy", null, { contentComplete: null })];

    assert.deepEqual(await windowFor(corpus, POOLED), ["legacy"]);
  });

  it("keeps non-RSS sources, which never carry the flag", async () => {
    // A product page / prompt / calendar event stores a JSON payload assembled
    // at ingestion, not an article read off a page.
    const corpus = [row("product-page", null, { contentComplete: null })];

    assert.deepEqual(await windowFor(corpus, { kind: "content_source", sourceId: "src-1" }), [
      "product-page",
    ]);
  });

  it("applies to a pinned sibling channel too", async () => {
    // The content-group door: a sibling window drops the usedInPost filter, and
    // must not become a way for an unread article to re-enter generation.
    const corpus = [row("pinned", null, { contentComplete: false, usedInPost: true })];

    assert.deepEqual(await windowFor(corpus, { kind: "feed_item", feedItemId: "pinned" }), []);
  });

  it("returns an empty window when every candidate is summary-only", async () => {
    // Correct outcome: the caller skips rather than writing from a blurb.
    const corpus = [
      row("s1", "HIGH", { contentComplete: false }),
      row("s2", "MEDIUM", { contentComplete: false }),
    ];

    assert.deepEqual(await windowFor(corpus, POOLED), []);
  });
});

// ─── Competitive Analysis isolation (Part 3B §3.8/§4) ─────────────────────────

describe("candidate window — competitor sources are never generation input", () => {
  it("excludes an item from a competitor ContentSource even though it is otherwise eligible", async () => {
    const corpus = [
      row("own", "HIGH"),
      row("competitor-item", "HIGH", { sourceId: "src-competitor", sourceCompetitorId: "c-1" }),
    ];

    assert.deepEqual(await windowFor(corpus, POOLED), ["own"]);
  });

  it("excludes a competitor item from every scope, not only pooled", async () => {
    const competitorRow = row("competitor-item", "HIGH", {
      sourceId: "src-competitor",
      sourceCompetitorId: "c-1",
    });

    assert.deepEqual(
      await windowFor([competitorRow], { kind: "source", sourceId: "src-competitor" }),
      []
    );
    assert.deepEqual(
      await windowFor([competitorRow], { kind: "content_source", sourceId: "src-competitor" }),
      []
    );
    // Even the pinned-sibling window, which drops usedInPost/contentComplete
    // leniency, must not let a competitor item back in.
    assert.deepEqual(
      await windowFor([competitorRow], { kind: "feed_item", feedItemId: "competitor-item" }),
      []
    );
  });
});
