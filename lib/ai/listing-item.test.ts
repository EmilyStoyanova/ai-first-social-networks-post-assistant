import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildListingIdentityIndex,
  listingIdentity,
  planListingSync,
  readStoredListing,
  renderListing,
  storedListingIdentity,
  type StoredListing,
} from "./listing-item";

const STORED: StoredListing = {
  provider: "qhti",
  externalId: "476",
  // Already extracted: these are the fields the source's instruction SELECTED at
  // ingestion. The instruction itself is deliberately not stored.
  fields: [
    { label: "Price", value: "74999" },
    { label: "VAT status", value: "INCLUDED" },
    { label: "Location", value: "гр. Лом, Монтана" },
  ],
  omitted: ["year", "engine"],
  basis: "instructed",
};

const URL_476 = "https://qhti.bg/obiavi/obiava-476-yahta-rinker-230";

function content(overrides: Partial<StoredListing> = {}): string {
  return JSON.stringify({ ...STORED, ...overrides });
}

// ─── Storage round-trip ───────────────────────────────────────────────────────

describe("readStoredListing", () => {
  it("round-trips what ingestion writes", () => {
    const read = readStoredListing(content());
    assert.deepEqual(read, STORED);
  });

  it("returns null for content that is not a listing payload", () => {
    // An RSS body, a product page's JSON, a prompt — none is a listing, and each
    // must fall through to the raw-text rendering rather than render an empty one.
    assert.equal(readStoredListing("Just some article prose."), null);
    assert.equal(readStoredListing('{"title":"A page","description":"x"}'), null);
    assert.equal(readStoredListing(null), null);
    assert.equal(readStoredListing(""), null);
    assert.equal(readStoredListing("{ not json"), null);
    assert.equal(readStoredListing("[1,2,3]"), null);
  });

  it("drops malformed field entries instead of rejecting the whole listing", () => {
    const read = readStoredListing(
      JSON.stringify({
        provider: "qhti",
        externalId: "1",
        fields: [
          { label: "Price", value: "10" },
          { label: "Broken" },
          null,
          "not an object",
          { label: "", value: "no label" },
          { label: "Location", value: "Варna" },
        ],
      })
    );
    assert.deepEqual(read?.fields, [
      { label: "Price", value: "10" },
      { label: "Location", value: "Варna" },
    ]);
  });

  it("defaults a row written before `basis` existed to 'all'", () => {
    const read = readStoredListing(
      JSON.stringify({ provider: "qhti", externalId: "1", fields: [] })
    );
    assert.equal(read?.basis, "all");
    assert.deepEqual(read?.omitted, []);
  });
});

describe("storedListingIdentity", () => {
  it("is provider-qualified, so two providers cannot collide on an id", () => {
    assert.equal(storedListingIdentity(content()), "qhti:476");
    assert.notEqual(listingIdentity("qhti", "1"), listingIdentity("other", "1"));
  });

  it("is null for a row that is not a listing", () => {
    assert.equal(storedListingIdentity("article text"), null);
  });
});

// ─── Synchronisation ──────────────────────────────────────────────────────────

describe("planListingSync", () => {
  const listings = [
    { externalId: "1", url: "https://x.test/a" },
    { externalId: "2", url: "https://x.test/b" },
    { externalId: "3", url: "https://x.test/c" },
  ];

  // The headline requirement: N listings in, N rows planned.
  it("plans ONE row per listing", () => {
    const plans = planListingSync(listings, new Map(), "qhti");
    assert.equal(plans.length, 3);
    assert.deepEqual(
      plans.map((p) => p.listing.url),
      ["https://x.test/a", "https://x.test/b", "https://x.test/c"]
    );
  });

  it("plans no rename for listings it has never seen", () => {
    const plans = planListingSync(listings, new Map(), "qhti");
    assert.ok(plans.every((p) => p.renameFrom === null));
  });

  // Idempotency: the same feed ingested twice must not double the rows.
  it("is idempotent across repeated syncs", () => {
    const index = buildListingIdentityIndex(
      listings.map((l) => ({
        url: l.url,
        content: JSON.stringify({ provider: "qhti", externalId: l.externalId, fields: [] }),
      }))
    );

    const plans = planListingSync(listings, index, "qhti");
    assert.equal(plans.length, 3, "still three — one per listing, not three more");
    assert.ok(
      plans.every((p) => p.renameFrom === null),
      "unchanged URLs need no rename"
    );
  });

  // The reason identity beats address.
  it("moves an existing row when a listing is re-slugged", () => {
    const index = new Map([["qhti:2", "https://x.test/b-OLD-SLUG"]]);
    const plans = planListingSync(listings, index, "qhti");

    const moved = plans.find((p) => p.listing.externalId === "2");
    assert.equal(moved?.renameFrom, "https://x.test/b-OLD-SLUG");
    assert.equal(moved?.listing.url, "https://x.test/b");

    // And nothing else is disturbed.
    assert.ok(
      plans.filter((p) => p.listing.externalId !== "2").every((p) => p.renameFrom === null)
    );
  });

  it("does not confuse the same external id from a different provider", () => {
    const index = new Map([["other:1", "https://elsewhere.test/1"]]);
    const plans = planListingSync(listings, index, "qhti");
    assert.equal(plans[0].renameFrom, null, "qhti:1 is not other:1");
  });

  it("drops a duplicate external id within one fetch", () => {
    const plans = planListingSync(
      [
        { externalId: "1", url: "https://x.test/a" },
        { externalId: "1", url: "https://x.test/a-again" },
      ],
      new Map(),
      "qhti"
    );
    assert.equal(plans.length, 1);
    assert.equal(plans[0].listing.url, "https://x.test/a");
  });
});

