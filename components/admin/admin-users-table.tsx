import { getTranslations } from "next-intl/server";
import { User } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import type { AdminUserItem } from "@/lib/services/admin/list-users.service";
import { formatDateNumeric } from "@/lib/i18n/format-date";

const fmtDate = formatDateNumeric;

interface Props {
  users: AdminUserItem[];
}

export async function AdminUsersTable({ users }: Props) {
  const t = await getTranslations("admin");

  if (users.length === 0) {
    return <EmptyState icon={<User className="h-5 w-5" />} title={t("noUsers")} />;
  }

  return (
    <Card className="overflow-hidden px-0 py-0">
      {/* Desktop header */}
      <div className="border-border bg-surface-subtle hidden grid-cols-[minmax(0,1fr)_6rem_5rem_5rem_7rem] gap-4 border-b px-6 py-3 sm:grid">
        <span className="text-micro text-fg-faint">{t("nameAndEmail")}</span>
        <span className="text-micro text-fg-faint">{t("role")}</span>
        <span className="text-micro text-fg-faint">{t("language")}</span>
        <span className="text-micro text-fg-faint text-center">{t("companies")}</span>
        <span className="text-micro text-fg-faint">{t("created")}</span>
      </div>

      <div className="divide-border divide-y">
        {users.map((u) => (
          <div key={u.id} className="px-6 py-4">
            {/* Mobile: stacked */}
            <div className="flex items-start justify-between gap-3 sm:hidden">
              <div className="min-w-0">
                <p className="text-fg text-sm font-semibold">{u.name ?? "—"}</p>
                <p className="text-fg-muted mt-0.5 truncate text-xs">{u.email}</p>
                <p className="text-fg-faint mt-1 text-xs">
                  {u.preferredLanguage.toUpperCase()} &middot;{" "}
                  {t("companyCount", { count: u.companyCount })} &middot; {fmtDate(u.createdAt)}
                </p>
              </div>
              <Badge variant={u.isGlobalAdmin ? "owner" : "editor"}>
                {u.isGlobalAdmin ? t("adminBadge") : t("userBadge")}
              </Badge>
            </div>

            {/* Desktop: grid */}
            <div className="hidden grid-cols-[minmax(0,1fr)_6rem_5rem_5rem_7rem] items-center gap-4 sm:grid">
              <div className="min-w-0">
                <p className="text-fg truncate text-sm font-semibold">{u.name ?? "—"}</p>
                <p className="text-fg-muted mt-0.5 truncate text-xs">{u.email}</p>
              </div>
              <div>
                <Badge variant={u.isGlobalAdmin ? "owner" : "editor"}>
                  {u.isGlobalAdmin ? t("adminBadge") : t("userBadge")}
                </Badge>
              </div>
              <div className="text-fg-muted text-sm">{u.preferredLanguage.toUpperCase()}</div>
              <div className="text-fg-muted text-center text-sm">{u.companyCount}</div>
              <div className="text-fg-muted text-xs">{fmtDate(u.createdAt)}</div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
