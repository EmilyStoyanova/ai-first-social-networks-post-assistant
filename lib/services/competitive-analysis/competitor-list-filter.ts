export type CompetitorListFilter = "active" | "archived" | "all";

export interface ArchivedWhereFragment {
  archivedAt?: null | { not: null };
}

/**
 * The `archivedAt` half of the Prisma `where` for `listCompetitors` — pure,
 * so the filter's actual matching behaviour is unit-testable without a
 * database (see list-competitors.service.test.ts, which interprets this
 * fragment against constructed rows rather than asserting its shape alone).
 */
export function archivedWhereFragment(filter: CompetitorListFilter): ArchivedWhereFragment {
  if (filter === "active") return { archivedAt: null };
  if (filter === "archived") return { archivedAt: { not: null } };
  return {};
}

/** Interprets `archivedWhereFragment`'s output against one row — used by both
 *  the service (conceptually, via Prisma) and its test (literally). */
export function matchesArchivedWhere(
  fragment: ArchivedWhereFragment,
  row: { archivedAt: Date | null }
): boolean {
  if (!("archivedAt" in fragment)) return true;
  const cond = fragment.archivedAt;
  if (cond === null) return row.archivedAt === null;
  return row.archivedAt !== null;
}
