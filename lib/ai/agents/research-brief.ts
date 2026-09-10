/**
 * The writing brief the Writer agent starts from.
 *
 * ── There is no research agent, and that is the point ───────────────────────
 *
 * A four-agent Research → Writer → Editor → QA crew would spend an LLM call
 * re-deriving what this system already knows. `understandArticle()`
 * (`lib/services/ai/understand-article.service.ts`) already reads the whole
 * article — chunking it when long, synthesising one global answer, and ceiling
 * its own confidence against cross-chunk agreement — and produces exactly the
 * structured answer a brief needs: real subject, thesis, conflict, type, topic
 * tiers, entities, evidence. Asking a second model the same question would cost
 * a call, would sometimes disagree with the verdict the article was CLASSIFIED
 * under, and would make the multi-agent arm's advantage partly "it did more
 * research" rather than "it edited and critiqued its own work".
 *
 * So this module is a FORMATTER. Every function here is pure: no provider
 * parameter, no I/O, no LLM call. That is enforced by the module having nothing
 * to call — there is no provider in scope — and asserted by a test.
 *
 * ── What is actually available today, and the honest consequence ────────────
 *
 * `ArticleUnderstanding` is NOT persisted. `classify-feed-item.service.ts`
 * produces one, uses it, and stores a lossy projection of it on the FeedItem:
 * `classificationMainSubject`, `classificationPrimaryTopic`,
 * `classificationMatchedTopics`, `classificationReason`. The richer fields —
 * `centralThesis`, `centralConflict`, `articleType`, `secondaryTopics`,
 * `incidentalTopics`, `entities`, `confidence`, `evidence` — are not kept
 * anywhere durable (`classificationChunkProgress` is transient by contract and
 * is cleared once classification reaches a terminal state).
 *
 * Both shapes are therefore accepted, and the brief RECORDS which one it was
 * built from (`source`). That field is not decoration: a measurement that finds
 * multi-agent no better than single-agent has to be able to distinguish "the
 * strategy does not help" from "the strategy was handed a one-line brief",
 * and without the provenance those two are indistinguishable.
 *
 * Persisting the full understanding is a deliberate later decision
 * (`FeedItem.articleUnderstanding Json?`, written in the same update
 * classification already performs, with no dual-write and no backfill). It is
 * not done here because this phase can be built, tested and measured without
 * it, and because a migration made "while we were nearby" is the kind that ends
 * up unused.
 */

import type { ArticleUnderstanding } from "../article-understanding";
import type { CrewArticleBrief } from "../crew/crew-contract";

/**
 * The lossy projection a FeedItem persists today. Every field nullable, because
 * an unclassified article legitimately has none of them — a company that has
 * configured no topics never classifies at all.
 */
export interface ClassificationProjection {
  mainSubject: string | null;
  primaryTopic: string | null;
  matchedTopics: readonly string[];
  reason: string | null;
}

/** A brief for a post with no article behind it — mission/evergreen content. */
export const NO_ARTICLE_BRIEF: CrewArticleBrief = {
  mainSubject: "",
  centralThesis: null,
  centralConflict: null,
  articleType: null,
  secondaryTopics: [],
  incidentalTopics: [],
  entities: [],
  confidence: null,
  source: "none",
};

/**
 * The full understanding, unchanged — a straight structural mapping, so nothing
 * is invented and nothing is summarised away.
 */
export function briefFromUnderstanding(u: ArticleUnderstanding): CrewArticleBrief {
  return {
    mainSubject: u.mainSubject,
    centralThesis: u.centralThesis,
    centralConflict: u.centralConflict,
    articleType: u.articleType,
    secondaryTopics: [...u.secondaryTopics],
    incidentalTopics: [...u.incidentalTopics],
    entities: [...u.entities],
    confidence: u.confidence,
    source: "understanding",
  };
}

/**
 * The projection, lifted into the same shape.
 *
 * The absent fields stay ABSENT — null and empty, never guessed. It would be
 * easy to put `classificationReason` in `centralThesis`, since both are
 * sentences about the article, but they answer different questions: the reason
 * explains why this article matched THIS COMPANY'S topic list, and a thesis is
 * the article's own argument. Putting the first where the second belongs would
 * hand the Writer the company's relevance rationale as though it were the
 * article's point.
 *
 * `primaryTopic` and `matchedTopics` become `secondaryTopics` because that is
 * honestly what they are: subjects the article touches, established against a
 * topic list rather than by reading for the central argument.
 */
export function briefFromClassification(p: ClassificationProjection): CrewArticleBrief {
  const subject = p.mainSubject?.trim() ?? "";
  if (subject === "") return NO_ARTICLE_BRIEF;

  const secondary = [p.primaryTopic, ...p.matchedTopics]
    .map((t) => t?.trim() ?? "")
    .filter((t) => t !== "");

  return {
    mainSubject: subject,
    centralThesis: null,
    centralConflict: null,
    articleType: null,
    secondaryTopics: dedupe(secondary),
    incidentalTopics: [],
    entities: [],
    confidence: null,
    source: "classification_projection",
  };
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Renders a brief as the prose block the Writer is shown.
 *
 * Sections are omitted rather than emptied. A heading followed by nothing tells
 * a model that the field exists and it should have something to say there,
 * which is an invitation to invent one — the specific failure the
 * understanding pipeline's own prompts guard against ("never invent one to fill
 * it"). An absent section says nothing at all, which is the truth.
 */
export function formatBrief(brief: CrewArticleBrief): string {
  if (brief.source === "none" || brief.mainSubject.trim() === "") {
    return "";
  }

  const lines: string[] = ["## What the source article is about", "", brief.mainSubject];

  if (brief.centralThesis) {
    lines.push("", "The article's own thesis:", brief.centralThesis);
  }
  if (brief.centralConflict) {
    lines.push("", "The central tension:", brief.centralConflict);
  }
  if (brief.articleType) {
    lines.push("", `Article type: ${brief.articleType}`);
  }
  if (brief.secondaryTopics.length > 0) {
    lines.push(
      "",
      `Subjects discussed in service of the main one: ${brief.secondaryTopics.join(", ")}`
    );
  }
  if (brief.incidentalTopics.length > 0) {
    lines.push(
      "",
      "Mentioned only in passing — these are NOT what the article is about: " +
        brief.incidentalTopics.join(", ")
    );
  }
  if (brief.entities.length > 0) {
    lines.push("", `Named in the article: ${brief.entities.join(", ")}`);
  }
  if (brief.confidence !== null) {
    lines.push(
      "",
      `Confidence in the subject above: ${brief.confidence.toFixed(2)}. Treat a low number as a ` +
        "reason to stay close to what the article plainly says, not as licence to pick your own subject."
    );
  }
  if (brief.source === "classification_projection") {
    lines.push(
      "",
      "This brief was built from the article's stored topic verdict, so it names the subject " +
        "but not the article's own argument. Do not invent a thesis it does not state."
    );
  }

  return lines.join("\n");
}
