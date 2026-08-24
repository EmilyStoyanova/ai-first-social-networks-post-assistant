"use client";

import { useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { FileText } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { GeneratedPostCard } from "./generated-post-card";
import { PostStatusFilterBar } from "./post-status-filter-bar";
import {
  POST_STATUS_FILTERS,
  POST_STATUS_PARAM,
  buildPostStatusQuery,
  filterPostsByStatus,
  resolvePostStatusFilter,
  resolvePostsEmptyState,
  type PostStatusFilter,
} from "@/lib/posts/post-status-filter";
import { groupPostsByTopic } from "@/lib/posts/post-groups";
import { applyPostEdit } from "@/lib/posts/apply-post-edit";
import { usePostsLiveRefresh } from "@/lib/posts/use-posts-live-refresh";
import type { PostItem } from "@/lib/services/company/list-posts.service";
import type { PostRole } from "@/lib/posts/post-actions";

interface Props {
  slug: string;
  /** Already narrowed to the current channel scope by the page. */
  initialPosts: PostItem[];
  canDelete: boolean;
  role: PostRole;
  bufferConnected: boolean;
  initialStatusFilter: PostStatusFilter;
  /** Offers the generation-trace action on each card. Admin-only; see the card. */
  isGlobalAdmin?: boolean;
}

/**
 * One channel's posts.
 *
 * The same grid the Posts tab draws — same cards, same status filter, same
 * topic grouping — with two things left out on purpose:
 *
 *   • the generation form, because generating is one job with one home, and the
 *     workspace's primary action already routes there. A second copy on four
 *     channel pages would be four places to keep a large form in step;
 *   • the analytics strip, which belongs to the tab that loads metrics for the
 *     whole company in one query. This view is a browsing surface.
 *
 * What remains is composition of existing parts rather than a second posts
 * implementation: everything that decides which posts are shown lives in
 * lib/posts/post-status-filter.ts and lib/channels/channel-scope.ts, and every
 * action on a post is `GeneratedPostCard`'s.
 */
export function ChannelPostsSection({
  slug,
  initialPosts,
  canDelete,
  role,
  bufferConnected,
  initialStatusFilter,
  isGlobalAdmin = false,
}: Props) {
  const t = useTranslations("planner.posts");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [posts, setPosts] = useState<PostItem[]>(initialPosts);
  const [statusFilter, setStatusFilter] = useState<PostStatusFilter>(initialStatusFilter);
  const [lastServerPosts, setLastServerPosts] = useState<PostItem[]>(initialPosts);
  const [lastUrlFilter, setLastUrlFilter] = useState<PostStatusFilter>(initialStatusFilter);

  // Same live-refresh mechanism as GeneratedPostsSection — see its comment.
  usePostsLiveRefresh(() => router.refresh());

  // A fresh list from the server replaces the local one — same adjust-during-
  // render pattern, and same reason, as GeneratedPostsSection: a `useState`
  // initialiser runs once, so without this a `router.refresh()` would deliver
  // new posts the grid then ignored.
  if (initialPosts !== lastServerPosts) {
    setLastServerPosts(initialPosts);
    setPosts(initialPosts);
  }

  // Back/forward should move the grid, not just the address bar.
  const urlFilter = resolvePostStatusFilter(searchParams.get(POST_STATUS_PARAM) ?? undefined);
  if (urlFilter !== lastUrlFilter) {
    setLastUrlFilter(urlFilter);
    setStatusFilter(urlFilter);
  }

  function handleFilterChange(filter: PostStatusFilter) {
    setStatusFilter(filter);
    router.replace(`${pathname}?${buildPostStatusQuery(searchParams.toString(), filter)}`, {
      scroll: false,
    });
  }

  function handleDelete(id: string) {
    setPosts((prev) => prev.filter((post) => post.id !== id));
  }

  /** A saved edit lands in the list, not only in the card that made it — see
   *  the note on `handleEdited` in GeneratedPostsSection. No refresh: nothing
   *  outside this grid reads a post's text. */
  function handleEdited(id: string, content: string, hashtags: string[]) {
    setPosts((prev) => applyPostEdit(prev, id, content, hashtags));
  }

  function handleStatusChange(id: string, newStatus: string) {
    setPosts((prev) =>
      prev.map((post) => (post.id === id ? { ...post, status: newStatus } : post))
    );
    // Reconciliation — the workspace header's pending-approval badge reads the
    // same posts, and the grid has already repainted from local state.
    router.refresh();
  }

  const visiblePosts = useMemo(
    () => filterPostsByStatus(posts, statusFilter),
    [posts, statusFilter]
  );
  const groups = useMemo(() => groupPostsByTopic(visiblePosts), [visiblePosts]);

  const counts = useMemo(
    () =>
      Object.fromEntries(
        POST_STATUS_FILTERS.map((filter) => [filter, filterPostsByStatus(posts, filter).length])
      ) as Record<PostStatusFilter, number>,
    [posts]
  );

  const emptyState = resolvePostsEmptyState(posts.length, visiblePosts.length);

  return (
    <div className="space-y-4">
      {posts.length > 0 && (
        <PostStatusFilterBar value={statusFilter} onChange={handleFilterChange} counts={counts} />
      )}

      {emptyState === "no-posts" ? (
        <EmptyState
          icon={<FileText className="h-5 w-5" />}
          title={t("emptyTitle")}
          description={t("emptyDesc")}
        />
      ) : emptyState === "no-matches" ? (
        <EmptyState
          icon={<FileText className="h-5 w-5" />}
          title={t("noMatchesTitle")}
          description={t("noMatchesDesc")}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {groups.map((group) => (
            <GeneratedPostCard
              key={group.key}
              slug={slug}
              posts={group.posts}
              canDelete={canDelete}
              role={role}
              bufferConnected={bufferConnected}
              onDelete={handleDelete}
              onStatusChange={handleStatusChange}
              onEdited={handleEdited}
              isGlobalAdmin={isGlobalAdmin}
            />
          ))}
        </div>
      )}
    </div>
  );
}
