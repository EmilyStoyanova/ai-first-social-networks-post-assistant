"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  CheckCircle2,
  Image,
  Pencil,
  RotateCcw,
  Send,
  Sparkles,
  XCircle,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { AuditLogItem } from "@/lib/services/audit/audit-log.service";

// ─── Display maps ──────────────────────────────────────────────────────────────

// §6.8: Lucide icons replace all emoji. Icons are decorative (aria-hidden).
const ACTION_ICONS: Record<string, LucideIcon> = {
  POST_GENERATED: Sparkles,
  POST_SUBMITTED: Send,
  POST_APPROVED: CheckCircle2,
  POST_REJECTED: XCircle,
  POST_EDITED: Pencil,
  POST_VERSION_RESTORED: RotateCcw,
  POST_PUBLISHED: Zap,
  MEDIA_ATTACHED: Image,
};

const ACTION_DOT_COLORS: Record<string, string> = {
  POST_GENERATED: "border-status-neutral-dot/40 bg-status-neutral-bg",
  POST_SUBMITTED: "border-status-warning-dot/40 bg-status-warning-bg",
  POST_APPROVED: "border-status-success-dot/40 bg-status-success-bg",
  POST_REJECTED: "border-status-danger-dot/40 bg-status-danger-bg",
  POST_EDITED: "border-status-info-dot/40 bg-status-info-bg",
  POST_VERSION_RESTORED: "border-status-warning-dot/40 bg-status-warning-bg",
  POST_PUBLISHED: "border-status-success-dot/40 bg-status-success-bg",
  MEDIA_ATTACHED: "border-status-neutral-dot/40 bg-status-neutral-bg",
};

const ALL_ACTION_KEYS = [
  "POST_GENERATED",
  "POST_SUBMITTED",
  "POST_APPROVED",
  "POST_REJECTED",
  "POST_EDITED",
  "POST_VERSION_RESTORED",
  "POST_PUBLISHED",
  "MEDIA_ATTACHED",
] as const;

// ─── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ─── Entries list (shared between page and modal) ──────────────────────────────

interface EntriesProps {
  logs: AuditLogItem[];
}

