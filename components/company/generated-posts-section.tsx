"use client";

import { useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { FileText } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { GeneratePostForm } from "./generate-post-form";
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
import type { PostItem } from "@/lib/services/company/list-posts.service";
import type { GenerationSourceOption } from "@/lib/services/company/list-generation-sources.service";
import type { PostRole } from "@/lib/posts/post-actions";
import {
  disabledMetrics,
  type PostMetricsView,
} from "@/lib/services/analytics/get-post-metrics.service";

interface Props {
  slug: string;
  initialPosts: PostItem[];
  canDelete: boolean;
  role: PostRole;
  bufferConnected: boolean;
  hasRssFeedItems: boolean;
  contentSources: GenerationSourceOption[];
  /** Engagement metrics by post id (v2-7). Loaded server-side for the whole tab. */
  postMetrics: Record<string, PostMetricsView>;
  /** Owners see the "add a key" nudge on the disabled state. */
  canManageAnalyticsKey: boolean;
  /** Filter parsed from ?status= server-side, so the first paint is already correct. */
  initialStatusFilter: PostStatusFilter;
}

export function GeneratedPostsSection({
  slug,
  initialPosts,
  canDelete,
  role,
  bufferConnected,
  hasRssFeedItems,
  contentSources,
  postMetrics,
  canManageAnalyticsKey,
  initialStatusFilter,
}: Props) {
  const t = useTranslations("posts");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [posts, setPosts] = useState<PostItem[]>(initialPosts);
  const [statusFilter, setStatusFilter] = useState<PostStatusFilter>(initialStatusFilter);
  const [lastUrlFilter, setLastUrlFilter] = useState<PostStatusFilter>(initialStatusFilter);

  // Back/forward should move the grid, not just the address bar. Local state
  // exists only so a click renders instantly rather than waiting on the router,
  // so when the URL changes underneath us — history navigation, not our own
  // click — the URL wins. Adjusting during render is React's supported way to
  // do this; an effect here would be a cascading re-render.
  const urlFilter = resolvePostStatusFilter(searchParams.get(POST_STATUS_PARAM) ?? undefined);
  if (urlFilter !== lastUrlFilter) {
    setLastUrlFilter(urlFilter);
    setStatusFilter(urlFilter);
  }

  function handleGenerated(post: PostItem) {
    setPosts((prev) => [post, ...prev]);
  }

  function handleDelete(id: string) {
    setPosts((prev) => prev.filter((p) => p.id !== id));
  }

  /**
   * Filter in place. The grid re-renders from state immediately; the URL catches
   * up separately so the view stays shareable and survives a reload.
   *
   * `replace` rather than `push` — a filter is a view setting, and stacking one
   * history entry per click would make Back mean "undo my last four clicks".
   * `scroll: false` keeps the page where the user left it.
   */
  function handleFilterChange(filter: PostStatusFilter) {
    setStatusFilter(filter);
    const query = buildPostStatusQuery(searchParams.toString(), filter);
    router.replace(`${pathname}?${query}`, { scroll: false });
  }

  const visiblePosts = useMemo(
    () => filterPostsByStatus(posts, statusFilter),
    [posts, statusFilter]
  );

  // Counts come from the same predicate the grid uses, so a label can never
  // promise a post the grid then hides.
  const counts = useMemo(
    () =>
      Object.fromEntries(
        POST_STATUS_FILTERS.map((f) => [f, filterPostsByStatus(posts, f).length])
      ) as Record<PostStatusFilter, number>,
    [posts]
  );

  const emptyState = resolvePostsEmptyState(posts.length, visiblePosts.length);

  return (
    <div className="space-y-4">
      <GeneratePostForm
        slug={slug}
        onGenerated={handleGenerated}
        hasRssFeedItems={hasRssFeedItems}
        contentSources={contentSources}
      />

      {/* Hidden when there is nothing to filter — a toolbar over an empty grid
          is four ways to see the same nothing. */}
      {posts.length > 0 && (
        <PostStatusFilterBar value={statusFilter} onChange={handleFilterChange} counts={counts} />
      )}

      {emptyState === "no-posts" ? (
        <EmptyState
          icon={<FileText className="h-5 w-5" />}
          title={t("noPostsTitle")}
          description={t("noPostsDesc")}
        />
      ) : emptyState === "no-matches" ? (
        <EmptyState
          icon={<FileText className="h-5 w-5" />}
          title={t("filters.noMatchesTitle")}
          description={t("filters.noMatchesDesc")}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {visiblePosts.map((post) => (
            <GeneratedPostCard
              key={post.id}
              slug={slug}
              post={post}
              canDelete={canDelete}
              role={role}
              bufferConnected={bufferConnected}
              onDelete={handleDelete}
              // A post generated after page load has no metrics row yet, so it
              // falls back to the disabled/pending state rather than crashing.
              metrics={postMetrics[post.id] ?? disabledMetrics()}
              canManageAnalyticsKey={canManageAnalyticsKey}
            />
          ))}
        </div>
      )}
    </div>
  );
}
