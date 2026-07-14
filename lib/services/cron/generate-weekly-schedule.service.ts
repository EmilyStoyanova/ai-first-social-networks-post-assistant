import { prisma } from "@/lib/db/client";
import { z } from "zod";
import { buildGenerationContextForCompany } from "@/lib/services/ai/build-generation-context.service";
import { generatePostFromContext } from "@/lib/services/ai/generate-draft-post.service";

/**
 * LLM calls are the slowest cron step; cap them per run so the function stays
 * well inside the Vercel timeout. Remaining posts are generated on the next
 * run — the schedule stays in "generating" until every channel hits target.
 */
const MAX_GENERATIONS_PER_RUN = 3;

/** Hard per-channel ceiling as a cost guard, regardless of postsPerWeek. */
const MAX_POSTS_PER_CHANNEL = 7;

const DAY_ORDER = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
] as const;

const postingWindowsSchema = z.array(
  z.object({
    day: z.enum(DAY_ORDER),
    start: z.string().regex(/^\d{2}:\d{2}$/),
    end: z.string().regex(/^\d{2}:\d{2}$/),
  })
);

export interface WeeklyScheduleSummary {
  weekStart: string;
  scheduleId: string | null;
  scheduleStatus: "generating" | "ready" | "skipped";
  postsGenerated: number;
  postsRemaining: number;
  failures: Array<{ channel: string; message: string }>;
}

/** Monday 00:00 UTC of the week after the given date. */
export function nextWeekStart(from: Date): Date {
  const date = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  // getUTCDay(): Sunday = 0 … Saturday = 6 → days elapsed since this week's Monday
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday + 7);
  return date;
}

/**
 * Picks the scheduled time for the Nth post (0-based) of `target` posts in a
 * week: posts are spread evenly across the 7 days, at the start of the
 * channel's posting window for that day when one exists, otherwise 10:00 UTC.
 */
function slotFor(
  weekStart: Date,
  slotIndex: number,
  target: number,
  postingWindows: unknown
): Date {
  const dayIndex = Math.min(6, Math.floor((slotIndex * 7) / Math.max(target, 1)));

  let hour = 10;
  let minute = 0;
  const parsed = postingWindowsSchema.safeParse(postingWindows);
  if (parsed.success && parsed.data.length > 0) {
    const dayName = DAY_ORDER[dayIndex];
    const window = parsed.data.find((w) => w.day === dayName) ?? parsed.data[0];
    const [h, m] = window.start.split(":").map(Number);
    hour = h;
    minute = m;
  }

  const slot = new Date(weekStart);
  slot.setUTCDate(slot.getUTCDate() + dayIndex);
  slot.setUTCHours(hour, minute, 0, 0);
  return slot;
}

/**
 * Cron step 3 — ensures next week's schedule exists and incrementally fills
 * it with generated posts (pending_approval; the auto-approve step promotes
 * them for fully automated companies). Generation is budgeted per run.
 */
export async function generateWeeklySchedule(companyId: string): Promise<WeeklyScheduleSummary> {
  const weekStart = nextWeekStart(new Date());
  const weekStartIso = weekStart.toISOString().slice(0, 10);

  const channelConfigs = await prisma.channelConfig.findMany({
    where: { companyId, enabled: true, postsPerWeek: { gt: 0 } },
    select: { channel: true, postsPerWeek: true, postingLanguage: true, postingWindows: true },
  });

  if (channelConfigs.length === 0) {
    return {
      weekStart: weekStartIso,
      scheduleId: null,
      scheduleStatus: "skipped",
      postsGenerated: 0,
      postsRemaining: 0,
      failures: [],
    };
  }

  const schedule = await prisma.weeklySchedule.upsert({
    where: { companyId_weekStart: { companyId, weekStart } },
    create: { companyId, weekStart, status: "generating" },
    update: {},
    select: { id: true, status: true },
  });

  // Already fully generated in a previous run — nothing to do.
  if (schedule.status !== "generating") {
    return {
      weekStart: weekStartIso,
      scheduleId: schedule.id,
      scheduleStatus: "ready",
      postsGenerated: 0,
      postsRemaining: 0,
      failures: [],
    };
  }

  const existingCounts = await prisma.post.groupBy({
    by: ["channel"],
    where: { scheduleId: schedule.id },
    _count: { _all: true },
  });
  const countByChannel = new Map(existingCounts.map((c) => [c.channel, c._count._all]));

  const summary: WeeklyScheduleSummary = {
    weekStart: weekStartIso,
    scheduleId: schedule.id,
    scheduleStatus: "generating",
    postsGenerated: 0,
    postsRemaining: 0,
    failures: [],
  };

  let budget = MAX_GENERATIONS_PER_RUN;

  for (const config of channelConfigs) {
    const target = Math.min(config.postsPerWeek, MAX_POSTS_PER_CHANNEL);
    let have = countByChannel.get(config.channel) ?? 0;

    while (have < target && budget > 0) {
      const contextResult = await buildGenerationContextForCompany(companyId, config.channel);
      if (!contextResult.success) {
        summary.failures.push({ channel: config.channel, message: contextResult.code });
        break;
      }

      const result = await generatePostFromContext(contextResult.context, companyId, {
        contentLanguage: config.postingLanguage,
        scheduleId: schedule.id,
        scheduledFor: slotFor(weekStart, have, target, config.postingWindows),
        initialStatus: "pending_approval",
      });

      if (!result.success) {
        // No unused source articles remain for this channel — a clean skip, not
        // a failure. No LLM call happened, so the run budget is left intact for
        // the other channels.
        if (result.code === "NO_FEED_ITEMS_AVAILABLE") break;

        budget--; // a real generation attempt consumed an LLM call
        summary.failures.push({
          channel: config.channel,
          message: result.message ?? result.code,
        });
        break; // LLM trouble is unlikely to be channel-specific; stop burning budget
      }

      budget--;
      have++;
      summary.postsGenerated++;
    }

    summary.postsRemaining += Math.max(0, target - have);
  }

  if (summary.postsRemaining === 0 && summary.failures.length === 0) {
    await prisma.weeklySchedule.update({
      where: { id: schedule.id },
      data: { status: "ready", generatedAt: new Date() },
    });
    summary.scheduleStatus = "ready";
  }

  return summary;
}
