import { prisma } from "@/lib/db/client";

export type BufferAccessResult =
  { ok: true; companyId: string } | { ok: false; error: "NOT_FOUND" | "FORBIDDEN" };

/**
 * Resolves company access for Buffer operations.
 * - Global admin: full access to any company.
 * - Owner: full access to their company.
 * - Editor: FORBIDDEN (403 — not 404, existence is not leaked because they are already a member).
 * - Non-member: NOT_FOUND (404 — existence of the company is not leaked).
 */
export async function checkBufferAccess(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<BufferAccessResult> {
  if (isGlobalAdmin) {
    const company = await prisma.company.findUnique({ where: { slug }, select: { id: true } });
    if (!company) return { ok: false, error: "NOT_FOUND" };
    return { ok: true, companyId: company.id };
  }

  const membership = await prisma.companyMember.findFirst({
    where: { company: { slug }, userId },
    select: { companyId: true, role: true },
  });

  if (!membership) return { ok: false, error: "NOT_FOUND" };
  if (membership.role !== "owner") return { ok: false, error: "FORBIDDEN" };
  return { ok: true, companyId: membership.companyId };
}
