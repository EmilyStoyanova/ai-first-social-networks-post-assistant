import { prisma } from "@/lib/db/client";

/**
 * How many posts are waiting for a decision in one company.
 *
 * Phase 4c gave this number two homes at once — the Posts tab badge and the
 * "Pending approval" filter chip — so it exists as one function rather than
 * being counted independently at each site. `listCompanies` computes the same
 * figure in bulk for the dashboard and companies list; the predicate must stay
 * in step with it and with `FILTER_STATUSES.pending_approval` in
 * lib/posts/post-status-filter.ts.
 *
 * No access check here: every caller renders inside a page that has already
 * resolved the company through `getCompany`, which is where membership is
 * enforced. A bare count keyed by an id the caller was already handed adds no
 * reachable information.
 */
export async function countPendingApprovals(companyId: string): Promise<number> {
  return prisma.post.count({
    where: { companyId, status: "pending_approval" as never },
  });
}
