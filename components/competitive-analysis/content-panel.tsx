"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Plus, MessageSquarePlus } from "lucide-react";
import { useApiErrorMessage } from "@/lib/i18n/api-error";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { ManualEntryForm } from "./manual-entry-form";
import { ContentItemDetail } from "./content-item-detail";
import type { CompetitorContentItem } from "@/lib/services/competitive-analysis/competitor-content-dto";
import type { ManualEntryItem } from "@/lib/services/competitive-analysis/create-manual-entry.service";
import {
  relevanceDisplayState,
  type RelevanceDisplayState,
} from "@/lib/services/competitive-analysis/relevance-display-state";

const FIELD =
  "text-body rounded-control border-border-strong bg-surface text-fg h-9 border px-3 outline-none transition-all duration-fast focus:border-accent focus:ring-2 focus:ring-accent/20 focus:ring-offset-0";

type RelevanceFilter = "" | "relevant" | "related" | "out_of_scope" | "pending";
type OriginFilter = "" | "feed_item" | "manual_entry";

/** Badge colour per TRUTHFUL display state (2026-09 relevance-UI fix) — keyed
 *  on `RelevanceDisplayState`, not the raw `relevance` column, so "failed"
 *  and "profile not configured" are visually distinct from a genuine
 *  "pending" instead of all three collapsing into one grey chip. */
export function relevanceBadgeVariant(
  state: RelevanceDisplayState
): "success" | "warning" | "neutral" | "readonly" | "danger" {
  switch (state) {
    case "relevant":
      return "success";
    case "related":
      return "warning";
    case "out_of_scope":
      return "neutral";
    case "failed":
      return "danger";
    default:
      // pending / profile_not_configured — both genuinely unresolved, and
      // neither is an error state.
      return "readonly";
  }
}

interface Props {
  slug: string;
  initialItems: CompetitorContentItem[];
  competitors: Array<{ id: string; name: string }>;
  canManage: boolean;
  /** The company's Research Profile `persisted` flag — see
   *  `relevance-display-state.ts` for why a lazily-computed default must not
   *  be treated as configured. */
  profileConfigured: boolean;
}

/**
 * Competitive Analysis → Content, real implementation (Part 3B §16, replacing
 * the Part 3A placeholder). "Observed content from monitored competitor
 * sources" — truthful wording (§16): monitoring may be incomplete, so this is
 * never framed as an exhaustive "all competitor posts" view.
 */
