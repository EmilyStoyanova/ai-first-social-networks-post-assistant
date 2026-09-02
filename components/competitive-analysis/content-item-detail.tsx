"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Modal } from "@/components/ui/Modal";
import { Badge } from "@/components/ui/Badge";
import { Alert } from "@/components/ui/Alert";
import type { CompetitorContentDetail } from "@/lib/services/competitive-analysis/competitor-content-dto";
import { relevanceBadgeVariant } from "./content-panel";
import { relevanceDisplayState } from "@/lib/services/competitive-analysis/relevance-display-state";
import { resolveRelevanceReason } from "@/lib/services/competitive-analysis/relevance-reason";
import { languageDisplayName } from "@/lib/i18n/language-name";

interface Props {
  slug: string;
  intelligenceId: string;
  onClose: () => void;
  /** See `relevance-display-state.ts` — the Research Profile's `persisted`
   *  flag, threaded down from the page so the drawer tells the same truth
   *  the list card does. */
  profileConfigured: boolean;
}

/** Full detail for one observed content item — the "View details" destination
 *  from the Content list (§15/§16). Fetches on open rather than being
 *  pre-loaded with the list, keeping the list response light. */
export function ContentItemDetail({ slug, intelligenceId, onClose, profileConfigured }: Props) {
  const t = useTranslations("competitiveAnalysis.content");
  const tCommon = useTranslations("common");
  const locale = useLocale();

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
            <Badge variant={relevanceBadgeVariant(relevanceDisplayState(item, profileConfigured))}>
              {t(`relevanceState.${relevanceDisplayState(item, profileConfigured)}`)}
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

          {/* Relevance section (2026-09 relevance-UI fix) — a dedicated,
              truthfully-worded block, NOT engagement or performance data.
              Every field renders only when genuinely available; nothing here
              is inferred or back-filled. */}
          {(() => {
            const state = relevanceDisplayState(item, profileConfigured);
            return (
              <div className="border-border-subtle rounded-md border p-3">
                <div className="text-fg-faint text-micro mb-2 font-medium tracking-wide uppercase">
                  {t("relevanceSection.title")}
                </div>

                <div className="mb-2">
                  <Badge variant={relevanceBadgeVariant(state)}>
                    {t(`relevanceState.${state}`)}
                  </Badge>
                </div>

                {state === "profile_not_configured" && (
                  <p className="text-fg-muted text-sm">
                    {t("relevanceSection.profileNotConfigured")}
                  </p>
                )}

                {state === "pending" && (
                  <p className="text-fg-muted text-sm">{t("relevanceSection.pendingExplain")}</p>
                )}

                {/* A failed evaluation shows the truthful fact that it failed
                    and is no longer being retried — never the raw provider
                    error text, which can carry internal/provider detail. */}
                {state === "failed" && (
                  <p className="text-fg-muted text-sm">{t("relevanceSection.failedExplain")}</p>
                )}

                {(state === "relevant" || state === "related" || state === "out_of_scope") && (
                  <div className="space-y-2">
                    {item.matchedResearchTopics.length > 0 && (
                      <div>
                        <div className="text-fg-faint text-micro font-medium tracking-wide uppercase">
                          {t("relevanceSection.matchedTopics")}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {item.matchedResearchTopics.map((topic) => (
                            <Badge key={topic} variant="accent">
                              {topic}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* The reason column holds two different kinds of value —
                        a canonical code this function localizes, or the
                        model's own sentence (already written in the company's
                        analysis language). `resolveRelevanceReason` tells them
                        apart, including for rows written before that split
                        existed. See `relevance-reason.ts`. */}
                    {(() => {
                      const reason = resolveRelevanceReason(item.relevanceReason);
                      if (!reason) return null;
                      return (
                        <div>
                          <div className="text-fg-faint text-micro font-medium tracking-wide uppercase">
                            {t("relevanceSection.reason")}
                          </div>
                          <p className="text-fg text-sm">
                            {reason.kind === "code"
                              ? t(`relevanceSection.reasonCode.${reason.code}`)
                              : reason.text}
                          </p>
                        </div>
                      );
                    })()}
                  </div>
                )}

                {(item.relevanceProfileVersion !== null || item.relevanceEvaluatedAt !== null) && (
                  <div className="text-fg-faint mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                    {item.relevanceProfileVersion !== null && (
                      <span>
                        {t("relevanceSection.profileVersion", {
                          version: item.relevanceProfileVersion,
                        })}
                      </span>
                    )}
                    {item.relevanceEvaluatedAt && (
                      <span>
                        {t("relevanceSection.evaluatedAt", {
                          date: new Date(item.relevanceEvaluatedAt).toLocaleString(),
                        })}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          {/* The analysis error is delivered ALREADY CLASSIFIED by the DTO —
              a deterministic condition this pipeline decided on purpose, or
              `unknown` for arbitrary provider/internal failure text. Only the
              deterministic ones get a specific message; `unknown` gets one
              honest generic line, because the raw text is a diagnostic written
              for the logs, is not localizable, and may carry internal detail.
              The generic line only PROMISES an automatic retry when one is
              genuinely still coming — `retryable` is decided server-side from
              the drain's own attempt cap. See `analysis-error.ts`. */}
          {item.analysisError && (
            <Alert variant="error">
              {item.analysisError.kind === "no_readable_content"
                ? t("analysisError.no_readable_content")
                : item.analysisError.kind === "content_too_short"
                  ? item.analysisError.chars !== null && item.analysisError.minimum !== null
                    ? t("analysisError.content_too_short_detail", {
                        chars: item.analysisError.chars,
                        minimum: item.analysisError.minimum,
                      })
                    : t("analysisError.content_too_short")
                  : item.analysisError.retryable
                    ? t("analysisError.unknown")
                    : t("analysisError.unknownTerminal")}
            </Alert>
          )}

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
            {/* The stored value is a canonical ISO 639-1 code and stays that
                way in the database; only the label is localized, so a
                Bulgarian UI reads "английски" instead of a bare "en". Pure
                mapping via Intl — never an AI call. */}
            {field(
              t("fields.originalLanguage"),
              languageDisplayName(item.originalLanguage, locale)
            )}
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
