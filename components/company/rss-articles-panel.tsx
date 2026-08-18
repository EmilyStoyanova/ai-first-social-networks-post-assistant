"use client";

import { useState, useCallback } from "react";
import { ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";
import { Alert } from "@/components/ui/Alert";
import type {
  FeedItemRow,
  FeedItemClassificationCounts,
} from "@/lib/services/company/list-feed-items.service";
import {
  FEED_ITEM_CLASSIFICATION_FILTERS,
  classificationStateOf,
  isDiagnosticFilter,
  type FeedItemClassificationFilter,
  type FeedItemClassificationState,
} from "@/lib/posts/feed-item-classification-filter";
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

/**
 * The topic verdict badge.
 *
 * `failed` and `pending` have their own labels and are NEVER shown as rejected:
 * "we could not ask" and "the company does not want this" are opposite claims,
 * and conflating them would make an outage look like an editorial decision.
 *
 * `used` is here for the mirror-image reason. A consumed article is never
 * reclassified, so a status of `pending` frozen on the day it was written from
 * would otherwise render as "awaiting review" for the rest of time — a queue
 * position in a queue it has left.
 */
const CLASSIFICATION_STYLES: Record<FeedItemClassificationState, string> = {
  high: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  medium: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  rejected: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  pending: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  failed: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
  used: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400",
  skipped: "bg-surface-subtle text-fg-faint",
  unclassified: "bg-surface-subtle text-fg-faint",
};

function ClassificationBadge({ item }: { item: FeedItemRow }) {
  const t = useTranslations("feedItems.classification");
  const state = classificationStateOf(item);

  // Nothing to say about a source the feature does not cover, or a row from
  // before it existed — a badge there would be noise, not information.
  if (state === "unclassified") return null;

  const reason = item.classificationRejectionReason;
  const label =
    state === "rejected" && reason === "BLACKLIST"
      ? t("rejectedBlacklist")
      : state === "rejected" && reason === "OUT_OF_SCOPE"
        ? t("rejectedOutOfScope")
        : t(state);

  // A used article's tooltip explains the absence of a verdict; every other
  // state's explains the verdict itself.
  const title = state === "used" ? t("usedHint") : (item.classificationReason ?? undefined);

  return (
    <span
      className={`text-micro rounded px-1.5 py-0.5 font-medium ${CLASSIFICATION_STYLES[state]}`}
      title={title}
    >
      {label}
    </span>
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
  const tc = useTranslations("feedItems.classification");
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState("");
  // The verdict's evidence is opened per row, never listed: a reason on every
  // line would bury the titles the list exists to show.
  const [showWhy, setShowWhy] = useState(false);
  const state = classificationStateOf(item);
  // A failure has no reason and no matched topics, so without its error there
  // would be nothing behind the toggle — and that is exactly the row an owner
  // most wants to open.
  const hasWhy =
    item.classificationReason !== null ||
    item.classificationMatchedTopics.length > 0 ||
    (state === "failed" && item.classificationError !== null);

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
          {/* Only when there is a real page behind it. A prompt or calendar
              item's stored url is an internal key, not somewhere to send a
              user. */}
          {item.publicUrl && (
            <a
              href={item.publicUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-fg-faint hover:text-accent shrink-0 transition-colors"
              aria-label={t("viewOriginal")}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
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

        {/* Why this verdict — collapsed by default, so the list stays readable. */}
        {hasWhy && (
          <button
            type="button"
            onClick={() => setShowWhy((v) => !v)}
            aria-expanded={showWhy}
            className="text-fg-faint hover:text-fg mt-1 text-xs underline-offset-2 transition-colors hover:underline"
          >
            {showWhy ? tc("hideWhy") : tc("showWhy")}
          </button>
        )}
        {showWhy && (
          <div className="text-fg-muted mt-1 text-xs leading-relaxed">
            {item.classificationMatchedTopics.length > 0 && (
              <p>{tc("matchedTopics", { topics: item.classificationMatchedTopics.join(", ") })}</p>
            )}
            {item.classificationReason && <p className="mt-0.5">{item.classificationReason}</p>}
            {state === "failed" && (
              <>
                {item.classificationError && (
                  <p className="mt-0.5">{tc("failedError", { error: item.classificationError })}</p>
                )}
                <p className="mt-0.5">{tc("failedHint")}</p>
              </>
            )}
          </div>
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
        {/* Independent of the toggle above, and shown alongside it on purpose:
            a disabled HIGH article is a legitimate, visible state — the person
            overruled the classifier, and both facts stay true. */}
        <ClassificationBadge item={item} />
        <TranslationBadge item={item} />
      </div>
    </li>
  );
}

export function RssArticlesPanel({ slug, sourceId, canManage }: Props) {
  const t = useTranslations("feedItems");
  const tc = useTranslations("feedItems.classification");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<FeedItemRow[] | null>(null);
  const [counts, setCounts] = useState<FeedItemClassificationCounts | null>(null);
  const [filter, setFilter] = useState<FeedItemClassificationFilter>("all");
  const [loadError, setLoadError] = useState("");
  const [reclassifying, setReclassifying] = useState(false);
  const [reclassified, setReclassified] = useState<number | null>(null);

  /**
   * Always refetches. The filter is applied by the SERVER over the whole source,
   * so changing it is a new question and not a re-slice of what is in memory —
   * see lib/posts/feed-item-classification-filter.ts.
   */
  const load = useCallback(
    async (next: FeedItemClassificationFilter) => {
      setLoading(true);
      setLoadError("");
      try {
        const url = `/api/v1/companies/${slug}/content-sources/${sourceId}/feed-items?classification=${next}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error();
        const json = (await res.json()) as {
          items: FeedItemRow[];
          counts: FeedItemClassificationCounts;
        };
        setItems(json.items);
        setCounts(json.counts);
      } catch {
        setLoadError(t("loadError"));
      } finally {
        setLoading(false);
      }
    },
    [slug, sourceId, t]
  );

  function handleOpen() {
    setOpen(true);
    if (items === null) void load(filter);
  }

  function handleFilter(next: FeedItemClassificationFilter) {
    setFilter(next);
    void load(next);
  }

  function handleToggle(id: string, enabled: boolean) {
    setItems((prev) => prev?.map((it) => (it.id === id ? { ...it, enabled } : it)) ?? prev);
  }

  /**
   * Queues the EXISTING classification drain — no LLM call happens in this
   * request. Scoped to THIS source, which is the source the button sits inside:
   * the number it reports back has to be checkable against the list below it.
   * The list is reloaded so a verdict that has already settled shows up;
   * anything still queued appears on the next open.
   */
  async function handleReclassify() {
    setReclassifying(true);
    setReclassified(null);
    setLoadError("");
    try {
      const res = await fetch(`/api/v1/companies/${slug}/content-sources/${sourceId}/reclassify`, {
        method: "POST",
      });
      if (!res.ok) throw new Error();
      const json = (await res.json()) as { data: { reopened: number } };
      setReclassified(json.data.reopened);
      await load(filter);
    } catch {
      setLoadError(tc("reclassifyError"));
    } finally {
      setReclassifying(false);
    }
  }

  const count = counts?.all ?? items?.length ?? 0;

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
          {/* Priority filter — server-side, so the counts are the source's
              totals rather than the loaded page's. */}
          {counts !== null && (
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              {FEED_ITEM_CLASSIFICATION_FILTERS.filter(
                (key) => !isDiagnosticFilter(key) || counts[key] > 0 || filter === key
              ).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => handleFilter(key)}
                  aria-pressed={filter === key}
                  disabled={loading}
                  className={`text-micro rounded-full px-2.5 py-1 font-medium transition-colors disabled:opacity-50 ${
                    filter === key
                      ? "bg-fg text-surface"
                      : "bg-surface-subtle text-fg-muted hover:text-fg"
                  }`}
                >
                  {tc(`filter.${key}`)} ({counts[key]})
                </button>
              ))}

              {canManage && (
                <button
                  type="button"
                  onClick={handleReclassify}
                  disabled={reclassifying || loading}
                  className="text-micro text-fg-muted hover:text-fg ml-auto font-medium underline-offset-2 transition-colors hover:underline disabled:opacity-50"
                >
                  {reclassifying ? tc("reclassifying") : tc("reclassify")}
                </button>
              )}
            </div>
          )}

          {/* Both messages name THIS source, because the action did. "0 queued"
              on its own reads like a failure, when it usually means the source
              was already up to date. */}
          {reclassified !== null && (
            <Alert variant="success" className="mb-3">
              {reclassified === 0
                ? tc("reclassifyQueuedNone")
                : tc("reclassifyQueued", { count: reclassified })}
            </Alert>
          )}

          {!loading && items !== null && items.length === 0 && (
            <p className="text-fg-faint text-xs">
              {filter === "all" ? t("noArticles") : tc("noneMatchFilter")}
            </p>
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
