"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { FileText } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { GeneratePostForm } from "./generate-post-form";
import { GeneratedPostCard } from "./generated-post-card";
import type { PostItem } from "@/lib/services/company/list-posts.service";
import type { GenerationSourceOption } from "@/lib/services/company/list-generation-sources.service";

interface Props {
  slug: string;
  initialPosts: PostItem[];
  canDelete: boolean;
  canPublish: boolean;
  canApprove: boolean;
  bufferConnected: boolean;
  hasRssFeedItems: boolean;
  contentSources: GenerationSourceOption[];
}

export function GeneratedPostsSection({
  slug,
  initialPosts,
  canDelete,
  canPublish,
  canApprove,
  bufferConnected,
  hasRssFeedItems,
  contentSources,
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
              canPublish={canPublish}
              canApprove={canApprove}
              bufferConnected={bufferConnected}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}
