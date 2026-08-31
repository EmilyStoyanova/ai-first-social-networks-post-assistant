import { prisma } from "@/lib/db/client";
import { listCompanies, type CompanyListItem } from "@/lib/services/company/list-companies.service";

export type { CompanyListItem };

export interface DashboardActivityItem {
  id: string;
  action: string;
  companyName: string;
  companySlug: string;
  createdAt: string;
  user: { name: string | null; email: string } | null;
}

export interface DashboardData {
  companies: CompanyListItem[];
  totalDrafts: number;
  recentActivity: DashboardActivityItem[];
}

export async function getDashboardData(
  userId: string,
  isGlobalAdmin: boolean
): Promise<DashboardData> {
  const companies = await listCompanies(userId, isGlobalAdmin);

  const totalDrafts = companies.reduce((sum, c) => sum + c.draftCount, 0);

  const recentActivity: DashboardActivityItem[] = [];

  if (companies.length > 0) {
    const companyIds = companies.map((c) => c.id);
    const companyMap = new Map(companies.map((c) => [c.id, { name: c.name, slug: c.slug }]));

    const rows = await prisma.auditLog.findMany({
      where: { companyId: { in: companyIds } },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: {
        id: true,
        action: true,
        companyId: true,
        createdAt: true,
        user: { select: { name: true, email: true } },
      },
    });

    for (const r of rows) {
      if (!r.companyId) continue;
      const company = companyMap.get(r.companyId);
      if (!company) continue;
      recentActivity.push({
        id: r.id,
        action: r.action,
        companyName: company.name,
        companySlug: company.slug,
        createdAt: r.createdAt.toISOString(),
        user: r.user,
      });
    }
  }

  return { companies, totalDrafts, recentActivity };
}
