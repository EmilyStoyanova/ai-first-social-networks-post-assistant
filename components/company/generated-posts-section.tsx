"use client";

import { useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { CheckSquare2, FileText } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { GeneratePostForm } from "./generate-post-form";
import { GeneratedPostCard } from "./generated-post-card";
import { PostStatusFilterBar } from "./post-status-filter-bar";
import {
  PENDING_APPROVAL_FILTER,
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
import type { GenerationChannelOption } from "@/lib/posts/generation-channels";
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
  /** Channels backed by an enabled Buffer profile — empty disables generation. */
  availableChannels: GenerationChannelOption[];
  /** Company.defaultLang, used to name the resolved "Default" language option. */
  companyDefaultLang: "en" | "bg";
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
  availableChannels,
  companyDefaultLang,
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

  /**
   * A bulk run finished. It reports post ids rather than whole posts, so the
   * grid is reloaded from the server instead of patched — one refresh against
   * up to ten follow-up fetches, and it repaints the tab counts too.
   */
  function handleBulkGenerated() {
    router.refresh();
  }

  function handleDelete(id: string) {
    setPosts((prev) => prev.filter((p) => p.id !== id));
  }

  /**
   * A card owns its own status while an action is in flight, but the list owns
   * the counts — so an approve/reject/submit has to land here too. Without it
   * the card's badge would flip while the post stayed in "Pending approval"
   * with a count that never moved, which is exactly the disagreement §9.4
   * forbids now that the Posts tab badge reads the same numbers.
   *
   * `router.refresh()` re-renders the server component behind the tab badge.
   * The local update above has already repainted the grid, so the refresh is
   * reconciliation, not the thing the user is waiting on.
   */
  function handleStatusChange(id: string, newStatus: string) {
    setPosts((prev) => prev.map((p) => (p.id === id ? { ...p, status: newStatus } : p)));
    router.refresh();
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
        onBulkGenerated={handleBulkGenerated}
        hasRssFeedItems={hasRssFeedItems}
        contentSources={contentSources}
        availableChannels={availableChannels}
        companyDefaultLang={companyDefaultLang}
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
        /* An empty approval queue is good news, not a failed search — it is the
           end of the review loop, and the generic "no posts with this status /
           widen your filter" would read as an error on the one filter where
           zero is the goal. */
        statusFilter === PENDING_APPROVAL_FILTER ? (
          <EmptyState
            icon={<CheckSquare2 className="h-5 w-5" />}
            title={t("filters.noPendingTitle")}
            description={t("filters.noPendingDesc")}
          />
        ) : (
          <EmptyState
            icon={<FileText className="h-5 w-5" />}
            title={t("filters.noMatchesTitle")}
            description={t("filters.noMatchesDesc")}
          />
        )
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
              onStatusChange={handleStatusChange}
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
