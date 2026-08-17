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

/** What the pills offer. `all` is the default and adds no predicate. */
export const FEED_ITEM_CLASSIFICATION_FILTERS = [
  "all",
  "high",
  "medium",
  "rejected",
  "unclassified",
] as const;
export type FeedItemClassificationFilter = (typeof FEED_ITEM_CLASSIFICATION_FILTERS)[number];

export function parseClassificationFilter(
  raw: string | null | undefined
): FeedItemClassificationFilter {
  const value = (raw ?? "").trim().toLowerCase();
  return (FEED_ITEM_CLASSIFICATION_FILTERS as readonly string[]).includes(value)
    ? (value as FeedItemClassificationFilter)
    : "all";
}

/**
 * The `where` fragment a filter means.
 *
 * `unclassified` is deliberately "no verdict", not "one particular status": an
 * article still queued, one whose classification failed, one skipped because the
 * company configured no topics, and one from before the feature existed are all
 * things a user thinks of as "not judged yet". The per-row badge tells them
 * apart; the filter groups them, because the question the pill answers is "what
 * has no verdict?".
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
    case "unclassified":
      return { classification: null };
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
  "high" | "medium" | "rejected" | "pending" | "failed" | "skipped" | "unclassified";

export interface ClassificationStateInput {
  classification?: string | null;
  classificationStatus?: string | null;
}

export function classificationStateOf(item: ClassificationStateInput): FeedItemClassificationState {
  // A stored verdict wins: it is the settled answer, whatever the status column
  // says afterwards (a reopened row keeps its old verdict visible until a new one
  // replaces it, which is deliberate — see the reclassification service).
  if (item.classification === "HIGH") return "high";
  if (item.classification === "MEDIUM") return "medium";
  if (item.classification === "REJECTED") return "rejected";

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

/** True when a row is still expected to receive a verdict. Drives the pill count hint. */
export function awaitingClassification(item: ClassificationStateInput): boolean {
  const state = classificationStateOf(item);
  return state === "pending" || state === "failed";
}
