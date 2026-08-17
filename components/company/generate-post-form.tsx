"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useApiErrorMessage } from "@/lib/i18n/api-error";
import { readJsonResponse } from "@/lib/http/read-json-response";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import type { PostItem } from "@/lib/services/company/list-posts.service";
import type { GenerationWarnings } from "@/lib/services/ai/generate-draft-post.service";
import type { GenerationSourceOption } from "@/lib/services/company/list-generation-sources.service";
import type { GenerationChannelOption } from "@/lib/posts/generation-channels";
import { COMPANY_MISSION_VALUE, COMPANY_RULES_VALUE } from "@/lib/ai/manual-content-source";
import { BulkGenerateFields, type BulkPlanState } from "./bulk-generate-fields";
import { BatchContentMixFields } from "./batch-content-mix-fields";
import { BulkResultSummary } from "./bulk-result-summary";
import { BulkJobProgress } from "./bulk-job-progress";
import { TopicJobProgress } from "./topic-job-progress";
import { ChannelMultiSelect } from "./channel-multi-select";
import {
  batchMixTotal,
  defaultBatchMix,
  defaultBulkRange,
  toCustomDistribution,
  toSourceMixPayload,
  type BulkBatchResponse,
} from "@/lib/posts/bulk-form";
import type { ContentMixDTO } from "@/lib/services/company/get-content-mix.service";
import {
  BULK_FORM_ANCHOR,
  clearActiveBulkJob,
  clearBulkDraft,
  readActiveBulkJob,
  saveActiveBulkJob,
  saveBulkDraft,
  stillAvailable,
  takeBulkDraft,
  clearActiveTopicJob,
  readActiveTopicJob,
  saveActiveTopicJob,
  type ActiveBulkJob,
  type ActiveTopicJobRef,
} from "@/lib/posts/bulk-draft";
import {
  channelGaps,
  hasNoPosts,
  newTopicPosts,
  type TopicJobFailure,
  // Aliased: `TopicJobProgress` is also the name of the panel component imported
  // above, and the two are different things.
  type TopicJobProgress as TopicJobProgressReport,
  type TopicJobPhase,
  type TopicJobStatus,
} from "@/lib/posts/topic-job";
import {
  CHANNEL_ORDER,
  channelLabel,
  normalizeChannelSelection,
  toChannelPayload,
} from "@/lib/posts/channel-selection";
import {
  bulkPollIntervalMs,
  committedPostCount,
  isTerminalBulkJobPhase,
  resolveBulkJobPhase,
  toBulkBatchResponse,
  type BulkJobPhase,
  type BulkJobStatus,
} from "@/lib/posts/bulk-job";
import {
  MAX_BULK_POSTS,
  isStartDateInPast,
  planBulkSlots,
  planCustomSlots,
  validateCustomDistribution,
} from "@/lib/scheduling/bulk-schedule";
import { appZoneToday, fromAppDateTimeLocal } from "@/lib/scheduling/app-datetime-local";
import { refuseScheduleTime } from "@/lib/scheduling/reschedule-policy";
import { SLOT_MINUTES } from "@/lib/scheduling/time-slots";
import { TimeSlotSelect } from "@/components/ui/TimeSlotSelect";
import { APP_TIME_ZONE } from "@/lib/i18n/format-date";

/** Three-state override: inherit the source/channel setting, or force on/off. */
type SourceLinkOverride = "inherit" | "include" | "exclude";

/** Three-state image override: inherit the channel setting, or force on/off. */
type ImageOverride = "inherit" | "generate" | "skip";

/** A selectable LLM returned by GET /companies/[slug]/available-llms (v2-5). */
interface AvailableLlm {
  id: string;
  displayName: string;
  provider: string;
  model: string;
  isDefault: boolean;
  /** The user's saved preference — preselected in the dropdown (v2-6). */
  isPreferred: boolean;
}

/** Diagnostics the generate API attaches to a CANNOT_GENERATE_UNIQUE_POST error. */
interface GenerateApiError {
  code?: string;
  message?: string;
  reason?: "jaccard_duplicate" | "semantic_duplicate" | "topic_repeated";
  attempts?: number;
}

/** Maps the abort reason to its reason-specific translation key. */
const UNIQUE_ERROR_KEY: Record<NonNullable<GenerateApiError["reason"]>, string> = {
  topic_repeated: "uniqueErrorTopicRepeated",
  semantic_duplicate: "uniqueErrorSemanticDuplicate",
  jaccard_duplicate: "uniqueErrorJaccardDuplicate",
};

/**
 * A failure recorded by a queued run, in the shape the inline error mapper reads.
 *
 * The two describe the same thing — the generator's own failure — but arrive
 * through different readers: an inline error is parsed against this union, while
 * a job's progress is parsed leniently on purpose, so that a worker running a
 * newer deploy cannot make an older reader throw. Narrowing here rather than
 * widening `GenerateApiError` keeps that leniency at the boundary: an unknown
 * `reason` becomes "no specific reason" and falls through to the generic
 * wording, which is exactly what the mapper already does for a missing one.
 */
function toGenerateApiError(failure: TopicJobFailure | undefined): GenerateApiError | undefined {
  if (!failure) return undefined;
  const reason = failure.reason;
  return {
    code: failure.code,
    message: failure.message,
    reason:
      reason !== undefined && reason in UNIQUE_ERROR_KEY
        ? (reason as GenerateApiError["reason"])
        : undefined,
    attempts: failure.attempts,
  };
}

/**
 * A channel this topic has no post for, and why.
 *
 * `detail` is the point. The channel name alone ("Facebook produced nothing")
 * is the one thing the user can already see from the missing card; what they
 * cannot see, and cannot find anywhere else, is whether the post was refused as
 * a duplicate, ran past the channel's character limit with its source link
 * attached, or never got a turn before the run's deadline. Those three want
 * three different actions, and the API has always sent the code needed to tell
 * them apart — it was only ever dropped here.
 */
interface ChannelFailure {
  channel: string;
  detail: string;
}

/** Which of the two generation modes the form is in. */
type GenerateMode = "single" | "multiple";

interface Props {
  slug: string;
  /**
   * One topic finished. An array because a topic written for three channels is
   * three independent posts — the grid renders them as one grouped card, but it
   * is given all three, in the order they were written.
   */
  onGenerated: (posts: PostItem[]) => void;
  /**
   * A bulk run finished with at least one post. Bulk returns ids rather than
   * whole posts, so the list reloads from the server instead of being patched
   * in place — the cheap alternative would be N follow-up fetches.
   */
  onBulkGenerated: () => void;
  /** Whether generation is based on an RSS feed item — gates the source-link override. */
  hasRssFeedItems: boolean;
  /**
   * Every enabled content source offered in the "Content source" dropdown —
   * RSS feeds, product pages, prompts, calendar events alike. Ones that cannot
   * currently back a post arrive with `available: false` and render disabled.
   */
  contentSources: GenerationSourceOption[];
  /**
   * Channels backed by an enabled Buffer profile. Empty means the company has
   * connected nothing yet — the form then explains that instead of offering
   * four channels it cannot publish to.
   */
  availableChannels: GenerationChannelOption[];
  /** Company.defaultLang — names the resolved "Default" language option. */
  companyDefaultLang: "en" | "bg";
  /**
   * The company's saved content mix — the DEFAULT a multi-post batch starts
   * from. Null when it could not be read, which simply leaves the batch on the
   * pooled behaviour it had before this panel existed.
   */
  contentMix: ContentMixDTO | null;
}

