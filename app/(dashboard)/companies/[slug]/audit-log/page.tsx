import { permanentRedirect } from "next/navigation";

interface Props {
  params: Promise<{ slug: string }>;
}

/**
 * Retired in Phase 4a — the audit log now lives at `/activity` (§2.2, renamed
 * for plain language). A 308 keeps existing links and bookmarks working.
 */
export default async function LegacyAuditLogPage({ params }: Props) {
  const { slug } = await params;
  permanentRedirect(`/companies/${slug}/activity`);
}
