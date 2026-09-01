"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Modal } from "@/components/ui/Modal";
import { Badge } from "@/components/ui/Badge";
import { Alert } from "@/components/ui/Alert";
import type { CompetitorContentDetail } from "@/lib/services/competitive-analysis/competitor-content-dto";
import { relevanceBadgeVariant } from "./content-panel";

interface Props {
  slug: string;
  intelligenceId: string;
  onClose: () => void;
}

/** Full detail for one observed content item — the "View details" destination
 *  from the Content list (§15/§16). Fetches on open rather than being
 *  pre-loaded with the list, keeping the list response light. */
export function ContentItemDetail({ slug, intelligenceId, onClose }: Props) {
  const t = useTranslations("competitiveAnalysis.content");
  const tCommon = useTranslations("common");

  const [item, setItem] = useState<CompetitorContentDetail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError("");
      try {
        const res = await fetch(
          `/api/v1/companies/${slug}/competitive-analysis/content/${intelligenceId}`
        );
        if (!res.ok) throw new Error(tCommon("somethingWentWrong"));
        const json = (await res.json()) as { item: CompetitorContentDetail };
        if (!cancelled) setItem(json.item);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [slug, intelligenceId, tCommon]);

  const field = (label: string, value: string | null | undefined) =>
    value ? (
      <div>
        <div className="text-fg-faint text-micro font-medium tracking-wide uppercase">{label}</div>
        <div className="text-fg text-sm">{value}</div>
      </div>
    ) : null;

  return (
    <Modal open onClose={onClose} title={t("detailTitle")} maxWidth="3xl">
      {loading && <p className="text-fg-faint text-sm">{tCommon("loading")}</p>}
      {error && <Alert variant="error">{error}</Alert>}

      {item && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={relevanceBadgeVariant(item.relevance)}>
              {t(`relevance.${item.relevance}`)}
            </Badge>
            <Badge variant="neutral">{item.competitorName}</Badge>
            <Badge variant="readonly">{t(`platform.${item.platform}`)}</Badge>
            {item.status !== "completed" && (
              <Badge variant="warning">{t(`status.${item.status}`)}</Badge>
            )}
          </div>

          {item.title && <h3 className="text-fg text-base font-semibold">{item.title}</h3>}

          {item.content && (
            <div className="border-border-subtle bg-surface-subtle max-h-64 overflow-y-auto rounded-md border p-3">
              <p className="text-fg-muted text-sm whitespace-pre-wrap">{item.content}</p>
            </div>
          )}

          {item.relevanceReason && (
            <Alert variant={item.relevance === "out_of_scope" ? "warning" : "success"}>
              {item.relevanceReason}
              {item.matchedResearchTopics.length > 0 && (
                <span className="ml-1 font-medium">({item.matchedResearchTopics.join(", ")})</span>
              )}
            </Alert>
          )}

          {item.analysisError && <Alert variant="error">{item.analysisError}</Alert>}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {field(t("fields.topic"), item.topic)}
            {field(t("fields.subtopic"), item.subtopic)}
            {field(t("fields.angle"), item.angle)}
            {field(
              t("fields.contentType"),
              item.contentType ? t(`contentType.${item.contentType}`) : null
            )}
            {field(t("fields.hookType"), item.hookType ? t(`hookType.${item.hookType}`) : null)}
            {field(
              t("fields.structurePattern"),
              item.structurePattern ? t(`structurePattern.${item.structurePattern}`) : null
            )}
            {field(
              t("fields.angleCategory"),
              item.angleCategory ? t(`angleCategory.${item.angleCategory}`) : null
            )}
            {field(
              t("fields.commercialIntent"),
              item.commercialIntent ? t(`commercialIntent.${item.commercialIntent}`) : null
            )}
            {field(t("fields.ctaType"), item.ctaType ? t(`ctaType.${item.ctaType}`) : null)}
            {field(t("fields.targetAudience"), item.targetAudience)}
            {field(t("fields.tone"), item.tone)}
            {field(t("fields.originalLanguage"), item.originalLanguage)}
          </div>

          {field(t("fields.summary"), item.summary)}
          {field(t("fields.keyMessage"), item.keyMessage)}
          {field(t("fields.problemAddressed"), item.problemAddressed)}
          {field(t("fields.ctaText"), item.ctaText)}
          {item.productsServicesMentioned.length > 0 &&
            field(t("fields.productsServicesMentioned"), item.productsServicesMentioned.join(", "))}

          <div className="border-border flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs">
            <span className="text-fg-faint">{item.dateKnown ? item.date : t("unknownDate")}</span>
            {item.sourceUrl && (
              <a
                href={item.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:text-fg"
              >
                {t("viewSource")}
              </a>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
