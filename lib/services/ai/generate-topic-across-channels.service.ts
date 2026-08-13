/**
 * One content topic, written once for each selected channel.
 *
 * This is an ORCHESTRATION layer over `generateDraftPost` and deliberately
 * nothing else — the same shape `bulkGeneratePosts` has over the same function.
 * It owns exactly two decisions:
 *
 *   1. which generation establishes the topic, and
 *   2. what every later channel is pinned to.
 *
 * Everything that makes a post good — access control, source resolution, the
 * atomic feed-item reservation, angle/pattern/aspect rotation, Topic Memory, the
 * Jaccard and semantic duplicate gates, language resolution, the frozen origin
 * snapshot, image generation, the source-article image import, embedding,
 * calibration and the audit log — happens inside that one call and is reached
 * here for free, once per channel. None of it is re-implemented or bypassed.
 *
 * ── Why an anchor ───────────────────────────────────────────────────────────
 *
 * "The same topic on three channels" is not something three independent
 * generations produce by coincidence. Left alone they would each claim a
 * DIFFERENT article (the first claim marks its item `usedInPost`, so the next
 * window no longer contains it) and each mine their own angle from it. The group
 * would share an id and nothing else.
 *
 * So the first generation to succeed becomes the ANCHOR, and every channel after
 * it is given two things:
 *
 *   • `pinnedFeedItemId` — write from THIS article. The window for it drops the
 *     `usedInPost` filter, nothing is claimed, and — critically — nothing is
 *     released if the sibling fails, because the claim belongs to the topic.
 *   • `sharedTopic`      — make THIS central claim, in this channel's voice.
 *     Carries mission and evergreen topics too, which have no article to pin but
 *     still have a topic; without it a group of company-content posts would be
 *     three unrelated posts.
 *
 * `FeedItem.usedInPost` therefore keeps its exact meaning — "this article has
 * been consumed as a topic" — claimed once, by the anchor. What changed is only
 * the DB guarantee beside it: uniqueness is now on (primaryFeedItemId, channel),
 * so one article backs one post per channel and same-channel duplication stays
 * impossible.
 *
 * ── Partial groups are a real outcome ───────────────────────────────────────
 *
 * A channel that fails does not fail the topic: the others are already
 * committed, real drafts. Nothing here is transactional and deliberately so —
 * one generation is minutes of LLM, image and upload calls, and holding a
 * database transaction across that would be worse than the problem it solves.
 * Every failure is returned per channel so the API and the UI can say which
 * channels exist and which do not, rather than presenting a group of two as if
 * it were the group of three that was asked for.
 *
 * ── Why the time budget lives here ──────────────────────────────────────────
 *
 * This function is the one place a caller's work MULTIPLIES: "generate a post"
 * used to mean one generation and now means up to four, without the caller
 * having asked for anything different. A synchronous caller runs under a
 * platform function cap, and a run killed by that cap is the worst outcome
 * available — the posts already written are committed while the caller gets a
 * connection reset and never learns their ids.
 *
 * So the loop refuses to START a channel it cannot finish, under the same
 * ambient deadline the bulk service and the cron pipelines use, and reports the
 * channels that never got a turn. Running out of time degrades into the partial
 * group that is already a supported outcome, instead of into a dropped request.
 */

import {
  generateDraftPost,
  type GeneratedPostDTO,
  type GenerateDraftPostFailure,
  type GenerationWarnings,
} from "./generate-draft-post.service";
import { remainingBudgetMs } from "@/lib/http/request-deadline";
import type { ManualContentSourceRef } from "@/lib/ai/manual-content-source";

/**
 * FLOOR for the time that must remain before ANOTHER channel is started.
 *
 * A floor, not the threshold itself — the threshold is measured (see
 * `observedChannelMs` in the loop). This value only covers the case where there
 * is no measurement worth trusting yet, such as a first channel that failed in
 * seconds.
 *
 * It is deliberately no longer used as the whole answer. A fixed 45s rested on
 * the assumption a channel "fits in well under a minute", and that assumption is
 * how a post lost its image: a channel admitted with 82s left spent 86s in the
 * LLM alone, after which every image call took its AbortSignal from a budget of
 * zero and was aborted the instant it was made. The post was written, committed,
 * and left permanently without an image — on a channel whose `imageRequired` is
 * true, so it could not even be published. Silently, because image generation is
 * best-effort by design and has nowhere to report to.
 *
 * The FIRST channel attempted is never gated — a request must never be told "no
 * time" without a single try.
 */