export function ContentPanel({
  slug,
  initialItems,
  competitors,
  canManage,
  profileConfigured,
}: Props) {
  const t = useTranslations("competitiveAnalysis.content");
  const tCommon = useTranslations("common");
  const apiError = useApiErrorMessage();

  const [items, setItems] = useState(initialItems);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [competitorId, setCompetitorId] = useState("");
  const [origin, setOrigin] = useState<OriginFilter>("");
  const [relevance, setRelevance] = useState<RelevanceFilter>("");

  const [showAddForm, setShowAddForm] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (competitorId) params.set("competitorId", competitorId);
      if (origin) params.set("origin", origin);
      if (relevance) params.set("relevance", relevance);
      const res = await fetch(
        `/api/v1/companies/${slug}/competitive-analysis/content?${params.toString()}`
      );
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error));
      }
      const json = (await res.json()) as { items: CompetitorContentItem[] };
      setItems(json.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setLoading(false);
    }
  }, [slug, competitorId, origin, relevance, apiError, tCommon]);

  // Re-fetch whenever a filter changes — skipped on first mount, which already
  // has the server-rendered initial list. A ref (not state) tracks that, since
  // triggering a render from inside the effect is exactly what caused the
  // cascading-render lint failure this replaced.
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [competitorId, origin, relevance]);

  function handleCreated(_entry: ManualEntryItem) {
    setShowAddForm(false);
    void load();
  }

  return (
    <div className="space-y-4">
      <p className="text-fg-faint text-xs">{t("observedNote")}</p>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={competitorId}
          onChange={(e) => setCompetitorId(e.target.value)}
          className={`${FIELD} w-44`}
        >
          <option value="">{t("filters.allCompetitors")}</option>
          {competitors.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>

        <select
          value={origin}
          onChange={(e) => setOrigin(e.target.value as OriginFilter)}
          className={`${FIELD} w-36`}
        >
          <option value="">{t("filters.allOrigins")}</option>
          <option value="feed_item">{t("filters.originRss")}</option>
          <option value="manual_entry">{t("filters.originManual")}</option>
        </select>

        <select
          value={relevance}
          onChange={(e) => setRelevance(e.target.value as RelevanceFilter)}
          className={`${FIELD} w-40`}
        >
          <option value="">{t("filters.allRelevance")}</option>
          <option value="relevant">{t("relevanceState.relevant")}</option>
          <option value="related">{t("relevanceState.related")}</option>
          <option value="out_of_scope">{t("relevanceState.out_of_scope")}</option>
          {/* Filters on the PERSISTED `relevance` column, so this one option
              covers every unresolved row — genuinely pending, failed after
              exhausted retries, and (when no Research Profile is saved) all
              of them. The card badge still distinguishes those three; see
              `relevance-display-state.ts`. */}
          <option value="pending">{t("filters.relevanceUnresolved")}</option>
        </select>

        {canManage && competitors.length > 0 && (
          <Button
            variant="secondary"
            size="sm"
            className="ml-auto"
            onClick={() => setShowAddForm(true)}
            leftIcon={<Plus size={14} aria-hidden="true" />}
          >
            {t("addContent")}
          </Button>
        )}
      </div>

      {error && <Alert variant="error">{error}</Alert>}
      {loading && <p className="text-fg-faint text-xs">{tCommon("loading")}</p>}

      {!loading && items.length === 0 ? (
        <EmptyState
          icon={<MessageSquarePlus className="h-5 w-5" />}
          title={t("emptyTitle")}
          description={t("emptyDesc")}
        />
      ) : (
        <div className="space-y-2">
          {items.map((item) => {
            const state = relevanceDisplayState(item, profileConfigured);
            // The strongest matched topic — first is strongest by the model's
            // own ordering (see competitor-relevance.ts's prompt). Shown only
            // for a genuinely relevant/related row, and only one, to keep the
            // card compact.
            const topMatchedTopic =
              (state === "relevant" || state === "related") && item.matchedResearchTopics.length > 0
                ? item.matchedResearchTopics[0]
                : null;
            return (
              <div
                key={item.id}
                role="button"
                tabIndex={0}
                onClick={() => setDetailId(item.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setDetailId(item.id);
                  }
                }}
                className="focus-ring rounded-card cursor-pointer"
              >
                <Card variant="hover" className="px-4 py-3">
                  <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                    <Badge variant={relevanceBadgeVariant(state)}>
                      {t(`relevanceState.${state}`)}
                    </Badge>
                    {topMatchedTopic && <Badge variant="accent">{topMatchedTopic}</Badge>}
                    <Badge variant="neutral">{item.competitorName}</Badge>
                    <Badge variant="readonly">{t(`platform.${item.platform}`)}</Badge>
                    {item.status !== "completed" && (
                      <Badge variant="warning">{t(`status.${item.status}`)}</Badge>
                    )}
                    <span className="text-fg-faint ml-auto text-xs">
                      {item.dateKnown ? item.date?.slice(0, 10) : t("unknownDate")}
                    </span>
                  </div>

                  {item.title && <p className="text-fg mb-1 text-sm font-medium">{item.title}</p>}
                  {item.excerpt && (
                    <p className="text-fg-muted mb-2 line-clamp-2 text-xs">{item.excerpt}</p>
                  )}

                  <div className="flex flex-wrap gap-1.5 text-xs">
                    {item.topic && <Badge variant="accent">{item.topic}</Badge>}
                    {item.contentType && (
                      <Badge variant="readonly">{t(`contentType.${item.contentType}`)}</Badge>
                    )}
                    {item.hookType && item.hookType !== "none" && (
                      <Badge variant="readonly">{t(`hookType.${item.hookType}`)}</Badge>
                    )}
                    {item.structurePattern && (
                      <Badge variant="readonly">
                        {t(`structurePattern.${item.structurePattern}`)}
                      </Badge>
                    )}
                  </div>
                </Card>
              </div>
            );
          })}
        </div>
      )}

      {showAddForm && (
        <Modal open onClose={() => setShowAddForm(false)} title={t("addContent")}>
          <ManualEntryForm
            slug={slug}
            competitors={competitors}
            onCreated={handleCreated}
            onCancel={() => setShowAddForm(false)}
          />
        </Modal>
      )}

      {detailId && (
        <ContentItemDetail
          slug={slug}
          intelligenceId={detailId}
          onClose={() => setDetailId(null)}
          profileConfigured={profileConfigured}
        />
      )}
    </div>
  );
}
