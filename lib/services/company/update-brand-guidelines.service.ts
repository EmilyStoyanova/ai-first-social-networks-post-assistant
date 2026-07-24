import { prisma } from "@/lib/db/client";
import type { UpdateBrandGuidelinesInput } from "@/lib/validators/brand-guidelines.schema";

export type BrandGuidelinesData = {
  id: string;
  companyId: string;
  logoUrl: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;
  fontFamily: string | null;
  toneOfVoice: string | null;
  companyDescription: string | null;
  targetAudience: string | null;
  forbiddenWords: string[];
  competitors: string[];
  createdAt: Date;
  updatedAt: Date;
};

export type UpdateBrandGuidelinesResult =
  | { success: true; brandGuidelines: BrandGuidelinesData }
  | { success: false; code: "NOT_FOUND" | "FORBIDDEN" };

const SELECT = {
  id: true,
  companyId: true,
  logoUrl: true,
  primaryColor: true,
  secondaryColor: true,
  fontFamily: true,
  toneOfVoice: true,
  companyDescription: true,
  targetAudience: true,
  forbiddenWords: true,
  competitors: true,
  createdAt: true,
  updatedAt: true,
} as const;

async function upsert(
  companyId: string,
  data: UpdateBrandGuidelinesInput
): Promise<BrandGuidelinesData> {
  return prisma.$transaction(async (tx) => {
    // Both automationMode and defaultLang live on Company (not BrandGuidelines),
    // but are edited from the same Brand Settings form, so they are updated here.
    if (data.automationMode || data.defaultLang) {
      await tx.company.update({
        where: { id: companyId },
        data: {
          ...(data.automationMode ? { automationMode: data.automationMode } : {}),
          ...(data.defaultLang ? { defaultLang: data.defaultLang } : {}),
        },
      });
    }
    return tx.brandGuidelines.upsert({
      where: { companyId },
      create: {
        companyId,
        logoUrl: data.logoUrl,
        primaryColor: data.primaryColor,
        secondaryColor: data.secondaryColor,
        fontFamily: data.fontFamily,
        toneOfVoice: data.toneOfVoice,
        companyDescription: data.companyDescription,
        targetAudience: data.targetAudience,
        forbiddenWords: data.forbiddenWords ?? [],
        competitors: data.competitors ?? [],
      },
      update: {
        logoUrl: data.logoUrl,
        primaryColor: data.primaryColor,
        secondaryColor: data.secondaryColor,
        fontFamily: data.fontFamily,
        toneOfVoice: data.toneOfVoice,
        companyDescription: data.companyDescription,
        targetAudience: data.targetAudience,
        forbiddenWords: data.forbiddenWords,
        competitors: data.competitors,
      },
      select: SELECT,
    });
  });
}

export async function updateBrandGuidelines(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean,
  data: UpdateBrandGuidelinesInput
): Promise<UpdateBrandGuidelinesResult> {
  if (isGlobalAdmin) {
    const company = await prisma.company.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (!company) return { success: false, code: "NOT_FOUND" };
    return { success: true, brandGuidelines: await upsert(company.id, data) };
  }

  // Regular users: find membership — returning null for both "not found" and
  // "not a member" avoids leaking whether the company exists.
  const membership = await prisma.companyMember.findFirst({
    where: { userId, company: { slug } },
    select: { role: true, company: { select: { id: true } } },
  });

  if (!membership) return { success: false, code: "NOT_FOUND" };

  // EDITORs are read-only for brand guidelines.
  if (membership.role !== "owner") return { success: false, code: "FORBIDDEN" };

  return { success: true, brandGuidelines: await upsert(membership.company.id, data) };
}
