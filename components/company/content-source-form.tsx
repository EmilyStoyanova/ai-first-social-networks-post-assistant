"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import type { ContentSourceItem } from "@/lib/services/company/list-content-sources.service";

export interface ContentSourcePayload {
  type: string;
  name: string;
  config: Record<string, string>;
  enabled: boolean;
}

interface Props {
  initialData?: ContentSourceItem;
  saving: boolean;
  onSave: (data: ContentSourcePayload) => void;
  onCancel: () => void;
}

const BASE =
  "w-full rounded-lg border px-3.5 py-2.5 text-sm outline-none transition-all duration-200 focus:ring-2 focus:ring-offset-0";
const NORMAL = "border-gray-300 bg-white focus:border-green-500 focus:ring-green-100";

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
  const [url, setUrl] = useState(initialData?.config.url ?? "");
  const [promptText, setPromptText] = useState(initialData?.config.promptText ?? "");
  const [eventTitle, setEventTitle] = useState(initialData?.config.title ?? "");
  const [eventDate, setEventDate] = useState(initialData?.config.date ?? "");
  const [eventDescription, setEventDescription] = useState(initialData?.config.description ?? "");
  const [enabled, setEnabled] = useState(initialData?.enabled ?? true);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    let config: Record<string, string> = {};

    if (type === "rss" || type === "product_page") {
      config = { url: url.trim() };
    } else if (type === "prompt") {
      config = { promptText: promptText.trim() };
    } else if (type === "calendar_event") {
      config = {
        title: eventTitle.trim(),
        date: eventDate.trim(),
        ...(eventDescription.trim() ? { description: eventDescription.trim() } : {}),
      };
    }

    onSave({ type, name: name.trim(), config, enabled });
  }

  const isEdit = !!initialData;

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      {/* Type — only visible when adding, locked when editing */}
      <div>
        <label className="mb-1.5 block text-sm font-medium text-gray-700">{t("sourceType")}</label>
        {isEdit ? (
          <p className="text-sm text-gray-600">
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

      {/* Name */}
      <div>
        <label className="mb-1.5 block text-sm font-medium text-gray-700">{t("name")}</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("namePlaceholder")}
          className={`${BASE} ${NORMAL}`}
          required
        />
      </div>

      {/* RSS / Product Page — URL */}
      {(type === "rss" || type === "product_page") && (
        <div>
          <label className="mb-1.5 block text-sm font-medium text-gray-700">
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

      {/* Prompt */}
      {type === "prompt" && (
        <div>
          <label className="mb-1.5 block text-sm font-medium text-gray-700">
            {t("promptText")}{" "}
            <span className="font-normal text-gray-400">{t("promptTextHint")}</span>
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
          <p className="mt-1 text-right text-xs text-gray-400">{promptText.length} / 5000</p>
        </div>
      )}

      {/* Calendar Event */}
      {type === "calendar_event" && (
        <>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700">
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
            <label className="mb-1.5 block text-sm font-medium text-gray-700">
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
            <label className="mb-1.5 block text-sm font-medium text-gray-700">
              {t("description")}{" "}
              <span className="font-normal text-gray-400">{t("descriptionHint")}</span>
            </label>
            <textarea
              rows={3}
              value={eventDescription}
              onChange={(e) => setEventDescription(e.target.value)}
              placeholder={t("eventDescPlaceholder")}
              className={`${BASE} ${NORMAL} resize-none`}
            />
          </div>
        </>
      )}

      {/* Active */}
      <label className="flex cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-4 w-4 rounded border-gray-300 text-green-500 focus:ring-green-500"
        />
        <span className="text-sm font-medium text-gray-700">{t("activeLabel")}</span>
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