describe("buildListingIdentityIndex", () => {
  it("indexes listing rows and ignores everything else", () => {
    const index = buildListingIdentityIndex([
      { url: URL_476, content: content() },
      { url: "https://news.test/article", content: "An article body." },
      { url: "prompt:abc", content: null },
    ]);

    assert.equal(index.size, 1);
    assert.equal(index.get("qhti:476"), URL_476);
  });
});

// ─── Rendering ────────────────────────────────────────────────────────────────

describe("renderListing", () => {
  it("prints every field on its own line, in the provider's order", () => {
    const text = renderListing(STORED, URL_476);
    const priceAt = text.indexOf("Price: 74999");
    const vatAt = text.indexOf("VAT status: INCLUDED");
    const locationAt = text.indexOf("Location: гр. Лом, Монтана");

    assert.ok(priceAt > -1 && vatAt > -1 && locationAt > -1, "all three present");
    assert.ok(priceAt < vatAt && vatAt < locationAt, "order preserved");
  });

  it("carries the listing's own URL and forbids rewriting it", () => {
    const text = renderListing(STORED, URL_476);
    assert.ok(text.includes(URL_476));
    assert.ok(/never alter it/i.test(text));
  });

  // The correction this module exists in its current form for: extraction is an
  // INGESTION concern. By the time a listing reaches a prompt the instruction has
  // already been applied, and repeating it would ask the Writer to perform a
  // retrieval it cannot perform — the source is not in front of it, only the
  // already-extracted result is.
  it("never renders the extraction instruction", () => {
    const text = renderListing(STORED, URL_476);
    assert.ok(!/extract/i.test(text), "no retrieval task reaches the Writer");
    assert.ok(!/WHAT THIS COMPANY WANTS/.test(text));
  });

  // Naming the blanks is how a model learns which ones to fill.
  it("never renders the omitted terms", () => {
    const text = renderListing(STORED, URL_476);
    assert.ok(!/year/i.test(text.replace(/a year/i, "")), "must not name 'year' as a gap");
    assert.ok(!/engine/i.test(text));
  });

  it("presents the selected fields as the COMPLETE fact set", () => {
    const text = renderListing(STORED, URL_476);
    assert.ok(/complete set of facts/i.test(text));
  });

  it("omits the link block when the listing has no public URL", () => {
    const text = renderListing(STORED, null);
    assert.ok(!/Listing page:/.test(text));
  });

  // The anti-fabrication rule is the load-bearing half of this prompt: a
  // marketplace post's commonest failure is a confident sentence about year,
  // condition or equipment that the feed never stated.
  it("always forbids inventing absent details", () => {
    for (const text of [
      renderListing(STORED, URL_476),
      renderListing({ ...STORED, fields: [], omitted: [], basis: "all" }, null),
    ]) {
      assert.ok(/Do not invent/i.test(text));
      assert.ok(/currency/i.test(text), "currency named explicitly — QHTI states none");
    }
  });

  it("frames the item as one listing, never as a catalogue", () => {
    const text = renderListing(STORED, URL_476);
    assert.ok(/ONE item/.test(text));
  });
});
