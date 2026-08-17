import { prisma } from "@/lib/db/client";
import { resolveTopicPriorities, type TopicPriorities } from "@/lib/ai/topic-priorities";
import {
  BRAND_GUIDELINES_SELECT,
  type BrandGuidelinesData,
} from "./update-brand-guidelines.service";

export async function getBrandGuidelines(companyId: string): Promise<BrandGuidelinesData | null> {
  return prisma.brandGuidelines.findUnique({
    where: { companyId },
    select: BRAND_GUIDELINES_SELECT,
  });
}

/**
 * A company's configured topic priorities, keyed by tier (`high` / `medium` /
 * `avoided`).
 *
 * The entry point for anything that has to decide what an article is worth — the
 * RSS classifier above all. It answers for a company that has no brand row and
 * for one written before the columns existed, so no caller needs a null check or
 * any knowledge of where the lists are stored.
 *
 * These are the INPUT to that decision, not the decision: `avoided` is the
 * configured blacklist, which is narrower than a REJECTED verdict (an article
 * can be rejected as out of scope without matching it). The classifier owns its
 * own verdict and reason vocabulary — see lib/ai/topic-priorities.ts.
 */
export async function getTopicPriorities(companyId: string): Promise<TopicPriorities> {
  const brand = await prisma.brandGuidelines.findUnique({
    where: { companyId },
    select: {
      topPriorityTopics: true,
      mediumPriorityTopics: true,
      avoidedTopics: true,
    },
  });

  return resolveTopicPriorities(brand);
}
