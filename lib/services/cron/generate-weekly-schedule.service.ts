import { prisma } from "@/lib/db/client";
import {
  buildGenerationContextForCompany,
  type SourceScope,
} from "@/lib/services/ai/build-generation-context.service";
import {
  parsePostingWindows,
  postingDaySlots,
  type PostingDaySlot,
  type PostingWindowEntry,
} from "@/lib/scheduling/posting-windows";
import { generatePostFromContext } from "@/lib/services/ai/generate-draft-post.service";
import {
  COMPANY_CONTENT_SOURCE_ID,
  contentMixTotal,
  MAX_POSTS_PER_CHANNEL_PER_WEEK,
  mixForChannel,
  nextDueQuota,
  resolveContentMix,
  type MixQuota,
} from "@/lib/scheduling/content-mix";

/**
 * LLM calls are the slowest cron step; cap them per run so the function stays
 * well inside the Vercel timeout. Remaining posts are generated on the next
 * run — the schedule stays in "generating" until every channel hits target.
 */
const MAX_GENERATIONS_PER_RUN = 3;

export interface WeeklyScheduleSummary {
  weekStart: string;
  scheduleId: string | null;
  scheduleStatus: "generating" | "ready" | "skipped";
  postsGenerated: number;
  postsRemaining: number;
  failures: Array<{ channel: string; message: string }>;
  /** v2-8 — false when no content mix is configured and legacy pooling ran. */
  mixConfigured: boolean;
  /**
   * v2-8 — quotas that ran out of eligible articles during this run. Their
   * unwritten posts are handed to a source that still has articles, so running
   * dry usually costs the week nothing. This reports what ran dry, not what was
   * lost — see `shortfalls` for that.
   * sourceId null = the company-content quota.
   */
  exhaustedQuotas: Array<{ channel: string; sourceId: string | null }>;
  /**
   * v2-8 — channels that will finish short, and why. A shortfall means the
   * transfer had nowhere to go: every RSS source with a quota was out of unused
   * articles, so those posts cannot be written by anyone this run.
   *
   * Reported rather than silently absorbed, because "5 posts a week produced 3"
   * is the kind of thing an operator has to be able to see. The posts stay
   * outstanding and the next run retries them once ingestion has fetched more.
   */
  shortfalls: Array<{ channel: string; posts: number; reason: "NO_ELIGIBLE_SOURCE" }>;
  /**
   * Enabled channels that were left out of the week because nobody configured
   * WHEN they publish. Not a failure and not a shortfall — there is no target to
   * fall short of, since a channel with no posting windows is not scheduled at
   * all (see the invariant on `generateWeeklySchedule`).
   *
   * Reported because the alternative is a cron that silently does nothing for a
   * channel an owner believes is switched on. This list is what an operator
   * reads to find out that the fix is on the settings page.
   */
  skippedChannels: Array<{ channel: string; reason: "NO_POSTING_WINDOWS" }>;
  /**
   * Channels whose weekly target was reduced to the number of days they
   * configured, because automatic scheduling places at most one post per
   * calendar day.
   *
   * A channel asking for 5 posts with one Friday window gets 1 post, not 5 —
   * the surplus has nowhere to go that its owner authorised. Reported rather
   * than absorbed silently, for the same reason `skippedChannels` is: a cron
   * writing one post where five were configured must not look like a cron that
   * is failing. The fix is on the settings page, which now refuses to save the
   * combination in the first place; this covers rows saved before it did.
   */
  cappedChannels: Array<{
    channel: string;
    requested: number;
    scheduled: number;
    reason: "FEWER_POSTING_DAYS_THAN_TARGET";
  }>;
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
 * The instant one of the channel's configured posting days names in this week.
 *
 * The caller picks the SLOT — one of `postingDaySlots`, which exist only for
 * weekdays the owner explicitly configured — and this turns it into a date.
 * There is no day arithmetic left here to get wrong.
 *
 * It used to spread the target evenly over all seven days and look up a time for
 * whatever day that produced, which is how a channel configured for Friday alone
 * ended up with posts on Monday, Tuesday, Wednesday and Saturday, each carrying
 * Friday's hour. A window authorises its own weekday and no other.
 */
function slotFor(weekStart: Date, slot: PostingDaySlot): Date {
  // weekStart is always a Monday, so the slot's DAY_ORDER index is its offset.
  const at = new Date(weekStart);
  at.setUTCDate(at.getUTCDate() + slot.dayIndex);
  at.setUTCHours(slot.time.hour, slot.time.minute, 0, 0);
  return at;
}

interface ChannelConfigRow {
  channel: string;
  postsPerWeek: number;
  // null = inherit the brand default; the generation context resolves it.
  postingLanguage: string | null;
  postingWindows: unknown;
}

/**
 * A channel that has passed the posting-window gate, carrying its parsed
 * schedule.
 *
 * The windows are parsed ONCE, at the gate, and travel with the channel from
 * there. Re-parsing per slot would let the two questions — "may this channel be
 * scheduled at all" and "at what time" — be answered from separate reads of the
 * same JSON, which is precisely how a default hour creeps back in.
 *
 * `daySlots` and `target` are derived there too, for the same reason: the days
 * this channel may publish on and how many posts its week can hold are one
 * decision, taken once, and every post placed below reads it rather than
 * re-deriving it.
 */
interface SchedulableChannel extends ChannelConfigRow {
  windows: PostingWindowEntry[];
  /** One per explicitly configured weekday — the only days a post may land on. */
  daySlots: PostingDaySlot[];
  /**
   * The posts this channel's week can actually hold: its weekly target, capped
   * at the per-channel ceiling AND at the number of days it configured, since
   * automatic scheduling places at most one post per calendar day.
   */
  target: number;
}

// ─── Minimal DB interface for testability ─────────────────────────────────────
// Same pattern as GenerateDraftPostDb: the real Prisma client satisfies this
// narrow shape, and unit tests inject a fake. `mock.module` is unavailable under
// `npx tsx --test`, so injection is the only way to test the wiring.
//
// Existing posts are read with findMany + counted in memory rather than groupBy:
// a schedule holds at most a handful of posts per channel, and the concrete
// signature stays mockable without reproducing Prisma's groupBy generics.

export interface GenerateWeeklyScheduleDb {
  channelConfig: {
    findMany: (args: {
      where: { companyId: string; enabled: true; postsPerWeek: { gt: number } };
      select: {
        channel: true;
        postsPerWeek: true;
        postingLanguage: true;
        postingWindows: true;
      };
    }) => Promise<ChannelConfigRow[]>;
  };
  weeklySchedule: {
    upsert: (args: {
      where: { companyId_weekStart: { companyId: string; weekStart: Date } };
      create: { companyId: string; weekStart: Date; status: "generating" };
      update: Record<string, never>;
      select: { id: true; status: true };
    }) => Promise<{ id: string; status: string }>;
    update: (args: {
      where: { id: string };
      data: { status: "ready"; generatedAt: Date };
    }) => Promise<unknown>;
  };
  company: {
    findUnique: (args: {
      where: { id: string };
      select: { companyContentPostsPerWeek: true };
    }) => Promise<{ companyContentPostsPerWeek: number | null } | null>;
  };
  contentSource: {
    findMany: (args: {
      where: { companyId: string };
      select: {
        id: true;
        name: true;
        enabled: true;
        postsPerWeek: true;
      };
    }) => Promise<
      Array<{
        id: string;
        name: string;
        enabled: boolean;
        postsPerWeek: number | null;
      }>
    >;
  };
  post: {
    findMany: (args: {
      where: { scheduleId: string };
      select: { channel: true; contentSourceId: true };
    }) => Promise<Array<{ channel: string; contentSourceId: string | null }>>;
  };
}

export interface GenerateWeeklyScheduleDeps {
  db?: GenerateWeeklyScheduleDb;
  buildContext?: typeof buildGenerationContextForCompany;
  generate?: typeof generatePostFromContext;
  /** Injected in tests so week boundaries are deterministic. */
  now?: () => Date;
  /**
   * Soft time-budget hook from the generation cron. Checked before each post's expensive
   * LLM/image generation; when it returns true the fill loops stop between posts, leaving
   * the schedule "generating" so the next run resumes. Defaults to never-stop.
   */
  shouldStop?: () => boolean;
}

/** Shared mutable generation budget for one cron run, across all channels. */
interface RunBudget {
  remaining: number;
}

interface FillContext {
  companyId: string;
  scheduleId: string;
  weekStart: Date;
  config: SchedulableChannel;
  budget: RunBudget;
  summary: WeeklyScheduleSummary;
  buildContext: typeof buildGenerationContextForCompany;
  generate: typeof generatePostFromContext;
  /** Soft deadline hook — stops the fill loop between posts at the cron time budget. */
  shouldStop: () => boolean;
}

/**
 * Cron step 3 — ensures next week's schedule exists and incrementally fills
 * it with generated posts (pending_approval; the auto-approve step promotes
 * them for fully automated companies). Generation is budgeted per run.
 *
 * WHICH CHANNELS TAKE PART. Being enabled with a weekly target is necessary but
 * not sufficient: a channel must also have posting windows an owner explicitly
 * configured. The invariant is
 *
 *     no configured posting window
 *         → no automatic generation schedule
 *         → no automatically generated post for that channel
 *
 * and it holds here rather than deeper down because this is the only place that
 * decides who gets a share of the week. Enforcing it further in — at the slot, or
 * at the generation call — would mean a channel had already been counted into a
 * target it can never fill, and the week would sit forever in "generating".
 *
 * Manual generation is untouched by this: a person naming a period and looking at
 * a preview is not the automatic pipeline, and the whole rule is about posts
 * nobody asked for. See lib/scheduling/bulk-schedule.ts.
 *
 * How many posts a channel gets is `ChannelConfig.postsPerWeek` on both paths
 * below, capped at MAX_POSTS_PER_CHANNEL_PER_WEEK. Only the choice of source
 * differs:
 *
 *   • Content mix configured (v2-8) — the company's recipe, resized to this
 *     channel's target, decides which source each post comes from; see
 *     fillChannelFromMix.
 *   • No mix — the pre-v2-8 pooled behaviour, unchanged: fill the channel's
 *     target from whatever unused article surfaces first.
 */
export async function generateWeeklySchedule(
  companyId: string,
  deps: GenerateWeeklyScheduleDeps = {}
): Promise<WeeklyScheduleSummary> {
  const db: GenerateWeeklyScheduleDb = deps.db ?? prisma;
  const buildContext = deps.buildContext ?? buildGenerationContextForCompany;
  const generate = deps.generate ?? generatePostFromContext;
  const shouldStop = deps.shouldStop ?? (() => false);

  const weekStart = nextWeekStart(deps.now ? deps.now() : new Date());
  const weekStartIso = weekStart.toISOString().slice(0, 10);

  const channelConfigs = await db.channelConfig.findMany({
    where: { companyId, enabled: true, postsPerWeek: { gt: 0 } },
    select: { channel: true, postsPerWeek: true, postingLanguage: true, postingWindows: true },
  });

  // ── The posting-window gate ───────────────────────────────────────────────
  // Applied before the schedule row is even upserted, so a company whose
  // channels are all unscheduled leaves no weekly schedule behind at all —
  // "skipped" here means exactly what it has always meant: this company has
  // nothing for the cron to do this week.
  const schedulable: SchedulableChannel[] = [];
  const skippedChannels: WeeklyScheduleSummary["skippedChannels"] = [];
  const cappedChannels: WeeklyScheduleSummary["cappedChannels"] = [];

  for (const config of channelConfigs) {
    const windows = parsePostingWindows(config.postingWindows);
    if (windows === null) {
      skippedChannels.push({ channel: config.channel, reason: "NO_POSTING_WINDOWS" });
      continue;
    }

    // ── The one-post-per-day rule ───────────────────────────────────────────
    // A week can hold no more posts than the channel has days to put them on.
    // Capping here, at the same place the target is otherwise decided, is what
    // keeps the surplus from being placed on days nobody configured — the old
    // behaviour, where postsPerWeek=5 against a single Friday window produced
    // posts on four other weekdays at Friday's hour.
    const daySlots = postingDaySlots(windows);
    const requested = Math.min(config.postsPerWeek, MAX_POSTS_PER_CHANNEL_PER_WEEK);
    const target = Math.min(requested, daySlots.length);

    if (target < requested) {
      cappedChannels.push({
        channel: config.channel,
        requested,
        scheduled: target,
        reason: "FEWER_POSTING_DAYS_THAN_TARGET",
      });
    }

    schedulable.push({ ...config, windows, daySlots, target });
  }

  if (schedulable.length === 0) {
    return {
      weekStart: weekStartIso,
      scheduleId: null,
      scheduleStatus: "skipped",
      postsGenerated: 0,
      postsRemaining: 0,
      failures: [],
      mixConfigured: false,
      exhaustedQuotas: [],
      shortfalls: [],
      skippedChannels,
      cappedChannels,
    };
  }

  const schedule = await db.weeklySchedule.upsert({
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
      mixConfigured: false,
      exhaustedQuotas: [],
      shortfalls: [],
      skippedChannels,
      cappedChannels,
    };
  }

  // ── Content mix (v2-8) ────────────────────────────────────────────────────
  // A null result means this company has no mix configured, which is the
  // backward-compatibility path: everything below then behaves exactly as it
  // did before v2-8.
  const [company, sources, existingPosts] = await Promise.all([
    db.company.findUnique({
      where: { id: companyId },
      select: { companyContentPostsPerWeek: true },
    }),
    db.contentSource.findMany({
      where: { companyId },
      select: { id: true, name: true, enabled: true, postsPerWeek: true },
    }),
    // Posts already generated for this schedule, carrying the channel AND source
    // so a run resuming mid-week knows which quota each existing post consumed.
    db.post.findMany({
      where: { scheduleId: schedule.id },
      select: { channel: true, contentSourceId: true },
    }),
  ]);

  const quotas = resolveContentMix({
    sources,
    companyContentPostsPerWeek: company?.companyContentPostsPerWeek ?? null,
  });

  const summary: WeeklyScheduleSummary = {
    weekStart: weekStartIso,
    scheduleId: schedule.id,
    scheduleStatus: "generating",
    postsGenerated: 0,
    postsRemaining: 0,
    failures: [],
    mixConfigured: quotas !== null,
    exhaustedQuotas: [],
    shortfalls: [],
    skippedChannels,
    cappedChannels,
  };

  const budget: RunBudget = { remaining: MAX_GENERATIONS_PER_RUN };

  for (const config of schedulable) {
    const generatedBySource = new Map<string | null, number>();
    for (const row of existingPosts) {
      if (row.channel !== config.channel) continue;
      generatedBySource.set(
        row.contentSourceId,
        (generatedBySource.get(row.contentSourceId) ?? 0) + 1
      );
    }

    const fill: FillContext = {
      companyId,
      scheduleId: schedule.id,
      weekStart,
      config,
      budget,
      summary,
      buildContext,
      generate,
      shouldStop,
    };

    if (quotas === null) {
      await fillChannelPooled(fill, generatedBySource);
    } else {
      await fillChannelFromMix(fill, quotas, generatedBySource);
    }
  }

  if (summary.postsRemaining === 0 && summary.failures.length === 0) {
    await db.weeklySchedule.update({
      where: { id: schedule.id },
      data: { status: "ready", generatedAt: new Date() },
    });
    summary.scheduleStatus = "ready";
  }

  return summary;
}

/**
 * Pre-v2-8 behaviour, preserved verbatim for companies with no content mix: fill
 * the channel's target from the pooled article window, whatever source surfaces.
 * Posts here are written with contentSourceId null, which is correct — they were
 * not drawn against any quota.
 */
async function fillChannelPooled(
  fill: FillContext,
  generatedBySource: ReadonlyMap<string | null, number>
): Promise<void> {
  const { companyId, scheduleId, weekStart, config, budget, summary, buildContext, generate } =
    fill;
  // Decided at the gate: the weekly target already capped at the per-channel
  // ceiling and at the number of days this channel configured.
  const target = config.target;

  let have = 0;
  for (const count of generatedBySource.values()) have += count;

  while (have < target && budget.remaining > 0) {
    // Soft deadline: stop between posts rather than starting another LLM/image generation
    // past the cron time budget. What's unwritten stays "generating" and resumes next run.
    if (fill.shouldStop()) break;

    // No configured day left to put a post on. Unreachable while `have < target`
    // — target IS the day count when days are the binding constraint — and kept
    // as the structural guarantee that a post is never created without one.
    const daySlot = config.daySlots[have];
    if (!daySlot) break;

    const contextResult = await buildContext(companyId, config.channel);
    if (!contextResult.success) {
      summary.failures.push({ channel: config.channel, message: contextResult.code });
      break;
    }

    const result = await generate(contextResult.context, companyId, {
      // null (inherit) → undefined so the context's resolved channel language
      // (which already falls back to the brand default) is used.
      contentLanguage: config.postingLanguage ?? undefined,
      scheduleId,
      scheduledFor: slotFor(weekStart, daySlot),
      initialStatus: "pending_approval",
      // Descriptive only, for the generation trace: the `scheduleId` above
      // already derives `cron`, and this adds how the article window was ordered.
      trace: { trigger: "cron", priority: contextResult.priority },
    });

    if (!result.success) {
      // No unused source articles remain for this channel — a clean skip, not
      // a failure. No LLM call happened, so the run budget is left intact for
      // the other channels.
      if (result.code === "NO_FEED_ITEMS_AVAILABLE") break;

      budget.remaining--; // a real generation attempt consumed an LLM call
      summary.failures.push({
        channel: config.channel,
        message: result.message ?? result.code,
      });
      break; // LLM trouble is unlikely to be channel-specific; stop burning budget
    }

    budget.remaining--;
    have++;
    summary.postsGenerated++;
  }

  summary.postsRemaining += Math.max(0, target - have);
}

/**
 * v2-8 — fills the channel's own weekly target, following the company's recipe
 * for where each post comes from.
 *
 * The target is the channel's `postsPerWeek` (capped), exactly as on the pooled
 * path; `mixForChannel` resizes the stored recipe to it, so a company posting to
 * Facebook 5× and Instagram 7× a week gets 5 and 7 posts, each split along the
 * same proportions. The mix is never the target — a recipe totalling 5 does not
 * hold Instagram to 5.
 *
 * Scaling is deterministic in (recipe, channel target), so a run resuming
 * mid-week re-derives the identical quotas; nothing about the split is
 * persisted.
 *
 * Each iteration asks nextDueQuota which source is due, scopes the generation
 * context to that source alone, and tags the resulting post with the quota it
 * consumed. Three properties matter, and each is load-bearing:
 *
 *   • A post can only consume the quota it was drawn against, because the
 *     context is scoped before generation rather than attributed after it.
 *   • A source that runs dry is marked exhausted and skipped for the rest of the
 *     run; the loop keeps filling the other quotas. Whether its unwritten posts
 *     are dropped or passed to another source is its fallback policy's call, and
 *     the loop needs no branch for it: nextDueQuota already answers in terms of
 *     the post-transfer quotas.
 *   • A quota left unfilled still counts as remaining, so the schedule stays
 *     "generating" and retries next run — by then ingestion may have fetched new
 *     articles. This mirrors what the pooled path already does on a dry pool.
 *
 * Everything below the context (article reservation, Jaccard and semantic
 * duplicate checks, topic memory) is untouched and still runs per post.
 */
async function fillChannelFromMix(
  fill: FillContext,
  mix: readonly MixQuota[],
  existing: ReadonlyMap<string | null, number>
): Promise<void> {
  const { companyId, scheduleId, weekStart, config, budget, summary, buildContext, generate } =
    fill;
  // The channel's week, split along the company's recipe. contentMixTotal of the
  // result is the channel's target — scaleMixToTotal hits the number exactly —
  // except for an all-zero recipe, which has no proportions to apply and
  // correctly yields an empty week rather than an invented split.
  // The channel's target as the gate settled it — its weekly count capped at the
  // per-channel ceiling and at the days it configured — so the recipe is scaled
  // to a week that can actually be placed. Handing mixForChannel the raw
  // postsPerWeek instead would split 5 posts across sources for a channel with
  // one posting day, and four of them would have nowhere to go.
  const quotas = mixForChannel(mix, config.target);
  const target = contentMixTotal(quotas);
  const generatedBySource = new Map(existing);
  const exhausted = new Set<string | null>();

  const totalGenerated = () => {
    let total = 0;
    for (const quota of quotas) total += generatedBySource.get(quota.sourceId) ?? 0;
    return total;
  };

  while (budget.remaining > 0) {
    // Soft deadline: stop between posts rather than starting another LLM/image generation
    // past the cron time budget. What's unwritten stays "generating" and resumes next run.
    if (fill.shouldStop()) break;

    // Defence in depth: mixForChannel already caps the target, so this can only
    // fire on posts a previous run wrote under a higher ceiling.
    if (totalGenerated() >= MAX_POSTS_PER_CHANNEL_PER_WEEK) break;

    const due = nextDueQuota({ quotas, generatedBySource, exhausted });
    if (!due) break; // every quota is filled or exhausted

    // The day this post would go on. Absent once every configured day is taken —
    // which is also where the target ends, so this is the structural guarantee
    // rather than a second rule: no post is created without a day its owner
    // explicitly configured.
    const daySlot = config.daySlots[totalGenerated()];
    if (!daySlot) break;

    const scope: SourceScope =
      due.sourceId === COMPANY_CONTENT_SOURCE_ID
        ? { kind: "company_content" }
        : { kind: "source", sourceId: due.sourceId };

    const contextResult = await buildContext(companyId, config.channel, scope);
    if (!contextResult.success) {
      summary.failures.push({ channel: config.channel, message: contextResult.code });
      break;
    }

    // An empty window for a scoped source means that source is spent. Detecting
    // it here rather than letting generation return NO_FEED_ITEMS_AVAILABLE also
    // closes a real gap: an evergreen source with no items would otherwise reach
    // planFeedItemUsage with no articles and no article sources, be resolved as
    // "mission", and quietly produce a company-content post against an RSS
    // quota. Company content legitimately has an empty window, so it is exempt.
    if (
      due.sourceId !== COMPANY_CONTENT_SOURCE_ID &&
      contextResult.context.feedItems.length === 0
    ) {
      exhausted.add(due.sourceId);
      summary.exhaustedQuotas.push({ channel: config.channel, sourceId: due.sourceId });
      continue;
    }

    const result = await generate(contextResult.context, companyId, {
      // null (inherit) → undefined so the context's resolved channel language
      // (which already falls back to the brand default) is used.
      contentLanguage: config.postingLanguage ?? undefined,
      scheduleId,
      scheduledFor: slotFor(weekStart, daySlot),
      initialStatus: "pending_approval",
      contentSourceId: due.sourceId,
      // Descriptive only, for the generation trace — see the pooled path above.
      trace: { trigger: "cron", priority: contextResult.priority },
    });

    if (!result.success) {
      // Every remaining article for this source was claimed by a concurrent run.
      // No LLM call happened, so the budget is intact — mark the source spent and
      // move to the next quota rather than abandoning the channel.
      if (result.code === "NO_FEED_ITEMS_AVAILABLE") {
        exhausted.add(due.sourceId);
        summary.exhaustedQuotas.push({ channel: config.channel, sourceId: due.sourceId });
        continue;
      }

      budget.remaining--; // a real generation attempt consumed an LLM call
      summary.failures.push({
        channel: config.channel,
        message: result.message ?? result.code,
      });
      break; // LLM trouble is unlikely to be source-specific; stop burning budget
    }

    budget.remaining--;
    generatedBySource.set(due.sourceId, (generatedBySource.get(due.sourceId) ?? 0) + 1);
    summary.postsGenerated++;
  }

  // What the week still owes, measured against the channel's target rather than
  // summed per quota — the same rule the pooled path above uses.
  //
  // Per-quota deficits cannot answer this once a transfer is in play: they clamp
  // at zero, so a recipient that wrote 4 against a quota of 2 reports 0 rather
  // than -2, and the donor's untouched deficit of 2 is then counted as
  // outstanding even though those posts exist. The target is invariant under
  // transfer, so target-minus-written is the honest number.
  //
  // Posts still owed keep the schedule "generating" so a later run retries them,
  // by which time ingestion may have fetched new articles.
  const owed = Math.max(0, target - totalGenerated());
  summary.postsRemaining += owed;

  // Say why the week came up short, rather than leaving an operator to infer it
  // from a number. Owing posts while the budget still had room means nothing was
  // due: every RSS quota was drained and the transfer had no eligible recipient.
  // (Owing posts with the budget spent is just "more runs to come", not a
  // shortfall — the next run continues.)
  if (owed > 0 && budget.remaining > 0 && summary.failures.length === 0) {
    summary.shortfalls.push({
      channel: config.channel,
      posts: owed,
      reason: "NO_ELIGIBLE_SOURCE",
    });
  }
}
