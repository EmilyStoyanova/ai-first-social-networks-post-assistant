import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { instructionTerms, selectListingFields } from "./listing-extraction";
import { normalizeQhtiListing } from "@/lib/integrations/listing-feed/providers/qhti.provider";
import type { ListingField } from "@/lib/integrations/listing-feed/types";

/** The fields a real QHTI ad produces, used so the tests bind to real vocabulary. */
const REAL_AD = {
  id: 476,
  title: "Яхта Rinker 230",
  slug: "obiava-476-yahta-rinker-230",
  category: "BOATS_AND_YACHTS",
  price: { amount: 22200.0, type: "FIXED_PRICE", vatStatus: "PRIVATE_SALE" },
  location1: "Русе",
  location2: "гр. Русе",
  adType: "FROM_PRIVATE",
  createdAt: [2026, 8, 14, 17, 40, 31, 0],
  primaryImageUrl: "https://boat-marketplace-images.s3.eu-north-1.amazonaws.com/ads/476/21.webp",
  companyLogo: "",
  homepageCategory: "YACHTS",
};

function qhtiFields(): readonly ListingField[] {
  const result = normalizeQhtiListing(REAL_AD, "yachts");
  assert.ok(result.ok);
  return result.listing.fields;
}

const labels = (fields: readonly ListingField[]) => fields.map((f) => f.label);

// ─── instructionTerms ─────────────────────────────────────────────────────────

describe("instructionTerms", () => {
  it("keeps the meaningful words and drops the scaffolding", () => {
    assert.deepEqual(instructionTerms("Extract the price and the location of each listing"), [
      "price",
      "location",
    ]);
  });

  it("handles a Bulgarian instruction", () => {
    // `\w` is ASCII-only in JS and would shred this to nothing — the reason
    // normalize() uses a Unicode property escape.
    assert.deepEqual(instructionTerms("Извлечи цената и локацията на всяка обява"), [
      "цената",
      "локацията",
    ]);
  });

  it("deduplicates and lowercases", () => {
    assert.deepEqual(instructionTerms("Price, PRICE, price."), ["price"]);
  });

  it("is empty for an instruction made only of scaffolding", () => {
    assert.deepEqual(instructionTerms("Extract all the relevant details"), []);
  });
});

// ─── The core requirement: the instruction shapes FeedItem content ────────────

describe("selectListingFields — the instruction selects the facts", () => {
  it("keeps every fact when there is no instruction", () => {
    const selection = selectListingFields(qhtiFields(), null);
    assert.equal(selection.basis, "all");
    assert.deepEqual(labels(selection.fields), [
      "Price",
      "Price type",
      "VAT status",
      "Category",
      "Listing group",
      "Seller type",
      "Location",
    ]);
  });

  it("narrows the content to what was asked for", () => {
    const selection = selectListingFields(qhtiFields(), "Extract the price and location.");
    assert.equal(selection.basis, "instructed");
    // Price type and VAT status answer to "price" too — a negotiable 22200 is a
    // materially different offer from a fixed 22200.
    assert.deepEqual(labels(selection.fields), ["Price", "Price type", "VAT status", "Location"]);
    assert.ok(!labels(selection.fields).includes("Seller type"));
    assert.ok(!labels(selection.fields).includes("Category"));
  });

  it("selects a different set for a different instruction", () => {
    const selection = selectListingFields(qhtiFields(), "Extract category and seller.");
    assert.deepEqual(labels(selection.fields), ["Category", "Listing group", "Seller type"]);
  });

  it("preserves the provider's field order regardless of instruction word order", () => {
    const a = selectListingFields(qhtiFields(), "location then price");
    const b = selectListingFields(qhtiFields(), "price then location");
    assert.deepEqual(labels(a.fields), labels(b.fields));
    assert.deepEqual(labels(a.fields), ["Price", "Price type", "VAT status", "Location"]);
  });

  it("works from a Bulgarian instruction", () => {
    const selection = selectListingFields(qhtiFields(), "Извлечи цена и локация.");
    assert.equal(selection.basis, "instructed");
    assert.deepEqual(labels(selection.fields), ["Price", "Price type", "VAT status", "Location"]);
  });

  it("never alters a value it selects", () => {
    const selection = selectListingFields(qhtiFields(), "price");
    assert.equal(selection.fields.find((f) => f.key === "price")?.value, "22200");
  });
});

// ─── Requirement 3: omit, never invent ───────────────────────────────────────

describe("selectListingFields — missing values are omitted, not invented", () => {
  it("reports requested facts this provider does not publish", () => {
    // The brief's own example. QHTI's payload has no year, no engine, no
    // equipment and no currency field at all.
    const selection = selectListingFields(
      qhtiFields(),
      "Extract model, price, year, engine, location and equipment."
    );

    for (const term of ["year", "engine", "equipment", "model"]) {
      assert.ok(selection.unavailable.includes(term), `${term} must be reported unavailable`);
    }
    // And nothing was fabricated to satisfy them.
    const values = selection.fields
      .map((f) => f.value)
      .join(" ")
      .toLowerCase();
    for (const invented of ["2015", "2020", "mercury", "hp", "eur", "€"]) {
      assert.ok(!values.includes(invented), `must not invent ${invented}`);
    }
  });

  it("still returns the facts that ARE available alongside the unavailable ones", () => {
    const selection = selectListingFields(
      qhtiFields(),
      "Extract model, price, year, engine, location and equipment."
    );
    assert.deepEqual(labels(selection.fields), ["Price", "Price type", "VAT status", "Location"]);
    assert.equal(selection.basis, "instructed");
  });

  it("does not report a term as unavailable when a field answered it", () => {
    const selection = selectListingFields(qhtiFields(), "price");
    assert.deepEqual(selection.unavailable, []);
  });
});

