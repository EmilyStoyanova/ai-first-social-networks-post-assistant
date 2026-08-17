/**
 * When an approved post is actually allowed to go out.
 *
 * Publishing is a repeating sweep, and Buffer is called with "share now" —
 * there is no future-dated handoff. So `scheduledFor` is honoured by WHICH sweep
 * picks a post up, and this module is the rule that decides that. How closely a
 * manual time can be honoured therefore follows directly from how often the
 * sweep runs: see PUBLISH_SWEEP_INTERVAL_MS.
 *
 * Two kinds of schedule exist, and they mean different things:
 *
 *   • A CRON schedule (`manuallyScheduled === false`) is the weekly filler's
 *     estimate of a good time. It has always been publishable up to
 *     `PUBLISH_LOOKAHEAD_MS` early, from when the sweep ran daily and could not
 *     hit an arbitrary hour. That behaviour is unchanged here, deliberately: the
 *     automated pipeline's timing is not this module's to renegotiate.
 *
 *   • A MANUAL schedule (`manuallyScheduled === true`) is a person naming a
 *     time — in a bulk run, in the single-post generation form, or from the
 *     post's own card. Publishing that two days early is not an approximation,
 *     it is ignoring the instruction — so those posts wait until they are due.
 *
 * Kept pure and separate from the publisher so every branch is testable without
 * a database or a Buffer client, and so the rule can be read in one place rather
 * than inferred from a Prisma `where`.
 */

/**
 * How early a CRON-scheduled post may be sent. Unchanged from the original
 * publisher: the sweep is daily, so without a look-ahead an automatic post
 * scheduled for any hour other than the tick's would always miss its day.
 */
export const PUBLISH_LOOKAHEAD_MS = 48 * 60 * 60 * 1000;

/**
 * How often the publishing sweep runs.
 *
 * Stated here because the grace below is derived from it and is meaningless
 * without it: a grace shorter than one interval would refuse every manual post
 * ever written, since a post due at 18:30 cannot be seen before the next tick.
 *
 * 30 minutes is the cadence manual scheduling is being built for — it is the
 * finest granularity a person can be promised without Buffer future-dating,
 * because "share now" means the sweep IS the schedule.
 *
 * Keep this in step with whatever actually invokes the sweep. That is an EXTERNAL
 * scheduler calling /api/v1/internal/cron/publish every 30 minutes, not a
 * vercel.json entry: Vercel Hobby crons are daily-only, which is precisely the
 * cadence the grace below rules out. The daily generation tick enqueues the same
 * job as a floor, so a missing external scheduler degrades to the old behaviour
 * rather than to no publishing at all — but it does not satisfy this constant,
 * and manual posts will be parked until the external cadence is in place.
 */
export const PUBLISH_SWEEP_INTERVAL_MS = 30 * 60 * 1000;

/**
 * How late a MANUAL post may still be sent after its own time — 90 minutes.
 *
 * Three sweep intervals, and each one is doing something:
 *
 *   1. the interval itself, since a post due between ticks is always seen late;
 *   2. the tick that a deploy, a cold start or a platform hiccup ate;
 *   3. one more, so a single retry-worthy blip is not the difference between a
 *      post going out and a person having to reschedule it by hand.
 *
 * Beyond that, "late" stops being a rounding error and starts being visible to
 * whoever reads the post: an hour and a half after the slot it is still the same
 * part of the same day, three hours later it may not be. Past the grace,
 * something real went wrong — nobody approved it, the worker was down, the post
 * sat in draft — and the safe move is to publish nothing and let a person choose
 * a new time. See `decidePublish`.
 *
 * DERIVED, not tuned: change the sweep interval and this follows it, which is
 * the only way the two can be kept from drifting apart silently.
 */
export const PAST_DUE_GRACE_MS = 3 * PUBLISH_SWEEP_INTERVAL_MS;

/** The post fields the rule reads. */
export interface PublishCandidate {
  scheduledFor: Date | null;
  /**
   * True iff a PERSON named this post's time — `Post.manuallyScheduled`. Stored
   * on the row rather than derived from `generationBatchId`, which only ever
   * implied it for as long as bulk was the one way to name a time.
   */
  manuallyScheduled: boolean;
}

