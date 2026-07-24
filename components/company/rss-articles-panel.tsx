"use client";

import { useState, useCallback } from "react";
import { ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";
import { Alert } from "@/components/ui/Alert";
import type { FeedItemRow } from "@/lib/services/company/list-feed-items.service";
import { formatDate as formatSharedDate } from "@/lib/i18n/format-date";

interface Props {
  slug: string;
  sourceId: string;
  canManage: boolean;
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  return formatSharedDate(iso);
}

function contentSnippet(content: string | null): string {
  if (!content) return "";
  const plain = content
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > 160 ? plain.slice(0, 160) + "…" : plain;
}

/**
 * Translation status badge (v2-4). "skipped" and null both mean the post is
 * written from the original article, so they share the "original" label.
 */
function TranslationBadge({ item }: { item: FeedItemRow }) {
  const t = useTranslations("feedItems");

  const STYLES: Record<string, string> = {
    completed: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
    pending: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
    failed: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
    original: "bg-surface-subtle text-fg-faint",
  };

  const status = item.translationStatus;
  // `translating` is a transient in-flight claim — show it as pending to the user.
  const key =
    status === "completed" || status === "failed"
      ? status
      : status === "pending" || status === "translating"
        ? "pending"
        : "original";

  const label =
    key === "completed"
      ? t("translationCompleted", { lang: (item.translationLanguage ?? "").toUpperCase() })
      : key === "pending"
        ? t("translationPending")
        : key === "failed"
          ? t("translationFailed")
          : t("translationOriginal");

  return (
    <span className={`text-micro rounded px-1.5 py-0.5 font-medium ${STYLES[key]}`}>{label}</span>
  );
}

interface ArticleRowProps {
  slug: string;
  sourceId: string;
  item: FeedItemRow;
  canManage: boolean;
  onToggle: (id: string, enabled: boolean) => void;
}

function ArticleRow({ slug, sourceId, item, canManage, onToggle }: ArticleRowProps) {
  const t = useTranslations("feedItems");
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState("");

  async function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const next = e.target.checked;
    setToggling(true);
    setError("");
    try {
      const res = await fetch(
        `/api/v1/companies/${slug}/content-sources/${sourceId}/feed-items/${item.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: next }),
        }
      );
      if (!res.ok) throw new Error();
      onToggle(item.id, next);
    } catch {
      setError(t("toggleError"));
    } finally {
      setToggling(false);
    }
  }

  return (
    <li className="border-border flex items-start gap-3 border-b py-3 last:border-0">
      {/* Toggle */}
      <div className="mt-0.5 shrink-0">
        {canManage ? (
          <input
            type="checkbox"
            role="switch"
            aria-checked={item.enabled}
            checked={item.enabled}
            disabled={toggling}
            onChange={handleChange}
            className="accent-fg h-4 w-4 cursor-pointer rounded-sm disabled:cursor-wait"
          />
        ) : (
          <span
            className={`inline-block h-2 w-2 rounded-full ${item.enabled ? "bg-green-500" : "bg-border"}`}
          />
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p
            className={`text-sm leading-snug font-medium ${item.enabled ? "text-fg" : "text-fg-faint"}`}
          >
            {item.title ?? t("noTitle")}
          </p>
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-fg-faint hover:text-accent shrink-0 transition-colors"
            aria-label={t("viewOriginal")}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>

        {item.publishedAt && (
          <p className="text-fg-faint mt-0.5 text-xs">{formatDate(item.publishedAt)}</p>
        )}

        {contentSnippet(item.content) && (
          <p className="text-fg-muted mt-1 text-xs leading-relaxed">
            {contentSnippet(item.content)}
          </p>
        )}

        {item.translationStatus === "failed" && item.translationError && (
          <p className="text-fg-faint mt-1 text-xs">
            {t("translationErrorSummary", { error: item.translationError })}
          </p>
        )}

        {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
      </div>

      {/* State badges */}
      <div className="mt-0.5 flex shrink-0 flex-col items-end gap-1">
        <span
          className={`text-micro rounded px-1.5 py-0.5 font-medium ${
            item.enabled
              ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
              : "bg-surface-subtle text-fg-faint"
          }`}
        >
          {item.enabled ? t("enabled") : t("disabled")}
        </span>
        <TranslationBadge item={item} />
      </div>
    </li>
  );
}

export function RssArticlesPanel({ slug, sourceId, canManage }: Props) {
  const t = useTranslations("feedItems");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<FeedItemRow[] | null>(null);
  const [loadError, setLoadError] = useState("");

  const load = useCallback(async () => {
    if (items !== null) return; // already loaded
    setLoading(true);
    setLoadError("");
    try {
      const res = await fetch(`/api/v1/companies/${slug}/content-sources/${sourceId}/feed-items`);
      if (!res.ok) throw new Error();
      const json = (await res.json()) as { items: FeedItemRow[] };
      setItems(json.items);
    } catch {
      setLoadError(t("loadError"));
    } finally {
      setLoading(false);
    }
  }, [slug, sourceId, items, t]);

  function handleOpen() {
    setOpen(true);
    void load();
  }

  function handleToggle(id: string, enabled: boolean) {
    setItems((prev) => prev?.map((it) => (it.id === id ? { ...it, enabled } : it)) ?? prev);
  }

  const count = items?.length ?? 0;

  return (
    <div className="border-border mt-4 border-t border-dashed pt-4">
      {/* Toggle button */}
      <button
        type="button"
        onClick={open ? () => setOpen(false) : handleOpen}
        className="text-fg-muted hover:text-fg text-xs font-medium transition-colors"
      >
        {loading
          ? t("articlesButtonLoading")
          : open
            ? `▲ ${t("articlesButton", { count })}`
            : `▼ ${items === null ? t("articlesButton", { count: "…" }) : t("articlesButton", { count })}`}
      </button>

      {/* Panel */}
      {open && (
        <div className="mt-3">
          {loadError && (
            <Alert variant="error" className="mb-3">
              {loadError}
            </Alert>
          )}
          {!loading && items !== null && items.length === 0 && (
            <p className="text-fg-faint text-xs">{t("noArticles")}</p>
          )}
          {!canManage && items !== null && items.length > 0 && (
            <p className="text-fg-faint mb-2 text-xs">{t("ownersOnly")}</p>
          )}
          {items !== null && items.length > 0 && (
            <ul className="max-h-96 overflow-y-auto">
              {items.map((item) => (
                <ArticleRow
                  key={item.id}
                  slug={slug}
                  sourceId={sourceId}
                  item={item}
                  canManage={canManage}
                  onToggle={handleToggle}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
