import { prisma } from "@/lib/db/client";

export type CompanyListItem = {
  id: string;
  name: string;
  slug: string;
  website: string | null;
  role: "OWNER" | "EDITOR" | null;
};

export async function listCompanies(
  userId: string,
  isGlobalAdmin: boolean
): Promise<CompanyListItem[]> {
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

    return companies.map((c) => ({
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
  }

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

  return memberships.map((m) => ({
    id: m.company.id,
    name: m.company.name,
    slug: m.company.slug,
    website: m.company.website,
    role: m.role === "owner" ? "OWNER" : "EDITOR",
  }));
}