export type PublishDecision =
  /** Due now (or acceptably close) — send it. */
  | "publish"
  /** Its time has not arrived — leave it approved and look again next sweep. */
  | "not_due"
  /** Its time went by too long ago to fire silently — a person must reschedule. */
  | "past_due";

/**
 * Whether this post may be sent to Buffer at `now`.
 *
 * A post with no `scheduledFor` is never due: it was never given a time, so
 * there is no moment at which it becomes correct to publish it automatically.
 */
export function decidePublish(post: PublishCandidate, now: Date): PublishDecision {
  if (post.scheduledFor === null) return "not_due";

  const due = post.scheduledFor.getTime();
  const nowMs = now.getTime();

  // Automatic posts keep the look-ahead they have always had, including the
  // long-standing behaviour that a late one still goes out.
  if (!post.manuallyScheduled) {
    return due <= nowMs + PUBLISH_LOOKAHEAD_MS ? "publish" : "not_due";
  }

  if (due > nowMs) return "not_due";
  return nowMs - due <= PAST_DUE_GRACE_MS ? "publish" : "past_due";
}

/**
 * Splits candidates into the ones to send and the ones to park as past due.
 * Anything `not_due` is simply dropped — it needs no action at all, and will be
 * reconsidered unchanged on the next sweep.
 */
export function partitionByPublishDecision<T extends PublishCandidate>(
  posts: readonly T[],
  now: Date
): { due: T[]; pastDue: T[] } {
  const due: T[] = [];
  const pastDue: T[] = [];

  for (const post of posts) {
    const decision = decidePublish(post, now);
    if (decision === "publish") due.push(post);
    else if (decision === "past_due") pastDue.push(post);
  }

  return { due, pastDue };
}

/**
 * Whether a PERSON chose this post's publish time, as opposed to the weekly
 * filler estimating one for it.
 *
 * Both halves are required. The flag is what distinguishes a hand-scheduled post
 * from a cron post, and a time is what there is to honour — a flag without one
 * has nothing to wait for and is an ordinary draft.
 *
 * This is the condition under which the two decisions "this is fit to publish"
 * and "publish it now" come apart, so it is what both of the rules that keep them
 * apart are written against: `blocksOnDemandPublish` here, and which drafts
 * `approvePost` will approve without publishing.
 */
export function isManuallyScheduled(
  post: PublishCandidate
): post is PublishCandidate & { scheduledFor: Date; manuallyScheduled: true } {
  return post.manuallyScheduled && post.scheduledFor !== null;
}

/**
 * Whether an ON-DEMAND publish — an owner pressing the button on the card, not a
 * sweep — has to be refused because a person named a later time for this post.
 *
 * This is the guarantee that a manually scheduled post cannot go out early. The
 * sweep already honours `scheduledFor` (see `decidePublish`), but the card's
 * approve-and-publish action bypasses the sweep entirely, so without this a
 * 12:00 post approved at 11:48 was sent at 11:48.
 *
 * Deliberately NOT `decidePublish(...) !== "publish"`, which would be wrong in
 * both directions for a person's own button press:
 *
 *   • A post with no `scheduledFor` is "not_due" forever, yet publishing one on
 *     demand is the normal case — that is what the button has always been for.
 *   • A manual post that is "past_due" must stay hand-publishable. The sweep
 *     refuses to fire it silently and parks it precisely so a person can decide;
 *     blocking them here too would strand it with no way out but a reschedule.
 *
 * So only one case is refused: a manual post whose time is still ahead of us.
 * Automatic posts are untouched and keep publishing on demand as before.
 */
export function blocksOnDemandPublish(post: PublishCandidate, now: Date): boolean {
  return isManuallyScheduled(post) && post.scheduledFor.getTime() > now.getTime();
}

/**
 * The explanation stored on a parked post, and shown on its card.
 *
 * Deterministic for a given `scheduledFor` so the publisher can tell an already
 * parked post from a newly parked one by comparing strings — that is what keeps
 * a repeating sweep from writing the same audit entry on every tick forever.
 */
export function pastDueMessage(scheduledFor: Date): string {
  return (
    `This post was scheduled for ${scheduledFor.toISOString()} and that time has passed. ` +
    `It was not published automatically — pick a new time for it.`
  );
}
