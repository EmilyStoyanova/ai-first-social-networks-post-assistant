/**
 * Topic priorities — the company's answer to "which subjects are worth a post?".
 *
 * Three ordered groups, configured per company in Brand Settings and stored on
 * BrandGuidelines. Everything about the SHAPE of that configuration lives here,
 * so a consumer never has to know how the settings are edited or stored.
 *
 * This module describes CONFIGURATION ONLY. It deliberately carries no verdict
 * vocabulary: a configured group is an input to a decision, never the decision.
 * The RSS/feed-article classifier is a later task, and it owns its own verdict
 * and rejection-reason types. The intended relationship is:
 *
 *   high    (topPriorityTopics)    → may produce HIGH
 *   medium  (mediumPriorityTopics) → may produce MEDIUM
 *   avoided (avoidedTopics)        → may produce REJECTED for reason BLACKLIST
 *   no matching configured topic   → may produce REJECTED for reason OUT_OF_SCOPE
 *
 * The last line is why `avoided` must not be called `rejected`: an article can
 * be rejected as out of scope without matching anything in the avoided list, so
 * the configured list is strictly narrower than the verdict. "avoided" is also
 * what the column (`avoided_topics`) and the UI ("Topics to avoid" / "Теми за
 * избягване") already call it, and it stays lexically distinct from the future
 * BLACKLIST reason rather than colliding with it.
 *
 * Pure: no Prisma, no network, no React.
 */

// ─── Vocabulary ───────────────────────────────────────────────────────────────

/**
 * The three stored lists, named as the BrandGuidelines columns are, so a group
 * identifier doubles as the field path a validation issue points at.
 */
export const TOPIC_GROUPS = ["topPriorityTopics", "mediumPriorityTopics", "avoidedTopics"] as const;
export type TopicGroup = (typeof TOPIC_GROUPS)[number];

/**
 * The same three groups under the short names a consumer reads them by — the
 * keys of `TopicPriorities`, in rank order.
 */
export const TOPIC_TIERS = ["high", "medium", "avoided"] as const;
export type TopicTier = (typeof TOPIC_TIERS)[number];

/**
 * Storage name → consumer name. A pure renaming of one configuration vocabulary
 * into the other; it asserts nothing about what any group makes the classifier
 * decide.
 */
export const TOPIC_GROUP_TIER: Record<TopicGroup, TopicTier> = {
  topPriorityTopics: "high",
  mediumPriorityTopics: "medium",
  avoidedTopics: "avoided",
};

// ─── Limits ───────────────────────────────────────────────────────────────────

/**
 * A topic is a subject, not a sentence — "смесители и аксесоари за баня" is 30
 * characters. The cap is generous enough for a multi-word Bulgarian phrase and
 * short enough that a pasted paragraph is rejected rather than stored.
 */
export const MAX_TOPIC_LENGTH = 80;

/**
 * Per group, not in total. Every topic will eventually be shown to a classifier
 * model in one prompt, so the list has to stay readable in a prompt as well as
 * in the form.
 */
export const MAX_TOPICS_PER_GROUP = 50;

// ─── Normalization ────────────────────────────────────────────────────────────

/**
 * The stored form of a topic: NFC, inner whitespace collapsed, trimmed.
 *
 * Case is PRESERVED — "ТОП" and "бои" are shown back to the user as typed, and a
 * classifier prompt reads better with the owner's own capitalisation.
 */
export function normalizeTopic(raw: string): string {
  return raw.normalize("NFC").replace(/\s+/gu, " ").trim();
}

/**
 * The comparison key for "is this the same topic?".
 *
 * Case-insensitive on top of normalization, because "Бои" and "бои" are one
 * subject and storing both would ask the classifier the same question twice —
 * and, across two groups, would ask it in two contradictory ways.
 */
export function topicKey(raw: string): string {
  return normalizeTopic(raw).toLowerCase();
}

// ─── Reading the configuration ────────────────────────────────────────────────

/**
 * Anything carrying the three lists — a BrandGuidelines row, a form payload, or
 * nothing at all. Every field is optional so a company with no brand row, and a
 * row written before this feature existed, both read as "not configured".
 */
export type TopicPrioritiesSource =
  | {
      topPriorityTopics?: readonly string[] | null;
      mediumPriorityTopics?: readonly string[] | null;
      avoidedTopics?: readonly string[] | null;
    }
  | null
  | undefined;

/**
 * The configuration as a consumer wants it: keyed by tier, never by the column
 * it came from — and never by a classifier verdict, which these are only an
 * input to (see the module header).
 */
export type TopicPriorities = Record<TopicTier, string[]>;

/**
 * The three lists, cleaned and de-duplicated, for a company that has configured
 * nothing / for one that has.
 *
 * Reads defensively rather than trusting the store: rows written before the
 * columns existed, and any list that slipped past validation, still resolve to
 * something a caller can iterate without checking.
 */
export function resolveTopicPriorities(source: TopicPrioritiesSource): TopicPriorities {
  return {
    high: cleanList(source?.topPriorityTopics),
    medium: cleanList(source?.mediumPriorityTopics),
    avoided: cleanList(source?.avoidedTopics),
  };
}

/** True when at least one group has a topic — i.e. there is a rule to apply. */
export function hasTopicPriorities(priorities: TopicPriorities): boolean {
  return TOPIC_TIERS.some((tier) => priorities[tier].length > 0);
}

