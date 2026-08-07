"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import type { ContentSourceItem } from "@/lib/services/company/list-content-sources.service";

export interface ContentSourcePayload {
  type: string;
  name: string;
  config: Record<string, string | boolean>;
  enabled: boolean;
}

/** Three-state source-link preference: inherit channel default, or force on/off. */
type SourceLinkPref = "inherit" | "include" | "exclude";

function asText(value: string | boolean | undefined): string {
  return typeof value === "string" ? value : "";
}

function initialSourceLinkPref(value: string | boolean | undefined): SourceLinkPref {
  if (value === true) return "include";
  if (value === false) return "exclude";
  return "inherit";
}

interface Props {
  initialData?: ContentSourceItem;
  saving: boolean;
  onSave: (data: ContentSourcePayload) => void;
  onCancel: () => void;
}

const BASE =
  "w-full rounded-control border px-3.5 py-2.5 text-sm outline-none transition-all duration-fast focus:ring-2 focus:ring-offset-0";
const NORMAL = "border-border-strong bg-surface focus:border-accent focus:ring-accent/20";

export function ContentSourceForm({ initialData, saving, onSave, onCancel }: Props) {
  const t = useTranslations("contentSources");
  const tCommon = useTranslations("common");

  const SOURCE_TYPES = [
    { value: "rss", label: t("rssType") },
    { value: "prompt", label: t("promptType") },
    { value: "product_page", label: t("productPageType") },
    { value: "calendar_event", label: t("calendarEventType") },
  ] as const;

  const [type, setType] = useState(initialData?.type ?? "rss");
  const [name, setName] = useState(initialData?.name ?? "");
  const [url, setUrl] = useState(asText(initialData?.config.url));
  const [promptText, setPromptText] = useState(asText(initialData?.config.promptText));
  const [eventTitle, setEventTitle] = useState(asText(initialData?.config.title));
  const [eventDate, setEventDate] = useState(asText(initialData?.config.date));
  const [eventDescription, setEventDescription] = useState(asText(initialData?.config.description));
  // Optional public page for the event. Shares the `url` config key with the
  // RSS/product-page field but never the same input — only one of the two is
  // ever submitted, decided by `type`.
  const [eventUrl, setEventUrl] = useState(asText(initialData?.config.url));
  const [sourceLinkPref, setSourceLinkPref] = useState<SourceLinkPref>(
    initialSourceLinkPref(initialData?.config.includeSourceLink)
  );
  const [translateEnabled, setTranslateEnabled] = useState(
    initialData?.config.translateEnabled === true
  );
  // Empty = use the company content language (v2-4).
  const [translateToLanguage, setTranslateToLanguage] = useState(
    asText(initialData?.config.translateToLanguage)
  );
  const [enabled, setEnabled] = useState(initialData?.enabled ?? true);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    let config: Record<string, string | boolean> = {};

    if (type === "rss") {
      config = {
        url: url.trim(),
        ...(sourceLinkPref === "inherit"
          ? {}
          : { includeSourceLink: sourceLinkPref === "include" }),
        // Omitted entirely when off, and the target is omitted when it should
        // follow the company content language.
        ...(translateEnabled
          ? {
              translateEnabled: true,
              ...(translateToLanguage ? { translateToLanguage } : {}),
            }
          : {}),
      };
    } else if (type === "product_page") {
      config = { url: url.trim() };
    } else if (type === "prompt") {
      config = { promptText: promptText.trim() };
    } else if (type === "calendar_event") {
      config = {
        title: eventTitle.trim(),
        date: eventDate.trim(),
        ...(eventDescription.trim() ? { description: eventDescription.trim() } : {}),
        // Omitted entirely when blank — the field is optional, and an empty
        // string would fail the URL validation instead of meaning "not set".
        ...(eventUrl.trim() ? { url: eventUrl.trim() } : {}),
      };
    }

    onSave({ type, name: name.trim(), config, enabled });
  }

  const isEdit = !!initialData;
  // The shared `name` column holds different things per source type. For a
  // calendar event it is who runs the event (DEV.BG, Tuk-Tam) — the event's own
  // name lives in `config.title` — so the field is labelled for that, not
  // "Name". Terminology only: the payload key is unchanged.
  const isCalendar = type === "calendar_event";

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      {/* Type — only visible when adding, locked when editing */}
      <div>
        <label className="text-fg-muted mb-1.5 block text-sm font-medium">{t("sourceType")}</label>
        {isEdit ? (
          <p className="text-fg-muted text-sm">
            {SOURCE_TYPES.find((s) => s.value === type)?.label ?? type}
          </p>
        ) : (
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className={`${BASE} ${NORMAL}`}
          >
            {SOURCE_TYPES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Name — "Organizer" for a calendar event */}
      <div>
        <label className="text-fg-muted mb-1.5 block text-sm font-medium">
          {isCalendar ? t("organizer") : t("name")}
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={isCalendar ? t("organizerPlaceholder") : t("namePlaceholder")}
          className={`${BASE} ${NORMAL}`}
          required
        />
        {isCalendar && <p className="text-fg-faint mt-1 text-xs">{t("organizerHelp")}</p>}
      </div>

      {/* RSS / Product Page — URL */}
      {(type === "rss" || type === "product_page") && (
        <div>
          <label className="text-fg-muted mb-1.5 block text-sm font-medium">
            {type === "rss" ? t("feedUrl") : t("pageUrl")}
          </label>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/feed.xml"
            className={`${BASE} ${NORMAL}`}
            required
          />
        </div>
      )}

      {/* RSS — source link preference (inherit / include / exclude) */}
      {type === "rss" && (
        <div>
          <label className="text-fg-muted mb-1.5 block text-sm font-medium">
            {t("sourceLinkLabel")}
          </label>
          <select
            value={sourceLinkPref}
            onChange={(e) => setSourceLinkPref(e.target.value as SourceLinkPref)}
            className={`${BASE} ${NORMAL}`}
          >
            <option value="inherit">{t("sourceLinkInherit")}</option>
            <option value="include">{t("sourceLinkInclude")}</option>
            <option value="exclude">{t("sourceLinkExclude")}</option>
          </select>
          <p className="text-fg-faint mt-1 text-xs">{t("sourceLinkHelp")}</p>
        </div>
      )}

      {/* RSS — translation (v2-4). Target defaults to the company content language. */}
      {type === "rss" && (
        <div>
          <label className="flex cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              checked={translateEnabled}
              onChange={(e) => setTranslateEnabled(e.target.checked)}
              className="border-border-strong text-status-success-dot focus:ring-accent h-4 w-4 rounded"
            />
            <span className="text-fg-muted text-sm font-medium">{t("translateLabel")}</span>
          </label>
          <p className="text-fg-faint mt-1 text-xs">{t("translateHelp")}</p>

          {translateEnabled && (
            <div className="mt-3">
              <label className="text-fg-muted mb-1.5 block text-sm font-medium">
                {t("translateLanguageLabel")}
              </label>
              <select
                value={translateToLanguage}
                onChange={(e) => setTranslateToLanguage(e.target.value)}
                className={`${BASE} ${NORMAL}`}
              >
                <option value="">{t("translateLanguageDefault")}</option>
                <option value="en">{t("translateLanguageEn")}</option>
                <option value="bg">{t("translateLanguageBg")}</option>
              </select>
              <p className="text-fg-faint mt-1 text-xs">{t("translateLanguageHelp")}</p>
            </div>
          )}
        </div>
      )}

      {/* Prompt */}
      {type === "prompt" && (
        <div>
          <label className="text-fg-muted mb-1.5 block text-sm font-medium">
            {t("promptText")}{" "}
            <span className="text-fg-faint font-normal">{t("promptTextHint")}</span>
          </label>
          <textarea
            rows={5}
            value={promptText}
            onChange={(e) => setPromptText(e.target.value)}
            placeholder={t("promptPlaceholder")}
            className={`${BASE} ${NORMAL} resize-none`}
            maxLength={5000}
            required
          />
          <p className="text-fg-faint mt-1 text-right text-xs">{promptText.length} / 5000</p>
        </div>
      )}

      {/* Calendar Event */}
      {type === "calendar_event" && (
        <>
          <div>
            <label className="text-fg-muted mb-1.5 block text-sm font-medium">
              {t("eventTitle")}
            </label>
            <input
              type="text"
              value={eventTitle}
              onChange={(e) => setEventTitle(e.target.value)}
              placeholder={t("eventTitlePlaceholder")}
              className={`${BASE} ${NORMAL}`}
              required
            />
          </div>
          <div>
            <label className="text-fg-muted mb-1.5 block text-sm font-medium">
              {t("eventDate")}
            </label>
            <input
              type="date"
              value={eventDate}
              onChange={(e) => setEventDate(e.target.value)}
              className={`${BASE} ${NORMAL}`}
              required
            />
          </div>
          <div>
            <label className="text-fg-muted mb-1.5 block text-sm font-medium">
              {t("description")}{" "}
              <span className="text-fg-faint font-normal">{t("descriptionHint")}</span>
            </label>
            <textarea
              rows={3}
              value={eventDescription}
              onChange={(e) => setEventDescription(e.target.value)}
              placeholder={t("eventDescPlaceholder")}
              className={`${BASE} ${NORMAL} resize-none`}
            />
          </div>
          <div>
            <label className="text-fg-muted mb-1.5 block text-sm font-medium">
              {t("eventUrl")} <span className="text-fg-faint font-normal">{t("eventUrlHint")}</span>
            </label>
            <input
              type="url"
              value={eventUrl}
              onChange={(e) => setEventUrl(e.target.value)}
              placeholder="https://example.com/events/2026"
              className={`${BASE} ${NORMAL}`}
            />
            <p className="text-fg-faint mt-1 text-xs">{t("eventUrlHelp")}</p>
          </div>
        </>
      )}

      {/* Active */}
      <label className="flex cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="border-border-strong text-status-success-dot focus:ring-accent h-4 w-4 rounded"
        />
        <span className="text-fg-muted text-sm font-medium">{t("activeLabel")}</span>
      </label>

      <div className="flex items-center gap-3 pt-1">
        <Button type="submit" variant="primary" size="sm" loading={saving}>
          {saving ? tCommon("saving") : isEdit ? tCommon("save") : t("addSource")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {tCommon("cancel")}
        </Button>
      </div>
    </form>
  );
}
