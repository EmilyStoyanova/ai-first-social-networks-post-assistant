import { permanentRedirect } from "next/navigation";
import { pendingApprovalsHref } from "@/lib/posts/post-status-filter";

interface Props {
  params: Promise<{ slug: string }>;
}

/**
 * Retired in Phase 4c — the queue is now a filter on Posts.
 *
 * The page is gone but the URL is not: it was the workspace's second tab for
 * months, so it is linked from bookmarks and from any approval-request mail a
 * team has already sent. A 308 to the filtered Posts view lands those links on
 * the same set of posts with the same actions available.
 *
 * `/approval` (singular) points at the same destination directly rather than
 * hopping through this file, so the older URL still costs one redirect.
 */
export default async function RetiredApprovalsPage({ params }: Props) {
  const { slug } = await params;
  permanentRedirect(pendingApprovalsHref(slug));
}