export const MIN_CHANNEL_BUDGET_MS = 45_000;

/**
 * The topic itself, once some channel has settled it.
 *
 * Persisted by the bulk job into its progress record, so a retry that resumes a
 * half-written group continues the SAME topic instead of starting a new one for
 * the channels that are still missing.
 */
export interface TopicAnchor {
  /** The article the topic claimed. Null for a mission/evergreen topic. */
  primaryFeedItemId: string | null;
  /** The central claim every sibling channel must adapt. */
  coreMessage: string;
  /** Its normalized topic, when the anchoring generation declared one. */
  topic: string | null;
  /** The channel that settled it — named in the sibling prompt so it reads concretely. */
  establishedBy: string;
}

export interface TopicChannelPost {
  channel: string;
  postId: string;
  scheduledFor: Date | null;
  /**
   * The generated post itself, and what the gates flagged about it.
   *
   * Carried so a SYNCHRONOUS caller — the single-post route, which writes one
   * topic across the selected channels and answers with them — can hand the
   * client finished cards with no follow-up read. The bulk path ignores both: it
   * records ids into a job summary that crosses a process boundary, and putting
   * whole posts in there would bloat every progress write for a reader that only
   * ever wanted the id.
   */
  post: GeneratedPostDTO;
  warnings: GenerationWarnings;
}

/**
 * A channel that produced nothing — the generator's OWN failure, verbatim, plus
 * which channel it was.
 *
 * Extending `GenerateDraftPostFailure` rather than restating two of its fields
 * is the point. A failure carries diagnostics that only it knows — `reason` and
 * `attempts` for a uniqueness abort, `retryAfterMs` for a rate limit — and those
 * are exactly what the API turns into a 409 body or a `retry-after` header. An
 * orchestration layer that rebuilt a smaller object here would silently downgrade
 * every one of those answers, and would do it again for any field added later.
 * So the failure is spread through whole and this type only widens it.
 */
export interface TopicChannelFailure extends GenerateDraftPostFailure {
  channel: string;
  /**
   * Always present here, unlike on the failure it extends: a channel that failed
   * inside a group has to be explainable on its own, so a generator that gave no
   * wording gets `defaultFailureMessage`'s. English — the UI translates `code`.
   */
  message: string;
}

export interface TopicGenerationOutcome {
  contentGroupId: string;
  /**
   * The company these posts belong to, or null when nothing was written.
   *
   * Read from the first successful generation, which has already resolved the
   * company — never looked up again. The caller needs it to write batch-level
   * records against the same company the posts landed in, and a second query
   * would be a chance for the two to disagree.
   */
  companyId: string | null;
  /** One entry per channel that produced a post, in the order they were written. */
  posts: TopicChannelPost[];
  /** One entry per channel that was attempted and produced nothing. */
  failures: TopicChannelFailure[];
  /**
   * Channels never attempted, because the ambient request deadline ran out
   * before there was time to write them.
   *
   * Distinct from `failures` on purpose: nothing was tried, so there is no
   * generator error to report and no diagnostic to attach — the honest answer is
   * "this one did not get a turn". A caller shows them beside the failures (both
   * mean "this channel has no post"), but it must not present them as a
   * generation that went wrong, and a retry of just these is worth offering.
   *
   * Always empty outside a request deadline, which is every path that has all
   * the time it needs — the worker, and the tests.
   */
  notAttempted: string[];
  /**
   * The topic this group settled on, or null when no channel got far enough to
   * settle one (every channel failed, or the group was already complete). Worth
   * persisting: it is what a later attempt resumes from.
   */
  anchor: TopicAnchor | null;
}

