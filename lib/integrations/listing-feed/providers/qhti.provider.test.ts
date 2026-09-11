import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  collectQhtiListings,
  joinLocation,
  normalizeQhtiListing,
  parseJavaDateArray,
} from "./qhti.provider";

/**
 * Fixtures are REAL rows, copied verbatim from https://qhti.bg/ads/homepage on
 * 2026-09-11. Every field name, enum token and nesting level below is what the
 * endpoint actually returned — the mapping is only worth testing against the
 * shape it has to survive.
 */
const REAL_BOAT = {
  id: 475,
  title: "Лодка Собствено производство / Други Play rover open",
  slug: "obiava-475-lodka-sobstveno-proizvodstvo-drugi-play-rover-open",
  category: "BOATS_AND_YACHTS",
  price: { amount: 1750.0, type: "FIXED_PRICE", vatStatus: "PRIVATE_SALE" },
  location1: "Монтана",
  location2: "гр. Лом",
  adType: "FROM_PRIVATE",
  userId: "c8ecb5e4-0b28-43aa-8d29-6cd8ca14dd15",
  createdAt: [2026, 8, 11, 9, 21, 52, 421057000],
  primaryImageUrl: "https://boat-marketplace-images.s3.eu-north-1.amazonaws.com/ads/475/a.webp",
  companyLogo: "",
  homepageCategory: "BOATS",
};

const REAL_SONAR = {
  id: 474,
  title: "Сонар Garmin Gpsmap 8412xsv",
  slug: "obiava-474-sonar-garmin-gpsmap-8412xsv",
  category: "MARINE_ELECTRONICS",
  price: { amount: 3800.0, type: "FIXED_PRICE", vatStatus: "INCLUDED" },
  location1: "Стара Загора",
  location2: "гр. Стара Загора",
  adType: "FROM_PRIVATE",
  createdAt: [2026, 8, 10, 18, 8, 39, 596851000],
  primaryImageUrl: "https://boat-marketplace-images.s3.eu-north-1.amazonaws.com/ads/474/b.webp",
  companyLogo: "",
  homepageCategory: "SONARS",
};

function fieldValue(
  fields: ReadonlyArray<{ label: string; value: string }>,
  label: string
): string | undefined {
  return fields.find((f) => f.label === label)?.value;
}

function conceptsOf(
  fields: ReadonlyArray<{ key: string; concepts: readonly string[] }>,
  key: string
): readonly string[] {
  return fields.find((f) => f.key === key)?.concepts ?? [];
}

// ─── parseJavaDateArray ───────────────────────────────────────────────────────

describe("parseJavaDateArray", () => {
  // The single highest-value assertion in this file. Java serialises
  // LocalDateTime with a 1-BASED month; Date.UTC takes a 0-based one. Reading it
  // straight through is an off-by-one month on every listing ever ingested.
  it("reads Java's 1-based month correctly", () => {
    const date = parseJavaDateArray([2026, 8, 11, 9, 21, 52, 421057000]);
    assert.equal(date?.toISOString(), "2026-08-11T09:21:52.000Z");
  });

  it("accepts a date-only array", () => {
    assert.equal(parseJavaDateArray([2026, 1, 5])?.toISOString(), "2026-01-05T00:00:00.000Z");
  });

  it("rejects anything that is not a plausible date array", () => {
    assert.equal(parseJavaDateArray(null), null);
    assert.equal(parseJavaDateArray("2026-08-11"), null);
    assert.equal(parseJavaDateArray([2026]), null);
    assert.equal(parseJavaDateArray([2026, 13, 1]), null, "month 13");
    assert.equal(parseJavaDateArray([2026, 0, 1]), null, "month 0 — a 0-based writer");
    assert.equal(parseJavaDateArray([2026, 8, 40]), null, "day 40");
  });
});

// ─── normalizeQhtiListing ─────────────────────────────────────────────────────

