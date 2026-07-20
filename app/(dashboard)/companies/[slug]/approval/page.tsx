import { permanentRedirect } from "next/navigation";
import { pendingApprovalsHref } from "@/lib/posts/post-status-filter";

interface Props {
  params: Promise<{ slug: string }>;
}

/**
 * Retired in Phase 4a, when the queue moved to `/approvals`; retired again in
 * Phase 4c, when the queue became a filter on Posts.
 *
 * Repointed at the final destination rather than left chaining through
 * `/approvals`, which now redirects too — two 308s to reach one page is a
 * round trip nobody needs, and the intermediate hop no longer means anything.
 */
export default async function LegacyApprovalPage({ params }: Props) {
  const { slug } = await params;
  permanentRedirect(pendingApprovalsHref(slug));
}
