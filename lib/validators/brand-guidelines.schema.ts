import { z } from "zod";
import {
  TOPIC_GROUPS,
  normalizeTopic,
  topicIssueMessage,
  validateTopicGroups,
  type TopicGroups,
} from "@/lib/ai/topic-priorities";

const hexColor = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/, "Must be a valid hex color (#RRGGBB).")
  .optional();

/**
 * One topic group. Whitespace is normalized here so everything downstream — the
 * duplicate check, the conflict check, the stored row — compares the same text.
 *
 * Every other rule (empty, length, count, duplicates, cross-group conflicts) is
 * applied together in the object-level refinement below, and none is restated
 * here: a topic's validity depends on the other two lists as well as its own,
 * and a rule checked in two places reports itself twice.
 */
const topicList = z
  .array(z.string())
  .transform((topics) => topics.map(normalizeTopic))
  .optional();

export const updateBrandGuidelinesSchema = z
  .object({
    automationMode: z.enum(["semi_automated", "fully_automated"]).optional(),
    // Company-wide brand default post language (Company.defaultLang). Channels
    // inherit this unless they set their own override.
    defaultLang: z.enum(["en", "bg"]).optional(),
    logoUrl: z.string().url("Must be a valid URL.").optional(),
    primaryColor: hexColor,
    secondaryColor: hexColor,
    fontFamily: z.string().max(100, "Font family must be at most 100 characters.").optional(),
    toneOfVoice: z.string().max(200, "Tone of voice must be at most 200 characters.").optional(),
    companyDescription: z
      .string()
      .max(2000, "Company description must be at most 2000 characters.")
      .optional(),
    targetAudience: z
      .string()
      .max(1000, "Target audience must be at most 1000 characters.")
      .optional(),
    forbiddenWords: z.array(z.string()).optional(),
    competitors: z.array(z.string()).optional(),
    // RSS/content topic priorities. Omitting a group leaves the stored list
    // untouched, so a client that predates this feature saves as it always did.
    topPriorityTopics: topicList,
    mediumPriorityTopics: topicList,
    avoidedTopics: topicList,
  })
  .superRefine((value, ctx) => {
    // A submitted group is checked against the other two AS SUBMITTED. An
    // omitted group contributes nothing rather than its stored contents: the
    // save leaves that list alone, so it cannot be the thing that conflicts.
    const groups = TOPIC_GROUPS.reduce((acc, group) => {
      acc[group] = value[group] ?? [];
      return acc;
    }, {} as TopicGroups);

    for (const issue of validateTopicGroups(groups)) {
      ctx.addIssue({
        code: "custom",
        message: topicIssueMessage(issue),
        path: [issue.group],
      });
    }
  });

export type UpdateBrandGuidelinesInput = z.infer<typeof updateBrandGuidelinesSchema>;