describe("normalizeQhtiListing — canonical values", () => {
  it("builds the listing URL from the provider's own slug", () => {
    const result = normalizeQhtiListing(REAL_BOAT, "boats");
    assert.ok(result.ok);
    assert.equal(
      result.listing.url,
      "https://qhti.bg/obiavi/obiava-475-lodka-sobstveno-proizvodstvo-drugi-play-rover-open"
    );
  });

  it("keeps the external id as the sync identity", () => {
    const result = normalizeQhtiListing(REAL_BOAT, "boats");
    assert.ok(result.ok);
    assert.equal(result.listing.externalId, "475");
  });

  it("preserves the image URL for the media pipeline", () => {
    const result = normalizeQhtiListing(REAL_BOAT, "boats");
    assert.ok(result.ok);
    assert.equal(
      result.listing.imageUrl,
      "https://boat-marketplace-images.s3.eu-north-1.amazonaws.com/ads/475/a.webp"
    );
  });

  it("never substitutes the seller's logo for a missing listing photo", () => {
    const result = normalizeQhtiListing(
      { ...REAL_BOAT, primaryImageUrl: null, companyLogo: "https://example.test/logo.png" },
      "boats"
    );
    assert.ok(result.ok);
    assert.equal(result.listing.imageUrl, null);
  });

  // QHTI's payload carries no currency field anywhere. Inventing one would put a
  // wrong price on a published advert.
  it("emits the amount with no invented currency", () => {
    const result = normalizeQhtiListing(REAL_BOAT, "boats");
    assert.ok(result.ok);
    assert.equal(fieldValue(result.listing.fields, "Price"), "1750");
    const rendered = result.listing.fields.map((f) => f.value).join(" ");
    for (const symbol of ["€", "$", "лв", "BGN", "EUR"]) {
      assert.ok(!rendered.includes(symbol), `must not invent a currency (${symbol})`);
    }
  });

  it("keeps a fractional amount at two decimals", () => {
    const result = normalizeQhtiListing(
      { ...REAL_BOAT, price: { amount: 27.5, type: "FIXED_PRICE", vatStatus: "INCLUDED" } },
      "parts"
    );
    assert.ok(result.ok);
    assert.equal(fieldValue(result.listing.fields, "Price"), "27.50");
  });

  it("passes enum tokens through verbatim rather than interpreting them", () => {
    const result = normalizeQhtiListing(REAL_BOAT, "boats");
    assert.ok(result.ok);
    assert.equal(fieldValue(result.listing.fields, "Price type"), "FIXED_PRICE");
    assert.equal(fieldValue(result.listing.fields, "VAT status"), "PRIVATE_SALE");
    assert.equal(fieldValue(result.listing.fields, "Seller type"), "FROM_PRIVATE");
  });

  it("joins the two location fields, most specific first", () => {
    const result = normalizeQhtiListing(REAL_BOAT, "boats");
    assert.ok(result.ok);
    assert.equal(fieldValue(result.listing.fields, "Location"), "гр. Лом, Монтана");
  });

  it("does not repeat a region the settlement already names", () => {
    // location1 "Стара Загора", location2 "гр. Стара Загора" — different strings,
    // same place. A published advert must not say "гр. Стара Загора, Стара Загора".
    const result = normalizeQhtiListing(REAL_SONAR, "sonars");
    assert.ok(result.ok);
    assert.equal(fieldValue(result.listing.fields, "Location"), "гр. Стара Загора");
  });
});

describe("normalizeQhtiListing — declared concepts", () => {
  // The concepts are what make ingestion-time extraction work without a model.
  // They live with the PROVIDER so the generic selector stays free of domain
  // vocabulary — it never learns what a price is, only what QHTI calls one.
  it("declares each field's own vocabulary, in both UI languages", () => {
    const result = normalizeQhtiListing(REAL_BOAT, "boats");
    assert.ok(result.ok);
    const { fields } = result.listing;

    assert.ok(conceptsOf(fields, "price").includes("price"));
    assert.ok(conceptsOf(fields, "price").includes("цена"), "an owner may write BG");
    assert.ok(conceptsOf(fields, "location").includes("location"));
    assert.ok(conceptsOf(fields, "location").includes("локация"));
    assert.ok(conceptsOf(fields, "sellerType").includes("seller"));
  });

  // "22200 NEGOTIABLE" is a materially different offer from "22200 FIXED_PRICE",
  // so an owner asking for the price gets the whole price picture.
  it("makes price type and VAT status answer to 'price' as well", () => {
    const result = normalizeQhtiListing(REAL_BOAT, "boats");
    assert.ok(result.ok);
    assert.ok(conceptsOf(result.listing.fields, "priceType").includes("price"));
    assert.ok(conceptsOf(result.listing.fields, "vatStatus").includes("price"));
  });

  it("gives every field a stable key", () => {
    const result = normalizeQhtiListing(REAL_BOAT, "boats");
    assert.ok(result.ok);
    const keys = result.listing.fields.map((f) => f.key);
    assert.deepEqual(keys, [
      "price",
      "priceType",
      "vatStatus",
      "category",
      "listingGroup",
      "sellerType",
      "location",
    ]);
    assert.equal(new Set(keys).size, keys.length, "keys are unique");
  });
});

