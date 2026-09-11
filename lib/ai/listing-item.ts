/**
 * How one listing is stored on a FeedItem, and how it is read back for a prompt.
 *
 * The stored shape is JSON in `FeedItem.content` — the same place `product_page`
 * and `calendar_event` already keep their structured payloads, which is why this
 * feature needs no new database column.
 *
 * ── Why there is no LLM extraction step here ─────────────────────────────────
 * A product page is read by a model because its facts arrive as prose in a web
 * page and there is no other way to find them. A listing feed's facts arrive as
 * named fields from an API. Sending them through a model could only introduce
 * error: it could drop a field, restate a price, or "improve" a URL, and the one
 * thing this integration must guarantee is that the canonical values — the URL
 * above all — are the provider's own.
 *
 * So the extraction INSTRUCTION is honoured without an extraction CALL. Every
 * provider field is preserved verbatim, and the owner's instruction travels
 * alongside them into the generation prompt, where it does the job it is actually
 * for: telling the Writer which of the available facts this company's posts should
 * lead with. Selection of emphasis is a writing decision, and the Writer is the
 * layer that makes writing decisions.
 *
 * That keeps extraction and copywriting separate, which is the requirement — it
 * just observes that for structured input the extraction half is already done.
 */

/** One listing, as stored in `FeedItem.content`. */
export interface StoredListing {
  /** Provider id — half of the sync identity, and how a row is traced to its adapter. */
  provider: string;
  /** The provider's own stable id. The other half of the identity. */
  externalId: string;
  /**
   * This listing's factual content: the fields the source's extraction
   * instruction SELECTED, verbatim from the provider, in its order.
   *
   * Already extracted. The Writer reads these as facts and is never handed the
   * instruction that chose them — selection happened at ingestion, per listing.
   */
  fields: Array<{ label: string; value: string }>;
  /**
   * Terms the instruction asked for that this provider does not publish.
   *
   * Recorded for diagnosis only, and deliberately NOT rendered into the prompt:
   * telling a model "you were asked for the year and there isn't one" is an
   * invitation to supply one. Absent facts are simply absent.
   */
  omitted: string[];
  /** How `fields` was chosen — see ListingSelection.basis. */
  basis: "all" | "instructed" | "unmatched";
}

/** The identity key a stored listing is matched on across ingests. */
export function listingIdentity(provider: string, externalId: string): string {
  return `${provider}:${externalId}`;
}

/**
 * Reads a stored listing payload, or null when the content is not one.
 *
 * Tolerant by design: a row written before a field existed, or by an older
 * provider version, must still render rather than throw.
 */
export function readStoredListing(content: string | null | undefined): StoredListing | null {
  const raw = content?.trim() ?? "";
  if (!raw.startsWith("{")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const obj = parsed as Record<string, unknown>;
  const provider = typeof obj.provider === "string" ? obj.provider : null;
  const externalId = typeof obj.externalId === "string" ? obj.externalId : null;
  if (!provider || !externalId) return null;

  const fields: Array<{ label: string; value: string }> = [];
  if (Array.isArray(obj.fields)) {
    for (const entry of obj.fields) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const { label, value } = entry as Record<string, unknown>;
      if (typeof label === "string" && typeof value === "string" && label && value) {
        fields.push({ label, value });
      }
    }
  }

  const omitted = Array.isArray(obj.omitted)
    ? obj.omitted.filter((t): t is string => typeof t === "string" && t.trim() !== "")
    : [];

  const basis =
    obj.basis === "instructed" || obj.basis === "unmatched" || obj.basis === "all"
      ? obj.basis
      : "all";

  return { provider, externalId, fields, omitted, basis };
}

/** The identity of a stored row, for matching against a freshly fetched listing. */
export function storedListingIdentity(content: string | null | undefined): string | null {
  const stored = readStoredListing(content);
  return stored ? listingIdentity(stored.provider, stored.externalId) : null;
}

// ─── Synchronisation ──────────────────────────────────────────────────────────

/**
 * What ingestion should do with one fetched listing.
 *
 * Generic in the listing so the planner hands BACK whatever it was given: the
 * planner only needs `externalId` and `url` to decide, but the caller needs the
 * whole NormalizedListing to write the row, and narrowing it here would force an
 * unchecked cast at exactly the point where the wrong listing could be stored.
 */
