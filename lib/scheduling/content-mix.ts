/**
 * Content mix — generation distribution (v2-8).
 *
 * Lets an owner say exactly where next week's posts come from:
 *
 *   Weekly target: 5
 *     RSS A ............ 3
 *     RSS B ............ 1
 *     Company content .. 1
 *
 * The mix is a single company-wide *recipe* that is applied to every enabled
 * channel (the "one shared recipe" model): each enabled channel fills its weekly
 * budget following the same distribution. That is why every enabled channel must
 * share the same `postsPerWeek` — the recipe has one total, so it cannot satisfy
 * two different channel budgets at once.
 *
 * Two invariants drive every function here:
 *
 *   • The week hits its total. A source that runs out of articles hands its
 *     unwritten posts to the sources that can still write them — always, with no
 *     setting to opt out of. See transferExhaustedQuotas. Only when no source can
 *     take them do the posts go unwritten.
 *   • An unconfigured mix is not a mix. When nothing is configured the scheduler
 *     falls back to the pre-v2-8 pooling behaviour, unchanged.
 *
 * Everything in this module is pure — no Prisma, no I/O — so the scheduler's
 * distribution logic is unit-testable without a database.
 */

/**
 * The company-generated-content quota (mission/brand posts written without any
 * RSS article) is modelled as a quota whose source id is null. Named so call
 * sites read as intent rather than as a bare null check.
 */
export const COMPANY_CONTENT_SOURCE_ID = null;

/**
 * Hard per-channel weekly ceiling, as a cost guard. Pre-v2-8 the scheduler
 * applied this silently (`Math.min(postsPerWeek, 7)`), which a mix cannot do:
 * capping a 10-post distribution at 7 would have to drop 3 posts from *someone's*
 * quota, and choosing whose is exactly the silent reassignment this feature
 * exists to prevent. So a mix must fit under the ceiling, and validation says so
 * out loud (MIX_EXCEEDS_MAX) instead of truncating.
 *
 * Lives here rather than in the scheduler because it is a rule about the
 * distribution; the scheduler imports it for the legacy path too.
 */
export const MAX_POSTS_PER_CHANNEL_PER_WEEK = 7;

/**
 * A content source as the mix sees it.
 *
 * The `content_sources.fallback_policy` column is deliberately absent: quota
 * transfer is unconditional, so nothing here reads it. The column survives in
 * the database for backwards compatibility only and must not resurface in any
 * type, DTO, or query.
 */
export interface MixSourceInput {
  id: string;
  name: string;
  enabled: boolean;
  /** null = no quota assigned; see resolveContentMix. */
  postsPerWeek: number | null;
}

/** One resolved quota: "this source owes N posts per week per channel". */
export interface MixQuota {
  /** null = company-generated content (no RSS). */
  sourceId: string | null;
  postsPerWeek: number;
}

export interface ResolveContentMixInput {
  sources: readonly MixSourceInput[];
  companyContentPostsPerWeek: number | null;
}

/**
 * Builds the quota list from stored config, or returns null when no quota has
 * been configured at all.
 *
 * A null result is the backward-compatibility signal: the company predates v2-8
 * (or has deliberately cleared its mix), so the caller must use the legacy
 * pooled-source behaviour. This is what makes "default behaviour matches the
 * current implementation until users configure quotas" true by construction.
 *
 * Disabled sources are excluded entirely — a disabled source generates nothing,
 * so a stale quota on one must not distort the mix. An *enabled* source with a
 * null quota contributes 0 and is never generated from; that is a
 * partially-configured mix, which validateContentMix rejects at save time (see
 * MIX_SOURCE_UNASSIGNED). It can still be reached at generation time when a
 * source is added after the mix was saved, and resolving it to 0 keeps the
 * scheduler deterministic instead of silently re-pooling.
 */
export function resolveContentMix(input: ResolveContentMixInput): MixQuota[] | null {
  const enabled = input.sources.filter((s) => s.enabled);
  const configured =
    input.companyContentPostsPerWeek !== null || enabled.some((s) => s.postsPerWeek !== null);
  if (!configured) return null;

  const quotas: MixQuota[] = enabled.map((s) => ({
    sourceId: s.id,
    postsPerWeek: s.postsPerWeek ?? 0,
  }));

  if (input.companyContentPostsPerWeek !== null) {
    quotas.push({
      sourceId: COMPANY_CONTENT_SOURCE_ID,
      postsPerWeek: input.companyContentPostsPerWeek,
    });
  }

  return quotas;
}

