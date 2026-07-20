import { permanentRedirect } from "next/navigation";

interface Props {
  params: Promise<{ slug: string }>;
}

/**
 * Retired in Phase 4a — the queue now lives at `/approvals` (§2.2).
 *
 * The rename is permanent, so the old path answers with a 308 rather than
 * being deleted: this URL is linked from the dashboard's pending-work rows and
 * from any approval-request mail a team has already sent.
 */
export default async function LegacyApprovalPage({ params }: Props) {
  const { slug } = await params;
  permanentRedirect(`/companies/${slug}/approvals`);
}