export interface ListingUpsertPlan<T extends ListingSyncInput = ListingSyncInput> {
  /** The listing, as the provider normalised it. */
  listing: T;
  /**
   * The URL this listing's row currently lives at, when that differs from the
   * listing's own URL — i.e. the listing was re-slugged and the existing row must
   * be MOVED rather than a second row created for the same thing.
   *
   * Null in the ordinary case: a brand-new listing, or one whose URL is unchanged.
   */
  renameFrom: string | null;
}

/** The fields the sync planner needs. A structural subset of NormalizedListing. */
export interface ListingSyncInput {
  externalId: string;
  url: string;
}

/**
 * Decides, for each fetched listing, which row it belongs to.
 *
 * Pure and database-free so the rule that actually matters here — that repeated
 * ingests are idempotent, and that a re-slugged listing keeps its row rather than
 * being posted about twice — is testable without a database. Mirrors the
 * `extractionFieldsFor` / `requiresExtractionWork` split in
 * ingest-content-source.service.ts, for the same reason.
 *
 * Identity beats address: a listing is matched on `provider:externalId` first and
 * only falls back to its URL. A marketplace regenerates a slug whenever the title
 * is edited — a corrected model name, a dropped price — and matching on the URL
 * alone would ingest a second FeedItem for an item already written about, with
 * `usedInPost` on the abandoned row no longer protecting anything.
 *
 * Duplicate `externalId`s within one fetch are dropped: a provider that lists one
 * item in two buckets must not produce two rows for it.
 */
export function planListingSync<T extends ListingSyncInput>(
  listings: readonly T[],
  identityToUrl: ReadonlyMap<string, string>,
  provider: string
): ListingUpsertPlan<T>[] {
  const plans: ListingUpsertPlan<T>[] = [];
  const seen = new Set<string>();

  for (const listing of listings) {
    const identity = listingIdentity(provider, listing.externalId);
    if (seen.has(identity)) continue;
    seen.add(identity);

    const storedUrl = identityToUrl.get(identity);
    plans.push({
      listing,
      renameFrom: storedUrl && storedUrl !== listing.url ? storedUrl : null,
    });
  }

  return plans;
}

/**
 * The `provider:externalId` → stored-URL index, built from the rows a source
 * already holds. A row whose content is not a listing payload (a legacy row, or
 * a source whose type was changed) contributes nothing and is left alone.
 */
export function buildListingIdentityIndex(
  rows: readonly { url: string; content: string | null }[]
): Map<string, string> {
  const index = new Map<string, string>();
  for (const row of rows) {
    const identity = storedListingIdentity(row.content);
    if (identity) index.set(identity, row.url);
  }
  return index;
}

/**
 * The prompt block for one listing.
 *
 * FACTS ONLY. The source's extraction instruction is deliberately absent: it was
 * applied at ingestion to choose these very fields, and repeating it here would
 * hand the Writer a retrieval task it has no way to perform — the page is not in
 * front of it, only this list is. Everything below is already the answer.
 *
 * Nor is `omitted` rendered. Naming the facts that could not be found would tell
 * a model exactly which blanks to fill, which is the one thing a marketplace post
 * must never do.
 *
 * `title` is not repeated — `renderFeedItemContent` prints it as the block's
 * heading, as it does for every source type.
 */
export function renderListing(stored: StoredListing, publicUrl: string | null): string {
  const lines: string[] = [
    "Marketplace listing — ONE item offered for sale. The post is about this single listing and no other.",
  ];

  if (stored.fields.length > 0) {
    lines.push(
      "",
      "LISTING DETAILS — the complete set of facts for this post, exactly as the source states them:"
    );
    for (const { label, value } of stored.fields) lines.push(`  ${label}: ${value}`);
  }

  if (publicUrl) {
    lines.push(
      "",
      `Listing page: ${publicUrl}`,
      "This link is attached to the post automatically. Do not write it into the post text yourself, and never alter it."
    );
  }

  lines.push(
    "",
    "Write only from the details above. Do not invent a price, a currency, a year, a model, equipment, condition, mileage/hours, or availability that is not listed. If a detail is absent, the post simply does not mention it."
  );

  return lines.join("\n");
}
