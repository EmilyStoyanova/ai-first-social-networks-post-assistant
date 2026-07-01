import { prisma } from "@/lib/db/client";
import type { BrandGuidelinesData } from "./update-brand-guidelines.service";

export async function getBrandGuidelines(companyId: string): Promise<BrandGuidelinesData | null> {
  return prisma.brandGuidelines.findUnique({
    where: { companyId },
    select: {
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
    },
  });
}
