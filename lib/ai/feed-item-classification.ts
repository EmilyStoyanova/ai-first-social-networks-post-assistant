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
  TOPIC_GROUPS,
  normalizeTopic,
  topicKey,
  type TopicGroup,
  type TopicPriorities,
} from "./topic-priorities";

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
 * How much of the article body is sent.
 *
 * Far below translation's 3000 because the question is different: translation has
 * to render the whole text, while this only has to identify what the piece is
 * ABOUT — and an article announces that in its title and opening paragraphs. The
 * cap keeps a long feature from costing more than a short one for an answer that
 * would not change.
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

/** The body as it is actually sent — trimmed and capped. */
export function classificationExcerpt(body: string | null): string {
  const trimmed = (body ?? "").trim();
  return trimmed.length <= MAX_CLASSIFICATION_CONTENT_CHARS
    ? trimmed
    : trimmed.slice(0, MAX_CLASSIFICATION_CONTENT_CHARS);
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
  priorities: TopicPriorities
): string {
  return createHash("sha256")
    .update(
      [
        (text.title ?? "").trim(),
        classificationExcerpt(text.body),
        topicsFingerprint(priorities),
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
    classification: { type: "string", enum: ["HIGH", "MEDIUM", "REJECTED"] },
    rejectionReason: { type: ["string", "null"], enum: ["BLACKLIST", "OUT_OF_SCOPE", null] },
    matchedTopics: { type: "array", items: { type: "string" } },
    reason: { type: "string" },
  },
  required: ["classification", "rejectionReason", "matchedTopics", "reason"],
  additionalProperties: false,
} as const;

/** A verdict that passed every check and may be stored. */
export interface ClassificationVerdict {
  classification: Classification;
  rejectionReason: RejectionReason | null;
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

/** First balanced JSON object in a reply, ignoring fences and surrounding prose. */
function findJsonObject(text: string): string | null {
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

function asString(value: unknown): string | null {
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
 *   • BLACKLIST must cite at least one configured avoided topic.
 *   • HIGH must cite at least one configured top-priority topic.
 *   • MEDIUM must cite at least one configured medium topic — EXCEPT in
 *     blacklist-only mode, where MEDIUM is the neutral "not blacklisted" answer
 *     and there are no medium topics to cite.
 *   • OUT_OF_SCOPE is unavailable in blacklist-only mode, for the same reason.
 */
export function parseClassificationResponse(
  raw: string | null | undefined,
  priorities: TopicPriorities
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

  // Matched topics: resolved against the configuration, unknown ones dropped.
  const index = topicIndex(priorities);
  const seen = new Set<string>();
  const matched: Array<{ topic: string; tier: TopicGroup }> = [];
  const rawMatched = Array.isArray(obj.matchedTopics) ? obj.matchedTopics : [];
  for (const entry of rawMatched) {
    const candidate = asString(entry);
    if (!candidate) continue;
    const hit = index.get(topicKey(candidate));
    if (!hit || seen.has(hit.topic)) continue;
    seen.add(hit.topic);
    matched.push(hit);
    if (matched.length >= MAX_STORED_MATCHED_TOPICS) break;
  }

  const has = (tier: TopicGroup) => matched.some((m) => m.tier === tier);

  if (classification === "HIGH" && !has("topPriorityTopics")) {
    return invalid(
      "HIGH was returned without citing a configured top priority topic.",
      'Answer "HIGH" only when the article\'s main subject is one of the TOP PRIORITY topics, and list the exact topic(s) from that list in "matchedTopics", copied verbatim.'
    );
  }
  if (classification === "MEDIUM" && mode !== "blacklist_only" && !has("mediumPriorityTopics")) {
    return invalid(
      "MEDIUM was returned without citing a configured medium priority topic.",
      'Answer "MEDIUM" only when the article\'s main subject is one of the MEDIUM PRIORITY topics, and list the exact topic(s) from that list in "matchedTopics", copied verbatim. If it matches nothing you were asked for, answer "REJECTED" with "OUT_OF_SCOPE".'
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
      'The "reason" field must be one short sentence saying what the article is about and why that produced this verdict.'
    );
  }

  return {
    status: "ok",
    classification,
    rejectionReason,
    matchedTopics: matched.map((m) => m.topic),
    reason: reason.slice(0, MAX_STORED_REASON_CHARS),
  };
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

function renderList(label: string, topics: string[]): string {
  if (topics.length === 0) return `${label}: (none configured)`;
  return `${label}:\n${topics.map((t) => `- ${t}`).join("\n")}`;
}

export interface ClassificationPromptInput {
  text: ClassifiableText;
  priorities: TopicPriorities;
  /** `title_only` makes the missing body explicit rather than leaving a gap. */
  inputKind: ClassificationInputKind;
}

/**
 * The system prompt — the rulebook.
 *
 * Two instructions here carry the feature. "Judge the MAIN subject" is what makes
 * an incidental mention harmless; "a topic need not appear as a word" is what
 * makes the match semantic instead of a keyword search that a model would happily
 * imitate if the prompt read like one.
 */
export function buildClassificationSystemPrompt(mode: ClassificationMode): string {
  const parts: string[] = [
    "You sort incoming news articles for a company, deciding how useful each one is for that company's social media.",
    "",
    "## How to judge",
    "",
    "1. Work out what the article is MAINLY about — its primary subject, the thing a reader would say it is about. Ignore passing mentions, examples, and asides.",
    "2. Compare that main subject with the company's configured topics below.",
    "3. A topic matches when the article's subject BELONGS to it. The topic word does not have to appear in the text: an article about choosing latex for a child's room is about paints, and an article about a heat pump is about air conditioning. Judge the meaning, never the spelling.",
    "4. Never invent a topic. Every topic you cite must be copied verbatim from the lists below.",
  ];

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
          '- "HIGH" — the article\'s main subject is one of the TOP PRIORITY topics.',
          '- "MEDIUM" — the article\'s main subject is one of the MEDIUM PRIORITY topics, and no stronger rule applies.',
          '- "REJECTED" with "BLACKLIST" — the article is MAINLY about one of the TOPICS TO AVOID.',
          '- "REJECTED" with "OUT_OF_SCOPE" — the article is about none of the topics the company asked for.',
        ].join("\n"),
    "",
    "## When rules collide",
    "",
    "Order of precedence: BLACKLIST beats HIGH, and HIGH beats MEDIUM.",
    "",
    "But BLACKLIST applies ONLY when an avoided topic is a main subject of the article. An article about paints that mentions a table once is an article about paints — judge it on paints. Rejecting it for the mention would throw away exactly the content the company asked for. If an avoided topic is genuinely one of the things the article is about, alongside a wanted one, then BLACKLIST wins.",
    "",
    "## Answer",
    "",
    "Reply with a single JSON object and nothing else:",
    "",
    "{",
    '  "classification": "HIGH" | "MEDIUM" | "REJECTED",',
    '  "rejectionReason": "BLACKLIST" | "OUT_OF_SCOPE" | null,',
    '  "matchedTopics": ["<topic copied verbatim from the lists>"],',
    '  "reason": "<one short sentence: what the article is about, and why that verdict>"',
    "}",
    "",
    'Set "rejectionReason" to null unless the classification is "REJECTED". Leave "matchedTopics" empty only when nothing matched.'
  );

  return parts.join("\n");
}

export function buildClassificationUserPrompt(input: ClassificationPromptInput): string {
  const { text, priorities, inputKind } = input;
  const parts: string[] = ["## The company's topics", ""];

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

  parts.push("", "## The article", "", `Title: ${text.title?.trim() || "(untitled)"}`);

  if (inputKind === "title_only") {
    parts.push(
      "",
      "The body of this article could not be read, so the title is all there is. Judge it on the title alone, and do not assume anything the title does not say. If the title is too vague to place, reject it as OUT_OF_SCOPE rather than guessing."
    );
  } else {
    parts.push("", "Article:", classificationExcerpt(text.body));
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
