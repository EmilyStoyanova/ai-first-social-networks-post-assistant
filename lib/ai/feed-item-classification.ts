/**
 * RSS article classification — deciding what an incoming article is WORTH to a
 * company, before anything is written from it.
 *
 * The company configures three topic groups in Brand Settings (see
 * lib/ai/topic-priorities.ts); this module turns an article plus that
 * configuration into one of three verdicts. It is the pure half: the hash, the
 * eligibility rules, the prompts, the reply contract, and every check that
 * decides whether a reply may be stored. No I/O, no Prisma, no provider — so all
 * of it is testable without a model.
 *
 * Mirrors `feed-item-translation.ts` and `product-page-extraction.ts` in its
 * queueing, claim, attempt and repair shape. Three things are specific to it:
 *
 *   • The verdict is SEMANTIC, not a keyword match. "Как да изберем подходящ
 *     латекс за детската стая" belongs to the configured topic "бои" without
 *     containing the word, and a substring search can never see that. That is the
 *     whole reason a model is involved at all.
 *
 *   • A blacklist topic rejects only when it is what the article is ABOUT. An
 *     article on paints that mentions a table in passing is not a furniture
 *     article, and rejecting it for the word "маси" would throw away exactly the
 *     content the company asked for. Precedence is BLACKLIST > HIGH > MEDIUM, but
 *     blacklist enters that ordering only as a main subject.
 *
 *   • A failure is never a rejection. A dead provider, a timeout, or a reply that
 *     cannot be trusted leaves the article UNCLASSIFIED — `classification` stays
 *     null and the item is retried. Turning any of those into REJECTED would
 *     silently discard content because a model was briefly unavailable.
 */

import { createHash } from "node:crypto";
import {
  normalizeTopic,
  topicKey,
  type TopicGroup,
  type TopicPriorities,
} from "./topic-priorities";
// Type-only: both `article-understanding.ts` and `classification-chunk-analysis.ts`
// depend on THIS module for findJsonObject/asString, so only the TYPE crosses
// back here, to describe what buildClassificationUserPrompt accepts. A
// type-only import is erased at compile time and cannot create a runtime
// circular-import problem.
import type { ArticleUnderstanding } from "./article-understanding";

// ─── Vocabulary ───────────────────────────────────────────────────────────────

/** The verdict an article receives. */
export const CLASSIFICATIONS = ["HIGH", "MEDIUM", "REJECTED"] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

/**
 * Why a REJECTED article was rejected. Two genuinely different things:
 *
 *   • BLACKLIST     — the article IS about something the company avoids;
 *   • OUT_OF_SCOPE  — the article is about nothing the company asked for.
 *
 * They are distinguished because they mean different things to an operator
 * reading the queue, and because only one of them is evidence that the blacklist
 * is doing its job.
 */
export const REJECTION_REASONS = ["BLACKLIST", "OUT_OF_SCOPE"] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

/**
 * pending → classifying → completed | skipped | failed
 *
 * `skipped` is a settled non-answer with no model call: the company configured no
 * topics, the source is not an article feed, or the item has no readable text.
 * It is deliberately NOT `REJECTED` — see the module header — and it is reopened
 * by a topic-settings change, which can turn the first of those into a real
 * question. (A bodyless item reopened that way is simply re-skipped, one cheap
 * write and no model call.)
 */
export type ClassificationStatus = "pending" | "classifying" | "completed" | "skipped" | "failed";

/** Source types whose items are classified. Article feeds only. */
export function isClassifiableSourceType(type: string): boolean {
  return type === "rss";
}

// ─── Limits ───────────────────────────────────────────────────────────────────

/**
 * Attempts before an item is left alone. Three, like extraction: a classification
 * that keeps failing is the article or the configuration, not a flaky call.
 */
export const MAX_CLASSIFICATION_ATTEMPTS = 3;

/**
 * Extra model calls one attempt may spend repairing its own reply. One, for the
 * same arithmetic reason extraction gives: two calls fit the item budget.
 */
export const MAX_CLASSIFICATION_REPAIR_ATTEMPTS = 1;

/** Items classified per company per run. */
export const CLASSIFICATION_BATCH_SIZE = 15;

/**
 * The threshold that decides whether an article fits in ONE model call — used
 * by `understandArticle` (`lib/services/ai/understand-article.service.ts`) to
 * decide direct-read vs. chunk-and-synthesize, and reused here, read-only, by
 * `classify-feed-item.service.ts` to size an item's timeout budget. This
 * module itself never truncates or samples article text — see
 * `ClassificationPromptInput`'s own comment: every article is judged from an
 * `ArticleUnderstanding`, produced upstream, whole, however long the source
 * article was.
 */
export const MAX_CLASSIFICATION_CONTENT_CHARS = 2000;

/**
 * Output ceiling. The reply is one small object; this exists only so a model that
 * starts rambling is cut off rather than allowed to outlive the deadline.
 */
export const MAX_CLASSIFICATION_OUTPUT_TOKENS = 512;

/** Wall-clock caps for one model call, and for one item across its repair call. */
export const CLASSIFICATION_ATTEMPT_TIMEOUT_MS = 60_000;
export const CLASSIFICATION_ITEM_TIMEOUT_MS = 130_000;

/** Below this much run budget, start no further item. */
export const MIN_CLASSIFICATION_ITEM_BUDGET_MS = 15_000;

/**
 * Stored explanation cap. The reply's `reason` is kept so a verdict can be
 * explained months later, but it is one sentence of evidence — not a transcript.
 */
export const MAX_STORED_REASON_CHARS = 300;

/**
 * Per FIELD, not in total, and deliberately small.
 *
 * The company context exists to disambiguate the topic words, not to describe the
 * business. A brand description long enough to list everything the company sells
 * starts acting as a second topic list — which is the exact failure this feature
 * is meant to fix.
 */
export const MAX_COMPANY_CONTEXT_CHARS = 400;

/** Stored matched topics cap. A verdict citing more than this is not more useful. */
export const MAX_STORED_MATCHED_TOPICS = 10;

/**
 * How long a claim is held before it is considered abandoned.
 *
 * Comfortably longer than the item timeout above, so a healthy in-flight
 * classification is never reclaimed, and short enough that a worker that died
 * mid-call returns the article to the queue the same day. Without this an article
 * would be silently invisible to generation forever — the reason classification
 * takes translation's lease rather than extraction's simpler no-lease claim.
 */
export const CLASSIFICATION_LEASE_MS = 10 * 60_000;

// ─── What gets classified ─────────────────────────────────────────────────────

/**
 * The text a classification was made from — already resolved through
 * `resolveFeedItemContent`, so a translated article is judged in the language its
 * topics are configured in.
 */
export interface ClassifiableText {
  title: string | null;
  body: string | null;
}

/**
 * What the article's stored text can support:
 *   • full       — there is a body to read;
 *   • title_only — no body, but a real title (a legitimate RSS outcome: a paywall
 *                  stub, a failed fetch, a summary-less entry);
 *   • empty      — neither, so there is nothing to classify.
 *
 * Classified up front for the reason translation learned the hard way: asking a
 * model to judge an article it was given no text for invites it to invent one.
 */
export type ClassificationInputKind = "full" | "title_only" | "empty";

function isBlank(text: string | null | undefined): boolean {
  return text === null || text === undefined || text.trim() === "";
}

