"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useApiErrorMessage } from "@/lib/i18n/api-error";
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
  MAX_BULK_POSTS,
  isStartDateInPast,
  planBulkSlots,
  planCustomSlots,
  validateCustomDistribution,
} from "@/lib/scheduling/bulk-schedule";
import { appZoneToday } from "@/lib/scheduling/app-datetime-local";

// Labels and display order only — which of these are actually offered is decided
// by the company's enabled Buffer profiles (see `availableChannels`).
const CHANNELS = [
  { value: "FACEBOOK", label: "Facebook" },
  { value: "LINKEDIN", label: "LinkedIn" },
  { value: "INSTAGRAM", label: "Instagram" },
  { value: "TIKTOK", label: "TikTok" },
] as const;

type Channel = (typeof CHANNELS)[number]["value"];

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

/** Which of the two generation modes the form is in. */
type GenerateMode = "single" | "multiple";

interface Props {
  slug: string;
  onGenerated: (post: PostItem) => void;
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
  const tCommon = useTranslations("common");
  const apiError = useApiErrorMessage();
  const locale = useLocale();

  // CHANNELS drives label and order; availableChannels decides membership. The
  // intersection is taken in CHANNELS order so the list never reshuffles when a
  // company connects a new profile.
  const channelOptions = useMemo(() => {
    const byChannel = new Map(availableChannels.map((c) => [c.channel, c]));
    return CHANNELS.flatMap((c) => {
      const config = byChannel.get(c.value);
      return config ? [{ value: c.value, label: c.label, config }] : [];
    });
  }, [availableChannels]);

  // "" only when there is nothing to pick — generation is disabled in that case,
  // so the empty value never reaches the API.
  const [channel, setChannel] = useState<Channel | "">(() => channelOptions[0]?.value ?? "");
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
  const selectedChannel = channelOptions.find((c) => c.value === channel) ?? null;

