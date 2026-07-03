"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useApiErrorMessage } from "@/lib/i18n/api-error";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import type { ClientMember } from "./company-members";

// ─── Select styling ───────────────────────────────────────────────────────────

const SELECT_CLS =
  "rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm outline-none " +
  "transition-colors duration-200 focus:border-green-500 focus:ring-2 focus:ring-green-100 " +
  "disabled:cursor-not-allowed disabled:opacity-60";

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  member: ClientMember;
  slug: string;
  isSelf: boolean;
  canManage: boolean;
  onRoleChanged: (memberId: string, newRole: "OWNER" | "EDITOR") => void;
  onRemoved: (memberId: string) => void;
}

export function MemberRow({ member, slug, isSelf, canManage, onRoleChanged, onRemoved }: Props) {
  const t = useTranslations("members");
  const tCommon = useTranslations("common");
  const apiError = useApiErrorMessage();
  const [isChangingRole, setIsChangingRole] = useState(false);
  const [roleError, setRoleError] = useState("");
  const [showConfirm, setShowConfirm] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [removeError, setRemoveError] = useState("");

  async function handleRoleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const newRole = e.target.value as "OWNER" | "EDITOR";
    if (newRole === member.role) return;

    setIsChangingRole(true);
    setRoleError("");

    try {
      const res = await fetch(`/api/v1/companies/${slug}/members/${member.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: newRole }),
      });

      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error, t("roleChangeError")));
      }

      onRoleChanged(member.id, newRole);
    } catch (err) {
      setRoleError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    } finally {
      setIsChangingRole(false);
    }
  }

  async function handleRemove() {
    setIsRemoving(true);
    setRemoveError("");

    try {
      const res = await fetch(`/api/v1/companies/${slug}/members/${member.id}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        const json = (await res.json()) as { error?: { message?: string } };
        throw new Error(apiError(json.error, t("removeError")));
      }

      onRemoved(member.id);
    } catch (err) {
      setIsRemoving(false);
      setShowConfirm(false);
      setRemoveError(err instanceof Error ? err.message : tCommon("somethingWentWrong"));
    }
  }

  const showActions = canManage && !isSelf;

  return (
    <div className="py-3">
      {/* Mobile: stacked flex */}
      <div className="flex items-start gap-3 sm:hidden">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-gray-900">{member.name ?? "—"}</p>
          <p className="mt-0.5 truncate text-xs text-gray-500">{member.email}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {canManage && !isSelf ? (
            <select
              value={member.role}
              onChange={handleRoleChange}
              disabled={isChangingRole}
              aria-label={`Role for ${member.email}`}
              className={SELECT_CLS}
            >
              <option value="OWNER">{t("owner")}</option>
              <option value="EDITOR">{t("editor")}</option>
            </select>
          ) : (
            <Badge variant={member.role === "OWNER" ? "owner" : "editor"}>{member.role}</Badge>
          )}
        </div>
      </div>

      {/* Desktop: 3-column grid — [name+email | role | actions] */}
      <div className="hidden sm:grid sm:grid-cols-[minmax(0,1fr)_8rem_auto] sm:items-center sm:gap-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-gray-900">{member.name ?? "—"}</p>
          <p className="mt-0.5 truncate text-xs text-gray-500">{member.email}</p>
        </div>

        {/* Role */}
        <div>
          {canManage && !isSelf ? (
            <select
              value={member.role}
              onChange={handleRoleChange}
              disabled={isChangingRole}
              aria-label={`Role for ${member.email}`}
              className={`${SELECT_CLS} w-full`}
            >
              <option value="OWNER">{t("owner")}</option>
              <option value="EDITOR">{t("editor")}</option>
            </select>
          ) : (
            <Badge variant={member.role === "OWNER" ? "owner" : "editor"}>{member.role}</Badge>
          )}
        </div>

        {/* Actions */}
        <div className="flex min-w-[6rem] items-center justify-end gap-2">
          {showActions &&
            (showConfirm ? (
              <>
                <span className="text-xs text-gray-500">{t("removeMember")}</span>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={handleRemove}
                  disabled={isRemoving}
                  loading={isRemoving}
                >
                  {isRemoving ? "…" : tCommon("confirm")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowConfirm(false)}
                  disabled={isRemoving}
                >
                  {tCommon("cancel")}
                </Button>
              </>
            ) : (
              <Button size="sm" variant="danger" onClick={() => setShowConfirm(true)}>
                {t("remove")}
              </Button>
            ))}
        </div>
      </div>

      {/* Inline errors */}
      {roleError && <p className="mt-1 text-xs text-red-600">{roleError}</p>}
      {removeError && <p className="mt-1 text-xs text-red-600">{removeError}</p>}

      {/* Mobile remove actions */}
      {showActions && (
        <div className="mt-2 sm:hidden">
          {showConfirm ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-gray-500">{t("removeMember")}</span>
              <Button
                size="sm"
                variant="danger"
                onClick={handleRemove}
                disabled={isRemoving}
                loading={isRemoving}
              >
                {isRemoving ? "…" : tCommon("confirm")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowConfirm(false)}
                disabled={isRemoving}
              >
                {tCommon("cancel")}
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="danger" onClick={() => setShowConfirm(true)}>
              {t("remove")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
