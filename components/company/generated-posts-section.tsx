"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { FileText } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { GeneratePostForm } from "./generate-post-form";
import { GeneratedPostCard } from "./generated-post-card";
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
}: Props) {
  const t = useTranslations("posts");
  const [posts, setPosts] = useState<PostItem[]>(initialPosts);

  function handleGenerated(post: PostItem) {
    setPosts((prev) => [post, ...prev]);
  }

  function handleDelete(id: string) {
    setPosts((prev) => prev.filter((p) => p.id !== id));
  }

  return (
    <div className="space-y-4">
      <GeneratePostForm
        slug={slug}
        onGenerated={handleGenerated}
        hasRssFeedItems={hasRssFeedItems}
        contentSources={contentSources}
      />

      {posts.length === 0 ? (
        <EmptyState
          icon={<FileText className="h-5 w-5" />}
          title={t("noPostsTitle")}
          description={t("noPostsDesc")}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {posts.map((post) => (
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
