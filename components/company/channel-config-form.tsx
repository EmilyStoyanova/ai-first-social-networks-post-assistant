"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import type {
  ChannelConfigItem,
  PostingWindow,
} from "@/lib/services/company/list-channel-configs.service";

export interface ChannelFormPayload {
  enabled: boolean;
  postsPerDay: number;
  postsPerWeek: number;
  language: "inherit" | "en" | "bg";
  imageRequired: boolean;
  includeSourceLink: boolean;
  autoGenerateImage: boolean;
  automationModeOverride: "semi_automated" | "fully_automated" | null;
  postingWindows: PostingWindow[];
}

interface Props {
  initialConfig: ChannelConfigItem;
  saving: boolean;
  onSave: (data: ChannelFormPayload) => void;
  onCancel: () => void;
  companyAutomationMode: "semi_automated" | "fully_automated";
  companyDefaultLang: "en" | "bg";
}

const BASE =
  "w-full rounded-control border px-3.5 py-2.5 text-sm outline-none transition-all duration-fast focus:ring-2 focus:ring-offset-0";
const NORMAL = "border-border-strong bg-surface focus:border-accent focus:ring-accent/20";

/** A week cannot hold more posting days than it has days. */
const DAYS_IN_WEEK = 7;

function formatWindows(windows: PostingWindow[]): string {
  return windows.map((w) => `${w.day} ${w.start}-${w.end}`).join("\n");
}

/**
 * Read the textarea back into windows, keeping the lines that did not parse.
 *
 * The invalid ones used to be dropped on the floor: a typo such as "MONDAY
 * 9:00-17:00" saved as *no* windows at all, and the field came back empty on the
 * next edit with nothing said about why. They are returned instead so the form
 * can refuse to submit and name them.
 *
 * `start < end` is checked here too because the API enforces it (see
 * upsertChannelConfigSchema) — without it the only feedback is a generic 400.
 */
function parseWindows(text: string): { windows: PostingWindow[]; invalid: string[] } {
  const windows: PostingWindow[] = [];
  const invalid: string[] = [];

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    const m = line
      .toUpperCase()
      .match(
        /^(MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY)\s+(\d{2}:\d{2})-(\d{2}:\d{2})$/
      );
    if (!m || m[2] >= m[3]) invalid.push(line);
    else windows.push({ day: m[1], start: m[2], end: m[3] });
  }

  return { windows, invalid };
}

