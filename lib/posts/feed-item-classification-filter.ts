/**
 * The classification filter above the RSS article list.
 *
 * Pure: the vocabulary, the database predicate each choice means, and the
 * display state each stored row maps to. No Prisma import — the predicate is a
 * plain object the service spreads into its `where`.
 *
 * Server-side by construction, and that is the point rather than a preference:
 * the article list is a capped page (the newest 50 of a feed that can hold
 * thousands), so filtering the loaded page in the browser would answer "the HIGH
 * articles among the newest 50", not "this source's HIGH articles". Those are
 * different sets, and the second is the one a user is asking for.
 */

/**
 * What the pills offer. `all` is the default and adds no predicate.
 *
 * The four priority pills are the vocabulary of the FEATURE — a verdict, or its
 * absence. The last three split what used to be one `unclassified` pill, because
 * "no verdict" was hiding four unrelated situations behind a single number: an
 * article still queued, one whose classification broke, one nobody will ever ask
 * about because a post was already written from it, and one the feature simply
 * does not apply to. Only the first is a reason to wait, and only the second is a
 * reason to act — so a count that adds them together answers no question at all.
 */
export const FEED_ITEM_CLASSIFICATION_FILTERS = [
  "all",
  "high",
  "medium",
  "rejected",
  "pending",
  "failed",
  "unclassified",
] as const;
export type FeedItemClassificationFilter = (typeof FEED_ITEM_CLASSIFICATION_FILTERS)[number];

/**
 * Every filter except `all` — i.e. the buckets a single row belongs to.
 *
 * These PARTITION the source: each article counts towards exactly one, and they
 * sum to `all`. That is what lets the pill counts be trusted as a breakdown
 * rather than a set of overlapping tallies.
 */
export type FeedItemClassificationBucket = Exclude<FeedItemClassificationFilter, "all">;

/**
 * Pills that describe a MALFUNCTION or a wait rather than a priority.
 *
 * The four priority pills are always shown, empty or not — they are the shape of
 * the feature and their zeros are informative ("no top-priority articles yet").
 * These two are informative only when non-zero: a permanent "Failed (0)" beside
 * every healthy feed teaches people to stop reading the bar. The panel still
 * keeps one on screen while it is the ACTIVE filter, so a pill can never vanish
 * from under the list it is currently showing.
 */
const DIAGNOSTIC_FILTERS: readonly FeedItemClassificationFilter[] = ["pending", "failed"];

export function isDiagnosticFilter(filter: FeedItemClassificationFilter): boolean {
  return DIAGNOSTIC_FILTERS.includes(filter);
}

export function parseClassificationFilter(
  raw: string | null | undefined
): FeedItemClassificationFilter {
  const value = (raw ?? "").trim().toLowerCase();
  return (FEED_ITEM_CLASSIFICATION_FILTERS as readonly string[]).includes(value)
    ? (value as FeedItemClassificationFilter)
    : "all";
}

/**
 * The statuses the classification drain will still act on. Kept as one list so
 * the predicate below and `classificationStateOf` cannot drift apart.
 *
 * `classifying` is in flight behind a lease rather than queued, but from a
 * reader's side of the glass both mean the same thing: an answer is coming.
 */
const AWAITING_STATUSES = ["pending", "classifying"] as const;

/**
 * The `where` fragment a filter means. Every one of these runs in the DATABASE,
 * over the whole source — see the note at the top of the file.
 *
 * The three no-verdict predicates are mutually exclusive by construction and
 * together cover every `classification: null` row, so they split the old
 * `unclassified` pill without losing anything.
 *
 * `usedInPost: false` appears in `pending` and `failed` and is the whole point of
 * the split. An article a post was already written from is never reopened —
 * reclassification excludes it deliberately, to stop a verdict being rewritten
 * under a post that already cited it — so its status column freezes at whatever
 * it held on the day it was consumed. Counting such a row as "pending" promises a
 * verdict that will never arrive, and it stays on that promise forever.
 */
