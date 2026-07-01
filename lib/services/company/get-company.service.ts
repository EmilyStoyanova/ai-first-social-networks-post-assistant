import { prisma } from "@/lib/db/client";

export type CompanyDetails = {
  id: string;
  name: string;
  slug: string;
  website: string | null;
  createdAt: Date;
  role: "OWNER" | "EDITOR" | null;
};

export async function getCompany(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<CompanyDetails | null> {
  if (isGlobalAdmin) {
    const company = await prisma.company.findUnique({
      where: { slug },
      select: {
        id: true,
        name: true,
        slug: true,
        website: true,
        createdAt: true,
        members: {
          where: { userId },
          select: { role: true },
          take: 1,
        },
      },
    });

    if (!company) return null;

    const membership = company.members[0];
    return {
      id: company.id,
      name: company.name,
      slug: company.slug,
      website: company.website,
      createdAt: company.createdAt,
      role:
        membership?.role === "owner" ? "OWNER" : membership?.role === "editor" ? "EDITOR" : null,
    };
  }

  // For regular users: find the company only if the user is a member.
  // Returning null for both "not found" and "not a member" avoids leaking
  // whether the company exists.
  const membership = await prisma.companyMember.findFirst({
    where: { userId, company: { slug } },
    select: {
      role: true,
      company: {
        select: {
          id: true,
          name: true,
          slug: true,
          website: true,
          createdAt: true,
        },
      },
    },
  });

  if (!membership) return null;

  return {
    id: membership.company.id,
    name: membership.company.name,
    slug: membership.company.slug,
    website: membership.company.website,
    createdAt: membership.company.createdAt,
    role: membership.role === "owner" ? "OWNER" : "EDITOR",
  };
}
