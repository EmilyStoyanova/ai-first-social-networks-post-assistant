"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { InviteMemberForm } from "./invite-member-form";
import { MemberRow } from "./member-row";

// ─── Shared type ──────────────────────────────────────────────────────────────

export type ClientMember = {
  id: string;
  name: string | null;
  email: string;
  role: "OWNER" | "EDITOR";
  joinedAt: string;
};

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  slug: string;
  initialMembers: ClientMember[];
  currentUserEmail: string;
  canManage: boolean;
}

export function CompanyMembers({ slug, initialMembers, currentUserEmail, canManage }: Props) {
  const t = useTranslations("members");
  const tCommon = useTranslations("common");
  const [members, setMembers] = useState<ClientMember[]>(initialMembers);

  function handleInvited(member: ClientMember) {
    setMembers((prev) => [...prev, member]);
  }

  function handleRoleChanged(memberId: string, newRole: "OWNER" | "EDITOR") {
    setMembers((prev) => prev.map((m) => (m.id === memberId ? { ...m, role: newRole } : m)));
  }

  function handleRemoved(memberId: string) {
    setMembers((prev) => prev.filter((m) => m.id !== memberId));
  }

  return (
    <Card className="px-6 py-6">
      {/* Card header */}
      <div className="mb-5 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">{t("title")}</h2>
        {!canManage && <Badge variant="readonly">{tCommon("readOnly")}</Badge>}
      </div>

      {/* Invite form — owners and global admins only */}
      {canManage && (
        <>
          <div className="mb-5">
            <h3 className="mb-3 text-xs font-semibold tracking-widest text-gray-400 uppercase">
              {t("inviteMember")}
            </h3>
            <InviteMemberForm slug={slug} onInvited={handleInvited} />
          </div>
          <hr className="mb-5 border-gray-100" />
        </>
      )}

      {/* Current members */}
      <div>
        <h3 className="mb-3 text-xs font-semibold tracking-widest text-gray-400 uppercase">
          {t("currentMembers")}
        </h3>

        {members.length === 0 ? (
          <p className="py-4 text-center text-sm text-gray-400">{t("noMembers")}</p>
        ) : (
          <div>
            {/* Table header — desktop only */}
            <div className="mb-1 hidden grid-cols-[minmax(0,1fr)_8rem_auto] gap-4 sm:grid">
              <span className="text-xs font-medium tracking-wide text-gray-400 uppercase">
                {t("nameAndEmail")}
              </span>
              <span className="text-xs font-medium tracking-wide text-gray-400 uppercase">
                {t("role")}
              </span>
              {canManage && (
                <span className="min-w-[6rem] text-right text-xs font-medium tracking-wide text-gray-400 uppercase">
                  {t("actions")}
                </span>
              )}
            </div>

            <div className="divide-y divide-gray-100">
              {members.map((member) => (
                <MemberRow
                  key={member.id}
                  member={member}
                  slug={slug}
                  isSelf={member.email === currentUserEmail}
                  canManage={canManage}
                  onRoleChanged={handleRoleChanged}
                  onRemoved={handleRemoved}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