// ─── The empty-selection safety rule ─────────────────────────────────────────

describe("selectListingFields — an instruction that matches nothing", () => {
  it("keeps every fact rather than producing an empty listing, and says so", () => {
    // A property-feed instruction pointed at a boat marketplace: none of these
    // words is in any QHTI field's declared vocabulary.
    const selection = selectListingFields(qhtiFields(), "Extract bedrooms, EPC and tenure.");
    assert.equal(selection.basis, "unmatched", "flagged, not hidden");
    assert.equal(selection.fields.length, 7, "a post with no facts would be worse");
    assert.ok(selection.unavailable.includes("bedrooms"));
  });

  // A documented limitation of token matching, pinned so it cannot change
  // unnoticed: single words carry no domain, so a term that is generic in one
  // vocabulary can answer to a field in another. Here "floor AREA" (a property
  // concept) matches QHTI's Location, which declares "area" meaning region.
  //
  // The effect is a field too many, never a fabricated value — which is the
  // trade this design accepts in exchange for never calling a model. It is
  // resolved by a provider declaring more precise concepts, not by guessing.
  it("can over-select on a word two domains share", () => {
    const selection = selectListingFields(qhtiFields(), "Extract the floor area.");
    assert.equal(selection.basis, "instructed");
    assert.deepEqual(labels(selection.fields), ["Location"]);
    assert.ok(selection.unavailable.includes("floor"), "the unmatched half is still reported");
  });

  it("treats a whitespace-only instruction as no instruction", () => {
    assert.equal(selectListingFields(qhtiFields(), "   ").basis, "all");
  });

  it("treats an all-stopword instruction as matching nothing", () => {
    // "Extract all the relevant details" names no concept at all.
    const selection = selectListingFields(qhtiFields(), "Extract all the relevant details");
    assert.equal(selection.basis, "unmatched");
    assert.equal(selection.fields.length, 7);
  });
});

// ─── Genericity: the core knows no domain vocabulary ─────────────────────────

describe("selectListingFields is provider-agnostic", () => {
  // A property feed. The core has never heard of a bedroom; the PROVIDER says so.
  const PROPERTY: ListingField[] = [
    { key: "price", label: "Price", value: "245000", concepts: ["price", "cost"] },
    { key: "beds", label: "Bedrooms", value: "3", concepts: ["bedrooms", "beds", "rooms"] },
    { key: "area", label: "Floor area", value: "88 m2", concepts: ["area", "size", "sqm"] },
    { key: "epc", label: "EPC rating", value: "B", concepts: ["epc", "energy"] },
  ];

  it("selects domain fields it has no knowledge of", () => {
    const selection = selectListingFields(PROPERTY, "Extract price, bedrooms and area.");
    assert.deepEqual(labels(selection.fields), ["Price", "Bedrooms", "Floor area"]);
    assert.ok(!labels(selection.fields).includes("EPC rating"));
  });

  it("matches a multi-word concept as a phrase", () => {
    const fields: ListingField[] = [
      { key: "vat", label: "VAT status", value: "INCLUDED", concepts: ["vat status"] },
      { key: "other", label: "Other", value: "x", concepts: ["status"] },
    ];
    const selection = selectListingFields(fields, "Extract the vat status.");
    // Both match: "vat status" as a phrase, and "status" as a bare token.
    assert.deepEqual(labels(selection.fields), ["VAT status", "Other"]);
  });

  it("never selects a field that declares no concepts, once an instruction exists", () => {
    const fields: ListingField[] = [
      { key: "a", label: "Named", value: "1", concepts: ["price"] },
      { key: "b", label: "Unnamed", value: "2", concepts: [] },
    ];
    assert.deepEqual(labels(selectListingFields(fields, "price").fields), ["Named"]);
    // …but with no instruction it is included, like everything else.
    assert.deepEqual(labels(selectListingFields(fields, null).fields), ["Named", "Unnamed"]);
  });

  it("returns an empty, all-basis selection for a provider with no fields", () => {
    assert.deepEqual(selectListingFields([], null), { fields: [], unavailable: [], basis: "all" });
  });
});

// ─── Per-listing application ─────────────────────────────────────────────────

describe("selection is applied per listing, not once per feed", () => {
  it("gives two listings with different available fields different content", () => {
    const withLocation = qhtiFields();
    const withoutLocation = (() => {
      const r = normalizeQhtiListing({ ...REAL_AD, id: 9, location1: null, location2: null }, "y");
      assert.ok(r.ok);
      return r.listing.fields;
    })();

    const instruction = "Extract price and location.";
    const a = selectListingFields(withLocation, instruction);
    const b = selectListingFields(withoutLocation, instruction);

    assert.ok(labels(a.fields).includes("Location"));
    assert.ok(!labels(b.fields).includes("Location"), "absent on this listing, so absent here");
    assert.ok(
      b.unavailable.includes("location"),
      "and reported unavailable for THIS listing specifically"
    );
    // The same instruction, two different outcomes — proof it is evaluated per
    // listing rather than once for the whole fetch.
    assert.notDeepEqual(labels(a.fields), labels(b.fields));
  });
});