export function classifyInput(text: ClassifiableText): ClassificationInputKind {
  if (!isBlank(text.body)) return "full";
  if (!isBlank(text.title)) return "title_only";
  return "empty";
}

/**
 * Whether a body fits in ONE model call — see {@link MAX_CLASSIFICATION_CONTENT_CHARS}.
 *
 * This module no longer builds a prompt from raw article text at all (see
 * `ClassificationPromptInput`) — every article, short or long, is judged from
 * an `ArticleUnderstanding`. This function survives because `understandArticle`
 * (`lib/services/ai/understand-article.service.ts`) reuses it for the identical
 * decision one step upstream — direct read vs. chunk-and-synthesize — and
 * because `classify-feed-item.service.ts` reuses it again, read-only, to size
 * an item's timeout budget without duplicating the threshold.
 */
export function fitsSingleClassificationCall(body: string | null): boolean {
  return (body ?? "").trim().length <= MAX_CLASSIFICATION_CONTENT_CHARS;
}

// ─── Modes ────────────────────────────────────────────────────────────────────

/**
 * Which question the configuration can actually pose.
 *
 *   • `none`            — no topics at all. No model call, and NOTHING is
 *     rejected. This is the backwards-compatibility contract: a company that has
 *     never opened the new section must keep seeing every article it saw before.
 *
 *   • `blacklist_only`  — an avoided list, but no HIGH and no MEDIUM topic. The
 *     company has said what it does NOT want and nothing about what it does, so
 *     OUT_OF_SCOPE is not a verdict it can support — there is no scope to be out
 *     of. Articles are rejected as BLACKLIST or accepted as MEDIUM, which is
 *     "usable, no priority signal" and reproduces today's behaviour minus the
 *     blacklist.
 *
 *   • `scoped`          — at least one HIGH or MEDIUM topic. Every verdict is
 *     available.
 */
export type ClassificationMode = "none" | "blacklist_only" | "scoped";

export function classificationMode(priorities: TopicPriorities): ClassificationMode {
  if (priorities.high.length > 0 || priorities.medium.length > 0) return "scoped";
  if (priorities.avoided.length > 0) return "blacklist_only";
  return "none";
}

// ─── The company context ──────────────────────────────────────────────────────

/**
 * Everything an article is judged against: the topic lists, plus the two lines of
 * brand copy that say what those topics MEAN for this business.
 *
 * The context is here because a bare topic list is ambiguous. "бои" alone could be
 * house paint, artists' paint, or powder coating, and a model handed only the word
 * picks whichever the article suggests — which is how an article about something
 * adjacent talks its way into HIGH.
 *
 * It is NOT a broadening of scope, and the prompt says so in as many words. Both
 * fields empty is the neutral case and must stay byte-for-byte identical to a
 * classification made without them — see `companyContextFingerprint`.
 */
export interface ClassificationContext {
  priorities: TopicPriorities;
  /** BrandGuidelines.companyDescription. */
  companyDescription: string | null;
  /** BrandGuidelines.targetAudience. */
  targetAudience: string | null;
}

/** One context field as it is actually used: trimmed, capped, or null if blank. */
function contextField(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (trimmed === "") return null;
  return trimmed.length <= MAX_COMPANY_CONTEXT_CHARS
    ? trimmed
    : trimmed.slice(0, MAX_COMPANY_CONTEXT_CHARS);
}

/** True when there is any company context to show the model. */
export function hasCompanyContext(context: ClassificationContext): boolean {
  return (
    contextField(context.companyDescription) !== null ||
    contextField(context.targetAudience) !== null
  );
}

/**
 * A fingerprint of the company context, for the classification hash.
 *
 * The EMPTY STRING when neither field has content — that is load-bearing, not a
 * detail. A company that has never filled in its brand copy must keep the exact
 * hash it had before this feature existed, so shipping it invalidates no stored
 * verdict and re-spends no model call.
 */
export function companyContextFingerprint(context: ClassificationContext): string {
  const description = contextField(context.companyDescription);
  const audience = contextField(context.targetAudience);
  if (description === null && audience === null) return "";
  // Joined with an ASCII Unit Separator (never typed by a human, so it can
  // never appear inside either field) rather than "" — concatenating with no
  // separator at all means description="AB", audience="" is indistinguishable
  // from description="A", audience="B", which would silently under-invalidate
  // the hash this feeds into.
  return [description ?? "", audience ?? ""].join("");
}

// ─── The hash ─────────────────────────────────────────────────────────────────

/**
 * A stable fingerprint of the topic configuration.
 *
 * Normalized and SORTED, so reordering the chips in the form is not a change and
 * does not re-spend a model call on every article; adding, removing or editing a
 * topic is, and does.
 */
export function topicsFingerprint(priorities: TopicPriorities): string {
  const groups = [priorities.high, priorities.medium, priorities.avoided].map((list) =>
    [...new Set(list.map(topicKey))].sort().join("")
  );
  return groups.join("");
}

/**
 * The semantics of the classifier itself, as a number that participates in the
 * classification hash.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The hash answers "would asking again produce the same verdict?", and it used
 * to describe only the ARTICLE and the CONFIGURATION. That silently assumed the
 * third input — the rulebook the model is judged by — never changes. When it
 * does, every stored verdict was produced by a classifier that no longer exists,
 * and nothing in the system can tell.
 *
 * That assumption is what would otherwise strand a fix. Reopening an article
 * (a Brand Settings save, the "Reclassify articles" button, the ingest
 * follow-up) does not by itself re-ask the model: the drain recomputes the hash,
 * finds it unchanged, and settles the row straight back to `completed` with the
 * OLD verdict and no model call — see `classify-feed-item.service.ts`'s
 * `item.classificationHash === hash` branch. Without this constant, a corrected
 * classifier would leave every previously misclassified article permanently
 * misclassified, and pressing Reclassify would look like it worked while
 * changing nothing.
 *
 * ── The contract ────────────────────────────────────────────────────────────
 *
 * Bump this when the classifier's own semantics change — the system prompt's
 * matching rules, the worked examples, the reply contract, or the vetting in
 * `parseClassificationResponse` — OR when the ArticleUnderstanding signal the
 * verdict is judged against changes in a way that can move a verdict. The two
 * calls this module documents as "one flow" (`classify-feed-item.service.ts`)
 * are a single question — "would asking again produce the same verdict?" — so a
 * fix upstream, in `article-understanding.ts`'s confidence computation, is
 * exactly as invalidating as a fix to this file's own prompt: neither changes
 * the article text or the topic configuration the hash otherwise fingerprints,
 * so without a bump a stale verdict settles back to `completed` for free,
 * forever, having never actually been re-asked under the fix. Do NOT bump it for
 * wording that cannot change a verdict, and never bump it per deploy.
 *
 * A bump makes stale verdicts ELIGIBLE for re-evaluation; it does not perform
 * one. Nothing reclassifies on deploy — the existing reopen paths
 * (`reclassify-feed-items.service.ts`) still decide WHICH rows are reopened and
 * WHEN, and this only decides whether a reopened row is genuinely re-asked or
 * settled for free. That separation is what keeps a version bump from being a
 * database-wide model spend, and what keeps ordinary runs idempotent: after one
 * re-evaluation the row stores the new hash, so every later reopen settles
 * without a call again. There is no loop, because the version is a constant and
 * not derived from anything the run writes.
 *
 * Deliberately NOT part of the translation hash — see `computeTranslationHash`.
 * Reclassifying is one cheap call against text that already exists; re-translating
 * would be a far larger spend for a change that cannot affect a translation.
 *
 * History:
 *   1 — the original classifier.
 *   2 — explicit cross-lingual matching: an article and a topic list in
 *       different languages/scripts match on meaning, the difference in language
 *       is never itself grounds for OUT_OF_SCOPE, and the configured topic is
 *       always written back verbatim. Precision rules unchanged.
 *   3 — `computeConfidenceSignals`'s `topicCoherence` (article-understanding.ts)
 *       stopped using exact-string Jaccard over freeform per-chunk topics and
 *       started using weighted token overlap, so multi-chunk articles whose
 *       chunks describe the same subject in different words are no longer
 *       pinned to a confidence ceiling of 0.40. This module's own code did not
 *       change, but the confidence value it renders into the prompt and gates
 *       on in `parseClassificationResponse` did, for some already-stored
 *       verdicts — hence the bump.
 */
