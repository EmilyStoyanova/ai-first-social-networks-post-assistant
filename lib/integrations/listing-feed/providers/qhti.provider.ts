/**
 * QHTI (qhti.bg) — a Bulgarian marine marketplace. The first listing-feed provider.
 *
 * ── Why an API adapter and not the product-page scraper ──────────────────────
 * qhti.bg is a Create React App single-page application. Every URL — the
 * catalogue and each individual listing alike — returns the same ~4.8KB shell with
 * an empty `<div id="root">` and only site-wide meta tags. There is no per-listing
 * og:title or og:image to read, so the HTML scraper would store one identical
 * generic description for every listing. The JSON the page's own client fetches is
 * the only real source of facts.
 *
 * ── The endpoint is PROVISIONAL ──────────────────────────────────────────────
 * `HOMEPAGE_ENDPOINT` below is the only place it appears. It is the endpoint that
 * works unauthenticated today, and it is NOT the catalogue: it is the selection
 * the site puts on its homepage, grouped into display buckets. The client is
 * expected to supply a supported active-listings endpoint (`ads/getAdsByActiveStatus`
 * returns 400 without parameters we do not yet know, and `ads/getAdBySlug` returns
 * 401), at which point this file is the only one that changes.
 *
 * That provisional status is reported honestly rather than hidden: the fetch
 * returns `complete: false`, which is what stops ingestion from ever concluding
 * that a listing absent from this response has been withdrawn. See the
 * disappearance note in ingest-content-source.service.ts.
 */

import {
  LISTING_FETCH_TIMEOUT_MS,
  MAX_LISTINGS_PER_FETCH,
  type ListingFeedProvider,
  type ListingFetchResult,
  type ListingField,
  type NormalizedListing,
} from "../types";

/** The one place the provisional endpoint is named. */
const HOMEPAGE_ENDPOINT = "https://qhti.bg/ads/homepage";

/** A listing's public page. The slug is the provider's, never constructed by a model. */
const LISTING_URL_PREFIX = "https://qhti.bg/obiavi/";

/**
 * The homepage payload's display buckets.
 *
 * Read by iterating the response's own array-valued keys rather than from this
 * list, so a bucket QHTI adds later is picked up without a code change. The list
 * survives only to document what was observed (2026-09-11: boats 100, engines 50,
 * yachts 26, parts 16, sonars 15, trollingMotors 7 — 214 listings, 214 distinct
 * ids, no cross-bucket duplication).
 */
const OBSERVED_BUCKETS = [
  "boats",
  "engines",
  "yachts",
  "parts",
  "sonars",
  "trollingMotors",
] as const;

interface RawPrice {
  amount?: unknown;
  type?: unknown;
  vatStatus?: unknown;
}

function asString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Formats a money amount without inventing precision or a currency.
 *
 * QHTI's payload carries NO currency field — not on the listing, not on the price
 * object. So none is emitted. Writing "€" or "лв." here would be exactly the
 * fabrication of a canonical value this integration is required not to do, and it
 * would be a fabrication with a price tag attached. The Writer receives the number
 * the provider stated and nothing more.
 */
