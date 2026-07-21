import { getTranslations } from "next-intl/server";
import {
  Activity as ActivityIcon,
  CalendarCheck,
  CheckCircle2,
  FileText,
  Image as ImageIcon,
  Pencil,
  Send,
  ShieldAlert,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { formatRelativeTime } from "@/lib/i18n/format-date";
import type { AuditLogItem } from "@/lib/services/audit/audit-log.service";
import { OverviewPanel } from "./overview-panel";

interface Props {
  slug: string;
  entries: AuditLogItem[];
}

/** Icon per action. Unknown actions still render — the log is append-only and
 *  new action strings ship without a migration, so this must never throw. */
const ACTION_ICONS: Record<string, LucideIcon> = {
  POST_GENERATED: FileText,
  POST_SUBMITTED: Send,
  POST_APPROVED: CheckCircle2,
  POST_REJECTED: XCircle,
  POST_EDITED: Pencil,
  POST_VERSION_RESTORED: Pencil,
  POST_PUBLISHED: CalendarCheck,
  POST_PUBLISH_FAILED: ShieldAlert,
  MEDIA_ATTACHED: ImageIcon,
};

export async function OverviewActivity({ slug, entries }: Props) {
  const t = await getTranslations("overview.activity");
  const tAudit = await getTranslations("auditLog");

  return (
    <OverviewPanel
      icon={ActivityIcon}
      title={t("title")}
      footerHref={`/companies/${slug}/activity`}
      footerLabel={t("viewAll")}
    >
      {entries.length === 0 ? (
        <p className="text-fg-faint py-8 text-center text-sm">{t("empty")}</p>
      ) : (
        <ul role="list" className="divide-border divide-y">
          {entries.map((entry) => {
            const Icon = ACTION_ICONS[entry.action] ?? ActivityIcon;
            // The log stores raw action strings with no enum, so an action added
            // later has no translation yet. Falling back to the raw string keeps
            // the row readable instead of rendering a missing-key error.
            const label = tAudit.has(`actions.${entry.action}`)
              ? tAudit(`actions.${entry.action}`)
              : entry.action;

            return (
              <li key={entry.id} className="flex items-start gap-3 py-3 first:pt-0">
                <span
                  className="bg-tile-neutral-bg text-tile-neutral-fg rounded-control mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center"
                  aria-hidden="true"
                >
                  <Icon className="h-4 w-4" />
                </span>

                <div className="min-w-0 flex-1">
                  <p className="text-fg text-sm leading-snug">{label}</p>
                  <p className="text-fg-faint mt-0.5 truncate text-xs">
                    {entry.user?.name ?? entry.user?.email ?? tAudit("system")}
                  </p>
                </div>

                <time
                  dateTime={entry.createdAt}
                  className="text-fg-faint shrink-0 text-xs whitespace-nowrap"
                >
                  {formatRelativeTime(entry.createdAt)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </OverviewPanel>
  );
}