export const CLASSIFICATION_SEMANTIC_VERSION = 3;

/**
 * The exact input a stored verdict was derived from: the text that was sent, plus
 * the configuration it was judged against.
 *
 * Both halves are load-bearing. A re-ingest that rewrites the article, or a
 * translation completing and changing which text is read, must re-classify; so
 * must an edited topic list. Anything else — a cron tick that re-fetches an
 * unchanged feed — skips the call. This is what makes the whole step idempotent,
 * and what makes reclassification after a settings change free to trigger
 * bluntly: an item whose inputs did not really change settles without a model.
 */
export function computeClassificationHash(
  text: ClassifiableText,
  context: ClassificationContext
): string {
  return createHash("sha256")
    .update(
      [
        (text.title ?? "").trim(),
        // The FULL body, uncapped — not a single-call excerpt. A long article
        // is read in full by `understandArticle`'s chunk-analysis pipeline, so
        // a change anywhere in it must reopen the item for reclassification,
        // not only a change within the single-call cap. Hashing cost is
        // irrelevant (a SHA-256 of a long article is microseconds); only the
        // PROMPT needs to stay bounded, and that is enforced separately.
        (text.body ?? "").trim(),
        topicsFingerprint(context.priorities),
        companyContextFingerprint(context),
        // The rulebook the verdict was made under — see
        // CLASSIFICATION_SEMANTIC_VERSION. Last so the field order of everything
        // that came before it is untouched.
        String(CLASSIFICATION_SEMANTIC_VERSION),
      ].join("")
    )
    .digest("hex");
}

// ─── Eligibility ──────────────────────────────────────────────────────────────

/** What the drain needs to know about a row's classification state. */
export interface ClassifiableItemState {
  classificationStatus: string | null;
  classificationHash: string | null;
  classificationAttemptCount: number;
}

/**
 * Classification state to write for a NEW feed item.
 *
 * Ingestion never calls the model — it records only that there is a question,
 * exactly as it does for translation and extraction. A non-article source keeps
 * null classification fields entirely, which is how "this feature does not apply
 * here" is represented.
 */
export function classificationFieldsForCreate(classifiable: boolean): Record<string, unknown> {
  return classifiable ? { classificationStatus: "pending" } : {};
}

/**
 * Classification state to write for an EXISTING feed item.
 *
 * An item that has settled against the same inputs is left completely alone —
 * including its attempt count and its error, which a blind re-queue would reset
 * and turn into an endless retry. A source that stopped being classifiable has
 * its fields cleared, so nothing downstream reads a verdict for an article the
 * feature no longer covers.
 */
export function classificationFieldsForUpdate(
  classifiable: boolean,
  existing: ClassifiableItemState | undefined
): Record<string, unknown> {
  if (!classifiable) {
    return existing?.classificationStatus
      ? {
          classificationStatus: null,
          classification: null,
          classificationRejectionReason: null,
          classificationMatchedTopics: [],
          classificationReason: null,
          classificationMainSubject: null,
          classificationPrimaryTopic: null,
          classificationHash: null,
          classificationError: null,
          classifiedAt: null,
          classificationAttemptCount: 0,
        }
      : {};
  }

  // Never classified at all — queue it.
  if (!existing?.classificationStatus) return { classificationStatus: "pending" };

  // Already queued, in flight, or out of attempts: whatever the drain decides is
  // more current than anything ingestion knows. The hash comparison that reopens
  // a genuinely changed article happens in the drain, which is the only place
  // that has resolved the text and loaded the configuration.
  return {};
}

/**
 * Rows a run should SELECT as classifiable right now:
 *   • pending/failed under the attempt cap, or
 *   • a crashed run's `classifying` claim whose lease has expired (recovery).
 *
 * A live claim is excluded, so an in-flight item is never picked twice. Callers
 * add their own scoping (company, enabled source, still-unconsumed) on top.
 */
export function classificationSelectableWhere(now: Date): Record<string, unknown> {
  return {
    classificationAttemptCount: { lt: MAX_CLASSIFICATION_ATTEMPTS },
    OR: [
      { classificationStatus: { in: ["pending", "failed"] } },
      { classificationStatus: "classifying", classificationLeaseExpiresAt: { lt: now } },
    ],
  };
}

// ─── The reply contract ───────────────────────────────────────────────────────

/**
 * The reply shape, as a JSON schema for providers that can constrain output
 * (Ollama `format`). Providers without structured output ignore it, which is why
 * `parseClassificationResponse` re-checks everything below rather than trusting
 * that the schema was applied.
 */
export const CLASSIFICATION_JSON_SCHEMA = {
  type: "object",
  properties: {
    primaryTopic: { type: ["string", "null"] },
    classification: { type: "string", enum: ["HIGH", "MEDIUM", "REJECTED"] },
    rejectionReason: { type: ["string", "null"], enum: ["BLACKLIST", "OUT_OF_SCOPE", null] },
    matchedTopics: { type: "array", items: { type: "string" } },
    reason: { type: "string" },
  },
  required: ["primaryTopic", "classification", "rejectionReason", "matchedTopics", "reason"],
  additionalProperties: false,
} as const;

/**
 * A verdict that passed every check and may be stored.
 *
 * Deliberately carries NO subject of its own. `mainSubject` used to be asked
 * for here, in the same call that decides the verdict — but naming the
 * subject and matching it against a topic are different questions, and asking
 * them together let the second bias the first. `mainSubject` now comes
 * exclusively from `ArticleUnderstanding` (`lib/ai/article-understanding.ts`),
 * produced once, upstream, by `understandArticle`; this call only ever
 * CONSUMES it (see `renderArticleUnderstandingSection`) and is neither asked
 * for it nor allowed to overwrite it. `classify-feed-item.service.ts` stores
 * `understanding.mainSubject` directly — never anything parsed from here.
 */