/** Total posts per channel per week the mix accounts for. */
export function contentMixTotal(quotas: readonly MixQuota[]): number {
  return quotas.reduce((sum, q) => sum + q.postsPerWeek, 0);
}

export type MixValidationCode =
  /** Quotas do not add up to the weekly target. */
  | "MIX_TOTAL_MISMATCH"
  /** An enabled source has no quota while the rest of the mix is configured. */
  | "MIX_SOURCE_UNASSIGNED"
  /** Enabled channels disagree on postsPerWeek, so one recipe cannot serve them all. */
  | "MIX_CHANNEL_TARGETS_DIFFER"
  /** A quota is negative or not a whole number. */
  | "MIX_INVALID_VALUE"
  /** The mix totals more than a channel may generate in a week. */
  | "MIX_EXCEEDS_MAX";

export interface MixValidationError {
  code: MixValidationCode;
  /** English, for logs and API consumers. The UI localizes off `code`. */
  message: string;
}

export type MixValidationResult = { valid: true } | { valid: false; error: MixValidationError };

export interface ValidateContentMixInput extends ResolveContentMixInput {
  /** Enabled channels only, with their weekly budget. */
  channelTargets: ReadonlyArray<{ channel: string; postsPerWeek: number }>;
}

/**
 * Validates a whole mix at once.
 *
 * Whole-mix validation is deliberate: quotas are only ever meaningful together.
 * Editing one source's quota in isolation would have to pass through an invalid
 * intermediate total (3→2 breaks the sum before the compensating edit lands), so
 * there is no per-field save path — the UI and the API both submit the complete
 * distribution.
 *
 * An unconfigured mix is always valid (it means "use legacy pooling"). A mix
 * with no enabled channels is also valid: there is no target to compare against
 * yet, and configuring the mix before turning a channel on is legitimate.
 */
export function validateContentMix(input: ValidateContentMixInput): MixValidationResult {
  const quotas = resolveContentMix(input);
  if (quotas === null) return { valid: true };

  const enabledSources = input.sources.filter((s) => s.enabled);

  const unassigned = enabledSources.find((s) => s.postsPerWeek === null);
  if (unassigned) {
    return {
      valid: false,
      error: {
        code: "MIX_SOURCE_UNASSIGNED",
        message: `Source "${unassigned.name}" has no posts-per-week value. Every enabled source needs one once a content mix is configured.`,
      },
    };
  }

  for (const quota of quotas) {
    if (!Number.isInteger(quota.postsPerWeek) || quota.postsPerWeek < 0) {
      return {
        valid: false,
        error: {
          code: "MIX_INVALID_VALUE",
          message: "Posts per week must be a whole number of zero or more.",
        },
      };
    }
  }

  const total = contentMixTotal(quotas);
  if (total > MAX_POSTS_PER_CHANNEL_PER_WEEK) {
    return {
      valid: false,
      error: {
        code: "MIX_EXCEEDS_MAX",
        message: `Content mix totals ${total} posts but a channel can generate at most ${MAX_POSTS_PER_CHANNEL_PER_WEEK} per week.`,
      },
    };
  }

  if (input.channelTargets.length === 0) return { valid: true };

  const targets = [...new Set(input.channelTargets.map((c) => c.postsPerWeek))];
  if (targets.length > 1) {
    const detail = input.channelTargets.map((c) => `${c.channel}=${c.postsPerWeek}`).join(", ");
    return {
      valid: false,
      error: {
        code: "MIX_CHANNEL_TARGETS_DIFFER",
        message: `A content mix is one recipe shared by every enabled channel, so all enabled channels must have the same posts-per-week. Got: ${detail}.`,
      },
    };
  }

  const target = targets[0];
  if (total !== target) {
    return {
      valid: false,
      error: {
        code: "MIX_TOTAL_MISMATCH",
        message: `Content mix totals ${total} posts but the weekly target is ${target}.`,
      },
    };
  }

  return { valid: true };
}

/**
 * The weekly target a validated mix implies, or null when it is unconfigured.
 * Once a mix exists it IS the budget — see nextDueQuota.
 */
