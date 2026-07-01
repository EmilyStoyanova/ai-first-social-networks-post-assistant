import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import type { AdminUserItem } from "@/lib/services/admin/list-users.service";

function fmtDate(d: Date) {
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

interface Props {
  users: AdminUserItem[];
}

export function AdminUsersTable({ users }: Props) {
  if (users.length === 0) {
    return <EmptyState icon="👤" title="No users found." />;
  }

  return (
    <Card className="overflow-hidden px-0 py-0">
      {/* Desktop header: Name+Email | Role | Language | Companies | Created */}
      <div className="hidden grid-cols-[minmax(0,1fr)_6rem_5rem_5rem_7rem] gap-4 border-b border-gray-100 bg-gray-50 px-6 py-3 sm:grid">
        <span className="text-xs font-medium tracking-wide text-gray-400 uppercase">
          Name &amp; Email
        </span>
        <span className="text-xs font-medium tracking-wide text-gray-400 uppercase">Role</span>
        <span className="text-xs font-medium tracking-wide text-gray-400 uppercase">Language</span>
        <span className="text-center text-xs font-medium tracking-wide text-gray-400 uppercase">
          Companies
        </span>
        <span className="text-xs font-medium tracking-wide text-gray-400 uppercase">Created</span>
      </div>

      <div className="divide-y divide-gray-100">
        {users.map((u) => (
          <div key={u.id} className="px-6 py-4">
            {/* Mobile: stacked */}
            <div className="flex items-start justify-between gap-3 sm:hidden">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-900">{u.name ?? "—"}</p>
                <p className="mt-0.5 truncate text-xs text-gray-500">{u.email}</p>
                <p className="mt-1 text-xs text-gray-400">
                  {u.preferredLanguage.toUpperCase()} &middot;{" "}
                  {u.companyCount === 1 ? "1 company" : `${u.companyCount} companies`} &middot;{" "}
                  {fmtDate(u.createdAt)}
                </p>
              </div>
              <Badge variant={u.isGlobalAdmin ? "owner" : "editor"}>
                {u.isGlobalAdmin ? "Admin" : "User"}
              </Badge>
            </div>

            {/* Desktop: grid */}
            <div className="hidden grid-cols-[minmax(0,1fr)_6rem_5rem_5rem_7rem] items-center gap-4 sm:grid">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-gray-900">{u.name ?? "—"}</p>
                <p className="mt-0.5 truncate text-xs text-gray-500">{u.email}</p>
              </div>
              <div>
                <Badge variant={u.isGlobalAdmin ? "owner" : "editor"}>
                  {u.isGlobalAdmin ? "Admin" : "User"}
                </Badge>
              </div>
              <div className="text-sm text-gray-600">{u.preferredLanguage.toUpperCase()}</div>
              <div className="text-center text-sm text-gray-600">{u.companyCount}</div>
              <div className="text-xs text-gray-500">{fmtDate(u.createdAt)}</div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