export interface ClassificationVerdict {
  classification: Classification;
  rejectionReason: RejectionReason | null;
  /**
   * The SINGLE configured topic the verdict rests on, in its stored spelling, or
   * null for OUT_OF_SCOPE.
   *
   * This is what decides HIGH vs MEDIUM. `matchedTopics` cannot: an article that
   * is mainly about a medium topic and mentions a top-priority one in passing
   * matches both, and a tier test over the whole list promotes it. Naming the
   * dominant topic forces the choice the tier test was silently making wrong.
   */
  primaryTopic: string | null;
  /**
   * The CONFIGURED topics the article matched, in their stored spelling. Only
   * topics that actually exist in the company's configuration survive — a model
   * that invents one has it dropped rather than persisted as if it were a setting.
   */
  matchedTopics: string[];
  /** One sentence of evidence, capped. */
  reason: string;
}

export type ClassificationOutcome =
  | ({ status: "ok" } & ClassificationVerdict)
  /** The reply arrived but cannot be trusted. `feedback` is what a repair is told. */
  | { status: "invalid"; problem: string; feedback: string };

export class ClassificationParseError extends Error {
  readonly code = "CLASSIFICATION_EMPTY_RESPONSE" as const;
  constructor(message: string) {
    super(message);
    this.name = "ClassificationParseError";
  }
}

/**
 * First balanced JSON object in a reply, ignoring fences and surrounding prose.
 * Exported so `classification-chunk-analysis.ts` reuses the same parser for its
 * own (differently-shaped) reply, rather than a second copy of this scan.
 */
export function findJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Exported so `classification-chunk-analysis.ts` reuses it for its own reply. */
export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function invalid(problem: string, feedback: string): ClassificationOutcome {
  return { status: "invalid", problem, feedback };
}

/**
 * Index of every configured topic by comparison key, so a matched topic can be
 * resolved back to its stored spelling and anything unrecognised dropped.
 */
function topicIndex(priorities: TopicPriorities): Map<string, { topic: string; tier: TopicGroup }> {
  const index = new Map<string, { topic: string; tier: TopicGroup }>();
  const lists: Array<[TopicGroup, string[]]> = [
    ["topPriorityTopics", priorities.high],
    ["mediumPriorityTopics", priorities.medium],
    ["avoidedTopics", priorities.avoided],
  ];
  for (const [tier, list] of lists) {
    for (const topic of list) {
      const key = topicKey(topic);
      if (!index.has(key)) index.set(key, { topic: normalizeTopic(topic), tier });
    }
  }
  return index;
}

/**
 * The MAXIMUM `ArticleUnderstanding.confidence` a HIGH verdict may rest on
 * without itself being refused for repair — see the guard at the end of
 * `parseClassificationResponse`.
 *
 * Sized from `confidenceCeiling`'s own formula (`lib/ai/article-understanding.ts`):
 * a chunked article with NO chunk found central at all floors at 0.2; even a
 * single, un-corroborated central chunk typically clears 0.5. 0.4 sits between
 * those two — below it, the understanding step itself found no coherent central
 * subject (nothing central, or central chunks that actively disagree), which is
 * exactly the case a confident HIGH verdict must not be built on. Only HIGH is
 * gated: it is the one verdict requirement (v2-13) calls "aggressive" — MEDIUM,
 * BLACKLIST, and OUT_OF_SCOPE are already the conservative answers, and BLACKLIST
 * has its own "must be central" requirement enforced separately below.
 */
export const MIN_UNDERSTANDING_CONFIDENCE_FOR_HIGH = 0.4;

/**
 * Parses and VETS a reply.
 *
 * The vetting is the point. A model asked for one of three labels will
 * occasionally return a label with no supporting topic, a topic that is not in
 * the configuration, or a REJECTED with no reason — all of which read as perfectly
 * good answers and none of which can be stored as a verdict. Each is turned into
 * a repairable `invalid` naming the exact problem, because that is the one thing
 * that reliably fixes it.
 *
 * The consistency rules, all mode-aware:
 *   • REJECTED must carry a reason; HIGH and MEDIUM must not.
 *   • Every cited topic must exist in the configuration. One that does not makes
 *     the whole reply invalid — the verdict resting on an invented topic is the
 *     failure, not just the topic string. `primaryTopic` is held to the same rule.
 *   • `primaryTopic` — the single topic the article is MAINLY about — decides the
 *     verdict, and its tier must agree with the label: top→HIGH, medium→MEDIUM,
 *     avoided→BLACKLIST, null→OUT_OF_SCOPE. It must also appear in `matchedTopics`.
 *     This is the rule that keeps HIGH and MEDIUM apart; the weaker "cites at least
 *     one topic of the tier" checks below are kept underneath it.
 *   • BLACKLIST must cite at least one configured avoided topic.
 *   • HIGH must cite at least one configured top-priority topic, AND rest on an
 *     `ArticleUnderstanding.confidence` of at least {@link MIN_UNDERSTANDING_CONFIDENCE_FOR_HIGH}
 *     — seeing `understandingConfidence` here is not a request for confidence,
 *     it is a fact this call receives from a step that already ran; a model does
 *     not get to argue with it, only stay under MEDIUM until it is true.
 *   • MEDIUM must cite at least one configured medium topic — EXCEPT in
 *     blacklist-only mode, where MEDIUM is the neutral "not blacklisted" answer
 *     and there are no medium topics to cite (and `primaryTopic` must be null).
 *   • OUT_OF_SCOPE must cite no wanted topic — that combination contradicts
 *     itself — and is unavailable in blacklist-only mode.
 *
 * `mainSubject` is deliberately NOT part of this reply or this function — see
 * `ClassificationVerdict`'s own comment.
 */
