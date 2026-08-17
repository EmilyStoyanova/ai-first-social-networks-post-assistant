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
  topPriorityTopics: string[];
  mediumPriorityTopics: string[];
  avoidedTopics: string[];
  createdAt: Date;
  updatedAt: Date;
};

export type UpdateBrandGuidelinesResult =
  | { success: true; brandGuidelines: BrandGuidelinesData }
  | { success: false; code: "NOT_FOUND" | "FORBIDDEN" };

export const BRAND_GUIDELINES_SELECT = {
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
  topPriorityTopics: true,
  mediumPriorityTopics: true,
  avoidedTopics: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Who may write, and to which company. */
export type BrandGuidelinesAccess =
  { ok: true; companyId: string } | { ok: false; code: "NOT_FOUND" | "FORBIDDEN" };

/**
 * Resolves the caller's right to edit a company's brand settings.
 *
 * A non-member gets NOT_FOUND rather than FORBIDDEN for the same reason
 * everywhere else in this service layer: "you may not" would confirm the company
 * exists. EDITORs are members, so they legitimately get FORBIDDEN.
 */
export async function resolveBrandGuidelinesAccess(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<BrandGuidelinesAccess> {
  if (isGlobalAdmin) {
    const company = await prisma.company.findUnique({ where: { slug }, select: { id: true } });
    return company ? { ok: true, companyId: company.id } : { ok: false, code: "NOT_FOUND" };
  }

  const membership = await prisma.companyMember.findFirst({
    where: { userId, company: { slug } },
    select: { role: true, company: { select: { id: true } } },
  });

  if (!membership) return { ok: false, code: "NOT_FOUND" };
  // EDITORs are read-only for brand guidelines.
  if (membership.role !== "owner") return { ok: false, code: "FORBIDDEN" };

  return { ok: true, companyId: membership.company.id };
}

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
        topPriorityTopics: data.topPriorityTopics ?? [],
        mediumPriorityTopics: data.mediumPriorityTopics ?? [],
        avoidedTopics: data.avoidedTopics ?? [],
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
        // undefined leaves the stored list alone — an omitted group is "not
        // edited", never "cleared".
        topPriorityTopics: data.topPriorityTopics,
        mediumPriorityTopics: data.mediumPriorityTopics,
        avoidedTopics: data.avoidedTopics,
      },
      select: BRAND_GUIDELINES_SELECT,
    });
  });
}

/**
 * The two halves of a save, injectable so the orchestration below — which
 * authorization outcome persists, and with what — can be unit-tested without a
 * database. Defaults are the real implementations.
 */
export interface UpdateBrandGuidelinesDeps {
  resolveAccess: typeof resolveBrandGuidelinesAccess;
  persist: (companyId: string, data: UpdateBrandGuidelinesInput) => Promise<BrandGuidelinesData>;
}

const REAL_DEPS: UpdateBrandGuidelinesDeps = {
  resolveAccess: resolveBrandGuidelinesAccess,
  persist: upsert,
};

export async function updateBrandGuidelines(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean,
  data: UpdateBrandGuidelinesInput,
  deps: UpdateBrandGuidelinesDeps = REAL_DEPS
): Promise<UpdateBrandGuidelinesResult> {
  const access = await deps.resolveAccess(slug, userId, isGlobalAdmin);
  if (!access.ok) return { success: false, code: access.code };

  return { success: true, brandGuidelines: await deps.persist(access.companyId, data) };
}