export function classificationFilterWhere(
  filter: FeedItemClassificationFilter
): Record<string, unknown> {
  switch (filter) {
    case "high":
      return { classification: "HIGH" };
    case "medium":
      return { classification: "MEDIUM" };
    case "rejected":
      return { classification: "REJECTED" };
    case "pending":
      return {
        classification: null,
        usedInPost: false,
        classificationStatus: { in: [...AWAITING_STATUSES] },
      };
    case "failed":
      return { classification: null, usedInPost: false, classificationStatus: "failed" };
    // The complement of the two above within "no verdict", written out as
    // alternatives rather than as a NOT so it stays readable in a query plan:
    // consumed (whatever its status), settled without a verdict, or never asked.
    // Prisma's `in` matches values and never NULL, so `null` is its own branch.
    case "unclassified":
      return {
        classification: null,
        OR: [
          { usedInPost: true },
          { classificationStatus: { in: ["completed", "skipped"] } },
          { classificationStatus: null },
        ],
      };
    case "all":
      return {};
  }
}

/**
 * What a row shows as — a strictly richer vocabulary than the filter's, because
 * a badge has room to distinguish what a pill should not.
 *
 * The `failed` state is the reason this is not simply the `classification`
 * column: a classification that broke must NEVER read as "rejected". They are
 * opposite claims — one says the company does not want this article, the other
 * says nobody managed to ask.
 */
export type FeedItemClassificationState =
  "high" | "medium" | "rejected" | "pending" | "failed" | "used" | "skipped" | "unclassified";

export interface ClassificationStateInput {
  classification?: string | null;
  classificationStatus?: string | null;
  /** Whether a post has already been written from this article. */
  usedInPost?: boolean | null;
}

export function classificationStateOf(item: ClassificationStateInput): FeedItemClassificationState {
  // A stored verdict wins: it is the settled answer, whatever the status column
  // says afterwards (a reopened row keeps its old verdict visible until a new one
  // replaces it, which is deliberate — see the reclassification service).
  if (item.classification === "HIGH") return "high";
  if (item.classification === "MEDIUM") return "medium";
  if (item.classification === "REJECTED") return "rejected";

  // Before the status column, because for a consumed article the status is STALE
  // rather than current: nothing will move it again. Reading it out loud would
  // report a queue position in a queue this row was removed from. Checked only
  // after the verdict above, so a used HIGH article still reads as HIGH — being
  // consumed explains a MISSING verdict, it does not replace one that exists.
  if (item.usedInPost) return "used";

  switch (item.classificationStatus) {
    case "pending":
    case "classifying":
      return "pending";
    // Never "rejected". Nobody managed to ask the question.
    case "failed":
      return "failed";
    // Settled with no verdict: no topics configured, or nothing readable to judge.
    case "skipped":
      return "skipped";
    default:
      return "unclassified";
  }
}

/**
 * Which pill a row is counted under. Derived from the state rather than computed
 * again, so a badge and the number above it can never disagree.
 *
 * `used`, `skipped` and `unclassified` collapse into one bucket: they are three
 * reasons for the same user-facing fact — no verdict, and none coming. The badge
 * on the row says which reason; the pill only has to say how many.
 */
export function classificationBucketOf(
  item: ClassificationStateInput
): FeedItemClassificationBucket {
  const state = classificationStateOf(item);
  switch (state) {
    case "high":
    case "medium":
    case "rejected":
    case "pending":
    case "failed":
      return state;
    case "used":
    case "skipped":
    case "unclassified":
      return "unclassified";
  }
}

/** Beyond this a "reason" stops being a reason and becomes a log line. */
const ERROR_SUMMARY_MAX = 160;

/**
 * The one line of a stored `classificationError` worth showing a person.
 *
 * The column holds `err.message`, which is usually a sentence our own validator
 * wrote ("HIGH was returned without citing a configured top priority topic") but
 * can just as easily be a provider's raw 429 body or a multi-line dump. The first
 * line, capped, is the part that survives both cases: enough for an owner to tell
 * "the model said something odd" from "the provider was down", without pasting an
 * API response into the page.
 */
export function summarizeClassificationError(error: string | null | undefined): string | null {
  if (!error) return null;

  const firstLine = error.split("\n")[0].replace(/\s+/g, " ").trim();
  if (firstLine.length === 0) return null;

  return firstLine.length > ERROR_SUMMARY_MAX
    ? firstLine.slice(0, ERROR_SUMMARY_MAX).trimEnd() + "…"
    : firstLine;
}

/**
 * True when a row is still expected to receive a verdict — i.e. waiting is a
 * sensible thing to do. False for a consumed article however its status reads,
 * which is the correction this module exists to make.
 */
export function awaitingClassification(item: ClassificationStateInput): boolean {
  const state = classificationStateOf(item);
  return state === "pending" || state === "failed";
}