export function contentMixTarget(input: ResolveContentMixInput): number | null {
  const quotas = resolveContentMix(input);
  return quotas === null ? null : contentMixTotal(quotas);
}

export interface NextDueQuotaInput {
  quotas: readonly MixQuota[];
  /** Posts already generated this week for this channel, keyed by source id (null = company content). */
  generatedBySource: ReadonlyMap<string | null, number>;
  /** Sources that ran out of eligible articles during this run. */
  exhausted: ReadonlySet<string | null>;
}

/** Company content is not an RSS quota, and only RSS quotas trade posts. */
function isRssQuota(quota: MixQuota): boolean {
  return quota.sourceId !== COMPANY_CONTENT_SOURCE_ID;
}

/** An exhausted RSS source: its unwritten posts go to whoever can write them. */
function donatesQuota(quota: MixQuota, exhausted: ReadonlySet<string | null>): boolean {
  return isRssQuota(quota) && exhausted.has(quota.sourceId);
}

/**
 * An RSS source that can absorb transferred posts: still has articles this run,
 * and was given a quota of its own.
 *
 * A quota of 0 is a deliberate "generate nothing from this source", so it is not
 * a recipient — a zero means the same thing whether it was typed as 0 or left
 * unset (resolveContentMix maps both to 0), and overriding it would publish from
 * a feed the owner switched off in all but name. Disabled sources cannot appear
 * here at all: resolveContentMix drops them before a quota exists.
 */
function acceptsQuota(quota: MixQuota, exhausted: ReadonlySet<string | null>): boolean {
  return isRssQuota(quota) && !exhausted.has(quota.sourceId) && quota.postsPerWeek > 0;
}

/**
 * The quotas as they stand once exhausted sources have handed off their unfilled
 * posts.
 *
 * The week's total is the promise this keeps: an RSS source that runs dry gives
 * up exactly the posts it could not write, and those same posts are added to the
 * sources that still have articles. Nothing is created and nothing is lost, so
 * the mix total — and therefore the channel's weekly post count — is identical
 * before and after. What changes is only *who* writes them.
 *
 * This is unconditional. It was briefly a per-source setting; the product
 * decision is that a company configuring "5 posts a week" wants 5 posts a week,
 * and which feed had articles left on a given Tuesday is not something an owner
 * should have to have an opinion about.
 *
 * Deliberately excluded:
 *
 *   • Company content, as donor and as recipient. Mission posts do not run out
 *     (they need no article), and a feed's shortfall must not quietly turn into
 *     more brand copy than the owner asked for.
 *   • Sources that are themselves exhausted — handing posts to a source with no
 *     articles just moves the shortfall.
 *
 * A pool with no eligible recipient is left exactly where it is: the donor keeps
 * its unfilled quota, so the posts stay outstanding and the next run retries them
 * once ingestion has fetched new articles. The scheduler reports that outcome as
 * NO_ELIGIBLE_SOURCE rather than letting the week quietly come up short.
 *
 * Recomputed from the stored quotas on every call rather than accumulated, so it
 * stays a pure function of (quotas, generated, exhausted). That is what lets a
 * cron run resume mid-week — the transfer is re-derived, never remembered — and
 * what makes a recipient that later runs dry itself donate in turn.
 */
export function transferExhaustedQuotas(input: NextDueQuotaInput): MixQuota[] {
  const { quotas, generatedBySource, exhausted } = input;
  const generatedFor = (quota: MixQuota) => generatedBySource.get(quota.sourceId) ?? 0;
  const unfilled = (quota: MixQuota) => quota.postsPerWeek - generatedFor(quota);

  const donorIds = new Set(
    quotas.filter((q) => donatesQuota(q, exhausted) && unfilled(q) > 0).map((q) => q.sourceId)
  );
  if (donorIds.size === 0) return quotas.map((q) => ({ ...q }));

  const recipients = quotas.filter((q) => acceptsQuota(q, exhausted));
  if (recipients.length === 0) return quotas.map((q) => ({ ...q }));

  const pool = quotas
    .filter((q) => donorIds.has(q.sourceId))
    .reduce((sum, q) => sum + unfilled(q), 0);

  // Even split, with the indivisible remainder going to the earliest recipients
  // in list order. Fairness here means equal shares, not shares proportional to
  // quota: the point is to spread the extra load, and a proportional split would
  // pile it onto whichever feed is already the busiest. List order comes from the
  // stored source order, so the outcome is reproducible across runs.
  const evenShare = Math.floor(pool / recipients.length);
  const remainder = pool % recipients.length;
  const bonusByRecipient = new Map(
    recipients.map((q, index) => [q.sourceId, evenShare + (index < remainder ? 1 : 0)])
  );

  return quotas.map((quota) => {
    // A donor keeps exactly what it managed to write, so its remaining is zero
    // and the posts it gave up are not counted twice.
    if (donorIds.has(quota.sourceId)) return { ...quota, postsPerWeek: generatedFor(quota) };
    const bonus = bonusByRecipient.get(quota.sourceId);
    if (bonus === undefined) return { ...quota };
    return { ...quota, postsPerWeek: quota.postsPerWeek + bonus };
  });
}

