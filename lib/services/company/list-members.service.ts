import { prisma } from "@/lib/db/client";

export type MemberItem = {
  id: string;
  name: string | null;
  email: string;
  role: "OWNER" | "EDITOR";
  joinedAt: Date;
};

export type ListMembersResult =
  { success: true; members: MemberItem[] } | { success: false; code: "NOT_FOUND" };

const SELECT = {
  id: true,
  role: true,
  createdAt: true,
  user: { select: { name: true, email: true } },
} as const;

export function toMemberItem(m: {
  id: string;
  role: string;
  createdAt: Date;
  user: { name: string | null; email: string };
}): MemberItem {
  return {
    id: m.id,
    name: m.user.name,
    email: m.user.email,
    role: m.role === "owner" ? "OWNER" : "EDITOR",
    joinedAt: m.createdAt,
  };
}

export async function listMembers(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<ListMembersResult> {
  if (isGlobalAdmin) {
    const company = await prisma.company.findUnique({
      where: { slug },
      select: { members: { select: SELECT, orderBy: { createdAt: "asc" } } },
    });
    if (!company) return { success: false, code: "NOT_FOUND" };
    return { success: true, members: company.members.map(toMemberItem) };
  }

  // Regular user: returns null for both "company not found" and "not a member"
  // so the existence of a company is never leaked to outsiders.
  const company = await prisma.company.findFirst({
    where: { slug, members: { some: { userId } } },
    select: { members: { select: SELECT, orderBy: { createdAt: "asc" } } },
  });
  if (!company) return { success: false, code: "NOT_FOUND" };
  return { success: true, members: company.members.map(toMemberItem) };
}
