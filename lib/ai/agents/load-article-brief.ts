/**
 * Reads the writing brief for one article, from what the database actually has.
 *
 * ── Why this is a separate, best-effort loader ──────────────────────────────
 *
 * `research-brief.ts` is a pure formatter with no I/O — that is enforced by it
 * having nothing to call — so somebody has to fetch the projection it formats.
 * This is that somebody, and it is deliberately the smallest possible thing: one
 * indexed read of four columns on a row the generation already claimed.
 *
 * It is best-effort in exactly the way the trace loaders are. A brief that
 * cannot be read degrades to `NO_ARTICLE_BRIEF`, and the multi-agent run
 * proceeds — because the brief is SUPPLEMENTARY. The whole article, the brand
 * voice, the channel policy and every diversity lever are already composed into
 * `systemPrompt`/`userPrompt` by the shared builder and travel to the sidecar
 * verbatim. The brief adds the article's structured subject on top of that; its
 * absence costs the Writer some orientation, and must never cost a generation.
 *
 * ── What it can and cannot return ───────────────────────────────────────────
 *
 * Only `source: "classification_projection"` or `"none"` — never
 * `"understanding"`. The full `ArticleUnderstanding` is not persisted anywhere
 * (see the note in `research-brief.ts`), so claiming that source would overstate
 * what the Writer was given, and the whole point of the `source` field is to let
 * a weak measurement be attributed to a thin brief rather than to the strategy.
 */

import { prisma } from "@/lib/db/client";
import { briefFromClassification, NO_ARTICLE_BRIEF } from "./research-brief";
import type { CrewArticleBrief } from "../crew/crew-contract";

export interface ArticleBriefDb {
  feedItem: {
    findUnique: (args: {
      where: { id: string };
      select: {
        classificationMainSubject: true;
        classificationPrimaryTopic: true;
        classificationMatchedTopics: true;
        classificationReason: true;
      };
    }) => Promise<{
      classificationMainSubject: string | null;
      classificationPrimaryTopic: string | null;
      classificationMatchedTopics: string[];
      classificationReason: string | null;
    } | null>;
  };
}

/**
 * The brief for one claimed article, or `NO_ARTICLE_BRIEF`.
 *
 * `null` in, `NO_ARTICLE_BRIEF` out: a mission or evergreen post has no article,
 * and that is an ordinary case rather than a missing value — the caller should
 * not have to branch on it.
 */
export async function loadArticleBrief(
  feedItemId: string | null | undefined,
  db: ArticleBriefDb = prisma as unknown as ArticleBriefDb
): Promise<CrewArticleBrief> {
  if (!feedItemId) return NO_ARTICLE_BRIEF;
  try {
    const row = await db.feedItem.findUnique({
      where: { id: feedItemId },
      select: {
        classificationMainSubject: true,
        classificationPrimaryTopic: true,
        classificationMatchedTopics: true,
        classificationReason: true,
      },
    });
    if (!row) return NO_ARTICLE_BRIEF;
    return briefFromClassification({
      mainSubject: row.classificationMainSubject,
      primaryTopic: row.classificationPrimaryTopic,
      matchedTopics: row.classificationMatchedTopics ?? [],
      reason: row.classificationReason,
    });
  } catch (err) {
    console.error(
      "[crew] Could not read the article brief; the multi-agent run continues " +
        "with no structured brief (the prompts are unaffected):",
      err instanceof Error ? err.message : err
    );
    return NO_ARTICLE_BRIEF;
  }
}
