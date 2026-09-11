/**
 * The listing-feed provider boundary.
 *
 * A listing feed is a structured catalogue — boats, cars, property, jobs, hotels,
 * marketplace ads — read through an API rather than scraped. Every provider
 * normalises its own response into the shape below, and NOTHING outside
 * `lib/integrations/listing-feed/` knows which provider produced a listing or what
 * its API looks like. That isolation is the point: the first provider is pointed
 * at a provisional endpoint that is expected to be replaced, and replacing it must
 * be an edit to one adapter rather than to the ingestion pipeline.
 *
 * The generic core deliberately knows nothing about boats. `title`, `url`,
 * `externalId` and `imageUrl` are the only fields it can name, because they are
 * the only ones whose MEANING is the same for a yacht, a flat and a job advert.
 * Everything else a provider reads — price, location, year, bedrooms, salary —
 * travels in `fields` as an ordered, already-stringified bag that the core stores
 * and renders without ever interpreting. A provider that learns a new field
 * therefore needs no change here, in ingestion, or in the Writer.
 */

/**
 * One listing, as the rest of the application sees it.
 *
 * Every value here is CANONICAL SOURCE DATA, taken verbatim from the provider's
 * response. No model ever produces or rewrites one — see the note on `fields`.
 */
export interface NormalizedListing {
  /**
   * The provider's own stable id for this listing, as a string.
   *
   * The synchronisation identity. Preferred over the URL because a slug can be
   * regenerated when a listing is edited (a price change, a corrected model name)
   * while the listing itself is unchanged — matching on the URL alone would then
   * ingest a second FeedItem for something already posted about.
   */
  externalId: string;
  /** The public page a reader opens. Appended to posts verbatim; never model-written. */
  url: string;
  /** The listing's own name, exactly as the provider states it. */
  title: string;
  /**
   * The listing's main image, or null when it has none. Stored on
   * `FeedItem.sourceImageUrl` and imported through the existing Cloudinary
   * pipeline, exactly as an RSS article's image is.
   */
  imageUrl: string | null;
  /** When the provider says the listing was created. Null when it does not say. */
  createdAt: Date | null;
  /**
   * Every other fact the provider read, in the order it should be presented.
   *
   * An array rather than an object so the order is the provider's decision and is
   * stable across ingests — a `Record` would leave it to key insertion and
   * quietly reshuffle the stored content, making every ingest look like a change.
   */
  fields: readonly ListingField[];
}

/**
 * One fact about a listing, as the provider read it.
 *
 * `concepts` is what makes ingestion-time extraction possible WITHOUT a model:
 * the provider declares which words each of its fields answers to, and the
 * generic selector (lib/ai/listing-extraction.ts) matches an owner's instruction
 * against those declarations. That is what keeps the core free of domain
 * knowledge — the core never learns what a "price" or a "berth" is; it only
 * compares the owner's words with the provider's.
 */
export interface ListingField {
  /**
   * Stable machine name for this field, unique within a provider. Used for
   * diagnostics and de-duplication, never shown to a reader.
   */
  key: string;
  /** The human label printed in the FeedItem's factual content. */
  label: string;
  /**
   * The value, verbatim from the provider. A string because it is QUOTED, not
   * computed: "74999" reaches the post as the provider wrote it, and a number
   * here would invite formatting decisions in three different layers.
   */
  value: string;
  /**
   * The words this field answers to, lowercase — including plurals and other
   * languages' terms for the same thing.
   *
   * Declared rather than inferred: matching is exact-token, so the provider
   * spelling out "price", "prices", "цена", "цени" is explicit, testable, and
   * cannot silently mis-stem. A field with no concepts can only ever be selected
   * when the instruction is absent.
   */
  concepts: readonly string[];
}

/** What a provider was asked to read, and what it found. */
export interface ListingFetchResult {
  listings: NormalizedListing[];
  /**
   * Whether this response is a COMPLETE picture of the feed.
   *
   * False when the provider knows it returned a partial view — a paged endpoint
   * whose later pages failed, or an endpoint (like QHTI's current one) that is
   * only ever a homepage selection rather than the full catalogue.
   *
   * Nothing may infer that a listing is gone from a response where this is false.
   * The distinction exists so that "the listing was withdrawn" and "we only asked
   * for part of the catalogue" can never be confused — see the disappearance note
   * in the ingestion service.
   */
  complete: boolean;
  /**
   * Listings the provider received and could not use, with the reason.
   *
   * Reported rather than thrown: one malformed entry must never cost the other
   * ninety-nine their ingest.
   */
  skipped: Array<{ reason: string; externalId?: string }>;
}

/** Credentials and endpoint overrides, read from the source config. */
export interface ListingProviderOptions {
  /**
   * The source's configured URL, when the provider accepts one.
   *
   * Optional because a provider may encapsulate its own endpoint entirely, which
   * is the right answer when the alternative is asking a non-technical owner to
   * paste an internal API path.
   */
  url?: string;
  /**
   * A secret for an authenticated endpoint. Read from the source config on the
   * SERVER only; never sent to the browser and never logged.
   *
   * Unused by every provider today — QHTI's current endpoint is unauthenticated —
   * and present so that adding a key later is a config change rather than an
   * interface change.
   */
  apiKey?: string;
}

export interface ListingFeedProvider {
  /** Stable machine name, stored with every item as half of its identity. */
  readonly id: string;
  /** What a person calls it. Shown in the source form. */
  readonly label: string;
  /**
   * Reads the feed and normalises it.
   *
   * Throws only when the fetch itself failed — an unreachable host, a non-2xx
   * response, a body that is not the expected document. An individual unusable
   * listing is reported in `skipped`, never thrown, because those are different
   * events with different correct responses: the first means "we learned nothing
   * this run, change nothing", the second means "we learned about the rest".
   */
  fetchListings(options: ListingProviderOptions): Promise<ListingFetchResult>;
}

/**
 * How long a provider may spend on one feed read before ingestion gives up.
 *
 * Ingestion of all of a company's sources shares one function budget, so a
 * provider that hangs must not be able to consume it.
 */
export const LISTING_FETCH_TIMEOUT_MS = 20_000;

/** Upper bound on listings taken from one response, so a runaway feed is bounded. */
export const MAX_LISTINGS_PER_FETCH = 500;
