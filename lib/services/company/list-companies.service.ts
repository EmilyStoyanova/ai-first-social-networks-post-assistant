import { prisma } from "@/lib/db/client";

export type CompanyListItem = {
  id: string;
  name: string;
  slug: string;
  website: string | null;
  role: "OWNER" | "EDITOR" | null;
  draftCount: number;
};

export async function listCompanies(
  userId: string,
  isGlobalAdmin: boolean
): Promise<CompanyListItem[]> {
  let baseItems: Array<{
    id: string;
    name: string;
    slug: string;
    website: string | null;
    role: "OWNER" | "EDITOR" | null;
  }>;

  if (isGlobalAdmin) {
    const companies = await prisma.company.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        slug: true,
        website: true,
        members: {
          where: { userId },
          select: { role: true },
          take: 1,
        },
      },
    });

    baseItems = companies.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      website: c.website,
      role:
        c.members[0]?.role === "owner"
          ? "OWNER"
          : c.members[0]?.role === "editor"
            ? "EDITOR"
            : null,
    }));
  } else {
    const memberships = await prisma.companyMember.findMany({
      where: { userId },
      orderBy: { company: { name: "asc" } },
      select: {
        role: true,
        company: {
          select: { id: true, name: true, slug: true, website: true },
        },
      },
    });

    baseItems = memberships.map((m) => ({
      id: m.company.id,
      name: m.company.name,
      slug: m.company.slug,
      website: m.company.website,
      role: m.role === "owner" ? "OWNER" : "EDITOR",
    }));
  }

  if (baseItems.length === 0) return [];

  const ids = baseItems.map((c) => c.id);

  const draftRows = await prisma.post.groupBy({
    by: ["companyId"],
    where: { companyId: { in: ids }, status: "draft" as never },
    _count: { _all: true },
  });

  const draftMap = new Map(draftRows.map((r) => [r.companyId, r._count._all]));

  return baseItems.map((c) => ({
    ...c,
    draftCount: draftMap.get(c.id) ?? 0,
  }));
}