  // The channel's own posting windows decide the times in both distribution
  // modes. Server-authored, carried down with the channel option purely so the
  // preview below can be computed without a round trip.
  const postingWindows = selectedChannel?.config.postingWindows ?? [];

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
  }, [plan, distributionError, customDistribution, channel]);

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
  const channelLanguage = selectedChannel?.config.postingLanguage;
  const languageFromChannel = channelLanguage === "en" || channelLanguage === "bg";
  const resolvedDefaultLang: "en" | "bg" = languageFromChannel
    ? channelLanguage
    : companyDefaultLang;

  // Only the explicit "do not generate" choice warns. Inheriting a channel that
  // simply has auto-generation off is the pre-existing default for most
  // companies, so warning on it would fire on nearly every first load.
  const imageWarning = imageOverride === "skip" && selectedChannel?.config.imageRequired === true;

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
        const json = (await res.json()) as { data?: AvailableLlm[] };
        if (!cancelled && Array.isArray(json.data)) {
          setAvailableLlms(json.data);
          const preferred = json.data.find((llm) => llm.isPreferred);
          if (preferred) setLlmConfigId(preferred.id);
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
   * The options both modes send. A bulk post is generated by the same pipeline
   * with the same settings — the only thing a batch adds is how many and when —
   * so these are built once rather than kept in step in two places.
   */
  function sharedGenerationBody(): Record<string, unknown> {
    return {
      channel,
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

  async function handleGenerate() {
    // Belt-and-braces: the button is already disabled without a channel, and
    // `generating` already blocks a second click — a bulk run is minutes of
    // billed work, so a duplicate submission is not a cosmetic problem.
    if (!channel || generating) return;

    setGenerating(true);
    setError("");
    setWarnings(null);
    setBatch(null);
    try {
      const res = await fetch(`/api/v1/companies/${slug}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sharedGenerationBody()),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: GenerateApiError };
        throw new Error(resolveGenerateError(json.error));
      }
      const json = (await res.json()) as { post: PostItem; warnings: GenerationWarnings };
      onGenerated(json.post);
      if (json.warnings.duplicate.flagged || json.warnings.safety.flagged) {
        setWarnings(json.warnings);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setGenerating(false);
    }
  }

  /**
   * Runs a whole batch in one request and reports what came back.
   *
   * A short batch is a SUCCESS with an account attached, not an error: the posts
   * that exist are real, committed drafts. Only a run that produced nothing at
   * all arrives as an error, and it carries the generation's own code, so it is
   * shown exactly like a failed single generation.
   */
  async function handleBulkGenerate() {
    if (!channel || generating || !bulkReady) return;

    setGenerating(true);
    setError("");
    setWarnings(null);
    setBatch(null);
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
          // from the channel's windows. In custom mode it carries the user's own
          // days AND times, and the server schedules exactly those — which is
          // why the preview above is not an estimate.
          ...(plan.distribution === "custom" ? { distribution: customDistribution } : {}),
          // Sent only when a mix is actually driving this run. Its absence is
          // what keeps a company without one — or a batch pinned to a single
          // source — on exactly the behaviour it had before.
          ...(mixActive ? { sourceMix: toSourceMixPayload(mixCounts) } : {}),
        }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: GenerateApiError };
        throw new Error(resolveGenerateError(json.error));
      }
      const json = (await res.json()) as { batch: BulkBatchResponse };
      setBatch(json.batch);
      onBulkGenerated();
    } catch (err) {
      setError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="rounded-card border-border bg-surface border px-5 py-5 shadow-sm">
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
              disabled={generating}
              onClick={() => {
                setMode(value);
                setError("");
                setBatch(null);
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

      {batch && <BulkResultSummary batch={batch} locale={locale} />}

      {error && (
        <Alert variant="error" className="mb-4">
          {error}
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

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[160px] flex-1">
          <label
            htmlFor="generate-channel"
            className="text-fg-muted mb-1.5 block text-sm font-medium"
          >
            {t("channel")}
          </label>
          <select
            id="generate-channel"
            value={channel}
            onChange={(e) => {
              setChannel(e.target.value as Channel);
              setWarnings(null);
            }}
            disabled={generating || noChannels}
            className="rounded-control border-border-strong bg-surface duration-fast focus:border-accent focus:ring-accent/20 w-full border px-3.5 py-2.5 text-sm transition-all outline-none focus:ring-2 focus:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {noChannels && <option value="">{t("noChannelsPlaceholder")}</option>}
            {channelOptions.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>

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
            disabled={generating}
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
            disabled={generating}
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
            disabled={generating}
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
              disabled={generating}
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
              disabled={generating}
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

        {mode === "single" ? (
          <Button
            variant="primary"
            loading={generating}
            disabled={noChannels || generating}
            onClick={handleGenerate}
          >
            {generating ? t("generating") : t("generateDraft")}
          </Button>
        ) : (
          <Button
            variant="primary"
            loading={generating}
            disabled={noChannels || generating || !bulkReady}
            onClick={handleBulkGenerate}
          >
            {generating
              ? tBulk("generating", { count: plan.numberOfPosts })
              : tBulk("generateDrafts", { count: plan.numberOfPosts })}
          </Button>
        )}
      </div>

      {mode === "multiple" && (
        <BulkGenerateFields
          plan={plan}
          onChange={setPlan}
          slots={slots}
          distributionError={distributionError}
          minDate={minDate}
          now={openedAt}
          postingWindows={postingWindows}
          disabled={generating || noChannels}
          locale={locale}
        />
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
          disabled={generating || noChannels}
        />
      )}

      {/* A specific source was picked, so there is nothing to distribute. Said
          out loud, with the way back, rather than by a panel silently vanishing. */}
      {mode === "multiple" && !mixApplies && mixConfigured && (
        <p className="text-fg-faint mt-3 text-xs">
          {tBulk("contentMixPinnedSource", { option: t("contentSourceCompanyRules") })}
        </p>
      )}

      {/* One run can take minutes; without this the user is looking at a
          spinner with no idea whether to wait or reload. */}
      {mode === "multiple" && generating && (
        <p className="text-fg-faint mt-3 text-xs">{tBulk("generatingHint")}</p>
      )}

      {/* Advisory, never blocking: the draft is still worth having, and an image
          can be generated or attached from the post card before publishing. */}
      {imageWarning && (
        <Alert variant="warning" className="mt-3">
          {t("imageRequiredWarning")}
        </Alert>
      )}

      {contentLanguage === "default" && selectedChannel && (
        <p className="text-fg-faint mt-3 text-xs">
          {languageFromChannel
            ? t("contentLanguageDefaultHint", { channel: selectedChannel.label })
            : t("contentLanguageDefaultHintCompany")}
        </p>
      )}
    </div>
  );
}
