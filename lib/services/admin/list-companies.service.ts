import { prisma } from "@/lib/db/client";

export type AdminCompanyItem = {
  id: string;
  name: string;
  slug: string;
  website: string | null;
  memberCount: number;
  ownerEmails: string[];
  createdAt: Date;
};

export type ListAdminCompaniesResult =
  { success: true; companies: AdminCompanyItem[] } | { success: false; code: "FORBIDDEN" };

export async function listAdminCompanies(
  isGlobalAdmin: boolean
): Promise<ListAdminCompaniesResult> {
  if (!isGlobalAdmin) return { success: false, code: "FORBIDDEN" };

  const companies = await prisma.company.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      slug: true,
      website: true,
      createdAt: true,
      _count: { select: { members: true } },
      members: {
        where: { role: "owner" },
        select: { user: { select: { email: true } } },
      },
    },
  });

  return {
    success: true,
    companies: companies.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      website: c.website,
      memberCount: c._count.members,
      ownerEmails: c.members.map((m) => m.user.email),
      createdAt: c.createdAt,
    })),
  };
}