export interface GenerateTopicInput {
  slug: string;
  userId: string;
  isGlobalAdmin: boolean;
  /** Minted by the caller so it is stable across retries of the same topic. */
  contentGroupId: string;
  /** Channels to write, in the order they should be attempted. */
  channels: readonly string[];
  /**
   * Per-channel publish slot, keyed by channel.
   *
   * Per CHANNEL rather than per topic because each channel's posting windows
   * decide its own times — a topic's LinkedIn version at 09:00 and its Instagram
   * version at 18:00 is the intended outcome, not a discrepancy. A channel
   * absent from the map is written as an unscheduled draft, which is what the
   * single-post flow does for all of them.
   */
  scheduledFor?: Readonly<Record<string, Date>>;
  generationBatchId?: string;
  /** The form's "Content source" choice, applied to the ANCHOR generation. */
  contentSource?: ManualContentSourceRef;
  /**
   * The content-mix quota this whole topic is drawn against. Passed to every
   * channel so a group consumes ONE quota, not one per channel.
   */
  contentSourceId?: string | null;
  contentLanguage?: string;
  includeSourceLinkOverride?: boolean;
  autoGenerateImageOverride?: boolean;
  llmConfigId?: string;
  /**
   * A topic this group already settled on in an earlier attempt. Present only on
   * a resumed run; the channels below are then all siblings, and no generation
   * re-decides what the topic is.
   */
  anchor?: TopicAnchor | null;
  /**
   * Channels an earlier attempt already committed. Skipped outright — not
   * regenerated, not reported as failures, and not counted as posts, because
   * they exist and this run did not write them.
   */
  alreadyGenerated?: readonly string[];
}

export interface GenerateTopicDeps {
  /** The single-post pipeline. Injected in tests; never re-implemented. */
  generate?: typeof generateDraftPost;
  /** Called after each channel commits, so a long group reports as it goes. */
  onChannelComplete?: (outcome: TopicGenerationOutcome) => Promise<void>;
  /** Overrides the `MIN_CHANNEL_BUDGET_MS` floor for one run (tests). */
  minChannelBudgetMs?: number;
  /** Reads the ambient deadline. Injected so the budget can be tested without waiting. */
  remainingBudgetMs?: () => number;
  /**
   * Wall clock, used only to measure how long a channel took. Injected so the
   * self-calibrating gate can be tested without actually spending minutes.
   */
  now?: () => number;
}

/**
 * Writes one topic across the given channels.
 *
 * Sequential by requirement, not by oversight: the anchor has to exist before a
 * sibling can be pinned to it, and the per-channel duplicate gates each measure
 * a candidate against what is already committed.
 *
 * Never throws for a per-channel failure — those are data. It can still throw
 * for a genuine fault (the database being unreachable), which the caller's own
 * error handling owns.
 */