export function ChannelConfigForm({
  initialConfig,
  saving,
  onSave,
  onCancel,
  companyAutomationMode,
  companyDefaultLang,
}: Props) {
  const t = useTranslations("channels");
  const tCommon = useTranslations("common");
  const [enabled, setEnabled] = useState(initialConfig.enabled);
  const [postsPerDay, setPostsPerDay] = useState(String(initialConfig.postsPerDay));
  const [postsPerWeek, setPostsPerWeek] = useState(String(initialConfig.postsPerWeek));
  // null posting language = inherit the brand default.
  const [language, setLanguage] = useState<"inherit" | "en" | "bg">(
    initialConfig.postingLanguage === "bg"
      ? "bg"
      : initialConfig.postingLanguage === "en"
        ? "en"
        : "inherit"
  );
  const [imageRequired, setImageRequired] = useState(initialConfig.imageRequired);
  const [includeSourceLink, setIncludeSourceLink] = useState(initialConfig.includeSourceLink);
  const [autoGenerateImage, setAutoGenerateImage] = useState(initialConfig.autoGenerateImage);
  const [automationOverride, setAutomationOverride] = useState<string>(
    initialConfig.automationModeOverride ?? ""
  );
  const [windowsText, setWindowsText] = useState(formatWindows(initialConfig.postingWindows));

  const { windows, invalid: invalidWindowLines } = parseWindows(windowsText);

  // Automatic generation publishes at most one post per calendar day, so a
  // weekly target needs that many DISTINCT posting days. Checked against the
  // field as it is being typed — the same rule the API enforces
  // (postingDaysCoverTarget), so the form never offers to save something the
  // server will refuse.
  //
  // Read off the parsed target rather than the raw input, so a half-typed "1"
  // on the way to "10" does not flash an error about a number nobody has
  // finished entering.
  const weeklyTarget = Math.max(0, Math.min(100, parseInt(postsPerWeek, 10) || 0));
  const configuredDays = new Set(windows.map((w) => w.day)).size;
  const requiredDays = Math.min(weeklyTarget, DAYS_IN_WEEK);
  // A channel with no windows at all takes no part in automatic generation —
  // a supported state, not an error. See postingDaysCoverTarget.
  const tooFewDays = windows.length > 0 && configuredDays < requiredDays;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Saving here would silently store fewer windows than are on screen.
    if (invalidWindowLines.length > 0) return;
    // …and saving here would store a week the scheduler cannot place.
    if (tooFewDays) return;

    onSave({
      enabled,
      postsPerDay: Math.max(0, Math.min(20, parseInt(postsPerDay, 10) || 0)),
      postsPerWeek: Math.max(0, Math.min(100, parseInt(postsPerWeek, 10) || 0)),
      language,
      imageRequired,
      includeSourceLink,
      autoGenerateImage,
      automationModeOverride:
        automationOverride === "semi_automated" || automationOverride === "fully_automated"
          ? automationOverride
          : null,
      postingWindows: windows,
    });
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      {/* Enabled */}
      <label className="flex cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="border-border-strong text-status-success-dot focus:ring-accent h-4 w-4 rounded"
        />
        <span className="text-fg-muted text-sm font-medium">{t("enabledLabel")}</span>
      </label>

      {/* Row: posts/day + posts/week */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="text-fg-muted mb-1.5 block text-sm font-medium">
            {t("postsPerDayLabel")}
          </label>
          <input
            type="number"
            min={0}
            max={20}
            value={postsPerDay}
            onChange={(e) => setPostsPerDay(e.target.value)}
            className={`${BASE} ${NORMAL}`}
          />
        </div>
        <div>
          <label className="text-fg-muted mb-1.5 block text-sm font-medium">
            {t("postsPerWeekLabel")}
          </label>
          <input
            type="number"
            min={0}
            max={100}
            value={postsPerWeek}
            onChange={(e) => setPostsPerWeek(e.target.value)}
            className={`${BASE} ${NORMAL}`}
          />
        </div>
      </div>

      {/* Row: language + automation override */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="text-fg-muted mb-1.5 block text-sm font-medium">{t("language")}</label>
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value as "inherit" | "en" | "bg")}
            className={`${BASE} ${NORMAL}`}
          >
            <option value="inherit">{t("languageBrandDefault")}</option>
            <option value="en">{t("languageEN")}</option>
            <option value="bg">{t("languageBG")}</option>
          </select>
          {language === "inherit" && (
            <div className="mt-1.5 space-y-0.5">
              <p className="text-fg-faint text-xs">{t("languageBrandDefaultHelp")}</p>
              <p className="text-fg-faint text-xs">
                {t("effectiveLanguage", { language: companyDefaultLang.toUpperCase() })}
              </p>
            </div>
          )}
        </div>
        <div>
          <label className="text-fg-muted mb-1.5 block text-sm font-medium">
            {t("automationMode")}
          </label>
          <select
            value={automationOverride}
            onChange={(e) => setAutomationOverride(e.target.value)}
            className={`${BASE} ${NORMAL}`}
          >
            <option value="">{t("companyDefault")}</option>
            <option value="semi_automated">{t("semiAutomated")}</option>
            <option value="fully_automated">{t("fullyAutomated")}</option>
          </select>
          {automationOverride === "" && (
            <div className="mt-1.5 space-y-0.5">
              <p className="text-fg-faint text-xs">{t("companyDefaultHelp")}</p>
              <p className="text-fg-faint text-xs">
                {t("effectiveMode", {
                  mode: t(
                    companyAutomationMode === "fully_automated" ? "fullyAutomated" : "semiAutomated"
                  ),
                })}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Image required */}
      <label className="flex cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          checked={imageRequired}
          onChange={(e) => setImageRequired(e.target.checked)}
          className="border-border-strong text-status-success-dot focus:ring-accent h-4 w-4 rounded"
        />
        <span className="text-fg-muted text-sm font-medium">{t("imageRequiredLabel")}</span>
      </label>

      {/* Include source link by default */}
      <div>
        <label className="flex cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            checked={includeSourceLink}
            onChange={(e) => setIncludeSourceLink(e.target.checked)}
            className="border-border-strong text-status-success-dot focus:ring-accent h-4 w-4 rounded"
          />
          <span className="text-fg-muted text-sm font-medium">{t("includeSourceLinkLabel")}</span>
        </label>
        <p className="text-fg-faint mt-1 ml-7 text-xs">{t("includeSourceLinkHelp")}</p>
      </div>

      {/* Generate an image automatically with every new post */}
      <div>
        <label className="flex cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            checked={autoGenerateImage}
            onChange={(e) => setAutoGenerateImage(e.target.checked)}
            className="border-border-strong text-status-success-dot focus:ring-accent h-4 w-4 rounded"
          />
          <span className="text-fg-muted text-sm font-medium">{t("autoGenerateImageLabel")}</span>
        </label>
        <p className="text-fg-faint mt-1 ml-7 text-xs">{t("autoGenerateImageHelp")}</p>
      </div>

      {/* Posting windows */}
      <div>
        <label className="text-fg-muted mb-1.5 block text-sm font-medium">
          {t("postingWindows")}{" "}
          <span className="text-fg-faint font-normal">{t("postingWindowsHint")}</span>
        </label>
        <textarea
          rows={4}
          value={windowsText}
          onChange={(e) => setWindowsText(e.target.value)}
          placeholder={"MONDAY 09:00-17:00\nTUESDAY 09:00-17:00"}
          aria-invalid={invalidWindowLines.length > 0 || tooFewDays || undefined}
          className={`${BASE} ${NORMAL} resize-none`}
        />
        {invalidWindowLines.length > 0 && (
          <p className="text-status-danger-fg mt-1.5 text-xs">
            {t("postingWindowsInvalid", { lines: invalidWindowLines.join(", ") })}
          </p>
        )}
        {/* Names the three numbers that matter — asked for, configured, missing
            — because "add more days" without them leaves the owner counting
            lines in a textarea. */}
        {tooFewDays && (
          <p className="text-status-danger-fg mt-1.5 text-xs">
            {t("postingWindowsTooFewDays", {
              posts: weeklyTarget,
              days: configuredDays,
              missing: requiredDays - configuredDays,
            })}
          </p>
        )}
        {/* The windows are no longer only a time of day — an empty list now
            means the channel is left out of the weekly cron entirely. Said here
            because this field is the only place that decision is made. */}
        <p className="text-fg-faint mt-1.5 text-xs">{t("postingWindowsAutomationHelp")}</p>
        {/* The one-post-per-day rule, said once where the schedule is authored
            — otherwise the only way to learn it is to trip the error above. */}
        <p className="text-fg-faint mt-1 text-xs">{t("postingWindowsOnePerDayHelp")}</p>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3 pt-1">
        <Button
          type="submit"
          variant="primary"
          size="sm"
          loading={saving}
          disabled={invalidWindowLines.length > 0 || tooFewDays}
        >
          {saving ? tCommon("saving") : t("save")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {tCommon("cancel")}
        </Button>
      </div>
    </form>
  );
}
