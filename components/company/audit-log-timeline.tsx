"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { AuditLogItem } from "@/lib/services/audit/audit-log.service";

// ─── Display maps ──────────────────────────────────────────────────────────────

const ACTION_ICONS: Record<string, string> = {
  POST_GENERATED: "✨",
  POST_SUBMITTED: "📤",
  POST_APPROVED: "✅",
  POST_REJECTED: "❌",
  POST_EDITED: "✏️",
  POST_VERSION_RESTORED: "🔄",
  POST_PUBLISHED: "🚀",
  MEDIA_ATTACHED: "🖼️",
};

const ACTION_DOT_COLORS: Record<string, string> = {
  POST_GENERATED: "border-purple-200 bg-purple-50",
  POST_SUBMITTED: "border-yellow-200 bg-yellow-50",
  POST_APPROVED: "border-green-200 bg-green-50",
  POST_REJECTED: "border-red-200 bg-red-50",
  POST_EDITED: "border-blue-200 bg-blue-50",
  POST_VERSION_RESTORED: "border-orange-200 bg-orange-50",
  POST_PUBLISHED: "border-indigo-200 bg-indigo-50",
  MEDIA_ATTACHED: "border-pink-200 bg-pink-50",
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
        <p className="text-sm text-gray-400">{t("noActivity")}</p>
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
      <div className="absolute top-3.5 bottom-3.5 left-3.5 w-px bg-gray-200" />

      <ul className="space-y-5">
        {logs.map((log) => {
          const dotColor = ACTION_DOT_COLORS[log.action] ?? "border-gray-200 bg-gray-50";
          const icon = ACTION_ICONS[log.action] ?? "•";
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
                  "relative z-10 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border text-sm",
                  dotColor,
                ].join(" ")}
              >
                {icon}
              </div>

              {/* Content */}
              <div className="min-w-0 flex-1 pb-1">
                <p className="text-sm font-medium text-gray-900">{label}</p>
                <p className="text-xs text-gray-500">
                  {actor} · {formatDate(log.createdAt)}
                </p>
                {log.entityId && (
                  <p className="font-mono text-xs text-gray-400">
                    {t("postRef", { id: log.entityId.slice(0, 8) })}
                  </p>
                )}
                {meta && <p className="text-xs text-gray-500 italic">{meta}</p>}
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
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500">{t("filterAction")}</label>
          <select
            value={filterAction}
            onChange={(e) => setFilterAction(e.target.value)}
            className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-800 outline-none focus:border-gray-400 focus:ring-2 focus:ring-gray-100"
          >
            <option value="">{t("filterAllActions")}</option>
            {ALL_ACTION_KEYS.map((a) => (
              <option key={a} value={a}>
                {t(`actions.${a}`)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500">{t("filterFrom")}</label>
          <input
            type="date"
            value={filterFrom}
            onChange={(e) => setFilterFrom(e.target.value)}
            className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-800 outline-none focus:border-gray-400 focus:ring-2 focus:ring-gray-100"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500">{t("filterTo")}</label>
          <input
            type="date"
            value={filterTo}
            onChange={(e) => setFilterTo(e.target.value)}
            className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-800 outline-none focus:border-gray-400 focus:ring-2 focus:ring-gray-100"
          />
        </div>

        {hasFilters && (
          <button
            onClick={reset}
            className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-500 transition-colors hover:border-gray-300 hover:text-gray-700"
          >
            {t("clear")}
          </button>
        )}

        <p className="ml-auto self-center text-xs text-gray-400">
          {t("entries", { filtered: filtered.length, total: logs.length })}
        </p>
      </div>

      {/* Timeline */}
      <AuditLogEntries logs={filtered} />
    </div>
  );
}
