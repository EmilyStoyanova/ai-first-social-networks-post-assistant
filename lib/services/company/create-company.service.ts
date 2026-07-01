import { prisma } from "@/lib/db/client";
import type { CreateCompanyInput } from "@/lib/validators/company.schema";

type CreatedCompany = {
  id: string;
  name: string;
  slug: string;
  website: string | null;
  createdAt: Date;
};

export type CreateCompanyResult = { success: true; company: CreatedCompany };

function generateBaseSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "company";
}

async function findUniqueSlug(base: string): Promise<string> {
  const existing = await prisma.company.findUnique({
    where: { slug: base },
    select: { id: true },
  });
  if (!existing) return base;

  let counter = 2;
  while (true) {
    const candidate = `${base}-${counter}`;
    const taken = await prisma.company.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });
    if (!taken) return candidate;
    counter++;
  }
}

export async function createCompany(
  userId: string,
  data: CreateCompanyInput
): Promise<CreateCompanyResult> {
  const base = generateBaseSlug(data.name);
  const slug = await findUniqueSlug(base);

  const company = await prisma.$transaction(async (tx) => {
    const created = await tx.company.create({
      data: {
        name: data.name,
        slug,
        website: data.website ?? null,
        createdBy: userId,
      },
      select: {
        id: true,
        name: true,
        slug: true,
        website: true,
        createdAt: true,
      },
    });

    await tx.companyMember.create({
      data: {
        companyId: created.id,
        userId,
        role: "owner",
      },
    });

    return created;
  });

  return { success: true, company };
}