export function AuditLogEntries({ logs }: EntriesProps) {
  const t = useTranslations("auditLog");

  if (logs.length === 0) {
    return (
      <div className="py-12 text-center">
        <p className="text-fg-faint text-sm">{t("noActivity")}</p>
      </div>
    );
  }

  function summarizeMetadata(
    action: string,
    metadata: Record<string, unknown> | null
  ): string | null {
    if (!metadata) return null;
    switch (action) {
      case "POST_GENERATED": {
        const parts = [metadata.llmProvider, metadata.llmModel].filter(Boolean);
        return parts.length > 0 ? t("viaProvider", { provider: parts.join(" ") }) : null;
      }
      case "POST_EDITED": {
        const fields = metadata.changedFields;
        if (Array.isArray(fields) && fields.length > 0) {
          return t("changed", { fields: (fields as string[]).join(", ") });
        }
        return null;
      }
      case "POST_VERSION_RESTORED":
        return t("restoredFromVersion");
      case "POST_PUBLISHED": {
        const id = metadata.bufferUpdateId;
        return id ? t("bufferRef", { id: String(id).slice(0, 14) }) : t("published");
      }
      case "MEDIA_ATTACHED":
        return t("imageAttached");
      default:
        return null;
    }
  }

  return (
    <div className="relative">
      {/* Vertical connecting line */}
      <div className="bg-border absolute top-3.5 bottom-3.5 left-3.5 w-px" />

      <ul className="space-y-5">
        {logs.map((log) => {
          const dotColor = ACTION_DOT_COLORS[log.action] ?? "border-border bg-surface-subtle";
          const Icon = ACTION_ICONS[log.action] ?? null;
          const actionKey = log.action as keyof typeof t;
          const label = ALL_ACTION_KEYS.includes(log.action as (typeof ALL_ACTION_KEYS)[number])
            ? t(`actions.${log.action as (typeof ALL_ACTION_KEYS)[number]}`)
            : log.action;
          const meta = summarizeMetadata(log.action, log.metadata);
          const actor = log.user ? (log.user.name ?? log.user.email) : t("system");

          void actionKey;

          return (
            <li key={log.id} className="relative flex gap-3">
              {/* Dot */}
              <div
                className={[
                  "relative z-10 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border",
                  dotColor,
                ].join(" ")}
                aria-hidden="true"
              >
                {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
              </div>

              {/* Content */}
              <div className="min-w-0 flex-1 pb-1">
                <p className="text-fg text-sm font-medium">{label}</p>
                <p className="text-fg-muted text-xs">
                  {actor} · {formatDate(log.createdAt)}
                </p>
                {log.entityId && (
                  <p className="text-data text-fg-faint">
                    {t("postRef", { id: log.entityId.slice(0, 8) })}
                  </p>
                )}
                {meta && <p className="text-fg-muted text-xs italic">{meta}</p>}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ─── Full timeline with filters ────────────────────────────────────────────────

interface TimelineProps {
  logs: AuditLogItem[];
}

export function AuditLogTimeline({ logs }: TimelineProps) {
  const t = useTranslations("auditLog");
  const [filterAction, setFilterAction] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");

  const filtered = logs.filter((log) => {
    if (filterAction && log.action !== filterAction) return false;
    if (filterFrom && new Date(log.createdAt) < new Date(filterFrom)) return false;
    if (filterTo && new Date(log.createdAt) > new Date(`${filterTo}T23:59:59`)) return false;
    return true;
  });

  function reset() {
    setFilterAction("");
    setFilterFrom("");
    setFilterTo("");
  }

  const hasFilters = filterAction || filterFrom || filterTo;

  return (
    <div className="space-y-6">
      {/* Filter bar */}
      <div className="rounded-card border-border bg-surface-subtle flex flex-wrap items-end gap-3 border px-4 py-3">
        <div className="flex w-full flex-col gap-1 sm:w-auto">
          <label className="text-fg-muted text-xs font-medium">{t("filterAction")}</label>
          <select
            value={filterAction}
            onChange={(e) => setFilterAction(e.target.value)}
            className="rounded-control border-border bg-surface text-fg focus:border-accent w-full border px-3 py-1.5 text-sm outline-none focus:outline-none sm:w-auto"
          >
            <option value="">{t("filterAllActions")}</option>
            {ALL_ACTION_KEYS.map((a) => (
              <option key={a} value={a}>
                {t(`actions.${a}`)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex w-full flex-col gap-1 sm:w-auto">
          <label className="text-fg-muted text-xs font-medium">{t("filterFrom")}</label>
          <input
            type="date"
            value={filterFrom}
            onChange={(e) => setFilterFrom(e.target.value)}
            className="rounded-control border-border bg-surface text-fg focus:border-accent w-full border px-3 py-1.5 text-sm outline-none focus:outline-none sm:w-auto"
          />
        </div>

        <div className="flex w-full flex-col gap-1 sm:w-auto">
          <label className="text-fg-muted text-xs font-medium">{t("filterTo")}</label>
          <input
            type="date"
            value={filterTo}
            onChange={(e) => setFilterTo(e.target.value)}
            className="rounded-control border-border bg-surface text-fg focus:border-accent w-full border px-3 py-1.5 text-sm outline-none focus:outline-none sm:w-auto"
          />
        </div>

        <div className="flex w-full items-center justify-between sm:contents">
          {hasFilters && (
            <button
              onClick={reset}
              className="rounded-control border-border bg-surface text-fg-muted hover:border-border-strong hover:text-fg border px-3 py-1.5 text-sm transition-colors"
            >
              {t("clear")}
            </button>
          )}

          <p className="text-fg-faint ml-auto self-center text-xs">
            {t("entries", { filtered: filtered.length, total: logs.length })}
          </p>
        </div>
      </div>

      {/* Timeline */}
      <AuditLogEntries logs={filtered} />
    </div>
  );
}