export async function generateTopicAcrossChannels(
  input: GenerateTopicInput,
  deps: GenerateTopicDeps = {}
): Promise<TopicGenerationOutcome> {
  const generate = deps.generate ?? generateDraftPost;
  const budgetLeft = deps.remainingBudgetMs ?? remainingBudgetMs;
  const minChannelBudgetMs = deps.minChannelBudgetMs ?? MIN_CHANNEL_BUDGET_MS;
  const now = deps.now ?? Date.now;
  const done = new Set(input.alreadyGenerated ?? []);

  const outcome: TopicGenerationOutcome = {
    contentGroupId: input.contentGroupId,
    companyId: null,
    posts: [],
    failures: [],
    notAttempted: [],
    anchor: input.anchor ?? null,
  };

  // Whether THIS call has started a generation yet. Not the same as
  // "outcome.posts is non-empty": a first channel that failed has still had its
  // turn, and a second channel must not be gated on the budget as if it were the
  // first. Not the same as the loop index either, because `done` channels are
  // skipped without being attempted.
  let attemptedAny = false;

  /**
   * The longest a channel of THIS topic has actually taken, in ms.
   *
   * The gate below is calibrated from this rather than from a constant, because
   * a constant cannot know what a channel costs here: the same generation is a
   * few seconds against a hosted LLM with images off, and around two and a half
   * minutes against a self-hosted image worker. A guess that is too small does
   * not merely mistime the run — it admits a channel that then cannot finish,
   * and the part that gets dropped is the image, silently.
   *
   * The maximum rather than the most recent: one fast channel does not make the
   * next one cheap, and the question being asked is "could a channel like the
   * ones I have seen still fit", where the expensive one is the honest answer.
   *
   * Includes channels that FAILED. A failure that took two minutes of LLM
   * retries is evidence about cost just as much as a success is.
   */
  let observedChannelMs = 0;

  for (const channel of input.channels) {
    // Committed by an earlier attempt. Regenerating it would write a second post
    // for a channel that already has one — which the (article, channel) unique
    // index would refuse anyway, but as a crash rather than as a skip.
    if (done.has(channel)) continue;

    // Out of time. Everything already written is committed and returned; the
    // channels that never got a turn are named, so the caller answers with a
    // partial group instead of being killed mid-generation by its own function
    // cap — which is the outcome that loses posts, because they ARE written and
    // the caller never learns their ids.
    //
    // Enough time to FINISH a channel, not merely to begin one. That distinction
    // is the whole bug this guards: a channel started with less than it costs
    // still writes its post — the LLM call comes first and gets what is left —
    // and then every image call derives its AbortSignal from a budget of zero
    // and is aborted the moment it is made. The result is a committed draft with
    // an image prompt and no image, which on an `imageRequired` channel cannot
    // even be published, and which no error is reported for because image
    // generation is best-effort. Not starting the channel at all is the strictly
    // better outcome: it is honest, it is reported, and it can be retried.
    //
    // No deadline installed means `remainingBudgetMs()` is +Infinity, so this is
    // inert on every path that has all the time it needs.
    if (attemptedAny && budgetLeft() < Math.max(observedChannelMs, minChannelBudgetMs)) {
      outcome.notAttempted.push(channel);
      continue;
    }
    attemptedAny = true;

    const startedAt = now();
    const anchor = outcome.anchor;

    const result = await generate(input.slug, channel, input.userId, input.isGlobalAdmin, {
      contentLanguage: input.contentLanguage,
      includeSourceLinkOverride: input.includeSourceLinkOverride,
      autoGenerateImageOverride: input.autoGenerateImageOverride,
      llmConfigId: input.llmConfigId,
      scheduledFor: input.scheduledFor?.[channel],
      generationBatchId: input.generationBatchId,
      contentGroupId: input.contentGroupId,
      contentSourceId: input.contentSourceId,
      // Without an anchor this is the generation that DECIDES the topic, so it
      // resolves the source exactly as a single-channel generation would.
      //
      // With one, the source question is already answered: an article-backed
      // topic pins the article outright, and a mission/evergreen topic re-uses
      // the same pick, whose window is deterministic — the same scope yields the
      // same item.
      ...(anchor === null
        ? { contentSource: input.contentSource }
        : {
            ...(anchor.primaryFeedItemId
              ? { pinnedFeedItemId: anchor.primaryFeedItemId }
              : { contentSource: input.contentSource }),
            sharedTopic: {
              coreMessage: anchor.coreMessage,
              topic: anchor.topic,
              establishedBy: anchor.establishedBy,
            },
          }),
    });

    // Recorded before the success branch so a failed channel counts too, and
    // before `continue` can skip it.
    observedChannelMs = Math.max(observedChannelMs, now() - startedAt);

    if (!result.success) {
      // Spread, so every diagnostic the generator attached travels intact —
      // `reason`/`attempts` on a uniqueness abort, `retryAfterMs` on a rate
      // limit — and so a field added to the failure type later needs no change
      // here to keep reaching the API.
      outcome.failures.push({
        ...result,
        channel,
        message: result.message ?? defaultFailureMessage(result),
      });
      // Deliberately continue rather than abandon the topic. The remaining
      // channels are independent generations; one channel's provider hiccup or
      // near-duplicate is no reason to deny the others a post. If this was the
      // anchoring attempt, the next channel simply becomes the anchor.
      continue;
    }

    outcome.posts.push({
      channel,
      postId: result.post.id,
      scheduledFor: result.post.scheduledFor,
      post: result.post,
      warnings: result.warnings,
    });

    // Every channel of a group resolves the same company — this is the first one
    // to have proved it, so it is taken once and not asked for again.
    outcome.companyId ??= result.post.companyId;

    // The first success settles the topic for everyone after it.
    if (outcome.anchor === null) {
      outcome.anchor = {
        primaryFeedItemId: result.post.primaryFeedItemId,
        coreMessage: result.post.coreMessage,
        topic: result.post.topic,
        establishedBy: channel,
      };
    }

    // Reported after each channel so a caller persisting progress records the
    // anchor as soon as it exists — which is what makes a retry resume THIS
    // topic rather than invent a new one for the channels still missing.
    await deps.onChannelComplete?.(outcome);
  }

  return outcome;
}

/** A readable English fallback for a failure the generator did not phrase. */
function defaultFailureMessage(failure: GenerateDraftPostFailure): string {
  switch (failure.code) {
    case "CANNOT_GENERATE_UNIQUE_POST":
      return "Could not write a sufficiently different post for this channel.";
    case "NO_FEED_ITEMS_AVAILABLE":
    case "SELECTED_SOURCE_UNAVAILABLE":
      return "There was nothing left to write from for this channel.";
    case "POST_TOO_LONG_WITH_URL":
      return "The post plus its source link exceeded this channel's character limit.";
    default:
      return "This channel's post could not be generated.";
  }
}