/**
 * Answers "which source is due next" — the scheduler's only source decision.
 *
 * Runs against the post-transfer quotas, so a handoff shows up here as the
 * recipient simply having a larger quota to work through.
 *
 * Picks the quota with the largest *fraction* of its own quota still outstanding,
 * not the largest absolute deficit. Ranking by absolute deficit would drain the
 * biggest source first (3/1/1 → A,A,A,B,C, i.e. one feed all of Mon–Wed);
 * ranking by fraction spreads the sources across the week (3/1/1 → A,B,C,A,A)
 * while producing exactly the same totals. Slot times come from the post's index
 * within the channel (see slotFor), so this ordering is what the reader actually
 * sees day to day.
 *
 * Ties break on the quota's position in the list, so the order is stable and a
 * run is reproducible — important because a 5-post week always spans several
 * cron runs (3 LLM calls per run) and must resume coherently.
 *
 * Returns null when every quota is either filled or exhausted. An exhausted
 * quota is always skipped; where its unwritten posts went was already settled by
 * transferExhaustedQuotas.
 */
export function nextDueQuota(input: NextDueQuotaInput): MixQuota | null {
  let best: MixQuota | null = null;
  let bestShare = 0;

  for (const quota of transferExhaustedQuotas(input)) {
    if (input.exhausted.has(quota.sourceId)) continue;
    if (quota.postsPerWeek <= 0) continue;
    const remaining = quota.postsPerWeek - (input.generatedBySource.get(quota.sourceId) ?? 0);
    if (remaining <= 0) continue;
    const share = remaining / quota.postsPerWeek;
    // Strictly greater keeps the first quota in list order on a tie.
    if (share > bestShare) {
      best = quota;
      bestShare = share;
    }
  }

  return best;
}

/**
 * The mix as it WOULD be after applying a submitted set of quotas.
 *
 * A request only carries the sources the client knew about, so anything it omits
 * must keep its stored quota rather than being cleared — otherwise a client with
 * a stale source list would silently wipe a quota it never displayed. Validation
 * then runs against this projection, so what is checked is exactly what is saved.
 */
export function projectMixSources(
  existing: readonly MixSourceInput[],
  submitted: ReadonlyMap<string, number | null>
): MixSourceInput[] {
  return existing.map((source) =>
    submitted.has(source.id)
      ? { ...source, postsPerWeek: submitted.get(source.id) ?? null }
      : source
  );
}

/**
 * The first submitted id that is not one of this company's sources, or null.
 * Unknown ids are rejected rather than ignored: silently dropping one would save
 * a distribution the user did not ask for.
 */
export function findUnknownSourceId(
  existing: readonly MixSourceInput[],
  submittedIds: readonly string[]
): string | null {
  const known = new Set(existing.map((s) => s.id));
  return submittedIds.find((id) => !known.has(id)) ?? null;
}

/**
 * Remaining posts per quota, for the UI and for run summaries.
 *
 * Measured against the post-transfer quotas so the totals tell the truth about
 * the week: a source that donated its shortfall is not still owed those posts,
 * and the recipient that took them on is. Pass the run's real `exhausted` set —
 * an empty one asks "what is outstanding if nothing ran dry", which is a
 * different question and will over-report.
 */
export function remainingByQuota(
  input: NextDueQuotaInput
): Array<{ sourceId: string | null; remaining: number }> {
  return transferExhaustedQuotas(input).map((q) => ({
    sourceId: q.sourceId,
    remaining: Math.max(0, q.postsPerWeek - (input.generatedBySource.get(q.sourceId) ?? 0)),
  }));
}