describe("joinLocation", () => {
  it("keeps a genuinely different region", () => {
    assert.equal(joinLocation("Монтана", "гр. Лом"), "гр. Лом, Монтана");
  });

  it("drops a region the settlement already contains", () => {
    assert.equal(joinLocation("Стара Загора", "гр. Стара Загора"), "гр. Стара Загора");
    assert.equal(joinLocation("Варна", "гр. Варна"), "гр. Варна");
  });

  it("is case- and whitespace-insensitive about that containment", () => {
    assert.equal(joinLocation("СОФИЯ", "гр.  софия"), "гр.  софия");
  });

  it("survives either half being absent", () => {
    assert.equal(joinLocation(null, "гр. Лом"), "гр. Лом");
    assert.equal(joinLocation("Монтана", null), "Монтана");
    assert.equal(joinLocation(null, null), null);
  });
});

describe("normalizeQhtiListing — malformed entries", () => {
  it("rejects a listing with no slug, because it would have no page to link", () => {
    const result = normalizeQhtiListing({ ...REAL_BOAT, slug: null }, "boats");
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.reason.includes("slug"));
    assert.ok(!result.ok && result.externalId === "475", "names the item it rejected");
  });

  it("rejects a listing with no id", () => {
    const result = normalizeQhtiListing({ ...REAL_BOAT, id: null }, "boats");
    assert.equal(result.ok, false);
  });

  it("rejects a listing with no title", () => {
    const result = normalizeQhtiListing({ ...REAL_BOAT, title: "  " }, "boats");
    assert.equal(result.ok, false);
  });

  it("rejects a non-object entry", () => {
    assert.equal(normalizeQhtiListing("a string", "boats").ok, false);
    assert.equal(normalizeQhtiListing(null, "boats").ok, false);
    assert.equal(normalizeQhtiListing([1, 2], "boats").ok, false);
  });

  // A listing missing a price is still a perfectly good advert.
  it("keeps a listing whose price is absent, simply without the field", () => {
    const result = normalizeQhtiListing({ ...REAL_BOAT, price: null }, "boats");
    assert.ok(result.ok);
    assert.equal(fieldValue(result.listing.fields, "Price"), undefined);
    assert.equal(result.listing.title, REAL_BOAT.title);
  });

  it("keeps a listing whose image is absent", () => {
    const result = normalizeQhtiListing({ ...REAL_BOAT, primaryImageUrl: null }, "boats");
    assert.ok(result.ok);
    assert.equal(result.listing.imageUrl, null);
  });
});

// ─── collectQhtiListings ──────────────────────────────────────────────────────

describe("collectQhtiListings", () => {
  it("produces ONE listing per ad across every bucket", () => {
    const result = collectQhtiListings({
      boats: [REAL_BOAT],
      sonars: [REAL_SONAR],
      engines: [],
    });

    assert.equal(result.listings.length, 2, "two ads in, two listings out");
    assert.deepEqual(
      result.listings.map((l) => l.externalId),
      ["475", "474"]
    );
  });

  it("reads a bucket the provider has never seen before", () => {
    // Buckets are iterated from the response, not from a hardcoded list, so a
    // category QHTI adds later is ingested without a code change.
    const result = collectQhtiListings({
      jetskis: [{ ...REAL_BOAT, id: 900, slug: "obiava-900-djet" }],
    });
    assert.equal(result.listings.length, 1);
    assert.equal(result.listings[0].externalId, "900");
  });

  it("deduplicates one ad appearing in two buckets", () => {
    const result = collectQhtiListings({ boats: [REAL_BOAT], yachts: [REAL_BOAT] });
    assert.equal(result.listings.length, 1);
  });

  // The rule the whole failure story rests on.
  it("keeps every valid listing when one entry is malformed", () => {
    const result = collectQhtiListings({
      boats: [REAL_BOAT, { ...REAL_BOAT, id: 999, slug: null }, REAL_SONAR],
    });

    assert.equal(result.listings.length, 2, "the two good ones survive");
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].externalId, "999");
  });

  it("ignores non-array keys in the payload", () => {
    const result = collectQhtiListings({ boats: [REAL_BOAT], totalCount: 1, meta: { page: 1 } });
    assert.equal(result.listings.length, 1);
  });

  // The safety interlock for inactivity. This endpoint is a homepage selection,
  // so absence from it can never mean a listing was withdrawn.
  it("ALWAYS reports the homepage endpoint as an incomplete view", () => {
    assert.equal(collectQhtiListings({ boats: [REAL_BOAT] }).complete, false);
    assert.equal(collectQhtiListings({}).complete, false);
  });

  it("throws on a response that is not an object, rather than reporting zero listings", () => {
    // "The fetch broke" and "the feed is empty" must never look alike.
    assert.throws(() => collectQhtiListings([]), /not a JSON object/);
    assert.throws(() => collectQhtiListings(null), /not a JSON object/);
    assert.throws(() => collectQhtiListings("<html>"), /not a JSON object/);
  });

  it("returns an empty, complete-flagged result for an object with no buckets", () => {
    const result = collectQhtiListings({});
    assert.deepEqual(result.listings, []);
    assert.deepEqual(result.skipped, []);
  });
});