export function parseClassificationResponse(
  raw: string | null | undefined,
  priorities: TopicPriorities,
  // Defaults to "fully confident" — every REAL caller (classify-feed-item.service.ts)
  // always passes the article's actual `ArticleUnderstanding.confidence` explicitly;
  // the default only exists so tests unrelated to the confidence gate (the large
  // majority) do not have to restate a value they do not care about.
  understandingConfidence = 1
): ClassificationOutcome {
  const text = (raw ?? "").trim();
  if (text === "") {
    throw new ClassificationParseError("The classification model returned an empty response.");
  }

  const json = findJsonObject(text);
  if (json === null) {
    return invalid(
      "The classification model replied with prose instead of the required JSON object.",
      "Your reply was not JSON. Answer with a SINGLE JSON object and nothing else — no prose before or after it, no markdown fences."
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return invalid(
      "The classification model's JSON could not be parsed.",
      "Your JSON was malformed. Answer again with a single valid JSON object, and check that every string is quoted and every list closed."
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return invalid(
      "The classification model's reply was not a JSON object.",
      "Answer with a single JSON object with the keys described, not an array or a bare value."
    );
  }

  const obj = parsed as Record<string, unknown>;
  const mode = classificationMode(priorities);

  const label = asString(obj.classification)?.toUpperCase();
  if (!label || !(CLASSIFICATIONS as readonly string[]).includes(label)) {
    return invalid(
      `The classification was missing or not one of the allowed labels (got ${JSON.stringify(obj.classification)}).`,
      'The "classification" field must be exactly one of "HIGH", "MEDIUM" or "REJECTED".'
    );
  }
  const classification = label as Classification;

  const rawReason = obj.rejectionReason;
  const reasonLabel =
    rawReason === null || rawReason === undefined
      ? null
      : (asString(rawReason)?.toUpperCase() ?? null);
  if (reasonLabel !== null && !(REJECTION_REASONS as readonly string[]).includes(reasonLabel)) {
    return invalid(
      `The rejection reason was not one of the allowed values (got ${JSON.stringify(rawReason)}).`,
      'The "rejectionReason" field must be "BLACKLIST", "OUT_OF_SCOPE", or null.'
    );
  }
  const rejectionReason = reasonLabel as RejectionReason | null;

  if (classification === "REJECTED" && rejectionReason === null) {
    return invalid(
      "The article was rejected without a reason.",
      'When "classification" is "REJECTED" you must set "rejectionReason" to "BLACKLIST" (the article is mainly about an avoided topic) or "OUT_OF_SCOPE" (it matches none of the wanted topics).'
    );
  }
  if (classification !== "REJECTED" && rejectionReason !== null) {
    return invalid(
      `A ${classification} article was given a rejection reason.`,
      'When "classification" is "HIGH" or "MEDIUM", "rejectionReason" must be null.'
    );
  }
  if (mode === "blacklist_only" && rejectionReason === "OUT_OF_SCOPE") {
    return invalid(
      "OUT_OF_SCOPE was used although no wanted topics are configured.",
      'No topics to look for are configured, so nothing can be "out of scope". Answer "REJECTED" with "BLACKLIST" only when the article is mainly about an avoided topic, and "MEDIUM" otherwise.'
    );
  }

  // Matched topics: resolved against the configuration. A topic that is not in
  // the configuration is NOT quietly dropped — see the block below.
  const index = topicIndex(priorities);
  const seen = new Set<string>();
  const matched: Array<{ topic: string; tier: TopicGroup }> = [];
  const invented: string[] = [];
  const rawMatched = Array.isArray(obj.matchedTopics) ? obj.matchedTopics : [];
  for (const entry of rawMatched) {
    const candidate = asString(entry);
    if (!candidate) continue;
    const hit = index.get(topicKey(candidate));
    if (!hit) {
      if (!invented.some((t) => topicKey(t) === topicKey(candidate))) invented.push(candidate);
      continue;
    }
    if (seen.has(hit.topic)) continue;
    seen.add(hit.topic);
    matched.push(hit);
  }

  /**
   * An invented topic is the signature of the precision failure this whole
   * strictness pass exists for: a model that cannot find a real match reaches for
   * the nearest plausible-sounding label ("trees", "garden", "home improvement")
   * and hands back a confident verdict built on it.
   *
   * Dropping it silently — which is what this used to do — kept the stored
   * `matchedTopics` clean but let the VERDICT survive, so an article about trees
   * could still land as HIGH on the strength of a topic the company never
   * configured. Refusing the reply outright is what makes "never invent a topic"
   * an enforced rule rather than a request in the prompt, and the repair call is
   * told exactly which word was invented, which is what reliably fixes it.
   */
  if (invented.length > 0) {
    return invalid(
      `The reply cited ${invented.length} topic(s) that are not in the company's configuration: ${invented.join(", ")}.`,
      `${JSON.stringify(invented[0])} is not one of the company's topics. Every entry in "matchedTopics" must be copied VERBATIM from the lists above — do not translate them, rephrase them, or name a broader category. If the article's main subject is not on any of those lists, do not reach for the closest one: answer "REJECTED" with "OUT_OF_SCOPE" and leave "matchedTopics" empty.`
    );
  }

  /**
   * The primary topic, resolved the same way and refused the same way. An invented
   * one is worse here than in `matchedTopics`: this is the topic the VERDICT rests
   * on, so a made-up value is a made-up decision.
   */
  const rawPrimary = obj.primaryTopic;
  const primaryCandidate =
    rawPrimary === null || rawPrimary === undefined ? null : asString(rawPrimary);
  const primaryHit =
    primaryCandidate === null ? null : (index.get(topicKey(primaryCandidate)) ?? null);
  if (primaryCandidate !== null && primaryHit === null) {
    return invalid(
      `The primary topic ${JSON.stringify(primaryCandidate)} is not in the company's configuration.`,
      `${JSON.stringify(primaryCandidate)} is not one of the company's topics. "primaryTopic" must be copied VERBATIM from the lists above, or be null. If the article's main subject is not on any list, set "primaryTopic" to null and answer "REJECTED" with "OUT_OF_SCOPE".`
    );
  }

  const has = (tier: TopicGroup) => matched.some((m) => m.tier === tier);

  /**
   * The verdict must rest on the topic the article is MOST about, and the tier of
   * THAT topic decides between HIGH and MEDIUM.
   *
   * This is the check `has(tier)` below could never make. `has` is satisfied by any
   * cited topic of the right tier, so an article mainly about a medium topic that
   * mentions a top-priority one in passing cites both and is promoted to HIGH — the
   * exact inconsistency this pass exists to remove. `has` is kept underneath as the
   * weaker guarantee for a reply whose `primaryTopic` is null.
   */
  const primaryTier = primaryHit?.tier ?? null;

  if (primaryHit !== null && !seen.has(primaryHit.topic)) {
    return invalid(
      `The primary topic ${JSON.stringify(primaryHit.topic)} was not listed in "matchedTopics".`,
      `"primaryTopic" is the one topic the article is mainly about, so it must also appear in "matchedTopics". Add it, or choose a different primary topic.`
    );
  }

  if (classification === "HIGH" && primaryTier !== "topPriorityTopics") {
    return invalid(
      primaryTier === null
        ? "HIGH was returned with no primary topic."
        : `HIGH was returned but the primary topic is from the ${primaryTier === "mediumPriorityTopics" ? "MEDIUM PRIORITY" : "TOPICS TO AVOID"} list.`,
      'Answer "HIGH" only when a TOP PRIORITY topic is what the article is MAINLY about, and put that topic in "primaryTopic". Mentioning a top priority topic while being mainly about something else is not enough — if the article is mainly about a MEDIUM PRIORITY topic, answer "MEDIUM" with that topic as "primaryTopic".'
    );
  }
  if (
    classification === "MEDIUM" &&
    mode !== "blacklist_only" &&
    primaryTier !== "mediumPriorityTopics"
  ) {
    return invalid(
      primaryTier === null
        ? "MEDIUM was returned with no primary topic."
        : `MEDIUM was returned but the primary topic is from the ${primaryTier === "topPriorityTopics" ? "TOP PRIORITY" : "TOPICS TO AVOID"} list.`,
      'Answer "MEDIUM" only when a MEDIUM PRIORITY topic is what the article is MAINLY about, and put that topic in "primaryTopic". If the article is mainly about a TOP PRIORITY topic, answer "HIGH" instead.'
    );
  }
  /**
   * Blacklist-only mode has no wanted topics at all, so MEDIUM there is the neutral
   * "not blacklisted" answer and has nothing to point at. Requiring null keeps the
   * field honest rather than inviting an avoided topic to be cited by a verdict that
   * is not a rejection.
   */
  if (classification === "MEDIUM" && mode === "blacklist_only" && primaryTier !== null) {
    return invalid(
      "MEDIUM cited a primary topic although no wanted topics are configured.",
      'No topics to look for are configured, so a "MEDIUM" answer has no topic to rest on. Set "primaryTopic" to null.'
    );
  }
  if (rejectionReason === "BLACKLIST" && primaryTier !== "avoidedTopics") {
    return invalid(
      primaryTier === null
        ? "BLACKLIST was returned with no primary topic."
        : "BLACKLIST was returned but the primary topic is not from the TOPICS TO AVOID list.",
      'Answer "BLACKLIST" only when one of the TOPICS TO AVOID is what the article is MAINLY about, and put that topic in "primaryTopic". A passing mention is not enough — if the article is really about something else, judge it on that.'
    );
  }
  if (rejectionReason === "OUT_OF_SCOPE" && primaryTier !== null) {
    return invalid(
      "OUT_OF_SCOPE was returned while naming a primary topic.",
      'You answered "OUT_OF_SCOPE" but named a configured topic in "primaryTopic"; those contradict each other. If the article really is mainly about that topic, give the matching verdict instead. If it is only loosely related, set "primaryTopic" to null and leave "matchedTopics" empty.'
    );
  }

  /**
   * A wanted topic cited alongside OUT_OF_SCOPE is a self-contradiction: the model
   * has named a subject the company asked for and then said the article is about
   * nothing the company asked for. One of the two is wrong, and only the model
   * knows which — so it is asked again rather than having either half stored.
   */
  if (
    rejectionReason === "OUT_OF_SCOPE" &&
    (has("topPriorityTopics") || has("mediumPriorityTopics"))
  ) {
    return invalid(
      "OUT_OF_SCOPE was returned while citing a topic the company asked for.",
      'You answered "OUT_OF_SCOPE" but listed a wanted topic in "matchedTopics"; those contradict each other. If the article really is substantially about that topic, answer "HIGH" (top priority list) or "MEDIUM" (medium priority list). If it is only loosely related to it, remove the topic and leave "matchedTopics" empty.'
    );
  }

  if (classification === "HIGH" && !has("topPriorityTopics")) {
    return invalid(
      "HIGH was returned without citing a configured top priority topic.",
      'Answer "HIGH" only when the article is substantially about one of the TOP PRIORITY topics, and list the exact topic(s) from that list in "matchedTopics", copied verbatim. Belonging to the same industry or general subject area is not enough. If it matches nothing you were asked for, answer "REJECTED" with "OUT_OF_SCOPE".'
    );
  }
  /**
   * The deterministic half of requirement (v2-13)'s confidence rule — see
   * {@link MIN_UNDERSTANDING_CONFIDENCE_FOR_HIGH}'s own comment. The prompt
   * already tells the model its UNDERSTANDING CONFIDENCE and asks it to hold
   * back; this is what makes that a rule rather than a suggestion the model is
   * free to ignore under a confident-sounding article.
   */
  if (
    classification === "HIGH" &&
    understandingConfidence < MIN_UNDERSTANDING_CONFIDENCE_FOR_HIGH
  ) {
    return invalid(
      `HIGH was returned but the article understanding's own confidence (${understandingConfidence.toFixed(2)}) is below ${MIN_UNDERSTANDING_CONFIDENCE_FOR_HIGH} — the article's central subject is not well-established.`,
      `UNDERSTANDING CONFIDENCE for this article is only ${understandingConfidence.toFixed(2)} — the central subject itself is uncertain. Do not answer "HIGH" on an uncertain subject. Answer "MEDIUM" if the match is still real but not unmistakable, or "REJECTED" with "OUT_OF_SCOPE" if you cannot point to a clear match.`
    );
  }
  if (classification === "MEDIUM" && mode !== "blacklist_only" && !has("mediumPriorityTopics")) {
    return invalid(
      "MEDIUM was returned without citing a configured medium priority topic.",
      'Answer "MEDIUM" only when the article is substantially about one of the MEDIUM PRIORITY topics, and list the exact topic(s) from that list in "matchedTopics", copied verbatim. Belonging to the same industry or general subject area is not enough. If it matches nothing you were asked for, answer "REJECTED" with "OUT_OF_SCOPE".'
    );
  }
  if (rejectionReason === "BLACKLIST" && !has("avoidedTopics")) {
    return invalid(
      "BLACKLIST was returned without citing a configured avoided topic.",
      'Answer "BLACKLIST" only when the article is MAINLY about one of the TOPICS TO AVOID, and list the exact topic(s) from that list in "matchedTopics", copied verbatim. A passing mention is not enough — if the article is really about something else, judge it on that.'
    );
  }

  const reason = asString(obj.reason);
  if (!reason) {
    return invalid(
      "The verdict came with no explanation.",
      'The "reason" field must be one short sentence saying why the main subject does or does not match a configured topic.'
    );
  }

  return {
    status: "ok",
    classification,
    rejectionReason,
    // The STORED spelling, not the model's — so a topic renamed in the settings is
    // matched by key here and written back exactly as the company typed it.
    primaryTopic: primaryHit?.topic ?? null,
    // Capped here rather than while collecting, so that a reply listing more than
    // the cap is still scanned to its end for invented topics.
    matchedTopics: matched.slice(0, MAX_STORED_MATCHED_TOPICS).map((m) => m.topic),
    reason: reason.slice(0, MAX_STORED_REASON_CHARS),
  };
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

function renderList(label: string, topics: string[]): string {
  if (topics.length === 0) return `${label}: (none configured)`;
  return `${label}:\n${topics.map((t) => `- ${t}`).join("\n")}`;
}

/**
 * What this call is judged from: `ArticleUnderstanding`, produced ONCE, in
 * full, upstream by `understandArticle` (`lib/services/ai/understand-article.service.ts`)
 * — never raw or truncated article text, and never re-derived here. Short and
 * long articles look identical by the time they reach this prompt: the size
 * of the original article, and whether it needed chunking, is entirely
 * `understandArticle`'s concern (see `article-understanding.ts`), not this
 * module's.
 */
export interface ClassificationPromptInput {
  understanding: ArticleUnderstanding;
  context: ClassificationContext;
}

/**
 * The company section, or the EMPTY ARRAY when there is nothing to say.
 *
 * The closing paragraph is the whole reason this is safe to add. Company copy is
 * written to sell the business, and a model handed "we are your partner for the
 * modern home" will happily read it as a licence to accept anything domestic —
 * turning a feature meant to sharpen scope into one that widens it. The paragraph
 * is the third statement of the same constraint, after rule 4 of the system prompt
 * and the verbatim-topic enforcement in `parseClassificationResponse`.
 */
function companySection(context: ClassificationContext): string[] {
  const description = contextField(context.companyDescription);
  const audience = contextField(context.targetAudience);
  if (description === null && audience === null) return [];

  const lines = ["## The company", ""];
  if (description !== null) lines.push(description);
  if (audience !== null) lines.push(`Audience: ${audience}`);

  lines.push(
    "",
    "Company context only explains what the configured topics mean for this business. It MUST NOT create new eligible topics. If the article matches none of the configured topics, return OUT_OF_SCOPE even if it is generally relevant to the company's industry.",
    ""
  );
  return lines;
}

/**
 * The system prompt — the rulebook.
 *
 * This call answers ONE question: does the article's ALREADY-DETERMINED
 * central subject match one of the company's configured topics? It does not
 * re-read the article, does not restate its subject, and does not get to
 * disagree with the ARTICLE UNDERSTANDING it is handed — see
 * `renderArticleUnderstandingSection`. Three instructions carry the matching
 * itself, and they pull against each other, which is why each is spelled out
 * rather than left to the model's judgement:
 *
 *   • "Judge MAIN SUBJECT / CENTRAL THESIS, not SECONDARY or INCIDENTAL" is
 *     what makes a frequent-but-incidental mention harmless.
 *
 *   • "A topic need not appear as a word" is what makes the match semantic instead
 *     of a keyword search that a model would happily imitate if the prompt read
 *     like one.
 *
 *   • "Industry relevance is not enough" is the counterweight to the previous one.
 *     Left alone, a model handed a list of home-improvement topics will treat the
 *     whole home-improvement field as matching it, and an article about free
 *     fast-growing trees comes back as a top-priority match for a company that
 *     sells paints and water heaters. The rule, the worked examples below, and the
 *     verbatim-topic enforcement in `parseClassificationResponse` are three
 *     statements of the same constraint at three different points.
 *
 * A fourth, separate from matching: low UNDERSTANDING CONFIDENCE is visible in
 * the prompt and this rule tells the model to act on it, but
 * `MIN_UNDERSTANDING_CONFIDENCE_FOR_HIGH` in `parseClassificationResponse` is
 * what actually enforces it — the rule below is a request, that constant is
 * the guarantee.
 */
export function buildClassificationSystemPrompt(mode: ClassificationMode): string {
  const parts: string[] = [
    "You sort incoming news articles for a company, deciding how useful each one is for that company's social media.",
    "",
    "You are given an ARTICLE UNDERSTANDING below — the article's subject, already determined by reading the whole article. Treat it as fact. Do NOT re-read, re-summarize, restate in different words, or replace it with a subject of your own; your only job is deciding whether THAT subject matches one of the company's configured topics.",
    "",
    "## How to judge",
    "",
    "1. Read the MAIN SUBJECT and CENTRAL THESIS/CENTRAL CONFLICT (if any) below — this is what the article is actually about. SECONDARY TOPICS are discussed in service of that subject but are not themselves the point; INCIDENTAL TOPICS are passing mentions. Ignore SECONDARY and INCIDENTAL topics when deciding the verdict — they exist only so you are not misled by something the article merely touches on.",
    "2. Compare the MAIN SUBJECT (and CENTRAL THESIS/CENTRAL CONFLICT) with the company's configured topics below.",
    "3. A topic matches when the MAIN SUBJECT IS that topic, a synonym of it, a specific kind of it, or the direct choice, use, installation, repair or care of it. The topic word does not have to appear in the text: an article whose main subject is choosing latex for a child's room is about paints, and one about descaling a water heater is about water heaters. Judge the meaning, never the spelling.",
    // Placed immediately after the semantic-match rule and before the strictness
    // rule, so "different language" is settled as a NON-reason before the model
    // reaches the rule that tells it to default to rejection.
    "4. The article and the configured topics may be written in DIFFERENT LANGUAGES or different scripts. That difference is NEVER, on its own, a reason to reject: a topic written in one language matches an article written in another whenever the meanings correspond — the topic's translation, a synonym of that translation, a specific kind of it, or its direct choice, use, installation, repair or care. Not recognising a word is not the same as the article being out of scope; translate the topic in your head and judge the meaning. Whatever you decide, always write the configured topic back EXACTLY as it appears in the lists below — never translate it, transliterate it, re-spell it, or replace it with the article's own wording.",
    mode === "blacklist_only"
      ? "5. Industry relevance is not enough, and neither is a SECONDARY or INCIDENTAL topic overlapping a configured one. The MAIN SUBJECT itself must be substantially about one of the configured topics."
      : '5. Industry relevance is not enough, and neither is a SECONDARY or INCIDENTAL topic overlapping a configured one. The MAIN SUBJECT itself must be SUBSTANTIALLY about one of the configured topics. Sharing a broad field with them — home improvement, the household, construction, renovation, the garden, DIY, or simply being the sort of thing this company might sell — is NOT a match. If your reasoning is "this is related to the same industry" or "this company\'s customers would find it interesting", that is not a match: the answer is OUT_OF_SCOPE.',
    // Stated straight after the strictness rule so the two are read together:
    // crossing a language barrier relaxes NOTHING about how central the subject
    // must be. Without this, rule 4 can be misread as a general licence to match
    // loosely whenever the languages differ.
    "6. Rules 4 and 5 are independent, and rule 4 never weakens rule 5. Reading the topic in another language tells you WHAT to look for; it does not lower the bar for how central it must be. A foreign-language article that is merely adjacent to a configured topic is still OUT_OF_SCOPE, exactly as a same-language one would be.",
    "7. Never invent a topic. Every topic you cite must be copied verbatim from the lists below. If the MAIN SUBJECT is not on any list, say so instead of naming the nearest one — a near-miss is worse than an honest rejection.",
    mode === "blacklist_only"
      ? '8. Pick the ONE configured topic the MAIN SUBJECT is mainly about and put it in "primaryTopic", or null if there is none.'
      : '8. Pick the ONE configured topic the MAIN SUBJECT is mainly about and put it in "primaryTopic", or null if there is none. That single topic decides your verdict.',
    "9. If UNDERSTANDING CONFIDENCE (below) is low, the article's own central subject is not well-established. Do not answer HIGH on a low-confidence understanding unless the topic match would be unmistakable regardless — prefer MEDIUM or OUT_OF_SCOPE when in doubt.",
  ];

  if (mode !== "blacklist_only") {
    parts.push(
      "",
      "## Worked examples",
      "",
      "These use a DIFFERENT company's topics, for illustration only — never cite them.",
      'Suppose the TOP PRIORITY list were: "paints", "water heaters", and the MEDIUM PRIORITY list: "air conditioners".',
      "",
      '- MAIN SUBJECT "choosing paint for a child\'s room" → primaryTopic "paints", HIGH, matchedTopics ["paints"]. Latex IS a paint; the main subject is choosing one.',
      '- MAIN SUBJECT "fast-growing trees available free from a municipal scheme", SECONDARY TOPICS ["gardening", "spring planting"] → primaryTopic null, REJECTED / OUT_OF_SCOPE, matchedTopics []. Trees belong to the same home-and-garden world, but no configured topic is about trees. Industry proximity is not a match.',
      '- MAIN SUBJECT "a general spring home-refresh round-up" → primaryTopic null, REJECTED / OUT_OF_SCOPE, matchedTopics []. A general home-improvement round-up is not substantially about any configured topic, even though it touches the same field.',
      '- MAIN SUBJECT "installing a window air conditioner", INCIDENTAL TOPICS ["repainting the frame afterwards"] → primaryTopic "air conditioners", MEDIUM, matchedTopics ["air conditioners", "paints"]. The main subject is the air conditioner; the paint is only an incidental mention. Citing "paints" is correct, but it is NOT the primary topic and must not raise this to HIGH.',
      "",
      'Now suppose the SAME company had written its topics in Bulgarian instead, so the TOP PRIORITY list were: "бои". The articles are still in English. The topic list being in another language changes NOTHING about which articles match:',
      "",
      '- MAIN SUBJECT "choosing paint colours and paint finishes for a bedroom" → primaryTopic "бои", HIGH, matchedTopics ["бои"]. "бои" is the Bulgarian word for paints and the main subject is choosing paint; a different alphabet is not a different subject. Note the topic is written back EXACTLY as configured — "бои", not "paints" and not "boi".',
      '- MAIN SUBJECT "how a room\'s orientation changes the amount of natural daylight it receives" → primaryTopic null, REJECTED / OUT_OF_SCOPE, matchedTopics []. Daylight and room orientation are interior-design context, not paint — this is the same OUT_OF_SCOPE it would be if the topic said "paints" in English. Crossing a language barrier never lowers the bar: the MAIN SUBJECT must still BE the configured topic, not merely a subject that advice about it often appears beside.'
    );
  }

  parts.push(
    "",
    "## Verdicts",
    "",
    mode === "blacklist_only"
      ? [
          '- "REJECTED" with "BLACKLIST" — the article is MAINLY about one of the TOPICS TO AVOID.',
          '- "MEDIUM" — anything else. The company has not said which subjects it wants, so every article that is not about an avoided topic is equally acceptable.',
          '- Do NOT use "HIGH", and do NOT use "OUT_OF_SCOPE": with no wanted topics configured, nothing can be out of scope.',
        ].join("\n")
      : [
          '- "HIGH" — the article is substantially about one of the TOP PRIORITY topics.',
          '- "MEDIUM" — the article is substantially about one of the MEDIUM PRIORITY topics, and no stronger rule applies.',
          '- "REJECTED" with "BLACKLIST" — the article is MAINLY about one of the TOPICS TO AVOID.',
          '- "REJECTED" with "OUT_OF_SCOPE" — the article is about none of the topics the company asked for. This is the DEFAULT answer: use it whenever you cannot point to a specific configured topic the article is substantially about. Being unsure is itself a reason to answer OUT_OF_SCOPE rather than to pick the closest topic.',
        ].join("\n"),
    "",
    "## When rules collide",
    "",
    mode === "blacklist_only"
      ? "BLACKLIST applies ONLY when an avoided topic is a main subject of the article. An article about paints that mentions a table once is an article about paints — judge it on paints. Rejecting it for the mention would throw away exactly the content the company asked for."
      : [
          'Decide which SINGLE configured topic the article is mainly about — that is "primaryTopic" — and the list it belongs to decides the verdict. There is no tie to break: one topic is always more central than the rest.',
          "",
          "An article whose main subject is a MEDIUM PRIORITY topic stays MEDIUM even when it also mentions a TOP PRIORITY topic. A passing mention never promotes it. Choose HIGH only when a TOP PRIORITY topic is itself the dominant subject.",
          "",
          "BLACKLIST overrides both, but ONLY when an avoided topic is itself a main subject of the article. An article about paints that mentions a table once is an article about paints — judge it on paints. Rejecting it for the mention would throw away exactly the content the company asked for. If an avoided topic is genuinely one of the things the article is about, alongside a wanted one, then BLACKLIST wins and it is the primary topic.",
        ].join("\n"),
    "",
    "## Answer",
    "",
    "Reply with a single JSON object and nothing else:",
    "",
    "{",
    mode === "blacklist_only"
      ? '  "primaryTopic": null,'
      : '  "primaryTopic": "<the ONE topic the MAIN SUBJECT is mainly about, copied verbatim>" | null,',
    '  "classification": "HIGH" | "MEDIUM" | "REJECTED",',
    '  "rejectionReason": "BLACKLIST" | "OUT_OF_SCOPE" | null,',
    '  "matchedTopics": ["<topic copied verbatim from the lists>"],',
    '  "reason": "<one short sentence: why the MAIN SUBJECT does or does not match a configured topic>"',
    "}",
    "",
    mode === "blacklist_only"
      ? 'Set "rejectionReason" to null unless the classification is "REJECTED". Set "primaryTopic" to the avoided topic when you answer "BLACKLIST", and to null otherwise. Leave "matchedTopics" empty only when nothing matched.'
      : 'Set "rejectionReason" to null unless the classification is "REJECTED". Set "primaryTopic" to null when, and only when, you answer "OUT_OF_SCOPE"; otherwise it must be the topic your verdict rests on, and it must also appear in "matchedTopics". Leave "matchedTopics" empty only when nothing matched.'
  );

  return parts.join("\n");
}

/**
 * Renders the "## Article understanding" section — the ONLY view of the article
 * this call gets, whether the source article was short or long. Replaces
 * BOTH of the old "## The article" branches (raw short text, and the
 * chunk-analysis synthesis): both are now `understandArticle`'s job, done
 * once, upstream (see `ClassificationPromptInput`'s own comment).
 *
 * SECONDARY and INCIDENTAL topics are shown under their own headings, exactly
 * as central/supporting points once were, and for the same reason — the
 * Albania-protesters case: tourism and scenery mentioned at length must not
 * outweigh a central conflict (a protest against coastal development) that is
 * what the piece is actually about. The difference now is that this MODULE
 * never has to make that distinction itself; `ArticleUnderstanding` already
 * arrives with it decided.
 */
function renderArticleUnderstandingSection(understanding: ArticleUnderstanding): string[] {
  const list = (items: readonly string[]) => (items.length > 0 ? items.join(", ") : "(none)");

  return [
    "",
    "## Article understanding",
    "",
    "This was already determined by reading the whole article. Trust it — do not re-derive the subject, and do not substitute a different one.",
    "",
    "MAIN SUBJECT:",
    understanding.mainSubject,
    "",
    "CENTRAL THESIS:",
    understanding.centralThesis ?? "(none — a straightforward report with no argument)",
    "",
    "CENTRAL CONFLICT:",
    understanding.centralConflict ?? "(none)",
    "",
    "ARTICLE TYPE:",
    understanding.articleType,
    "",
    "SECONDARY TOPICS:",
    list(understanding.secondaryTopics),
    "",
    "INCIDENTAL TOPICS:",
    list(understanding.incidentalTopics),
    "",
    "ENTITIES:",
    list(understanding.entities),
    "",
    "UNDERSTANDING CONFIDENCE:",
    understanding.confidence.toFixed(2),
    "",
    "EVIDENCE:",
    ...(understanding.evidence.length > 0
      ? understanding.evidence.map((e) => `- [section ${e.chunkIndex}] ${e.reason}`)
      : ["(none)"]),
    "",
  ];
}

export function buildClassificationUserPrompt(input: ClassificationPromptInput): string {
  const { understanding, context } = input;
  const { priorities } = context;
  // Empty context contributes nothing, so a company that has filled in no brand
  // copy gets byte-for-byte the prompt it got before this feature existed.
  const parts: string[] = [
    ...companySection(context),
    ...renderArticleUnderstandingSection(understanding),
    "## The company's topics",
    "",
  ];

  if (classificationMode(priorities) === "blacklist_only") {
    parts.push(renderList("TOPICS TO AVOID", priorities.avoided));
  } else {
    parts.push(
      renderList("TOP PRIORITY topics", priorities.high),
      "",
      renderList("MEDIUM PRIORITY topics", priorities.medium),
      "",
      renderList("TOPICS TO AVOID", priorities.avoided)
    );
  }

  return parts.join("\n");
}

/**
 * A repair call — the original request plus the exact problem.
 *
 * Mirrors `buildExtractionRepairPrompt`: a retry that merely re-asks reproduces
 * the same reply, so the correction has to travel with it.
 */
export function buildClassificationRepairPrompt(
  originalUserPrompt: string,
  badReply: string,
  feedback: string
): string {
  return [
    originalUserPrompt,
    "",
    "## Your previous answer was rejected",
    "",
    badReply.trim().slice(0, 500),
    "",
    feedback,
    "",
    "Answer again with a single valid JSON object and nothing else.",
  ].join("\n");
}
