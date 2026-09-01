"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, ChevronRight, Plus, RefreshCw, Trash2, ExternalLink } from "lucide-react";
import { useApiErrorMessage } from "@/lib/i18n/api-error";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import type { CompetitorSourceItem } from "@/lib/services/competitive-analysis/competitor-source-dto";

const FIELD =
  "text-body rounded-control border-border-strong bg-surface text-fg h-9 border px-3 outline-none transition-all duration-fast focus:border-accent focus:ring-2 focus:ring-accent/20 focus:ring-offset-0";

interface Props {
  slug: string;
  competitorId: string;
  canManage: boolean;
}

/**
 * RSS feed management for one competitor (Part 3B §18). Deliberately its own
 * section, visually and functionally separate from Social Profiles — RSS
 * feeds ARE ingestible in this phase; social profiles are still reference-only
 * (§21). Lazy-loaded: sources are fetched only once this section is opened, so
 * the competitor list page never fans out an N+1 request per competitor.
 */
export function CompetitorSourcesEditor({ slug, competitorId, canManage }: Props) {
  const t = useTranslations("competitiveAnalysis.competitors.sources");
  const tCommon = useTranslations("common");
  const apiError = useApiErrorMessage();

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sources, setSources] = useState<CompetitorSourceItem[] | null>(null);
  const [error, setError] = useState("");

  const [showAddForm, setShowAddForm] = useState(false);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);

  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  const base = `/api/v1/companies/${slug}/competitive-analysis/competitors/${competitorId}/sources`;

  async function load() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(base);
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error));
      }
      const json = (await res.json()) as { sources: CompetitorSourceItem[] };
      setSources(json.sources);
    } catch (err) {
      setError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setLoading(false);
    }
  }

  async function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next && sources === null) await load();
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const res = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, url }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error));
      }
      const json = (await res.json()) as { source: CompetitorSourceItem };
      setSources((prev) => [...(prev ?? []), json.source]);
      setLabel("");
      setUrl("");
      setShowAddForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleEnabled(source: CompetitorSourceItem) {
    setError("");
    try {
      const res = await fetch(`${base}/${source.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: source.label, url: source.url, enabled: !source.enabled }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error));
      }
      const json = (await res.json()) as { source: CompetitorSourceItem };
      setSources((prev) => (prev ?? []).map((s) => (s.id === source.id ? json.source : s)));
    } catch (err) {
      setError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    }
  }

  async function handleDelete(sourceId: string) {
    setError("");
    try {
      const res = await fetch(`${base}/${sourceId}`, { method: "DELETE" });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error));
      }
      setSources((prev) => (prev ?? []).filter((s) => s.id !== sourceId));
    } catch (err) {
      setError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    }
  }

  async function handleSync(sourceId: string) {
    setSyncingId(sourceId);
    setSyncResult(null);
    setError("");
    try {
      const res = await fetch(`${base}/${sourceId}/ingest`, { method: "POST" });
      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error));
      }
      const json = (await res.json()) as { created: number; updated: number };
      setSyncResult(t("syncResult", { created: json.created, updated: json.updated }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setSyncingId(null);
    }
  }

  return (
    <div className="border-border mt-3 border-t pt-3">
      {/*
       * This toggle is the ONLY way to reach RSS source management for a
       * competitor — it must read as a clickable control at a glance, not as
       * a plain label, or the (already-implemented) empty-state message and
       * "Add RSS source" action inside never get discovered (Part 3B UX fix:
       * a competitor with zero sources looked like it had no RSS management
       * at all, even though `open && sources.length === 0` already rendered
       * both correctly once expanded).
       */}
      <button
        type="button"
        onClick={() => void toggleOpen()}
        aria-expanded={open}
        className="text-fg-muted hover:text-fg hover:bg-surface-subtle duration-fast -mx-2 flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium transition-colors"
      >
        {open ? (
          <ChevronDown size={14} aria-hidden="true" />
        ) : (
          <ChevronRight size={14} aria-hidden="true" />
        )}
        {t("title")} {sources ? `(${sources.length})` : ""}
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          <p className="text-fg-faint text-xs">{t("hint")}</p>

          {error && (
            <Alert variant="error" className="text-xs">
              {error}
            </Alert>
          )}
          {syncResult && (
            <Alert variant="success" className="text-xs">
              {syncResult}
            </Alert>
          )}

          {loading && <p className="text-fg-faint text-xs">{tCommon("loading")}</p>}

          {sources && sources.length === 0 && !showAddForm && (
            <p className="text-fg-faint text-xs">{t("empty")}</p>
          )}

          {sources && sources.length > 0 && (
            <ul className="space-y-1.5">
              {sources.map((source) => (
                <li
                  key={source.id}
                  className="border-border-subtle flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-1.5"
                >
                  <span className="text-fg min-w-0 flex-1 truncate text-xs font-medium">
                    {source.label}
                  </span>
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-fg-faint hover:text-accent inline-flex items-center gap-1 text-xs"
                  >
                    <ExternalLink size={11} aria-hidden="true" />
                  </a>
                  {!source.enabled && <Badge variant="neutral">{t("disabled")}</Badge>}
                  {canManage && (
                    <div className="ml-auto flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={syncingId === source.id}
                        disabled={!source.enabled}
                        onClick={() => void handleSync(source.id)}
                        leftIcon={<RefreshCw size={12} aria-hidden="true" />}
                      >
                        {t("sync")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleToggleEnabled(source)}
                      >
                        {source.enabled ? t("disable") : t("enable")}
                      </Button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(source.id)}
                        aria-label={tCommon("delete")}
                        className="text-fg-faint hover:text-status-danger-fg duration-fast p-1 transition-colors"
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          {canManage && showAddForm && (
            <form onSubmit={(e) => void handleAdd(e)} className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={t("labelPlaceholder")}
                required
                className={`${FIELD} w-32 shrink-0`}
              />
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://…/feed.xml"
                required
                className={`${FIELD} min-w-0 flex-1`}
              />
              <Button type="submit" variant="secondary" size="sm" loading={saving}>
                {tCommon("save")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setShowAddForm(false)}>
                {tCommon("cancel")}
              </Button>
            </form>
          )}

          {canManage && !showAddForm && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowAddForm(true)}
              leftIcon={<Plus size={12} aria-hidden="true" />}
            >
              {t("addSource")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
