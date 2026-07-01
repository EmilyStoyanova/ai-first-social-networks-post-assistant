import { prisma } from "@/lib/db/client";

export type AdminUserItem = {
  id: string;
  name: string | null;
  email: string;
  isGlobalAdmin: boolean;
  preferredLanguage: string;
  companyCount: number;
  createdAt: Date;
};

export type ListAdminUsersResult =
  { success: true; users: AdminUserItem[] } | { success: false; code: "FORBIDDEN" };

export async function listAdminUsers(isGlobalAdmin: boolean): Promise<ListAdminUsersResult> {
  if (!isGlobalAdmin) return { success: false, code: "FORBIDDEN" };

  const users = await prisma.user.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      email: true,
      isGlobalAdmin: true,
      preferredLang: true,
      createdAt: true,
      _count: { select: { companies: true } },
    },
  });

  return {
    success: true,
    users: users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      isGlobalAdmin: u.isGlobalAdmin,
      preferredLanguage: u.preferredLang,
      companyCount: u._count.companies,
      createdAt: u.createdAt,
    })),
  };
}