function cleanList(list: readonly string[] | null | undefined): string[] {
  if (!list) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const topic = normalizeTopic(raw);
    if (!topic) continue;
    const key = topic.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(topic);
  }
  return out;
}

// ─── Validation ───────────────────────────────────────────────────────────────

/** The three lists exactly as submitted, before any cleaning. */
export type TopicGroups = Record<TopicGroup, readonly string[]>;

export type TopicIssue =
  | { code: "EMPTY_TOPIC"; group: TopicGroup }
  | { code: "TOPIC_TOO_LONG"; group: TopicGroup; topic: string }
  | { code: "TOO_MANY_TOPICS"; group: TopicGroup }
  | { code: "DUPLICATE_TOPIC"; group: TopicGroup; topic: string }
  | { code: "TOPIC_IN_MULTIPLE_GROUPS"; group: TopicGroup; topic: string; otherGroup: TopicGroup };

/**
 * Every rule the three lists must satisfy, checked against the submitted values
 * rather than a cleaned copy — the caller is told what is wrong, never quietly
 * handed something it did not send.
 *
 * The cross-group rule is the reason this takes all three lists at once: a topic
 * in two groups is a configuration with no answer ("бои" is both HIGH and
 * REJECTED), and silently picking one would make the classifier's verdict depend
 * on an ordering nobody chose. Groups are checked in TOPIC_GROUPS order, so the
 * FIRST group a topic appears in is the one it keeps and the later one is the
 * one reported — deterministic whichever way the user got there.
 */
export function validateTopicGroups(groups: TopicGroups): TopicIssue[] {
  const issues: TopicIssue[] = [];
  const owner = new Map<string, TopicGroup>();

  for (const group of TOPIC_GROUPS) {
    const list = groups[group] ?? [];
    if (list.length > MAX_TOPICS_PER_GROUP) issues.push({ code: "TOO_MANY_TOPICS", group });

    const seen = new Set<string>();
    for (const raw of list) {
      const topic = normalizeTopic(raw);

      if (!topic) {
        issues.push({ code: "EMPTY_TOPIC", group });
        continue;
      }
      if (topic.length > MAX_TOPIC_LENGTH) {
        issues.push({ code: "TOPIC_TOO_LONG", group, topic });
        continue;
      }

      const key = topic.toLowerCase();
      if (seen.has(key)) {
        issues.push({ code: "DUPLICATE_TOPIC", group, topic });
        continue;
      }
      seen.add(key);

      const other = owner.get(key);
      if (other && other !== group) {
        issues.push({ code: "TOPIC_IN_MULTIPLE_GROUPS", group, topic, otherGroup: other });
        continue;
      }
      if (!other) owner.set(key, group);
    }
  }

  return issues;
}

/** Developer-facing wording for an issue — API `message`, logs, zod issues. */
export function topicIssueMessage(issue: TopicIssue): string {
  switch (issue.code) {
    case "EMPTY_TOPIC":
      return "A topic cannot be empty.";
    case "TOPIC_TOO_LONG":
      return `Topic "${issue.topic}" is longer than ${MAX_TOPIC_LENGTH} characters.`;
    case "TOO_MANY_TOPICS":
      return `At most ${MAX_TOPICS_PER_GROUP} topics are allowed per group.`;
    case "DUPLICATE_TOPIC":
      return `Topic "${issue.topic}" is listed twice in the same group.`;
    case "TOPIC_IN_MULTIPLE_GROUPS":
      return `Topic "${issue.topic}" is already in ${issue.otherGroup}. A topic belongs to exactly one priority group.`;
  }
}

// ─── Adding one topic (the chip input) ────────────────────────────────────────

/**
 * Why a candidate topic was refused. Narrower than TopicIssue on purpose: the
 * input is adding ONE topic to a known group, so there is no group to report and
 * no ambiguity about which entry is at fault.
 */
export type TopicRejection =
  | { reason: "empty" }
  | { reason: "too_long" }
  | { reason: "limit_reached" }
  | { reason: "duplicate" }
  | { reason: "conflict"; otherGroup: TopicGroup };

export type TopicAddition = { ok: true; topic: string } | ({ ok: false } & TopicRejection);

/**
 * Vets one typed topic against the whole configuration before it becomes a chip.
 *
 * This is the same rulebook as validateTopicGroups, asked one topic at a time so
 * the form can refuse at the moment of typing instead of at save. The server
 * still runs the full check — this exists for the message, not for the safety.
 */
export function checkTopicAddition(
  raw: string,
  target: TopicGroup,
  groups: TopicGroups
): TopicAddition {
  const topic = normalizeTopic(raw);
  if (!topic) return { ok: false, reason: "empty" };
  if (topic.length > MAX_TOPIC_LENGTH) return { ok: false, reason: "too_long" };
  if ((groups[target] ?? []).length >= MAX_TOPICS_PER_GROUP) {
    return { ok: false, reason: "limit_reached" };
  }

  const key = topic.toLowerCase();
  for (const group of TOPIC_GROUPS) {
    if (!(groups[group] ?? []).some((existing) => topicKey(existing) === key)) continue;
    return group === target
      ? { ok: false, reason: "duplicate" }
      : { ok: false, reason: "conflict", otherGroup: group };
  }

  return { ok: true, topic };
}