function formatAmount(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/**
 * Parses QHTI's `createdAt`, a Java `LocalDateTime` serialised as an array:
 * `[year, month, day, hour, minute, second, nano]`.
 *
 * The month is 1-BASED, which `Date.UTC` is not — reading it straight through is
 * an off-by-one month on every single listing. Built in UTC because the payload
 * states no zone; the value is only ever used as `publishedAt` ordering, so a
 * consistent reading matters more than a guessed offset.
 */
export function parseJavaDateArray(value: unknown): Date | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const parts = value.slice(0, 6).map((n) => (typeof n === "number" && Number.isFinite(n) ? n : 0));
  const [year, month, day, hour = 0, minute = 0, second = 0] = parts;
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Combines a region and a settlement into one location string.
 *
 * Exported for its own test: the containment rule is the part that is easy to get
 * wrong and invisible until it reaches a published post.
 */
export function joinLocation(region: string | null, place: string | null): string | null {
  if (!region) return place;
  if (!place) return region;

  const normalise = (value: string) => value.toLocaleLowerCase("bg").replace(/\s+/g, " ").trim();
  // The settlement already names the region ("гр. Стара Загора" vs "Стара Загора").
  return normalise(place).includes(normalise(region)) ? place : `${place}, ${region}`;
}

/**
 * Turns one raw QHTI ad into a NormalizedListing, or explains why it cannot.
 *
 * Exported so the mapping can be tested against real payload shapes without a
 * network call — this function is where every QHTI-specific assumption lives.
 */
export function normalizeQhtiListing(
  raw: unknown,
  bucket: string
): { ok: true; listing: NormalizedListing } | { ok: false; reason: string; externalId?: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "entry is not an object" };
  }
  const ad = raw as Record<string, unknown>;

  const externalId = asString(ad.id);
  if (!externalId) return { ok: false, reason: "listing has no id" };

  // The slug IS the URL. Without it there is no page to link, and a listing whose
  // post could not carry its own link is not worth ingesting — the whole feature
  // is "a post that points at this exact listing".
  const slug = asString(ad.slug);
  if (!slug) return { ok: false, reason: "listing has no slug, so it has no page", externalId };

  const title = asString(ad.title);
  if (!title) return { ok: false, reason: "listing has no title", externalId };

  const price = (ad.price ?? {}) as RawPrice;
  const amount = formatAmount(price.amount);

  // Enum tokens are passed through verbatim (FIXED_PRICE, INCLUDED, FROM_COMPANY).
  // Translating them into prose here would be this layer guessing at meaning —
  // "PRIVATE_SALE" is a VAT status, not a sale type — and a token QHTI adds later
  // would be mistranslated rather than simply passed on.
  //
  // Each field declares the words it answers to, in both languages an owner may
  // write their instruction in. That declaration is the ONLY thing that makes
  // ingestion-time extraction possible without a model — see lib/ai/listing-extraction.ts.
  const fields: ListingField[] = [];
  const push = (key: string, label: string, value: string | null, concepts: readonly string[]) => {
    if (value) fields.push({ key, label, value, concepts });
  };

  push("price", "Price", amount, [
    "price",
    "prices",
    "cost",
    "amount",
    "asking",
    "цена",
    "цени",
    "цената",
    "стойност",
  ]);
  // Subordinate to price: an owner asking for "price" means the whole price
  // picture, and "22200 NEGOTIABLE" is a materially different offer from
  // "22200 FIXED_PRICE". Both therefore answer to "price" as well as to
  // their own narrower terms.
  push("priceType", "Price type", asString(price.type), [
    "price",
    "prices",
    "negotiable",
    "terms",
    "цена",
    "цени",
    "договаряне",
  ]);
  push("vatStatus", "VAT status", asString(price.vatStatus), [
    "price",
    "prices",
    "vat",
    "tax",
    "цена",
    "цени",
    "ддс",
    "данък",
  ]);
  push("category", "Category", asString(ad.category), [
    "category",
    "categories",
    "type",
    "kind",
    "категория",
    "категории",
    "вид",
    "тип",
  ]);
  push("listingGroup", "Listing group", asString(ad.homepageCategory) ?? bucket, [
    "category",
    "categories",
    "group",
    "section",
    "категория",
    "категории",
    "група",
    "раздел",
  ]);
  push("sellerType", "Seller type", asString(ad.adType), [
    "seller",
    "dealer",
    "private",
    "company",
    "owner",
    "продавач",
    "фирма",
    "частно",
    "дилър",
  ]);

  // Two location fields — `location1` is the region, `location2` the settlement —
  // joined most-specific-first, but only when the broader one adds something.
  //
  // Containment, not equality: QHTI writes the region as "Стара Загора" and the
  // settlement as "гр. Стара Загора" (гр. = "town"), which are different strings
  // naming the same place. Joining them yields "гр. Стара Загора, Стара Загора",
  // which a published advert should never say.
  push("location", "Location", joinLocation(asString(ad.location1), asString(ad.location2)), [
    "location",
    "locations",
    "place",
    "city",
    "town",
    "region",
    "area",
    "where",
    "локация",
    "местоположение",
    "град",
    "област",
    "регион",
    "място",
  ]);

  return {
    ok: true,
    listing: {
      externalId,
      url: `${LISTING_URL_PREFIX}${slug}`,
      title,
      // `companyLogo` is an empty string on most rows and is a SELLER's logo, not
      // the listing's photo — never a substitute for the item's own image.
      imageUrl: asString(ad.primaryImageUrl),
      createdAt: parseJavaDateArray(ad.createdAt),
      fields,
    },
  };
}

/**
 * Collects every listing out of the homepage payload's display buckets.
 *
 * Iterates the response's own array-valued keys, so a bucket added by QHTI is
 * ingested without a code change here. Deduplicates by `externalId`: the buckets
 * are a layout decision, and nothing in the payload promises an ad appears in only
 * one of them (it happens to today — 214 of 214 distinct — which is exactly the
 * kind of incidental fact that stops being true without warning).
 */
export function collectQhtiListings(payload: unknown): ListingFetchResult {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("QHTI response was not a JSON object.");
  }

  const listings: NormalizedListing[] = [];
  const skipped: ListingFetchResult["skipped"] = [];
  const seen = new Set<string>();

  for (const [bucket, value] of Object.entries(payload as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;

    for (const entry of value) {
      if (listings.length >= MAX_LISTINGS_PER_FETCH) break;

      const result = normalizeQhtiListing(entry, bucket);
      if (!result.ok) {
        skipped.push({ reason: result.reason, externalId: result.externalId });
        continue;
      }
      // A duplicate is not a fault — it is one ad shown in two buckets.
      if (seen.has(result.listing.externalId)) continue;
      seen.add(result.listing.externalId);
      listings.push(result.listing);
    }
  }

  return {
    listings,
    // NEVER true for this endpoint. It is a homepage selection, not the catalogue,
    // so a listing missing from it says nothing whatever about whether that
    // listing is still active. Flipping this to `true` requires a real
    // active-listings endpoint, and is the single change that would let
    // disappearance tracking be switched on.
    complete: false,
    skipped,
  };
}

export const qhtiListingProvider: ListingFeedProvider = {
  id: "qhti",
  label: "QHTI.bg",

  async fetchListings() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LISTING_FETCH_TIMEOUT_MS);

    let payload: unknown;
    try {
      const res = await fetch(HOMEPAGE_ENDPOINT, {
        cache: "no-store",
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        throw new Error(`QHTI listing fetch failed: ${res.status} ${res.statusText}`);
      }
      payload = await res.json();
    } catch (err) {
      // Re-thrown, never swallowed: a failed fetch must reach the ingestion
      // service as a failure, because "we learned nothing" and "we learned the
      // feed is empty" have opposite consequences for every stored listing.
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`QHTI listing fetch timed out after ${LISTING_FETCH_TIMEOUT_MS}ms.`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    return collectQhtiListings(payload);
  },
};

export { HOMEPAGE_ENDPOINT as QHTI_HOMEPAGE_ENDPOINT, OBSERVED_BUCKETS as QHTI_OBSERVED_BUCKETS };