export function GeneratePostForm({
  slug,
  onGenerated,
  onBulkGenerated,
  hasRssFeedItems,
  contentSources,
  availableChannels,
  companyDefaultLang,
  contentMix,
}: Props) {
  const t = useTranslations("posts.generate");
  const tBulk = useTranslations("posts.generate.bulk");
  // The post card's schedule wording, reused verbatim: the same field means the
  // same thing whether it is filled in before generation or after it.
  const tSchedule = useTranslations("posts.schedule");
  const tCommon = useTranslations("common");
  const apiError = useApiErrorMessage();
  const locale = useLocale();

  // CHANNEL_ORDER drives display order; availableChannels decides membership.
  // The intersection is taken in that order so the list never reshuffles when a
  // company connects a new profile.
  const channelOptions = useMemo(() => {
    const byChannel = new Map(availableChannels.map((c) => [c.channel, c]));
    return CHANNEL_ORDER.flatMap((value) => {
      const config = byChannel.get(value);
      return config ? [{ value: value as string, label: channelLabel(value), config }] : [];
    });
  }, [availableChannels]);

  const channelValues = useMemo(() => channelOptions.map((c) => c.value), [channelOptions]);

  /**
   * Every channel this topic is written for.
   *
   * Empty only when the company has connected nothing — generation is disabled
   * in that case, so an empty selection never reaches the API. Otherwise the
   * selection helpers guarantee at least one entry, all of them currently
   * available.
   */
  const [channels, setChannels] = useState<string[]>(() => channelValues.slice(0, 1));
  // "default" = inherit the selected channel's configured posting language;
  // "en"/"bg" = explicit one-time override.
  const [contentLanguage, setContentLanguage] = useState<"default" | "en" | "bg">("default");
  const [sourceLinkOverride, setSourceLinkOverride] = useState<SourceLinkOverride>("inherit");
  const [imageOverride, setImageOverride] = useState<ImageOverride>("inherit");
  // The "Content source" choice: a sentinel, or a content source id of any type.
  // Defaults to company rules, which is the behaviour the form has always had.
  const [contentSource, setContentSource] = useState<string>(COMPANY_RULES_VALUE);
  // Empty string = "System default (auto)"; otherwise an LlmConfig id (v2-5).
  const [llmConfigId, setLlmConfigId] = useState("");
  const [availableLlms, setAvailableLlms] = useState<AvailableLlm[]>([]);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<GenerationWarnings | null>(null);

  // ── Single-post publish time ──────────────────────────────────────────────
  // Optional, and empty by default: an unscheduled draft is what this form has
  // always produced, and scheduling is an extra a user opts into rather than a
  // field they must clear. Held as a day plus a slot — the same pair the post
  // card's picker uses, and for the same reason: the publishing sweep runs every
  // half hour, so those are the only times a post can actually go out at.
  const [singleDay, setSingleDay] = useState("");
  const [singleTime, setSingleTime] = useState("");

  // ── Bulk mode ─────────────────────────────────────────────────────────────
  const [mode, setMode] = useState<GenerateMode>("single");
  // Seeded once, from the browser's clock at first render: the default range
  // starts tomorrow, and re-deriving it on every render would move it at
  // midnight underneath a form someone is filling in.
  const [plan, setPlan] = useState<BulkPlanState>(() => ({
    numberOfPosts: 3,
    ...defaultBulkRange(new Date()),
    distribution: "even",
    counts: {},
    times: {},
  }));
  // The clock, read once — for the same reason the default range is: "today"
  // must not move to a new day underneath a form someone is in the middle of
  // filling in. It is the floor under the period, in the business zone.
  const [openedAt] = useState(() => new Date());
  const minDate = useMemo(() => appZoneToday(openedAt), [openedAt]);
  const [batch, setBatch] = useState<BulkBatchResponse | null>(null);

  // ── The queued run ────────────────────────────────────────────────────────
  // `activeJob` is what the browser is WATCHING; `jobStatus` is the last thing
  // the status endpoint said about it. They are separate because they end at
  // different moments: polling stops the instant the run is terminal, but its
  // final state — a failure, its error, what it managed to write — has to stay
  // on screen after it does.
  const [activeJob, setActiveJob] = useState<ActiveBulkJob | null>(null);
  const [jobStatus, setJobStatus] = useState<BulkJobStatus | null>(null);
  /**
   * What to say about the run.
   *
   * Stored rather than derived at render, because deciding it needs the clock —
   * "queued" only becomes "waiting for a worker" after enough time has passed —
   * and reading the clock while rendering is exactly the impurity that makes a
   * component's output depend on when React happened to re-run it. So it is
   * settled where a clock reading is a fact rather than a guess: in the poll,
   * against the status that poll just fetched. A job sat in the queue slides
   * into the waiting state on the first poll past the threshold.
   *
   * Null when this tab has never watched a run in this session.
   */
  const [jobPhase, setJobPhase] = useState<BulkJobPhase | null>(null);
  /** True when this run was adopted from a 409 rather than started by this click. */
  const [resumedExisting, setResumedExisting] = useState(false);
  /** The channels that produced nothing on a partial SINGLE generation. */
  const [channelFailures, setChannelFailures] = useState<ChannelFailure[]>([]);

  // ── The queued MULTI-CHANNEL topic run ────────────────────────────────────
  // Held separately from the bulk run above, for the same reason it is stored
  // under its own key: both can be in flight at once, and one state pair serving
  // two runs would show whichever polled last.
  const [activeTopicJob, setActiveTopicJob] = useState<ActiveTopicJobRef | null>(null);
  const [topicStatus, setTopicStatus] = useState<TopicJobStatus<PostItem> | null>(null);
  const [topicPhase, setTopicPhase] = useState<TopicJobPhase | null>(null);

  // ── This batch's content mix ──────────────────────────────────────────────
  // Null means "untouched, so use the saved default". Holding the override as
  // null-or-edits rather than as a copy of the default is what keeps the panel
  // honest for free: the badge, the reset, and the re-scaling when the number of
  // posts changes are all just this one distinction, and no effect has to keep a
  // duplicate in step with the source of truth.
  const [mixOverride, setMixOverride] = useState<Record<string, number> | null>(null);

  // A saved mix exists AND the batch is drawing on all sources — a specific
  // content-source pick is an instruction of its own and is not overridden here.
  const mixConfigured = contentMix?.configured === true;
  const mixApplies = mode === "multiple" && contentSource === COMPANY_RULES_VALUE;

  const mixCounts = useMemo(() => {
    if (!contentMix) return {};
    return mixOverride ?? defaultBatchMix(contentMix, plan.numberOfPosts);
  }, [contentMix, mixOverride, plan.numberOfPosts]);

  /** The mix is what this run will follow — as opposed to merely being shown. */
  const mixActive = mixApplies && mixConfigured;
  const mixBalanced = batchMixTotal(mixCounts) === plan.numberOfPosts;

  const noChannels = channelOptions.length === 0;

  /**
   * The channel the per-channel hints below speak for.
   *
   * Several channels can be selected, and each has its own posting language, its
   * own image requirement and its own posting windows — so a hint has to be
   * about ONE of them or it is about nothing. The first selected is used, and
   * the hints name it, rather than four hints crowding the form or one hint
   * silently averaging settings that differ.
   */
  const primaryChannel = channelOptions.find((c) => c.value === channels[0]) ?? null;

  // The channel's own posting windows decide the times in both distribution
  // modes. Server-authored, carried down with the channel option purely so the
  // preview below can be computed without a round trip.
  //
  // Each selected channel is scheduled into ITS OWN windows by the server, so a
  // multi-channel batch cannot be previewed as one timetable. The preview shows
  // the first channel's, labelled as such — an honest sample of the period
  // rather than a promise about all of them.
  const postingWindows = primaryChannel?.config.postingWindows ?? [];

  /**
   * The custom distribution exactly as it will be sent: the days, their counts,
   * and the times the user chose for each post. This one object is what gets
   * validated, what gets previewed, and what goes in the request body — the
   * three cannot disagree because there is only one of it.
   */
  const customDistribution = useMemo(
    () => toCustomDistribution(plan.counts, plan.times),
    [plan.counts, plan.times]
  );

  const distributionError = useMemo(
    () =>
      plan.distribution === "custom"
        ? validateCustomDistribution(
            customDistribution,
            plan.numberOfPosts,
            plan.startDate,
            plan.endDate,
            openedAt
          )
        : null,
    [
      plan.distribution,
      plan.numberOfPosts,
      plan.startDate,
      plan.endDate,
      customDistribution,
      openedAt,
    ]
  );

  /**
   * The exact instants this plan would schedule.
   *
   * Computed with the SAME pure planner the service runs, so the preview is not
   * a second implementation that can drift — it is the answer, shown early. A
   * custom plan that does not yet add up previews nothing rather than previewing
   * a schedule the request would be refused for.
   *
   * Note that only the even branch is given the channel's posting windows.
   * Custom slots come from the user's own times and nothing else, on both sides
   * of the wire.
   */
  const slots = useMemo(() => {
    if (plan.distribution === "custom") {
      return distributionError === null ? planCustomSlots(customDistribution) : [];
    }
    return planBulkSlots({
      startDate: plan.startDate,
      endDate: plan.endDate,
      count: plan.numberOfPosts,
      postingWindows,
    });
    // `postingWindows` is a fresh array each render; the channel it came from is
    // what actually changes, so that is what the memo watches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, distributionError, customDistribution, channels[0]]);

  /**
   * The instant the single-post fields name, or null when they name none.
   *
   * Null covers both "the user wants no schedule" (both fields empty) and "the
   * pair is not yet a usable time" (one filled in, or a day that does not
   * exist). `scheduleIncomplete` below is what tells those two apart, because
   * only one of them should stop the button.
   *
   * Converted with the same business-zone helper the bulk form and the post card
   * use, so a time typed here means what it says on every screen that reads it
   * back afterwards.
   */
  const singleScheduledFor = useMemo(
    () =>
      singleDay === "" || singleTime === ""
        ? null
        : fromAppDateTimeLocal(`${singleDay}T${singleTime}`),
    [singleDay, singleTime]
  );

  /** Half a time. Worth blocking on: the other half was going to be ignored. */
  const scheduleIncomplete = (singleDay === "") !== (singleTime === "");

  /**
   * Both fields filled in, and still naming no instant. The date input can hold
   * a day that does not exist (2026-02-30), which the API refuses.
   */
  const scheduleUnusable = !scheduleIncomplete && singleDay !== "" && singleScheduledFor === null;

  /**
   * A time already gone by. Refused by the API — generation is minutes of work,
   * and a post written straight into the past-due state is stranded — so the
   * button must not offer it either. Measured against the clock the form opened
   * on, so a field cannot start failing while it is being read; the server
   * measures against its own and is the authority.
   */
  const schedulePast =
    singleScheduledFor !== null &&
    refuseScheduleTime(new Date(singleScheduledFor), openedAt) !== null;

  /** A single-post request the API would accept — what the Generate button waits for. */
  const singleReady = !scheduleIncomplete && !scheduleUnusable && !schedulePast;

  /**
   * A run is in flight and this tab is following it.
   *
   * The bulk form's "busy" is no longer `generating`, which now only covers the
   * few milliseconds of the enqueue request itself. Everything the user waits on
   * happens after that, so this is what locks the form.
   */
  const bulkRunning = activeJob !== null;

  /**
   * A multi-channel single generation is in flight and this tab is following it.
   *
   * Locks the form for the same reason `bulkRunning` does — the enqueue request
   * itself takes milliseconds, so `generating` goes false almost immediately
   * while the actual work is only starting. It matters more here than for bulk:
   * a topic run carries no dedupe key, so a second click would not be refused by
   * the queue — it would simply write the topic twice.
   */
  const topicRunning = activeTopicJob !== null;

  /** A bulk request the API would accept — what the Generate button waits for. */
  const bulkReady =
    plan.numberOfPosts >= 1 &&
    plan.numberOfPosts <= MAX_BULK_POSTS &&
    distributionError === null &&
    // Literally the same function the service runs: a period that has already
    // begun is refused there, so the button must not offer it here.
    !isStartDateInPast(plan.startDate, openedAt) &&
    slots.length > 0 &&
    // The mix IS the batch when it applies, so one that does not add up would
    // ask for a different number of posts than the button promises. The service
    // refuses it too; this is what stops the request being made at all.
    (!mixActive || mixBalanced);

  // The language "Default" resolves to, mirroring the server's order:
  // ChannelConfig.postingLanguage → Company.defaultLang. Naming it in the option
  // label means the user can see what "Default" means without opening settings.
  const channelLanguage = primaryChannel?.config.postingLanguage;
  const languageFromChannel = channelLanguage === "en" || channelLanguage === "bg";
  const resolvedDefaultLang: "en" | "bg" = languageFromChannel
    ? channelLanguage
    : companyDefaultLang;

  // Only the explicit "do not generate" choice warns. Inheriting a channel that
  // simply has auto-generation off is the pre-existing default for most
  // companies, so warning on it would fire on nearly every first load.
  //
  // Across a multi-channel selection ANY channel needing an image is worth the
  // warning — the point is that a post will be publishable on some channels and
  // not others, which is precisely the case a per-channel check would miss.
  const imageRequiringChannels = channelOptions
    .filter((c) => channels.includes(c.value) && c.config.imageRequired)
    .map((c) => c.label);
  const imageWarning = imageOverride === "skip" && imageRequiringChannels.length > 0;

  /**
   * Whether this form opened on a restored draft — which makes every choice in
   * it the user's own, including the ones that happen to equal a default. Read
   * by the LLM loader below, whose job is to preselect a preference for a form
   * nobody has filled in yet.
   */
  const restoredFromDraft = useRef(false);

  /**
   * Restores the draft left behind on the way to the content-mix settings, once.
   *
   * Applied in an effect rather than in the `useState` initialisers because the
   * initialisers also run on the server, where there is no sessionStorage to
   * read: a restored initialiser would render one form on the server and
   * hydrate a different one on the client. So the form mounts on its defaults
   * and this replaces them immediately — the effect is deliberately the first
   * in the component, ahead of anything that fetches.
   *
   * `takeBulkDraft` deletes as it reads, so this is a no-op on every run but the
   * first — including the reruns a changed channel or source list would cause.
   *
   * Two values are re-checked against what the page currently offers: a channel
   * can be disconnected and a source deleted while the user is in settings, and
   * a select holding a value that is no longer an option shows blank.
   */
  useEffect(() => {
    const draft = takeBulkDraft(slug);
    if (!draft) return;
    restoredFromDraft.current = true;

    const sources = [
      COMPANY_RULES_VALUE,
      COMPANY_MISSION_VALUE,
      ...contentSources.map((s) => s.id),
    ];

    // The one cascading render this rule exists to prevent is the one this
    // feature is: browser storage cannot be read while rendering, so restored
    // state can only arrive after the first paint. It happens once per mount,
    // only when a draft exists, and settles immediately.
    /* eslint-disable react-hooks/set-state-in-effect */
    setMode(draft.mode);
    // Reduced to what is still on offer — a profile can be disconnected while
    // the user is in settings, and a checkbox for a channel that is gone would
    // send a request the server refuses.
    setChannels(normalizeChannelSelection(draft.channels, channelValues));
    setContentLanguage(draft.contentLanguage);
    setImageOverride(draft.imageOverride);
    setContentSource(stillAvailable(draft.contentSource, sources, COMPANY_RULES_VALUE));
    setSourceLinkOverride(draft.sourceLinkOverride);
    setLlmConfigId(draft.llmConfigId);
    // The compile-time check that the draft's plan and the form's state are the
    // same shape — `BulkPlanState` is mirrored, not imported, in bulk-draft.ts.
    const restoredPlan: BulkPlanState = draft.plan;
    setPlan(restoredPlan);
    setMixOverride(draft.mixOverride);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [slug, channelValues, contentSources]);

  /** Snapshots the form so the trip to settings and back costs nothing typed. */
  function rememberDraft() {
    saveBulkDraft(slug, {
      mode,
      channels,
      contentLanguage,
      imageOverride,
      contentSource,
      sourceLinkOverride,
      llmConfigId,
      plan,
      mixOverride,
    });
  }

  /**
   * Picks up the run this tab was already watching.
   *
   * Bulk generation happens in a worker now, so the browser can leave and come
   * back while it runs — and a form that looked idle over a live run would
   * invite a second click, which the queue would refuse as ALREADY_RUNNING. The
   * id is read back rather than consumed, so it survives every visit until the
   * run terminates.
   *
   * Guarded by a ref rather than by the dependency list because the read is NOT
   * consume-once: re-running it would hand `setActiveJob` a fresh object each
   * time and restart the polling effect below in a loop.
   */
  const jobRestored = useRef(false);
  useEffect(() => {
    if (jobRestored.current) return;
    jobRestored.current = true;
    const existing = readActiveBulkJob(slug);
    // Same reason the draft restore sets state in an effect: browser storage
    // cannot be read while rendering, so this can only arrive after first paint.
    // Once per mount, and only when a run is actually in flight.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (existing) {
      setActiveJob(existing);
      // Shown immediately rather than after the first poll lands, so returning
      // to the page never presents an idle-looking form over a live run.
      setJobPhase("queued");
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [slug]);

  /**
   * Starts watching a run, and writes it down so a navigation cannot lose it.
   *
   * The one place `activeJob` is set from a response — used by both the ordinary
   * 202 and the 409 that hands back a run already in flight, so the two cannot
   * drift on what "watching a job" involves.
   */
  function adoptJob(next: ActiveBulkJob) {
    saveActiveBulkJob(slug, next);
    setActiveJob(next);
    setJobStatus(null);
    // "Queued" until the first poll says otherwise — the panel has to appear on
    // the click rather than five seconds later.
    setJobPhase("queued");
  }

  /**
   * The run is over, one way or another: stop polling and forget the reference.
   *
   * `jobStatus` is deliberately kept — a failed run's error and the posts it
   * managed to write are the whole reason the user is looking at the panel.
   */
  const finishJob = useCallback(() => {
    clearActiveBulkJob(slug);
    setActiveJob(null);
  }, [slug]);

  // The grid's refresh callback, held in a ref so the polling effect does not
  // restart every time the parent re-renders and hands down a new function.
  const onBulkGeneratedRef = useRef(onBulkGenerated);
  useEffect(() => {
    onBulkGeneratedRef.current = onBulkGenerated;
  });

  /**
   * Follows the run until it stops.
   *
   * Deliberately a self-scheduling `setTimeout` chain rather than a fixed
   * `setInterval`: the cadence depends on what the job is doing (see
   * `bulkPollIntervalMs`), and an interval would also stack requests if one poll
   * outlived its own period.
   *
   * The grid is refreshed whenever the count of committed posts has GROWN, so
   * drafts appear as the worker writes them rather than all at once at the end —
   * and a poll that reports no new posts costs no server round trip.
   */
  useEffect(() => {
    if (!activeJob) return;

    const jobId = activeJob.jobId;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Local rather than a ref, so it resets naturally per job. Starting at zero
    // on a RESTORED job is intentional: whatever was written while this tab was
    // away is new to the grid and worth a refresh.
    let lastSeenPosts = 0;

    async function poll() {
      try {
        const res = await fetch(`/api/v1/companies/${slug}/generate/bulk/${jobId}`);

        if (res.status === 404) {
          // The row is gone — a pruned queue, or an id from a database that has
          // since been reset. Keeping the reference would leave the form
          // permanently "generating" with nothing to generate, so the whole
          // reference goes: the job, and the panel reporting it.
          if (!cancelled) {
            finishJob();
            setJobPhase(null);
          }
          return;
        }
        if (!res.ok) throw new Error("status unavailable");

        const json = (await readJsonResponse(res)) as { job?: BulkJobStatus };
        // A 200 whose body is not the status — a gateway page served with the
        // wrong status, a deploy mid-flight. Treated as a dropped poll rather
        // than as a job that stopped: the run is on the server either way.
        if (!json.job) throw new Error("status unreadable");
        if (cancelled) return;

        const job = json.job;
        setJobStatus(job);

        const committed = committedPostCount(job.progress);
        if (committed > lastSeenPosts) {
          lastSeenPosts = committed;
          onBulkGeneratedRef.current();
        }

        const phase = resolveBulkJobPhase(job, Date.now());
        setJobPhase(phase);

        if (isTerminalBulkJobPhase(phase)) {
          finishJob();
          // A finished job's result IS the batch summary, so the completed state
          // is rendered by the same panel the synchronous route's answer always
          // used — same wording, same explanations, no second design.
          if (phase === "completed") setBatch(toBulkBatchResponse(job.progress));
          // One last refresh: the final topic commits after the poll that
          // reported the one before it.
          onBulkGeneratedRef.current();
          return;
        }

        timer = setTimeout(poll, bulkPollIntervalMs(phase));
      } catch {
        // A dropped connection is not a failed run. The job is on the server and
        // carries on regardless, so this backs off and asks again rather than
        // reporting an error the run did not have.
        if (!cancelled) timer = setTimeout(poll, 5_000);
      }
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeJob, slug, finishJob]);

  // The grid's add-a-card callback, held in a ref for the same reason the bulk
  // refresh is: the polling effect must not restart every time the parent
  // re-renders and hands down a new function.
  const onGeneratedRef = useRef(onGenerated);
  useEffect(() => {
    onGeneratedRef.current = onGenerated;
  });

  /** The topic run is over: stop polling and forget the reference. */
  const finishTopicJob = useCallback(() => {
    clearActiveTopicJob(slug);
    setActiveTopicJob(null);
  }, [slug]);

  /**
   * Picks up the topic run this tab was already watching.
   *
   * Same shape, and the same ref guard, as the bulk restore above: the read is
   * NOT consume-once, so re-running it would hand `setActiveTopicJob` a fresh
   * object each time and restart the polling effect in a loop.
   */
  const topicJobRestored = useRef(false);
  useEffect(() => {
    if (topicJobRestored.current) return;
    topicJobRestored.current = true;
    const existing = readActiveTopicJob(slug);
    // Browser storage cannot be read while rendering, so this can only arrive
    // after the first paint. Once per mount, and only over a live run.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (existing) {
      setActiveTopicJob(existing);
      setTopicPhase("queued");
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [slug]);

  /**
   * Follows the topic run until it stops, adding each channel's card as it lands.
   *
   * The interesting difference from the bulk poll: bulk reports ids and the grid
   * reloads from the server, whereas a topic job's progress carries the finished
   * POSTS, so a committed channel is handed straight to `onGenerated` — the same
   * call, with the same objects, that the synchronous single-channel path makes.
   * There is no second rendering path and no follow-up fetch.
   *
   * `seen` is local to the effect, so it resets naturally per job. Starting empty
   * on a RESTORED job is deliberate: whatever was written while this tab was away
   * has never been added to this grid.
   */
  useEffect(() => {
    if (!activeTopicJob) return;

    const jobId = activeTopicJob.jobId;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const seen = new Set<string>();

    async function poll() {
      try {
        const res = await fetch(`/api/v1/companies/${slug}/generate/topic/${jobId}`);

        if (res.status === 404) {
          // The row is gone — a pruned queue, or an id from a database that has
          // since been reset. Keeping the reference would leave the form
          // permanently locked over nothing.
          if (!cancelled) {
            finishTopicJob();
            setTopicPhase(null);
          }
          return;
        }
        if (!res.ok) throw new Error("status unavailable");

        const json = (await readJsonResponse(res)) as { job?: TopicJobStatus<PostItem> };
        // A 200 whose body is not the status — a gateway page served with the
        // wrong status, a deploy mid-flight. Treated as a dropped poll rather
        // than as a run that stopped: the job is on the server either way.
        if (!json.job) throw new Error("status unreadable");
        if (cancelled) return;

        const job = json.job;
        setTopicStatus(job);

        // Channels committed since the last poll, in the order they were written.
        const fresh = newTopicPosts(job.progress, seen);
        if (fresh.length > 0) {
          for (const entry of fresh) seen.add(entry.postId);
          onGeneratedRef.current(fresh.map((entry) => entry.post));
        }

        const phase = resolveBulkJobPhase(job, Date.now());
        setTopicPhase(phase);

        if (isTerminalBulkJobPhase(phase)) {
          finishTopicJob();
          if (phase === "completed") {
            // The cards are already in the grid, so completion needs no panel of
            // its own — only the channels that produced NOTHING still need
            // saying, reported with exactly the wording the inline path uses.
            setChannelFailures(describeChannelFailures(job.progress));
            // Every channel refused. There is no card to explain itself, so the
            // first failure's own code is what the user is told, through the same
            // mapper the inline path answers errors with.
            if (hasNoPosts(job.progress)) {
              setError(resolveGenerateError(toGenerateApiError(job.progress?.failures?.[0])));
            }
            // The panel has nothing left to report; the alerts above carry it.
            setTopicPhase(null);
          }
          return;
        }

        timer = setTimeout(poll, bulkPollIntervalMs(phase));
      } catch {
        // A dropped connection is not a failed run. The job is on the server and
        // carries on regardless, so this backs off and asks again rather than
        // reporting an error the run did not have.
        if (!cancelled) timer = setTimeout(poll, 5_000);
      }
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // `resolveGenerateError` is recreated each render and reads only `t`/`apiError`,
    // both stable for the life of the component; including it would restart the
    // poll on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTopicJob, slug, finishTopicJob]);

  // Load the company's selectable LLMs once. Failure is silent — the dropdown
  // simply stays at "System default", preserving the pre-v2-5 behaviour. When the
  // user has a saved preference among the active models, preselect it (v2-6); a
  // one-time change here never persists back to the saved preference.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/v1/companies/${slug}/available-llms`);
        if (!res.ok) return;
        const json = (await readJsonResponse(res)) as { data?: AvailableLlm[] };
        if (!cancelled && Array.isArray(json.data)) {
          setAvailableLlms(json.data);
          const preferred = json.data.find((llm) => llm.isPreferred);
          // A restored form already holds a choice the user made — including an
          // explicit "System default", which this would otherwise overwrite with
          // the preference the moment the fetch lands.
          if (preferred && !restoredFromDraft.current) setLlmConfigId(preferred.id);
        }
      } catch {
        // Non-fatal: leave the dropdown at the system default.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  /**
   * Resolves a generate-API error to a user-facing message. A uniqueness abort
   * (CANNOT_GENERATE_UNIQUE_POST) gets a reason-specific explanation that names
   * how many attempts were made; everything else uses the generic code mapping.
   */
  function resolveGenerateError(err?: GenerateApiError): string {
    if (err?.code === "CANNOT_GENERATE_UNIQUE_POST") {
      const key = (err.reason && UNIQUE_ERROR_KEY[err.reason]) ?? "uniqueErrorGeneric";
      return t(key, { attempts: err.attempts ?? 3 });
    }
    return apiError(err);
  }

  /**
   * The channels this topic has no post for, each with the reason.
   *
   * Both answer shapes reach this: the 201 body of an inline run and the
   * progress record of a queued one carry the same `failures`/`notAttempted`
   * pair, so they are described once here rather than in two places that could
   * disagree about what a user is told.
   */
  function describeChannelFailures(progress: TopicJobProgressReport | null): ChannelFailure[] {
    return channelGaps(progress).map((gap) => ({
      channel: channelLabel(gap.channel),
      // No failure means nothing was ever run for this channel — the deadline
      // ran out first. Saying "not attempted" is both the truth and the useful
      // instruction, because asking again usually works.
      detail: gap.failure
        ? resolveGenerateError(toGenerateApiError(gap.failure))
        : t("channelNotAttempted"),
    }));
  }

  /**
   * The options both modes send. A bulk post is generated by the same pipeline
   * with the same settings — the only thing a batch adds is how many and when —
   * so these are built once rather than kept in step in two places.
   */
  function sharedGenerationBody(): Record<string, unknown> {
    return {
      // Lowercase, which is how the channel is spelled on the wire. Sent as an
      // array by both modes — one channel is the ordinary case with one entry,
      // and the server still accepts the old singular `channel` from a client
      // that has not been updated.
      channels: toChannelPayload(channels),
      // Omit when "Default" so the server inherits the channel's language.
      ...(contentLanguage !== "default" ? { contentLanguage } : {}),
      ...(hasRssFeedItems && sourceLinkOverride !== "inherit"
        ? { includeSourceLink: sourceLinkOverride === "include" }
        : {}),
      // Omit when inheriting so the server keeps reading the channel's
      // autoGenerateImage setting, exactly as cron does.
      ...(imageOverride !== "inherit" ? { generateImage: imageOverride === "generate" } : {}),
      contentSource,
      // Omit entirely when "System default" is selected so the server keeps
      // its env-var default provider path unchanged (v2-5).
      ...(llmConfigId ? { llmConfigId } : {}),
    };
  }

  /**
   * Writes ONE topic across the selected channels.
   *
   * Answered two different ways, decided by the server and detected here from
   * the status code:
   *
   *   • 201 — one channel, generated inline and returned. Unchanged, and the
   *     path every existing client still gets.
   *   • 202 — several channels, queued. Two channels are ~320s of generation
   *     against a 300s function cap, so the work happens in a worker and this
   *     starts watching it; the cards arrive one at a time from the poll.
   *
   * Either way a group where some channels succeeded and others did not is a
   * normal result: the posts that exist are real drafts and go into the grid,
   * and the channels that produced nothing are named rather than quietly
   * missing.
   */
  async function handleGenerate() {
    // Belt-and-braces: the button is already disabled without a channel, and
    // `generating` already blocks a second click — generation is minutes of
    // billed work, so a duplicate submission is not a cosmetic problem. A queued
    // topic run is part of the guard too, since `generating` goes false the
    // moment the 202 lands while the work is only starting.
    if (channels.length === 0 || generating || topicRunning || !singleReady) return;

    setGenerating(true);
    setError("");
    setWarnings(null);
    setChannelFailures([]);
    setBatch(null);
    try {
      const res = await fetch(`/api/v1/companies/${slug}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...sharedGenerationBody(),
          // Omitted when no time was picked, which leaves the unscheduled draft
          // this form has always produced. Sent as an instant: the day and slot
          // above are business-zone wall clock and are converted here, once.
          ...(singleScheduledFor === null ? {} : { scheduledFor: singleScheduledFor }),
        }),
      });
      // Read as text and parsed safely, never `res.json()`. A request that runs
      // past the platform's function cap is answered by the gateway, not by the
      // route, and its body is not JSON — parsing it directly turned a timeout
      // into "Unexpected token 'A', "An error o"... is not valid JSON" in the
      // user's face.
      const json = (await readJsonResponse(res)) as {
        post?: PostItem;
        posts?: PostItem[];
        warnings?: GenerationWarnings;
        contentGroupId?: string;
        failures?: TopicJobFailure[];
        notAttempted?: string[];
        job?: { jobId: string; contentGroupId: string; channels: string[] };
        error?: GenerateApiError;
      };
      if (!res.ok) throw new Error(resolveGenerateError(json.error));

      // Queued rather than generated: several channels, so the work is a
      // worker's and this tab follows it. Nothing has been written yet, which is
      // why nothing is reported here — the posts arrive through the poll.
      if (res.status === 202 && json.job) {
        const ref: ActiveTopicJobRef = {
          jobId: json.job.jobId,
          contentGroupId: json.job.contentGroupId,
          // The server's echo, not the local selection: it is what the run will
          // actually write, and it survives this tab being closed and reopened.
          channels: json.job.channels.length > 0 ? json.job.channels : channels,
          startedAt: new Date().toISOString(),
        };
        saveActiveTopicJob(slug, ref);
        setActiveTopicJob(ref);
        setTopicStatus(null);
        // "Queued" until the first poll says otherwise — the panel has to appear
        // on the click rather than five seconds later.
        setTopicPhase("queued");
        return;
      }

      // `posts` is the multi-channel answer; `post` is the same thing for a
      // server that predates it, so an older deployment still renders a card.
      const generated = json.posts ?? (json.post ? [json.post] : []);
      if (generated.length === 0) throw new Error(resolveGenerateError(json.error));
      onGenerated(generated);
      if (json.warnings && (json.warnings.duplicate.flagged || json.warnings.safety.flagged)) {
        setWarnings(json.warnings);
      }
      // A channel that failed and a channel there was no time for both mean the
      // same thing to the person looking at the card — this topic has no version
      // for it — so they are named together, each with its own reason.
      setChannelFailures(
        describeChannelFailures({
          contentGroupId: json.contentGroupId ?? "",
          failures: json.failures,
          notAttempted: json.notAttempted,
        })
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setGenerating(false);
    }
  }

  /**
   * Queues a batch, and starts watching it.
   *
   * The request no longer generates anything: it returns 202 with a job id and a
   * worker does the work. Which is why nothing here reports a result — the
   * response means "accepted", and everything the user is actually waiting for
   * arrives through the polling effect above.
   *
   * Everything that CAN be decided from the request itself is still answered
   * synchronously by the server (post count, period, distribution, content mix),
   * so a malformed batch is refused here with the same error it always was
   * rather than accepted and failed in a worker log.
   */
  async function handleBulkGenerate() {
    // `activeJob` is part of the guard, not just `generating`: the request
    // finishes in milliseconds now, so without it a second click during a
    // multi-minute run would sail straight through to the queue.
    if (channels.length === 0 || generating || activeJob !== null || !bulkReady) return;

    setGenerating(true);
    setError("");
    setWarnings(null);
    setChannelFailures([]);
    setBatch(null);
    setResumedExisting(false);
    try {
      const res = await fetch(`/api/v1/companies/${slug}/generate/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...sharedGenerationBody(),
          numberOfPosts: plan.numberOfPosts,
          startDate: plan.startDate,
          endDate: plan.endDate,
          // Omitted for an even spread, so the server plans the slots itself
          // from EACH channel's own windows. In custom mode it carries the
          // user's own days AND times, and every channel version of a topic is
          // scheduled at the one the user picked.
          ...(plan.distribution === "custom" ? { distribution: customDistribution } : {}),
          // Sent only when a mix is actually driving this run. Its absence is
          // what keeps a company without one — or a batch pinned to a single
          // source — on exactly the behaviour it had before.
          ...(mixActive ? { sourceMix: toSourceMixPayload(mixCounts) } : {}),
        }),
      });

      const json = (await readJsonResponse(res)) as {
        job?: { jobId: string; batchId: string };
        error?: GenerateApiError & { jobId?: string | null };
      };

      // One bulk run per company at a time. When the queue can name the run that
      // IS going, watch that one — the user came here to see a batch happen, and
      // an error with no way back to it would be the worst of both answers. It
      // is emphatically not a second job: nothing new is enqueued.
      if (res.status === 409) {
        const running = json.error?.jobId;
        if (typeof running === "string" && running.length > 0) {
          setResumedExisting(true);
          adoptJob({
            jobId: running,
            // Unknown from here — this request did not create it. The status
            // endpoint supplies the real counts on the first poll.
            batchId: null,
            requestedTopics: 0,
            startedAt: new Date().toISOString(),
          });
          return;
        }
        throw new Error(resolveGenerateError(json.error));
      }

      if (!res.ok || !json.job) throw new Error(resolveGenerateError(json.error));

      adoptJob({
        jobId: json.job.jobId,
        batchId: json.job.batchId,
        requestedTopics: plan.numberOfPosts,
        startedAt: new Date().toISOString(),
      });

      // The batch this draft described has been queued, so restoring it on a
      // later visit would re-offer a run that is already happening. Normally
      // there is nothing here to clear — the restore consumed it on mount — but
      // a trip to settings the user never came back from leaves one behind.
      clearBulkDraft(slug);
    } catch (err) {
      setError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setGenerating(false);
    }
  }

  return (
    // The anchor the "Back to generation" link lands on. Offset so the card's
    // heading clears the sticky dashboard header rather than sitting under it.
    <div
      id={BULK_FORM_ANCHOR}
      className="rounded-card border-border bg-surface scroll-mt-24 border px-5 py-5 shadow-sm"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-fg text-sm font-semibold">
          {mode === "single" ? t("title") : tBulk("title")}
        </h3>

        {/* Two modes of one form, not two forms: every option below is shared,
            and switching keeps whatever has been picked. */}
        <div
          role="tablist"
          aria-label={tBulk("modeLabel")}
          className="border-border bg-surface-subtle rounded-control inline-flex gap-0.5 border p-0.5"
        >
          {(["single", "multiple"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              // Also locked while a queued run is in flight: switching to
              // single-post mode would hide the panel reporting it.
              disabled={generating || bulkRunning || topicRunning}
              onClick={() => {
                setMode(value);
                setError("");
                setBatch(null);
                setChannelFailures([]);
              }}
              className={`rounded-control px-3 py-1.5 text-xs font-semibold transition-colors ${
                mode === value
                  ? "bg-surface text-fg shadow-sm"
                  : "text-fg-muted hover:text-fg disabled:cursor-not-allowed"
              }`}
            >
              {tBulk(value === "single" ? "modeSingle" : "modeMultiple")}
            </button>
          ))}
        </div>
      </div>

      {/* A run this tab is following. Completion is not shown here — a finished
          job's result IS the batch summary, and the panel below already reads
          one, so there is exactly one place that reports an outcome. */}
      {jobPhase !== null && jobPhase !== "completed" && (
        <BulkJobProgress
          phase={jobPhase}
          status={jobStatus}
          requestedTopics={activeJob?.requestedTopics || plan.numberOfPosts}
        />
      )}

      {/* A queued multi-channel single generation. Completion is not shown: its
          cards are already in the grid, added as each channel committed. */}
      {topicPhase !== null && (
        <TopicJobProgress
          phase={topicPhase}
          status={topicStatus}
          requestedChannels={activeTopicJob?.channels ?? channels}
        />
      )}

      {resumedExisting && bulkRunning && (
        <Alert variant="info" role="status" className="mb-4">
          {tBulk("jobAlreadyRunning")}
        </Alert>
      )}

      {batch && <BulkResultSummary batch={batch} locale={locale} />}

      {error && (
        <Alert variant="error" className="mb-4">
          {error}
        </Alert>
      )}

      {/* Some channels of this topic produced nothing. The ones that did are
          already in the grid — this names the gap rather than leaving a group
          silently short of the channels that were asked for. */}
      {channelFailures.length > 0 && (
        <Alert variant="warning" className="mb-4">
          <div className="space-y-1.5">
            <p>
              {t("channelsPartial", {
                channels: channelFailures.map((f) => f.channel).join(", "),
              })}
            </p>
            {/* One line per channel, with its own reason. A duplicate refusal, a
                post that overran the character limit with its source link, and a
                channel that never got a turn want three different actions — and
                the reason is the only thing that tells them apart. */}
            <ul className="space-y-1 text-xs">
              {channelFailures.map((failure) => (
                <li key={failure.channel}>
                  <span className="font-medium">{failure.channel}</span> — {failure.detail}
                </li>
              ))}
            </ul>
          </div>
        </Alert>
      )}

      {/* Nothing to generate for: say so once, at the top, instead of letting the
          user fill in four dropdowns before finding out. */}
      {noChannels && (
        <Alert variant="info" className="mb-4">
          {t("noChannels")}{" "}
          <Link
            href={`/companies/${slug}/settings/buffer`}
            className="font-semibold underline underline-offset-2"
          >
            {t("noChannelsCta")}
          </Link>
        </Alert>
      )}

      {warnings?.duplicate.flagged && (
        <Alert variant="warning" className="mb-3">
          {t("duplicateWarning", { score: warnings.duplicate.similarityScore?.toFixed(2) ?? "0" })}
        </Alert>
      )}

      {warnings?.safety.flagged && (
        <Alert variant="warning" className="mb-3">
          {t("safetyWarning", { terms: warnings.safety.matchedTerms.join(", ") })}
        </Alert>
      )}

      {/* One topic, one or more channels. Full width above the rest: it is the
          decision that changes how many posts the click produces, so it reads
          badly squeezed in beside four dropdowns. */}
      {!noChannels && (
        <div className="mb-3">
          <ChannelMultiSelect
            available={channelValues}
            selected={channels}
            onChange={(next) => {
              setChannels(next);
              setWarnings(null);
              setChannelFailures([]);
            }}
            disabled={generating || bulkRunning || topicRunning}
          />
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[140px]">
          <label
            htmlFor="generate-content-language"
            className="text-fg-muted mb-1.5 block text-sm font-medium"
          >
            {t("contentLanguage")}
          </label>
          <select
            id="generate-content-language"
            value={contentLanguage}
            onChange={(e) => setContentLanguage(e.target.value as "default" | "en" | "bg")}
            disabled={generating || bulkRunning || topicRunning}
            className="rounded-control border-border-strong bg-surface duration-fast focus:border-accent focus:ring-accent/20 w-full border px-3.5 py-2.5 text-sm transition-all outline-none focus:ring-2 focus:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <option value="default">
              {t("contentLanguageDefaultResolved", {
                language: t(resolvedDefaultLang === "bg" ? "languageNameBG" : "languageNameEN"),
              })}
            </option>
            <option value="en">{t("contentLanguageEN")}</option>
            <option value="bg">{t("contentLanguageBG")}</option>
          </select>
        </div>

        <div className="min-w-[180px]">
          <label
            htmlFor="generate-image"
            className="text-fg-muted mb-1.5 block text-sm font-medium"
          >
            {t("image")}
          </label>
          <select
            id="generate-image"
            value={imageOverride}
            onChange={(e) => setImageOverride(e.target.value as ImageOverride)}
            disabled={generating || bulkRunning || topicRunning}
            className="rounded-control border-border-strong bg-surface duration-fast focus:border-accent focus:ring-accent/20 w-full border px-3.5 py-2.5 text-sm transition-all outline-none focus:ring-2 focus:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <option value="inherit">{t("imageInherit")}</option>
            <option value="generate">{t("imageGenerate")}</option>
            <option value="skip">{t("imageSkip")}</option>
          </select>
        </div>

        <div className="min-w-[200px]">
          <label
            htmlFor="generate-content-source"
            className="text-fg-muted mb-1.5 block text-sm font-medium"
          >
            {t("contentSource")}
          </label>
          <select
            id="generate-content-source"
            value={contentSource}
            onChange={(e) => setContentSource(e.target.value)}
            disabled={generating || bulkRunning || topicRunning}
            className="rounded-control border-border-strong bg-surface duration-fast focus:border-accent focus:ring-accent/20 w-full border px-3.5 py-2.5 text-sm transition-all outline-none focus:ring-2 focus:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <option value={COMPANY_RULES_VALUE}>{t("contentSourceCompanyRules")}</option>
            {contentSources.map((source) => (
              // A source that cannot back a post stays listed but unpickable, so
              // it reads as "this one has nothing to say right now" rather than
              // "this one is gone". The label names which of the two it is: an
              // RSS feed is waiting for new articles, anything else is waiting to
              // be fetched.
              <option key={source.id} value={source.id} disabled={!source.available}>
                {source.available
                  ? source.name
                  : `${source.name} ${t(
                      source.unavailableReason === "no_content"
                        ? "contentSourceNoContent"
                        : "contentSourceNoArticles"
                    )}`}
              </option>
            ))}
            <option value={COMPANY_MISSION_VALUE}>{t("contentSourceCompanyMission")}</option>
          </select>
        </div>

        {hasRssFeedItems && (
          <div className="min-w-[180px]">
            <label
              htmlFor="generate-source-link"
              className="text-fg-muted mb-1.5 block text-sm font-medium"
            >
              {t("sourceLink")}
            </label>
            <select
              id="generate-source-link"
              value={sourceLinkOverride}
              onChange={(e) => setSourceLinkOverride(e.target.value as SourceLinkOverride)}
              disabled={generating || bulkRunning || topicRunning}
              className="rounded-control border-border-strong bg-surface duration-fast focus:border-accent focus:ring-accent/20 w-full border px-3.5 py-2.5 text-sm transition-all outline-none focus:ring-2 focus:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="inherit">{t("sourceLinkInherit")}</option>
              <option value="include">{t("sourceLinkInclude")}</option>
              <option value="exclude">{t("sourceLinkExclude")}</option>
            </select>
          </div>
        )}

        {availableLlms.length > 0 && (
          <div className="min-w-[200px]">
            <label
              htmlFor="generate-llm"
              className="text-fg-muted mb-1.5 block text-sm font-medium"
            >
              {t("llm")}
            </label>
            <select
              id="generate-llm"
              value={llmConfigId}
              onChange={(e) => setLlmConfigId(e.target.value)}
              disabled={generating || bulkRunning || topicRunning}
              className="rounded-control border-border-strong bg-surface duration-fast focus:border-accent focus:ring-accent/20 w-full border px-3.5 py-2.5 text-sm transition-all outline-none focus:ring-2 focus:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="">{t("llmSystemDefault")}</option>
              {availableLlms.map((llm) => (
                <option key={llm.id} value={llm.id}>
                  {llm.displayName}
                  {llm.isDefault ? " ★" : ""}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* When the post goes out. Optional, and the only field here that is:
            leaving it empty writes the unscheduled draft this form has always
            written, and filling it in hands the post to exactly the publishing
            sweep a bulk-scheduled post uses. A date and a slot rather than a
            datetime-local, because the sweep runs every half hour and those are
            the only times a post can actually be published at. */}
        {mode === "single" && (
          <div className="min-w-[220px]">
            <label
              htmlFor="generate-schedule-date"
              className="text-fg-muted mb-1.5 block text-sm font-medium"
            >
              {tSchedule("publishTimeOptional")}
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                id="generate-schedule-date"
                type="date"
                value={singleDay}
                min={minDate}
                onChange={(e) => setSingleDay(e.target.value)}
                disabled={generating || topicRunning || noChannels}
                aria-invalid={scheduleIncomplete || scheduleUnusable || schedulePast || undefined}
                className="rounded-control border-border-strong bg-surface duration-fast focus:border-accent focus:ring-accent/20 border px-3.5 py-2.5 text-sm transition-all outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60"
              />
              <TimeSlotSelect
                value={singleTime}
                onChange={setSingleTime}
                disabled={generating || topicRunning || noChannels}
                invalid={scheduleIncomplete || schedulePast}
                aria-label={tSchedule("newTimeOfDay")}
                className="px-3.5 py-2.5 text-sm"
              />
              {/* The way back to "no schedule". Without it a date input that has
                  been filled in cannot reliably be emptied again. */}
              {(singleDay !== "" || singleTime !== "") && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={generating || topicRunning}
                  onClick={() => {
                    setSingleDay("");
                    setSingleTime("");
                  }}
                >
                  {tCommon("clear")}
                </Button>
              )}
            </div>
          </div>
        )}

        {mode === "single" ? (
          <Button
            variant="primary"
            // Spins for the whole run when the topic was queued, not just for the
            // request: with several channels selected the POST returns in
            // milliseconds and the writing happens afterwards, in a worker.
            loading={generating || topicRunning}
            disabled={noChannels || generating || topicRunning || !singleReady}
            onClick={handleGenerate}
          >
            {generating || topicRunning ? t("generating") : t("generateDraft")}
          </Button>
        ) : (
          <Button
            variant="primary"
            // Spinning for the whole run, not just for the enqueue request: the
            // request returns in milliseconds, and a button that went idle while
            // a worker was still writing would invite the second click the queue
            // then refuses.
            loading={generating || bulkRunning}
            disabled={noChannels || generating || bulkRunning || !bulkReady}
            onClick={handleBulkGenerate}
          >
            {generating || bulkRunning
              ? tBulk("generating", { count: plan.numberOfPosts })
              : tBulk("generateDrafts", { count: plan.numberOfPosts })}
          </Button>
        )}
      </div>

      {/* What the schedule field is doing, or why it is not usable yet. Only one
          shows at a time: a problem replaces the hint rather than sitting under
          it, so there is never advice and a complaint about the same field. */}
      {mode === "single" &&
        (scheduleIncomplete ? (
          <p className="text-status-danger-fg mt-3 text-xs">{tSchedule("pickBothParts")}</p>
        ) : scheduleUnusable ? (
          <p className="text-status-danger-fg mt-3 text-xs">{tSchedule("invalidDate")}</p>
        ) : schedulePast ? (
          <p className="text-status-danger-fg mt-3 text-xs">{tSchedule("timeInPast")}</p>
        ) : singleScheduledFor !== null ? (
          <p className="text-fg-faint mt-3 text-xs">
            {tSchedule("slotHint", { minutes: SLOT_MINUTES })}{" "}
            {tSchedule("timeZoneHint", { zone: APP_TIME_ZONE })}{" "}
            {tSchedule("approvalStillRequired")}
          </p>
        ) : (
          <p className="text-fg-faint mt-3 text-xs">{tSchedule("optionalHint")}</p>
        ))}

      {mode === "multiple" && (
        <BulkGenerateFields
          plan={plan}
          onChange={setPlan}
          slots={slots}
          distributionError={distributionError}
          minDate={minDate}
          now={openedAt}
          postingWindows={postingWindows}
          disabled={generating || bulkRunning || topicRunning || noChannels}
          locale={locale}
        />
      )}

      {/* The preview above is one channel's timetable. Every other selected
          channel is scheduled into its OWN posting windows, so a topic's
          versions can legitimately go out at different times — said here rather
          than discovered when the drafts appear with times nobody previewed. */}
      {mode === "multiple" &&
        plan.distribution === "even" &&
        channels.length > 1 &&
        primaryChannel && (
          <p className="text-fg-faint mt-3 text-xs">
            {tBulk("previewPerChannel", { channel: primaryChannel.label })}
          </p>
        )}

      {/* Where the posts come from, beside when they go out. Shown only for a
          batch — a single post already answers this with the dropdown above —
          and only while that dropdown is on "company rules", since a specific
          pick is itself the answer. */}
      {mixApplies && contentMix && (
        <BatchContentMixFields
          slug={slug}
          mix={contentMix}
          counts={mixCounts}
          onChange={setMixOverride}
          isDefault={mixOverride === null}
          onReset={() => setMixOverride(null)}
          numberOfPosts={plan.numberOfPosts}
          sources={contentSources}
          disabled={generating || bulkRunning || topicRunning || noChannels}
          onLeaveForSettings={rememberDraft}
        />
      )}

      {/* A specific source was picked, so there is nothing to distribute. Said
          out loud, with the way back, rather than by a panel silently vanishing. */}
      {mode === "multiple" && !mixApplies && mixConfigured && (
        <p className="text-fg-faint mt-3 text-xs">
          {tBulk("contentMixPinnedSource", { option: t("contentSourceCompanyRules") })}
        </p>
      )}

      {/* Advisory, never blocking: the draft is still worth having, and an image
          can be generated or attached from the post card before publishing. The
          channels are named, because with several selected the warning is about
          some of them and not the others. */}
      {imageWarning && (
        <Alert variant="warning" className="mt-3">
          {t("imageRequiredWarningChannels", { channels: imageRequiringChannels.join(", ") })}
        </Alert>
      )}

      {contentLanguage === "default" && primaryChannel && (
        <p className="text-fg-faint mt-3 text-xs">
          {languageFromChannel
            ? t("contentLanguageDefaultHint", { channel: primaryChannel.label })
            : t("contentLanguageDefaultHintCompany")}
        </p>
      )}
    </div>
  );
}
